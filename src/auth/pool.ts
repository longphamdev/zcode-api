/**
 * AccountPool — runtime lifecycle manager for the multi-account store.
 *
 * Pure module: no imports from server/handler. Time is injectable so tests
 * exercise cooling/queue-timeout/expiry without real sleeps.
 *
 * Responsibilities (per plan v3 + reviews):
 *  - Runtime state machine per account: healthy / cooling / exhausted / expired.
 *    RAM only — never persisted into credentials.json.
 *  - Pick strategy: round-robin over healthy accounts (default), skipping
 *    unhealthy ones, respecting a per-account inFlight cap.
 *  - reserve/release: idempotent release (double release never drives inFlight
 *    negative), safe under concurrent picks.
 *  - Queue: when every account is at cap, callers wait on a promise woken by
 *    release() (no polling); a queue timeout converts the wait into a
 *    TryAllAccountsBusy error with Retry-After.
 *  - All-cooling → CoolDownError carrying min(retryAt) for Retry-After;
 *    all-exhausted/expired → NoAccountAvailableError (no long Retry-After).
 *
 * Store sync: `syncWithStore()` re-reads the account store (hot-reload keyed
 * by mtime+size inside accounts.ts) and adds/removes accounts while keeping
 * the runtime state of surviving accounts.
 */
import { listAccounts, type StoredAccount } from "./accounts.js";
import type { Credential } from "./types.js";

// ---------------------------------------------------------------------------
// Errors surfaced to the proxy layer (handler maps them to HTTP responses)
// ---------------------------------------------------------------------------

/** Every account is cooling (rate-limited) — HTTP 429 + Retry-After. */
export class AllAccountsCoolingError extends Error {
  /** Unix ms when the earliest account becomes available. */
  readonly retryAtMs: number;
  constructor(retryAtMs: number, detail: string) {
    super(detail);
    this.name = "AllAccountsCoolingError";
    this.retryAtMs = retryAtMs;
  }
}

/** Every account is exhausted/expired — HTTP 503, no Retry-After. */
export class NoAccountAvailableError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "NoAccountAvailableError";
  }
}

