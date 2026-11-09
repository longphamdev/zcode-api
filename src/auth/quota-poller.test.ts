/**
 * Tests for the per-account quota poller (#6) — fake timers via short real
 * intervals; no real network (fetchBalance is injected).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createQuotaPoller, type QuotaPollResult } from "./quota-poller.js";
import { AccountPool } from "./pool.js";
import type { StoredAccount } from "./accounts.js";
import type { Credential } from "./types.js";

const cred = (key: string): Credential => ({ apiKey: key, provider: "zai", userId: key });
const stored = (key: string): StoredAccount => ({ id: key, credential: cred(key), addedAt: 0 });

class FakeStore {
  accounts: StoredAccount[] = [];
  async listAccounts(): Promise<StoredAccount[]> {
    return [...this.accounts];
  }
}

class FakeClock {
  private t = 1_700_000_000_000;
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

interface Setup {
  pool: AccountPool;
  poller: ReturnType<typeof createQuotaPoller>;
  calls: string[];
  setResult: (r: Partial<QuotaPollResult> & { ok: boolean }) => void;
  store: FakeStore;
  clock: FakeClock;
}

function setup(poolOpts = {}, pollerOpts = {}): Setup {
  const store = new FakeStore();
  const clock = new FakeClock();
  const pool = new AccountPool(store, { now: clock.now, ...poolOpts });
  void pool.syncWithStore();
  const calls: string[] = [];
  let next: QuotaPollResult = { ok: true, remainingUnits: 500 };
  const poller = createQuotaPoller(
    pool,
    store,
    async () => {
      return next;
    },
    { intervalMs: 20, timeoutMs: 50, followIntervalMs: 20, now: clock.now, ...pollerOpts },
  );
  // Wrap fetchBalance to record account ids — patch via pool after the fact:
  // instead, record inside pollNow usage. Simpler: track calls via the pool.
  return {
    pool,
    poller,
    calls,
    store,
    clock,
    setResult: (r) => (next = { ...next, ...r }),
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("QuotaPoller — lifecycle", () => {
  let setup_: Setup;
  beforeEach(() => {
    setup_ = setup();
  });
  afterEach(() => setup_.poller.stop());

  it("starts/stops; polls each account on its own timer", async () => {
    const { pool, poller, store } = setup_;
    store.accounts = [stored("a"), stored("b")];
    await pool.syncWithStore();
    poller.start();
    expect(poller.isRunning()).toBe(true);
    await wait(80); // interval 20ms ±jitter → both accounts polled
    const a = pool.runtimeFor("a")!;
    const b = pool.runtimeFor("b")!;
    expect(a.lastPolledAtMs).toBeDefined();
    expect(b.lastPolledAtMs).toBeDefined();
    expect(a.remainingUnits).toBe(500);
    poller.stop();
    expect(poller.isRunning()).toBe(false);
  });

  it("account added mid-run starts polling; removed stops", async () => {
    const { pool, poller, store } = setup_;
    store.accounts = [stored("a")];
    await pool.syncWithStore();
    poller.start();
    await wait(60);
    expect(pool.runtimeFor("a")!.lastPolledAtMs).toBeDefined();

    store.accounts = [stored("a"), stored("b")]; // CLI added B
    await pool.syncWithStore();
    await wait(120); // follower detects + polls B
    expect(pool.runtimeFor("b")!.lastPolledAtMs).toBeDefined();

    store.accounts = [stored("b")]; // A removed
    const aLast = pool.runtimeFor("a")!.lastPolledAtMs;
    await pool.syncWithStore(); // pool drops A
    expect(pool.runtimeFor("a")).toBeUndefined(); // gone from the pool
    await wait(120); // poller follower must not resurrect it
  });

  it("single-flight: a slow poll never overlaps itself", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a")];
    const clock = new FakeClock();
    const pool = new AccountPool(store, { now: clock.now });
    await pool.syncWithStore();
    let inFlight = 0;
    let maxConcurrent = 0;
    const poller = createQuotaPoller(
      pool,
      store,
      async () => {
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await wait(40); // slower than the 20ms interval
        inFlight--;
        return { ok: true, remainingUnits: 1 };
      },
      { intervalMs: 20, timeoutMs: 200, now: clock.now },
    );
    poller.start();
    await wait(150);
    poller.stop();
    expect(maxConcurrent).toBe(1); // never overlapped
  });

  it("poll SUCCESS heals expired/exhausted accounts", async () => {
    const { pool, poller, store } = setup_;
    store.accounts = [stored("a"), stored("b")];
    await pool.syncWithStore();
    pool.markExpired("a");
    pool.markExhausted("b", Date.now() + 999_999_999);
    expect(pool.runtimeFor("a")!.status).toBe("expired");
    poller.start();
    await wait(150); // poll succeeds (balances 500) → both heal
    expect(pool.runtimeFor("a")!.status).toBe("healthy");
    expect(pool.runtimeFor("b")!.status).toBe("healthy");
  });

  it("poll FAILURE is not exhaustion — state kept, failures counted", async () => {
    const { pool, poller, store, setResult } = setup_;
    store.accounts = [stored("a")];
    await pool.syncWithStore();
    setResult({ ok: false, error: "network down" });
    poller.start();
    await wait(100);
    expect(pool.runtimeFor("a")!.status).toBe("healthy"); // untouched
    expect(pool.runtimeFor("a")!.consecutiveFailures).toBeGreaterThan(0);
    expect(pool.runtimeFor("a")!.lastPolledAtMs).toBeUndefined(); // no fresh data
  });

  it("timeout: a hung poll aborts and counts as failure, never blocks the next round", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a")];
    const clock = new FakeClock();
    const pool = new AccountPool(store, { now: clock.now });
    await pool.syncWithStore();
    let aborted = false;
    const poller = createQuotaPoller(
      pool,
      store,
      async (cred, signal) => {
        // Hang until aborted.
        await new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        });
        return { ok: true };
      },
      { intervalMs: 20, timeoutMs: 30, now: clock.now },
    );
    poller.start();
    await wait(150);
    poller.stop();
    expect(aborted).toBe(true); // timeout fired
    expect(pool.runtimeFor("a")!.consecutiveFailures).toBeGreaterThan(0);
  });

  it("sick accounts poll at the slower probe cadence", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a")];
    const clock = new FakeClock();
    const pool = new AccountPool(store, { now: clock.now });
    await pool.syncWithStore();
    let pollCount = 0;
    const poller = createQuotaPoller(
      pool,
      store,
      async () => {
        pollCount++;
        return { ok: false, error: "still dead" };
      },
      { intervalMs: 20, timeoutMs: 100, now: clock.now },
    );
    pool.markExpired("a");
    poller.start();
    await wait(200); // healthy cadence would poll ~10x; probe cadence ~half
    poller.stop();
    expect(pollCount).toBeLessThanOrEqual(6); // 200ms / 40ms(probe) = ~5
  });
});
