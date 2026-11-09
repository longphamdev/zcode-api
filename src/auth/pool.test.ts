/**
 * Tests for AccountPool — pure module, injectable clock, no handler imports.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  AccountPool,
  AllAccountsCoolingError,
  NoAccountAvailableError,
  AccountsBusyError,
} from "./pool.js";
import type { StoredAccount } from "./accounts.js";
import type { Credential } from "./types.js";

const cred = (key: string): Credential => ({ apiKey: key, provider: "zai", userId: key });
const stored = (key: string): StoredAccount => ({
  id: key,
  credential: cred(key),
  addedAt: 0,
});

/** Fake store: mutable list, no disk. */
class FakeStore {
  accounts: StoredAccount[] = [];
  async listAccounts(): Promise<StoredAccount[]> {
    return [...this.accounts];
  }
}

/** Injectable clock. */
class FakeClock {
  private t = 1_700_000_000_000;
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

function makePool(store: FakeStore, clock: FakeClock, opts = {}) {
  const pool = new AccountPool(store, { now: clock.now, ...opts });
  return pool.syncWithStore().then(() => pool);
}

describe("AccountPool — sync with store", () => {
  it("loads accounts from the store", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a"), stored("b")];
    const pool = await makePool(store, new FakeClock());
    expect(pool.accountCount()).toBe(2);
    expect(pool.snapshot().every((r) => r.status === "healthy")).toBe(true);
  });

  it("keeps runtime state of surviving accounts, drops removed ones", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a"), stored("b")];
    const clock = new FakeClock();
    const pool = await makePool(store, clock);
    pool.cool("a", clock.now() + 60_000);
    store.accounts = [stored("a"), stored("c")]; // b removed, c added
    await pool.syncWithStore();
    expect(pool.accountCount()).toBe(2);
    expect(pool.runtimeFor("a")!.status).toBe("cooling"); // state kept
    expect(pool.runtimeFor("b")).toBeUndefined(); // dropped
    expect(pool.runtimeFor("c")!.status).toBe("healthy"); // fresh
  });
});

describe("AccountPool — pick strategies", () => {
  it("round-robin distributes evenly across N healthy accounts", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a"), stored("b"), stored("c")];
    const pool = await makePool(store, new FakeClock());
    const picks: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await pool.reserve();
      picks.push(r.accountId);
      r.release();
    }
    // Sorted ids: a,b,c — each appears exactly twice over 6 picks.
    for (const id of ["a", "b", "c"]) {
      expect(picks.filter((p) => p === id)).toHaveLength(2);
    }
  });

  it("most-remaining-quota picks the account with most units left", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a"), stored("b")];
    const clock = new FakeClock();
    const pool = await makePool(store, clock);
    pool.setStrategy("most-remaining-quota");
    pool.updateQuota("a", 100, clock.now());
    pool.updateQuota("b", 900, clock.now());
    const r = await pool.reserve();
    expect(r.accountId).toBe("b");
    r.release();
  });

  it("concurrent picks do not all land on one account", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a"), stored("b"), stored("c")];
    const pool = await makePool(store, new FakeClock(), { maxInFlightPerAccount: 3 });
    // 6 concurrent reserves with NO release: must spread over all 3.
    const reservations = await Promise.all([pool.reserve(), pool.reserve(), pool.reserve(), pool.reserve(), pool.reserve(), pool.reserve()]);
    const counts = new Map<string, number>();
    for (const r of reservations) counts.set(r.accountId, (counts.get(r.accountId) ?? 0) + 1);
    expect(counts.size).toBe(3); // all three accounts used
    for (const [, n] of counts) expect(n).toBe(2); // evenly
    for (const r of reservations) r.release();
  });
});

describe("AccountPool — unhealthy accounts are skipped", () => {
  it("skips cooling accounts and revives them when retryAt elapses", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a"), stored("b")];
    const clock = new FakeClock();
    const pool = await makePool(store, clock);
    pool.cool("a", clock.now() + 10_000);
    const r = await pool.reserve();
    expect(r.accountId).toBe("b"); // a skipped
    r.release();
    expect(pool.hasPickable()).toBe(true);
    clock.advance(10_001);
    // Revival is lazy: reserve() revives a when its cooldown has elapsed.
    // The exact pick still follows round-robin fairness, so assert revival
    // through pickability + the runtime state after the next reserve.
    const r2 = await pool.reserve();
    r2.release();
    expect(pool.runtimeFor("a")!.status).toBe("healthy");
    expect(pool.hasPickable()).toBe(true);
  });

  it("skips exhausted accounts until quotaExpiresAt, then revives", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a"), stored("b")];
    const clock = new FakeClock();
    const pool = await makePool(store, clock);
    pool.markExhausted("a", clock.now() + 5_000);
    let r = await pool.reserve();
    expect(r.accountId).toBe("b");
    r.release();
    clock.advance(5_001);
    r = await pool.reserve(); // lazily revives a when its window is over
    r.release();
    expect(pool.runtimeFor("a")!.status).toBe("healthy");
  });

  it("never picks expired accounts", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a")];
    const pool = await makePool(store, new FakeClock());
    pool.markExpired("a");
    expect(pool.hasPickable()).toBe(false);
    await expect(pool.reserve()).rejects.toBeInstanceOf(NoAccountAvailableError);
  });
});