/** Queue wait exceeded accounts.queueTimeoutMs — HTTP 429, short Retry-After. */
export class AccountsBusyError extends Error {
  readonly retryAfterSec: number;
  constructor(retryAfterSec: number, detail: string) {
    super(detail);
    this.name = "AccountsBusyError";
    this.retryAfterSec = retryAfterSec;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AccountStatus = "healthy" | "cooling" | "exhausted" | "expired";

export interface PoolOptions {
  /**
   * Max concurrent in-flight requests per account. Streams from coding
   * agents (Claude Code) hold a slot for minutes, so this stays generous.
   * Default 4. Config: `accounts.maxInFlightPerAccount`.
   */
  maxInFlightPerAccount?: number;
  /**
   * Queue wait cap when all accounts are at their inFlight cap, in ms.
   * Default 5000. `0` disables queueing (immediate AccountsBusyError).
   * Config: `accounts.queueTimeoutMs`.
   */
  queueTimeoutMs?: number;
  /**
   * Fallback cooling duration for a 429 without Retry-After, in ms.
   * Default 30_000. Config: `accounts.rateLimitCooldownMs`.
   */
  rateLimitCooldownMs?: number;
  /**
   * Reservation watchdog: a reservation held longer than this is force-
   * released with a warning (protects the cap against leaked slots — e.g.
   * a runtime that never delivers body-stream completion events, or a
   * hung upstream). Default 15 minutes. `0` disables.
   * Config: `accounts.reservationTimeoutMs`.
   */
  reservationTimeoutMs?: number;
  /**
   * Injectable clock (Date.now-compatible). Tests freeze/advance time here.
   */
  now?: () => number;
}

export interface AccountRuntime {
  id: string;
  status: AccountStatus;
  /** Unix ms when a cooling account becomes pickable again. */
  retryAtMs?: number;
  /** Unix ms when an exhausted account's quota resets/expires. */
  quotaExpiresAtMs?: number;
  /** From the quota poller (ticket #6); optional pick hint. */
  remainingUnits?: number;
  /** From the poller; freshness marker (stale data never gates picking). */
  lastPolledAtMs?: number;
  inFlight: number;
  /** Consecutive upstream failures without an error class (informational). */
  consecutiveFailures: number;
}

/** A live reservation — release() is idempotent. */
export interface Reservation {
  readonly accountId: string;
  readonly credential: Credential;
  /** Idempotent: safe to call from both `finally` and response close. */
  release(): void;
}

/** Which pick strategy to use. */
export type PickStrategy = "round-robin" | "most-remaining-quota";

interface QueueWaiter {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout> | null;
}

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

export class AccountPool {
  private readonly maxInFlight: number;
  private readonly queueTimeoutMs: number;
  private readonly rateLimitCooldownMs: number;
  private readonly reservationTimeoutMs: number;
  private readonly now: () => number;

  private accounts = new Map<string, StoredAccount>();
  private runtime = new Map<string, AccountRuntime>();
  private strategy: PickStrategy = "round-robin";
  private rrCursor = 0;
  private queue: QueueWaiter[] = [];

  constructor(private store: { listAccounts(): Promise<StoredAccount[]> }, opts: PoolOptions = {}) {
    this.maxInFlight = opts.maxInFlightPerAccount ?? 4;
    this.queueTimeoutMs = opts.queueTimeoutMs ?? 5_000;
    this.rateLimitCooldownMs = opts.rateLimitCooldownMs ?? 30_000;
    this.reservationTimeoutMs = opts.reservationTimeoutMs ?? 15 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** Load accounts from the store. Runtime state of surviving ids is kept. */
  async syncWithStore(): Promise<void> {
    const stored = await this.store.listAccounts();
    const nextIds = new Set(stored.map((a) => a.id));
    this.accounts = new Map(stored.map((a) => [a.id, a]));
    for (const id of nextIds) {
      if (!this.runtime.has(id)) {
        this.runtime.set(id, {
          id,
          status: "healthy",
          inFlight: 0,
          consecutiveFailures: 0,
        });
      }
    }
    for (const id of [...this.runtime.keys()]) {
      if (!nextIds.has(id)) this.runtime.delete(id); // removed from store
    }
  }

  setStrategy(strategy: PickStrategy): void {
    this.strategy = strategy;
  }

  /** Snapshot for tests / `auth list` / `/quota`. */
  snapshot(): AccountRuntime[] {
    return [...this.runtime.values()].map((r) => ({ ...r }));
  }

  accountCount(): number {
    return this.accounts.size;
  }

  // -- state transitions ----------------------------------------------------

  /** Rate-limited: cool until `retryAtMs` (absolute unix ms). */
  cool(accountId: string, retryAtMs?: number): void {
    const r = this.runtime.get(accountId);
    if (!r) return;
    const until = retryAtMs ?? this.now() + this.rateLimitCooldownMs;
    if (until <= this.now()) {
      // Expired cooldown → healthy again.
      r.status = "healthy";
      r.retryAtMs = undefined;
    } else {
      r.status = "cooling";
      r.retryAtMs = until;
    }
  }

  /** Quota gone: exhausted until quotaExpiresAtMs (absolute unix ms). */
  markExhausted(accountId: string, quotaExpiresAtMs?: number): void {
    const r = this.runtime.get(accountId);
    if (!r) return;
    r.status = "exhausted";
    r.retryAtMs = undefined;
    if (quotaExpiresAtMs !== undefined) r.quotaExpiresAtMs = quotaExpiresAtMs;
  }

  /** Auth dead (refresh confirmed invalid upstream) — not pickable. */
  markExpired(accountId: string): void {
    const r = this.runtime.get(accountId);
    if (!r) return;
    r.status = "expired";
    r.retryAtMs = undefined;
  }

  /** Feed poller data (ticket #6). Does not gate picking on staleness. */
  updateQuota(accountId: string, remainingUnits: number | undefined, polledAtMs: number): void {
    const r = this.runtime.get(accountId);
    if (!r) return;
    r.lastPolledAtMs = polledAtMs;
    if (remainingUnits !== undefined) r.remainingUnits = remainingUnits;
  }

  /** Note a failure that does not classify (informational counter). */
  noteFailure(accountId: string): void {
    const r = this.runtime.get(accountId);
    if (r) r.consecutiveFailures++;
  }

  /** A healthy response resets the consecutive-failure counter. */
  noteSuccess(accountId: string): void {
    const r = this.runtime.get(accountId);
    if (r) r.consecutiveFailures = 0;
  }

  // -- picking ----------------------------------------------------------------

  /** Accounts that are pickable right now (healthy, under the cap). */
  private pickable(cap: number = this.maxInFlight): string[] {
    const t = this.now();
    const out: string[] = [];
    for (const [id, r] of this.runtime) {
      if (r.status === "cooling" && r.retryAtMs !== undefined && r.retryAtMs <= t) {
        r.status = "healthy"; // cooldown elapsed — lazily revive
        r.retryAtMs = undefined;
      }
      if (r.status === "exhausted" && r.quotaExpiresAtMs !== undefined && r.quotaExpiresAtMs <= t) {
        r.status = "healthy"; // quota window over — lazily revive
        r.quotaExpiresAtMs = undefined;
      }
      if (r.status === "healthy" && r.inFlight < cap) out.push(id);
    }
    return out;
  }

  /**
   * Reserve the next account for a request. Throws (do NOT wait) when the
   * pool cannot serve immediately and queueing is disabled or impossible.
   *
   * Pass-through mode: when the store holds exactly ONE account, no inflight
   * cap and no queue are applied — behavior matches the pre-pool proxy
   * exactly (a coding agent runs many subagent requests concurrently).
   *
   * `signal`: abort while queued removes the waiter (no leaked slot later);
   * an already-aborted signal rejects immediately.
   */
  async reserve(opts: { queueTimeoutMs?: number; signal?: AbortSignal } = {}): Promise<Reservation> {
    if (opts.signal?.aborted) {
      throw new AccountsBusyError(1, "request already aborted");
    }
    const singleAccount = this.accounts.size === 1;
    const id = this.pickImmediate(singleAccount ? Number.MAX_SAFE_INTEGER : undefined);
    if (id) return this.makeReservation(id);

    // Nothing immediate. Distinguish the three failure shapes first.
    this.throwForPoolState();

    // Queue up (unless queueing disabled).
    const timeoutMs = opts.queueTimeoutMs ?? this.queueTimeoutMs;
    if (timeoutMs <= 0) {
      throw new AccountsBusyError(1, "all accounts at in-flight cap (queueing disabled)");
    }
    await this.enqueueWait(timeoutMs, opts.signal);
    // Woken by a release() (or timeout-throw above). Try again.
    const retryId = this.pickImmediate(singleAccount ? Number.MAX_SAFE_INTEGER : undefined);
    if (retryId) return this.makeReservation(retryId);
    this.throwForPoolState();
    // release() woke us but another waiter took the slot — one more queued
    // wait would loop; surface busy honestly instead.
    throw new AccountsBusyError(1, "all accounts still busy after queue wake");
  }

  private pickImmediate(capOverride?: number): string | null {
    const cap = capOverride ?? this.maxInFlight;
    const ids = this.pickable(cap);
    if (ids.length === 0) return null;
    let picked: string;
    if (this.strategy === "most-remaining-quota") {
      picked = ids.reduce((best, id) => {
        const rb = this.runtime.get(best)!.remainingUnits ?? -1;
        const rc = this.runtime.get(id)!.remainingUnits ?? -1;
        return rc > rb ? id : best;
      }, ids[0]);
    } else {
      // Round-robin on pick order (insertion order of the runtime map), not a
      // re-sorted id list: re-sorting would hand the revived account the next
      // slot only when it sorts earliest, breaking even distribution across
      // mixed pickable sets. Insertion order is stable per syncWithStore.
      const idx = this.rrCursor % ids.length;
      this.rrCursor = (this.rrCursor + 1) % Number.MAX_SAFE_INTEGER;
      picked = ids[idx];
    }
    return picked;
  }

  private throwForPoolState(): void {
    const t = this.now();
    let anyCooling = false;
    let minRetryAt = Number.POSITIVE_INFINITY;
    let anyPickableStatus = false;
    for (const r of this.runtime.values()) {
      if (r.status === "cooling") {
        anyCooling = true;
        if (r.retryAtMs !== undefined) minRetryAt = Math.min(minRetryAt, r.retryAtMs);
      }
      if (r.status === "exhausted" || r.status === "expired") anyPickableStatus = true;
    }
    void t;
    if (anyCooling) {
      throw new AllAccountsCoolingError(
        minRetryAt,
        "all accounts are rate-limited (cooling)",
      );
    }
    if (anyPickableStatus) {
      throw new NoAccountAvailableError(
        "all accounts are exhausted or expired; no quota available",
      );
    }
    // Only remaining reason: inFlight caps. Handled by the queue path.
  }

  private makeReservation(accountId: string): Reservation {
    const r = this.runtime.get(accountId)!;
    r.inFlight++;
    let released = false;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const doRelease = () => {
      if (released) return; // idempotent
      released = true;
      if (watchdog) clearTimeout(watchdog);
      r.inFlight = Math.max(0, r.inFlight - 1);
      this.wakeNext();
    };
    if (this.reservationTimeoutMs > 0) {
      // Watchdog: a reservation that outlives the cap is force-released with
      // a warning. Real timer (operational lifetime, not injectable-clock
      // territory): tests use short timeouts.
      watchdog = setTimeout(() => {
        if (released) return;
        console.warn(`pool: reservation watchdog force-released account=${accountId} after ${Math.round(this.reservationTimeoutMs / 1000)}s (leaked slot suspected — hung stream or missing release path)`);
        doRelease();
      }, this.reservationTimeoutMs);
      watchdog.unref?.();
    }
    return {
      accountId,
      credential: this.accounts.get(accountId)!.credential,
      release: doRelease,
    };
  }

  /** Wake exactly one queued waiter (FIFO) — called from release(). */
  private wakeNext(): void {
    const waiter = this.queue.shift();
    if (waiter) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  private enqueueWait(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const waiter: QueueWaiter = { resolve, timer: null };
      const cleanup = (err: Error) => {
        const i = this.queue.indexOf(waiter);
        if (i >= 0) this.queue.splice(i, 1); // aborted → never woken, never leaks a slot
        if (waiter.timer) clearTimeout(waiter.timer);
        reject(err);
      };
      waiter.timer = setTimeout(() => {
        cleanup(new AccountsBusyError(1, `queue wait exceeded ${timeoutMs}ms`));
      }, timeoutMs);
      if (signal) {
        if (signal.aborted) {
          cleanup(new AccountsBusyError(1, "request aborted while queued"));
          return;
        }
        signal.addEventListener("abort", () => cleanup(new AccountsBusyError(1, "request aborted while queued")), { once: true });
      }
      this.queue.push(waiter);
    });
  }

  /**
   * Immediate non-async check for tests/diagnostics: is any account
   * pickable right now? (Single-account pools are always pickable unless
   * unhealthy — pass-through mode has no cap.)
   */
  hasPickable(): boolean {
    return this.pickable(this.accounts.size === 1 ? Number.MAX_SAFE_INTEGER : undefined).length > 0;
  }

  /** Test/ops helper: a reservation's runtime entry. */
  runtimeFor(accountId: string): AccountRuntime | undefined {
    const r = this.runtime.get(accountId);
    return r ? { ...r } : undefined;
  }
}

/** Convenience: pool bound to the real store with default options. */
export function createAccountPool(opts: PoolOptions = {}): AccountPool {
  return new AccountPool({ listAccounts }, opts);
}
