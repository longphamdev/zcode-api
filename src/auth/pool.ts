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

/** Internal cooling clamp — a weird upstream Retry-After (days) must not lock
 *  an account out of rotation for that long. Client sees the verbatim header. */
const MAX_COOLING_MS = 6 * 60 * 60_000;

export interface PoolOptions {
  /**
   * Max concurrent in-flight requests per account. Free-tier accounts 429
   * with ~3 concurrent streams (live data, #7) — default 2 lets the queue
   * absorb bursts instead of feeding the upstream limit. Config:
   * `accounts.maxInFlightPerAccount`.
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
   * Half-open delay for expired (401-marked) accounts, in ms. After this,
   * one probe request is allowed; 401 re-arms, 2xx heals. Default 10 min.
   * Config: `accounts.expiredHalfOpenMs`. `0` makes the probe immediate.
   */
  expiredHalfOpenMs?: number;
  /**
   * Half-open delay for exhausted accounts with an UNKNOWN quota reset time
   * (biz-1005 mid-request). Default 30 min. Accounts with a known reset
   * (from the poller) revive at that time instead.
   */
  exhaustedHalfOpenMs?: number;
  /**
   * Window (ms) for the global-401 detector: >= 2 distinct accounts 401ing
   * within this window is treated as an upstream-wide incident. Default 30s.
   */
  global401WindowMs?: number;
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
  /** Aggregate remaining across models — DISPLAY ONLY (buckets are per-model). */
  remainingUnits?: number;
  /** Per-model buckets from the poller — the real quota shape (#7). */
  models?: Array<{ model: string; remainingUnits?: number; totalUnits?: number; expiresAtMs?: number }>;
  /** True when the 0 reading conflicts with observed successful traffic
   *  (billing balance can under-report — live finding, #7). */
  remainingUnreliable?: boolean;
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
  /**
   * Aborts when the watchdog force-releases this reservation (or manually
   * via `abortReservation`). Handlers should thread `signal` into the
   * upstream dispatch so a watchdog firing also tears down the hung request
   * — releasing the slot alone would let the request keep running with
   * real concurrency above the cap.
   */
  readonly signal: AbortSignal;
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
  private readonly expiredHalfOpenMs: number;
  private readonly exhaustedHalfOpenMs: number;
  private readonly global401WindowMs: number;
  private readonly now: () => number;
  /** Recent 401 timestamps per account — the global-outage detector. */
  private recent401s: Array<{ id: string; at: number }> = [];
  /** Recent 429 timestamps per account — the global-rate-limit detector. */
  private recent429s: Array<{ id: string; at: number }> = [];
  /** Last successful request per account (ground truth vs balance polls). */
  private lastSuccessAtMs = new Map<string, number>();

  private accounts = new Map<string, StoredAccount>();
  private runtime = new Map<string, AccountRuntime>();
  private strategy: PickStrategy = "round-robin";
  private rrCursor = 0;
  private queue: QueueWaiter[] = [];
  private lastSyncAtMs = 0;
  private syncing: Promise<void> | null = null;
  private credentialsAtLastSync = new Map<string, Credential>();