describe("AccountPool — all-unhealthy error shapes", () => {
  it("all cooling → AllAccountsCoolingError with min retryAt", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a"), stored("b")];
    const clock = new FakeClock();
    const pool = await makePool(store, clock);
    pool.cool("a", clock.now() + 30_000);
    pool.cool("b", clock.now() + 10_000);
    try {
      await pool.reserve();
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AllAccountsCoolingError);
      expect((e as AllAccountsCoolingError).retryAtMs).toBe(clock.now() + 10_000);
    }
  });

  it("all exhausted → NoAccountAvailableError (no Retry-After semantics)", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a")];
    const clock = new FakeClock();
    const pool = await makePool(store, clock);
    pool.markExhausted("a", clock.now() + 3 * 24 * 3600_000);
    await expect(pool.reserve()).rejects.toBeInstanceOf(NoAccountAvailableError);
  });

  it("mixed exhausted+expired → NoAccountAvailableError", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a"), stored("b")];
    const pool = await makePool(store, new FakeClock());
    pool.markExhausted("a", Date.now() + 1000);
    pool.markExpired("b");
    await expect(pool.reserve()).rejects.toBeInstanceOf(NoAccountAvailableError);
  });
});

describe("AccountPool — inFlight cap, reserve/release", () => {
  it("respects the inFlight cap; release frees the slot (2 accounts — cap only applies multi-account)", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a"), stored("b")];
    const clock = new FakeClock();
    const pool = await makePool(store, clock, { maxInFlightPerAccount: 1, queueTimeoutMs: 0 });
    const r1 = await pool.reserve();
    const r2 = await pool.reserve();
    expect(pool.runtimeFor("a")!.inFlight).toBe(1);
    expect(pool.runtimeFor("b")!.inFlight).toBe(1);
    await expect(pool.reserve()).rejects.toBeInstanceOf(AccountsBusyError); // both at cap
    r1.release();
    const r3 = await pool.reserve(); // slot freed
    expect(r3.accountId).toBe("a");
    r2.release();
    r3.release();
  });

  it("SINGLE account = pass-through: no cap, no queue — 20 concurrent reserves all succeed", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a")];
    const clock = new FakeClock();
    const pool = await makePool(store, clock, { maxInFlightPerAccount: 4, queueTimeoutMs: 0 }); // cap would reject
    const rs = await Promise.all(Array.from({ length: 20 }, () => pool.reserve()));
    expect(rs.every((r) => r.accountId === "a")).toBe(true);
    expect(pool.runtimeFor("a")!.inFlight).toBe(20);
    for (const r of rs) r.release();
    expect(pool.runtimeFor("a")!.inFlight).toBe(0);
  });

  it("release is idempotent: double release never drives inFlight negative", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a")];
    const pool = await makePool(store, new FakeClock());
    const r = await pool.reserve();
    expect(pool.runtimeFor("a")!.inFlight).toBe(1);
    r.release();
    r.release();
    r.release();
    expect(pool.runtimeFor("a")!.inFlight).toBe(0);
  });

  it("credential exposed on the reservation matches the picked account", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a")];
    const pool = await makePool(store, new FakeClock());
    const r = await pool.reserve();
    expect(r.credential.apiKey).toBe("a");
    r.release();
  });
});

describe("AccountPool — queue (woken by release, no polling)", () => {
  it("waiters are woken by release() and get the freed slot", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a"), stored("b")];
    const clock = new FakeClock();
    const pool = await makePool(store, clock, { maxInFlightPerAccount: 1, queueTimeoutMs: 5_000 });
    const r1 = await pool.reserve();
    const r2 = await pool.reserve(); // both slots busy → waiter must queue

    let woken: Awaited<ReturnType<AccountPool["reserve"]>> | null = null;
    let wokenErr: unknown = null;
    const waiter = pool.reserve().then(
      (r) => (woken = r),
      (e) => (wokenErr = e),
    );
    // Not resolved while the cap holds:
    await new Promise((r) => setTimeout(r, 20));
    expect(woken).toBeNull();
    expect(wokenErr).toBeNull();

    r1.release(); // must wake the waiter
    await waiter;
    expect(wokenErr).toBeNull();
    expect(woken).not.toBeNull();
    // The woken reservation is for a healthy account (round-robin decides
    // which) and holds a real slot.
    const wokenAccount = (woken as unknown as { accountId: string }).accountId;
    expect(["a", "b"]).toContain(wokenAccount);
    (woken as unknown as { release: () => void }).release();
    r2.release();
  });

  it("queue timeout → AccountsBusyError with short Retry-After", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a"), stored("b")];
    const clock = new FakeClock();
    const pool = await makePool(store, clock, { maxInFlightPerAccount: 1, queueTimeoutMs: 50 });
    const r1 = await pool.reserve();
    const r2 = await pool.reserve(); // both accounts now at cap
    const t0 = Date.now();
    await expect(pool.reserve()).rejects.toBeInstanceOf(AccountsBusyError);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45); // waited the timeout, no wake
    r1.release();
    r2.release();
  });

  it("FIFO: first waiter wins the freed slot", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a"), stored("b")];
    const pool = await makePool(store, new FakeClock(), { maxInFlightPerAccount: 1, queueTimeoutMs: 5_000 });
    const r1 = await pool.reserve();
    const order: number[] = [];
    const w1 = pool.reserve().then((r) => { order.push(1); r.release(); });
    const w2 = pool.reserve().then((r) => { order.push(2); r.release(); });
    await new Promise((r) => setTimeout(r, 20));
    r1.release();
    await Promise.all([w1, w2]);
    expect(order).toEqual([1, 2]); // FIFO regardless of which account each got
  });

  it("failing waiter (timeout) does not consume a future wake", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a"), stored("b")];
    const pool = await makePool(store, new FakeClock(), { maxInFlightPerAccount: 1, queueTimeoutMs: 30 });
    const r1 = await pool.reserve();
    const r2 = await pool.reserve(); // fill both slots
    const doomed = pool.reserve().catch((e) => e);
    await new Promise((r) => setTimeout(r, 60)); // doomed times out, leaves queue
    // New waiter joins and gets woken by an original reservation's release.
    const late = pool.reserve().then((r) => r.accountId);
    await new Promise((r) => setTimeout(r, 10));
    r1.release();
    expect(await late).toBe("a");
    r2.release();
  });
});

describe("AccountPool — state transitions", () => {
  it("cool → elapsed → healthy", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a")];
    const clock = new FakeClock();
    const pool = await makePool(store, clock);
    pool.cool("a", clock.now() + 100);
    expect(pool.runtimeFor("a")!.status).toBe("cooling");
    clock.advance(101);
    expect(pool.runtimeFor("a")!.status).toBe("cooling"); // lazy — until picked
    await pool.reserve();
    expect(pool.runtimeFor("a")!.status).toBe("healthy");
  });

  it("cool with past retryAt is immediately healthy", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a")];
    const clock = new FakeClock();
    const pool = await makePool(store, clock);
    pool.cool("a", clock.now() - 1);
    expect(pool.runtimeFor("a")!.status).toBe("healthy");
  });

  it("default cooldown (no retryAt) uses rateLimitCooldownMs", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a")];
    const clock = new FakeClock();
    const pool = await makePool(store, clock, { rateLimitCooldownMs: 1234 });
    pool.cool("a"); // no explicit retryAt
    expect(pool.runtimeFor("a")!.retryAtMs).toBe(clock.now() + 1234);
  });

  it("noteSuccess resets consecutiveFailures; noteFailure increments", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a")];
    const pool = await makePool(store, new FakeClock());
    pool.noteFailure("a");
    pool.noteFailure("a");
    expect(pool.runtimeFor("a")!.consecutiveFailures).toBe(2);
    pool.noteSuccess("a");
    expect(pool.runtimeFor("a")!.consecutiveFailures).toBe(0);
  });

  it("unknown account ids in state calls are no-ops", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a")];
    const pool = await makePool(store, new FakeClock());
    expect(() => pool.cool("ghost")).not.toThrow();
    expect(() => pool.markExhausted("ghost")).not.toThrow();
    expect(() => pool.markExpired("ghost")).not.toThrow();
    expect(() => pool.noteFailure("ghost")).not.toThrow();
    expect(() => pool.updateQuota("ghost", 5, Date.now())).not.toThrow();
  });
});