  constructor(private store: { listAccounts(): Promise<StoredAccount[]> }, opts: PoolOptions = {}) {
    this.maxInFlight = opts.maxInFlightPerAccount ?? 2;
    this.queueTimeoutMs = opts.queueTimeoutMs ?? 5_000;
    this.rateLimitCooldownMs = opts.rateLimitCooldownMs ?? 30_000;
    this.reservationTimeoutMs = opts.reservationTimeoutMs ?? 15 * 60_000;
    this.expiredHalfOpenMs = opts.expiredHalfOpenMs ?? 10 * 60_000;
    this.exhaustedHalfOpenMs = opts.exhaustedHalfOpenMs ?? 30 * 60_000;
    this.global401WindowMs = opts.global401WindowMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Sync when the cache is older than `maxAgeMs` (default 1000ms). Runs at
   * most once concurrently (single-flight): a burst of reserves triggers one
   * store read, everyone awaits the same promise. Keeps re-login credentials
   * fresh without waiting on the server's 5s sync timer.
   */
  async syncIfStale(maxAgeMs = 1_000): Promise<void> {
    if (this.now() - this.lastSyncAtMs < maxAgeMs) return;
    if (this.syncing) return this.syncing;
    this.syncing = this.syncWithStore().finally(() => {
      this.lastSyncAtMs = this.now();
      this.syncing = null;
    });
    return this.syncing;
  }

  /** Load accounts from the store. Runtime state of surviving ids is kept. */
  async syncWithStore(): Promise<void> {
    const stored = await this.store.listAccounts();
    const nextIds = new Set(stored.map((a) => a.id));
    this.accounts = new Map(stored.map((a) => [a.id, a]));
    for (const id of nextIds) {
      const existingRuntime = this.runtime.get(id);
      const existingCred = this.accounts.get(id)!.credential;
      const prevCred = this.credentialsAtLastSync.get(id);
      const credentialChanged =
        prevCred !== undefined &&
        (prevCred.apiKey !== existingCred.apiKey ||
          prevCred.secret !== existingCred.secret ||
          prevCred.jwt !== existingCred.jwt);
      if (credentialChanged && existingRuntime && existingRuntime.status !== "healthy" && existingRuntime.inFlight === 0) {
        this.logTransition(id, existingRuntime.status, "healthy", "credential changed (re-login)");
        // A re-login replaced the credential for a sick account — reset its
        // runtime state so it rejoins the pool (expired/cooling/exhausted
        // referred to the OLD credential).
        this.runtime.set(id, { id, status: "healthy", inFlight: 0, consecutiveFailures: 0 });
        continue;
      }
      if (!existingRuntime) {
        this.runtime.set(id, {
          id,
          status: "healthy",
          inFlight: 0,
          consecutiveFailures: 0,
        });
      }
    }
    this.credentialsAtLastSync = new Map([...this.accounts].map(([id, a]) => [id, a.credential]));
    for (const id of [...this.runtime.keys()]) {
      if (!nextIds.has(id)) this.runtime.delete(id); // removed from store
    }
    this.lastSyncAtMs = this.now();
  }

  setStrategy(strategy: PickStrategy): void {
    this.strategy = strategy;
  }

  /** Snapshot for tests / `auth list` / `/quota`. */
  snapshot(): AccountRuntime[] {
    return [...this.runtime.values()].map((r) => ({ ...r }));
  }

  /** Account labels (safe to surface in error messages — never credentials). */
  labels(): Array<{ id: string; label?: string }> {
    return [...this.accounts.values()].map((a) => ({ id: a.id, ...(a.label ? { label: a.label } : {}) }));
  }

  accountCount(): number {
    return this.accounts.size;
  }

  /**
   * Accounts that can serve traffic now or soon: healthy or cooling.
   * Exhausted/expired are dead until a probe/poller proves otherwise —
   * they must not count toward multi-account decisions (global guards,
   * single-acc pass-through parity). With a 2-acc pool where one is dead,
   * the live account behaves as single-acc.
   */
  usableCount(): number {
    const t = this.now();
    let n = 0;
    for (const r of this.runtime.values()) {
      if (r.status === "healthy" || r.status === "cooling") {
        // A cooling account whose deadline passed is effectively usable.
        if (r.status === "cooling" && r.retryAtMs !== undefined && r.retryAtMs > t) continue;
        n++;
      }
    }
    return n;
  }

  // -- state transitions ----------------------------------------------------

  /**
   * Grep-able state transition log (#8 watchlist metric 2): one line per
   * transition, `account=<id> from=<x> to=<y> reason=<z>` — count with
   * `grep -c "from=healthy to=exhausted"` etc. No credential material.
   */
  private logTransition(accountId: string, from: AccountStatus, to: AccountStatus, reason: string): void {
    if (from === to) return;
    console.log(`pool: account=${accountId} from=${from} to=${to} reason=${reason}`);
  }

  /**
   * Rate-limited from an upstream `Retry-After` in SECONDS — the deadline is
   * computed with the pool's own clock (handlers must not mix Date.now()
   * with an injectable pool clock).
   */
  coolForSeconds(accountId: string, retryAfterSec?: number): void {
    const until = retryAfterSec !== undefined && Number.isFinite(retryAfterSec)
      ? this.now() + retryAfterSec * 1000
      : undefined;
    this.cool(accountId, until);
  }

  /**
   * Rate-limited: cool until `retryAtMs` (absolute unix ms).
   *
   * Precedence rule: `exhausted`/`expired` OUTRANK `cooling`. A half-open
   * probe (or any stray 429 on a dead account) must not downgrade a terminal
   * state to cooling — that would resurrect the account early and burn the
   * same failure (e.g. biz-1005) on every subsequent request. Exhausted
   * accounts revive only via their own deadline, the poller, or a
   * credential change.
   */
  cool(accountId: string, retryAtMs?: number): void {
    const r = this.runtime.get(accountId);
    if (!r) return;
    if (r.status === "exhausted" || r.status === "expired") return; // terminal outranks cooling
    const from = r.status;
    let until = retryAtMs ?? this.now() + this.rateLimitCooldownMs;
    // Clamp: a weird upstream Retry-After (days) must not lock an account out
    // of rotation for that long. The client still sees the verbatim header —
    // this clamp bounds only the POOL's internal cooling.
    const maxCooling = this.now() + MAX_COOLING_MS;
    if (until > maxCooling) until = maxCooling;
    if (until <= this.now()) {
      // Expired cooldown → healthy again.
      this.logTransition(accountId, from, "healthy", "cooling elapsed");
      r.status = "healthy";
      r.retryAtMs = undefined;
    } else {
      this.logTransition(accountId, from, "cooling", "upstream 429");
      r.status = "cooling";
      r.retryAtMs = until;
    }
  }

  /**
   * Quota gone: exhausted until `quotaExpiresAtMs` (absolute unix ms, from
   * the poller). When the reset time is unknown (e.g. biz-1005 mid-request),
   * arm the half-open delay instead — one probe after
   * `exhaustedHalfOpenMs` (default 30 min), mirroring `markExpired`, so the
   * account cannot stay stuck when no poller is running.
   */
  markExhausted(accountId: string, quotaExpiresAtMs?: number): void {
    const r = this.runtime.get(accountId);
    if (!r) return;
    this.logTransition(accountId, r.status, "exhausted", quotaExpiresAtMs !== undefined ? "quota reset known" : "biz-1005");
    r.status = "exhausted";
    r.retryAtMs = undefined;
    if (quotaExpiresAtMs !== undefined) {
      r.quotaExpiresAtMs = quotaExpiresAtMs;
    } else {
      r.quotaExpiresAtMs = this.now() + this.exhaustedHalfOpenMs;
    }
  }

  /**
   * Auth rejected upstream (401, account-level). Not pickable until the
   * half-open delay elapses — then one probe request is allowed (see
   * `pickable`). Because this system's JWTs carry no `exp`, `expired` can
   * also mean a transient upstream auth incident; half-open bounds that
   * blast radius.
   */
  markExpired(accountId: string, halfOpenDelayMs?: number): void {
    const r = this.runtime.get(accountId);
    if (!r) return;
    this.logTransition(accountId, r.status, "expired", "upstream 401");
    r.status = "expired";
    r.retryAtMs = this.now() + (halfOpenDelayMs ?? this.expiredHalfOpenMs);
  }

  /**
   * Record a 401 for `accountId` at `atMs` and prune the window. When many
   * DISTINCT accounts get 401 within `global401WindowMs`, the outage is
   * almost certainly upstream-wide (gateway/auth incident) — callers should
   * stop marking accounts expired and surface the error instead.
   */
  note401(accountId: string, atMs?: number): void {
    const at = atMs ?? this.now();
    this.recent401s.push({ id: accountId, at });
    this.recent401s = this.recent401s.filter((e) => at - e.at < this.global401WindowMs);
  }

  /** True when >= 2 distinct accounts saw a 401 inside the recent window. */
  isGlobal401(): boolean {
    const cutoff = this.now() - this.global401WindowMs;
    const distinct = new Set(this.recent401s.filter((e) => e.at >= cutoff).map((e) => e.id));
    return distinct.size >= 2;
  }

  /**
   * Escape hatch for the global-401 guard: if the guard has now suppressed
   * marking for `global401SuppressLimit` consecutive window-fills AND the
   * same accounts keep 401ing, the outage is probably real per-account death
   * (every credential revoked) — callers may mark expired again. Implemented
   * as: guard applies while the evidence window keeps rolling with the SAME
   * accounts; once total 401 events exceed distinct accounts x 3 (i.e.
   * repeated rejections), stop suppressing.
   */
  shouldSuppressExpiredMarking(): boolean {
    const cutoff = this.now() - this.global401WindowMs;
    const recent = this.recent401s.filter((e) => e.at >= cutoff);
    const distinct = new Set(recent.map((e) => e.id)).size;
    if (distinct < 2) return false; // not global — mark normally
    // Guard limits: suppress only the first burst (each account ~1 rejection);
    // more than one rejection per account within the window means the accounts
    // keep getting rejected across retries — real per-account death.
    return recent.length <= distinct;
  }

  /**
   * Cool EVERY healthy/cooling account until `untilMs` — the global-429
   * response. Requests arriving during a pool cooldown get
   * AllAccountsCoolingError with Retry-After = time remaining.
   */
  /** coolAll with a Retry-After in SECONDS (pool-clock deadline). */
  coolAllForSeconds(retryAfterSec: number): void {
    this.coolAll(this.now() + retryAfterSec * 1000);
  }

  coolAll(untilMs: number): void {
    for (const r of this.runtime.values()) {
      if (r.status === "healthy" || r.status === "cooling") {
        r.status = "cooling";
        r.retryAtMs = Math.max(r.retryAtMs ?? 0, untilMs);
      }
    }
  }

  /** Record a 429 for `accountId` (global-rate-limit evidence window). */
  note429(accountId: string, atMs?: number): void {
    const at = atMs ?? this.now();
    this.recent429s.push({ id: accountId, at });
    this.recent429s = this.recent429s.filter((e) => at - e.at < this.global401WindowMs);
  }

  /** True when >= 2 distinct accounts saw a 429 inside the recent window. */
  isGlobal429(): boolean {
    const cutoff = this.now() - this.global401WindowMs;
    const distinct = new Set(this.recent429s.filter((e) => e.at >= cutoff).map((e) => e.id));
    return distinct.size >= 2;
  }

  /** Feed poller data (#6). Does not gate picking on staleness. */
  updateQuota(
    accountId: string,
    remainingUnits: number | undefined,
    polledAtMs: number,
    models?: Array<{ model: string; remainingUnits?: number; totalUnits?: number; expiresAtMs?: number }>,
  ): void {
    const r = this.runtime.get(accountId);
    if (!r) return;
    r.lastPolledAtMs = polledAtMs;
    if (models !== undefined) r.models = models;
    if (remainingUnits !== undefined) {
      r.remainingUnits = remainingUnits;
      // A 0 reading from an account with a recent successful request is kept
      // but flagged unreliable (billing balance can under-report claimed-plan
      // entitlements — live finding #7). Without the flag,
      // most-remaining-quota would penalize a working account between polls
      // (the flapping the review called out). A NON-ZERO reading clears the
      // flag — it proves the endpoint now reports real numbers.
      if (remainingUnits === 0) {
        const lastSuccess = this.lastSuccessAtMs.get(accountId);
        r.remainingUnreliable =
          lastSuccess !== undefined && polledAtMs - lastSuccess < 30 * 60_000
            ? true
            : undefined;
      } else {
        r.remainingUnreliable = undefined;
      }
    }
  }

  /** Poller reports the account's entitlement expiry (quotaExpiresAt). */
  setQuotaExpiry(accountId: string, expiresAtMs: number): void {
    const r = this.runtime.get(accountId);
    if (!r) return;
    r.quotaExpiresAtMs = expiresAtMs;
  }

  /** Note a failure that does not classify (informational counter). */
  noteFailure(accountId: string): void {
    const r = this.runtime.get(accountId);
    if (r) r.consecutiveFailures++;
  }

  /** A healthy response resets the consecutive-failure counter and heals a
   *  half-open probe / poller success (the credential works again).
   *
   *  Ground truth rule: the REQUEST response outranks the balance poll. A
   *  successful request invalidates a stale "0 remaining" reading (observed
   *  live: the billing balance can report 0 for an account that serves
   *  traffic fine — the claimed-plan entitlement does not surface there).
   */
  noteSuccess(accountId: string): void {
    this.lastSuccessAtMs.set(accountId, this.now());
    const r = this.runtime.get(accountId);
    if (r) {
      r.consecutiveFailures = 0;
      if (r.remainingUnits === 0) {
        // Stale 0 cleared AND flagged: the next poll may report 0 again, and
        // the flag keeps most-remaining-quota from penalizing a working acc.
        r.remainingUnits = undefined;
        r.remainingUnreliable = true;
      }
      if (r.status === "expired" || r.status === "exhausted") {
        // Healed: a successful authenticated interaction proves the
        // credential works and quota exists.
        this.logTransition(accountId, r.status, "healthy", "request succeeded");
        r.status = "healthy";
        r.retryAtMs = undefined;
        r.quotaExpiresAtMs = undefined;
      } else {
        r.retryAtMs = undefined;
      }
    }
  }

  // -- picking ----------------------------------------------------------------

  /** Accounts that are pickable right now (healthy, under the cap). */
  private pickable(cap: number = this.maxInFlight): string[] {
    const t = this.now();
    const out: string[] = [];
    for (const [id, r] of this.runtime) {
      if (r.status === "cooling" && r.retryAtMs !== undefined && r.retryAtMs <= t) {
        this.logTransition(id, "cooling", "healthy", "cooldown elapsed");
        r.status = "healthy"; // cooldown elapsed — lazily revive
        r.retryAtMs = undefined;
      }
      if (r.status === "exhausted" && r.quotaExpiresAtMs !== undefined && r.quotaExpiresAtMs <= t) {
        this.logTransition(id, "exhausted", "healthy", "quota window elapsed");
        r.status = "healthy"; // quota window (or half-open probe) elapsed — revive
        r.quotaExpiresAtMs = undefined;
      }
      // Half-open: an expired account (401-marked) gets one probe request
      // after the half-open delay. A 401 re-arms the delay; a 2xx returns
      // it to healthy. JWTs have no exp in this system, so "expired" can
      // also mean a transient upstream auth incident — without half-open a
      // single flapped 401 would lock the account until a manual re-login.
      if (r.status === "expired") {
        const halfOpenAt = r.retryAtMs ?? 0;
        if (t >= halfOpenAt && r.inFlight === 0) {
          this.logTransition(id, "expired", "healthy", "half-open probe");
          r.status = "healthy"; // probe — noteSuccess/markExpired will settle it
          r.retryAtMs = undefined;
        } else {
          continue;
        }
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
  async reserve(opts: { queueTimeoutMs?: number; signal?: AbortSignal; exclude?: ReadonlySet<string> } = {}): Promise<Reservation> {
    if (opts.signal?.aborted) {
      throw new AccountsBusyError(1, "request already aborted");
    }
    // Freshness: a credential re-login (CLI, another process) lands in the
    // store via lockfile; pick from a store read at most 1s old.
    await this.syncIfStale();
    const singleAccount = this.accounts.size === 1;
    const id = this.pickImmediate(singleAccount ? Number.MAX_SAFE_INTEGER : undefined, opts.exclude);
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
    const retryId = this.pickImmediate(singleAccount ? Number.MAX_SAFE_INTEGER : undefined, opts.exclude);
    if (retryId) return this.makeReservation(retryId);
    this.throwForPoolState();
    // release() woke us but another waiter took the slot — one more queued
    // wait would loop; surface busy honestly instead.
    throw new AccountsBusyError(1, "all accounts still busy after queue wake");
  }

  private pickImmediate(capOverride?: number, exclude?: ReadonlySet<string>): string | null {
    const cap = capOverride ?? this.maxInFlight;
    const ids = this.pickable(cap).filter((id) => !exclude?.has(id));
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
    const controller = new AbortController();
    const doRelease = () => {
      if (released) return; // idempotent
      released = true;
      if (watchdog) clearTimeout(watchdog);
      r.inFlight = Math.max(0, r.inFlight - 1);
      this.wakeNext();
    };
    if (this.reservationTimeoutMs > 0) {
      // Watchdog: a reservation that outlives the cap is force-released with
      // a warning AND an abort — releasing the slot alone would leave the
      // upstream request running with real concurrency above the cap. Real
      // timer (operational lifetime, not injectable-clock territory).
      watchdog = setTimeout(() => {
        if (released) return;
        const heldSec = Math.round(this.reservationTimeoutMs / 1000);
        console.warn(`pool: reservation watchdog force-released account=${accountId} held=${heldSec}s (leaked slot suspected — hung stream or missing release path); aborting request`);
        try { controller.abort(new Error(`reservation watchdog fired after ${heldSec}s (account=${accountId})`)); } catch {}
        doRelease();
      }, this.reservationTimeoutMs);
      watchdog.unref?.();
    }
    return {
      accountId,
      credential: this.accounts.get(accountId)!.credential,
      release: doRelease,
      signal: controller.signal,
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