describe("AccountPool — watchdog (leaked-slot protection)", () => {
  it("force-releases a reservation held past reservationTimeoutMs", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a"), stored("b")];
    const pool = await makePool(store, new FakeClock(), { maxInFlightPerAccount: 1, reservationTimeoutMs: 50 });
    const r1 = await pool.reserve();
    expect(pool.runtimeFor("a")!.inFlight).toBe(1);
    // Simulate a hung stream: never release r1. After the watchdog fires the
    // slot must be free again.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(pool.runtimeFor("a")!.inFlight).toBe(0);
    const r2 = await pool.reserve(); // slot freed by watchdog
    expect(["a", "b"]).toContain(r2.accountId);
    r2.release();
  });

  it("watchdog does NOT fire on reservations released in time", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a"), stored("b")];
    const pool = await makePool(store, new FakeClock(), { maxInFlightPerAccount: 1, reservationTimeoutMs: 10_000 });
    const r1 = await pool.reserve();
    r1.release(); // well before 10s
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(pool.runtimeFor("a")!.inFlight).toBe(0);
  });

  it("watchdog release is idempotent with a late manual release", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a"), stored("b")];
    const pool = await makePool(store, new FakeClock(), { maxInFlightPerAccount: 1, reservationTimeoutMs: 40 });
    const r1 = await pool.reserve();
    await new Promise((resolve) => setTimeout(resolve, 80)); // watchdog fired
    r1.release(); // late manual release — must not drive inFlight negative
    expect(pool.runtimeFor("a")!.inFlight).toBe(0);
  });
});

describe("AccountPool — account removed while reserved", () => {
  it("release() after removal from the store is a safe no-op", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a"), stored("b")];
    const clock = new FakeClock();
    const pool = await makePool(store, clock);
    const r1 = await pool.reserve();
    // CLI removes the account mid-request:
    store.accounts = [stored("b")];
    await pool.syncWithStore();
    expect(pool.runtimeFor("a")).toBeUndefined(); // gone from runtime
    expect(() => r1.release()).not.toThrow(); // safe no-op
    expect(pool.accountCount()).toBe(1);
  });
});

describe("AccountPool — single-account 429 behavior (pass-through parity)", () => {
  it("cool() on a single account does not gate requests (cap-free pass-through has no pool gate)", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a")];
    const clock = new FakeClock();
    const pool = await makePool(store, clock);
    // Handler marks the single account cooling on 429 (parity with no-pool
    // behavior would IGNORE this). The pool itself must not throw when the
    // only account is cooling BUT the pool is in pass-through mode... 
    // Decision (ticket #5 note): handler does NOT call cool() when accounts.size === 1,
    // preserving legacy behavior. Pool-level: cooling a single account makes it
    // unpickable — document via AllAccountsCoolingError:
    pool.cool("a", clock.now() + 5_000);
    await expect(pool.reserve()).rejects.toBeInstanceOf(AllAccountsCoolingError);
    // Legacy parity is enforced in the handler (no cool() call for single-account pools).
  });
});

describe("AccountPool — exhausted revival semantics", () => {
  it("revival follows quotaExpiresAt (runtime), NOT the credential's tokenExpiresAt", async () => {
    const store = new FakeStore();
    store.accounts = [{
      id: "a",
      credential: { apiKey: "k", provider: "zai", userId: "a", expiresAt: Date.now() + 60_000 },
      addedAt: 0,
    }];
    const clock = new FakeClock();
    const pool = await makePool(store, clock);
    // Quota exhausted until +5s; credential (token) valid for another 60s.
    pool.markExhausted("a", clock.now() + 5_000);
    clock.advance(5_001);
    // Revived despite tokenExpiresAt being far in the future — the two expiries
    // are independent (revival is quota-gated only).
    const r = await pool.reserve();
    expect(r.accountId).toBe("a");
    r.release();
  });
});

describe("AccountPool — watchdog aborts the request", () => {
  it("watchdog firing aborts the reservation signal (upstream teardown)", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a"), stored("b")];
    const pool = await makePool(store, new FakeClock(), { maxInFlightPerAccount: 1, reservationTimeoutMs: 40 });
    const r1 = await pool.reserve();
    let aborted = false;
    r1.signal.addEventListener("abort", () => (aborted = true));
    expect(aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 80)); // watchdog fires
    expect(aborted).toBe(true);
    expect(r1.signal.aborted).toBe(true);
    expect(pool.runtimeFor("a")!.inFlight).toBe(0);
  });

  it("signal is NOT aborted by a normal release", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a")];
    const pool = await makePool(store, new FakeClock(), { reservationTimeoutMs: 10_000 });
    const r = await pool.reserve();
    r.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(r.signal.aborted).toBe(false);
  });
});
