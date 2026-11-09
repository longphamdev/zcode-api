/**
 * Per-account quota poller (#6).
 *
 * Reads each account's billing balance (start-plan plane) on a jittered
 * interval and feeds results into the AccountPool:
 *  - remainingUnits / quotaExpiresAt / lastPolledAt (runtime freshness)
 *  - poll SUCCESS with balances > 0 heals `expired`/`exhausted` accounts
 *    (the poller is the primary probe — a successful authenticated poll
 *    proves the JWT works)
 *  - poll FAILURE is NOT exhaustion: network/5xx keeps the account's state
 *    and only bumps consecutiveFailures (via pool.noteFailure)
 *
 * Operational properties (review requirements):
 *  - single-flight per account (never two polls for one account at once)
 *  - jitter (accounts don't poll in lockstep)
 *  - its own timeout (a hung poll never blocks the next round)
 *  - holds NO reservation slot (it reads credentials directly from the store)
 *  - follows store changes: accounts added via syncWithStore start polling,
 *    removed accounts stop (their timers cleared)
 *  - accounts in `expired`/`exhausted` state are polled at a slower cadence
 *    (probe cadence — don't hammer a JWT that upstream just rejected)
 */
import type { AccountPool } from "./pool.js";
import type { StoredAccount } from "./accounts.js";

export interface PollerOptions {
  /** Base poll interval (ms). Default 5 min. Jitter: ±20%. */
  intervalMs?: number;
  /** Per-poll timeout (ms). Default 10s. */
  timeoutMs?: number;
  /** Store-follow interval (ms) — detects CLI-added/removed accounts. Default 10s. */
  followIntervalMs?: number;
  /** Injectable clock. */
  now?: () => number;
}

/** One model bucket from the billing balance (per-model — buckets are never
 *  summed across models: GLM-5.3 and GLM-5.3-Flash are separate grants). */
export interface ModelQuota {
  /** Capability matcher from upstream, e.g. "model:glm-5.3-flash". */
  model: string;
  totalUnits?: number;
  usedUnits?: number;
  remainingUnits?: number;
  /** Bucket expiry (unix ms) — daily grants reset here. */
  expiresAtMs?: number;
}

/** One account's billing-balance snapshot. */
export interface QuotaPollResult {
  ok: boolean;
  /** Aggregate across models — display only; strategy uses per-model. */
  remainingUnits?: number;
  /** Earliest bucket expiry (unix ms) — the daily reset deadline. */
  quotaExpiresAtMs?: number;
  /** Per-model buckets (the real shape — never sum these for decisions). */
  models?: ModelQuota[];
  error?: string;
  lastPolledAtMs?: number;
}

export interface QuotaPoller {
  start(): void;
  stop(): void;
  /** Poll one account right now (used by tests and manual refresh). */
  pollNow(accountId: string): Promise<QuotaPollResult>;
  /** Manual snapshot for tests. */
  isRunning(): boolean;
}

interface PollState {
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
}

export function createQuotaPoller(
  pool: AccountPool,
  store: { listAccounts(): Promise<StoredAccount[]> },
  fetchBalance: (cred: StoredAccount["credential"], signal: AbortSignal) => Promise<QuotaPollResult>,
  opts: PollerOptions = {},
): QuotaPoller {
  const intervalMs = opts.intervalMs ?? 5 * 60_000;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const followIntervalMs = opts.followIntervalMs ?? 10_000;
  const now = opts.now ?? Date.now;
  const states = new Map<string, PollState>();
  let running = false;

  const jitter = (): number => {
    // ±20% around intervalMs — accounts never poll in lockstep.
    const spread = intervalMs * 0.2;
    return intervalMs - spread + Math.random() * spread * 2;
  };

  const PROBE_INTERVAL_MS = intervalMs * 2; // sick accounts poll half as often

  const pollAccount = async (accountId: string): Promise<void> => {
    const state = states.get(accountId);
    if (!state || state.inFlight) return; // single-flight per account
    state.inFlight = true;
    try {
      const accounts = await store.listAccounts();
      const account = accounts.find((a) => a.id === accountId);
      if (!account) return; // removed mid-flight
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("quota poll timeout")), timeoutMs);
      let result: QuotaPollResult;
      try {
        result = await fetchBalance(account.credential, controller.signal);
      } finally {
        clearTimeout(timer);
      }
      if (result.ok) {
        // A successful authenticated poll proves the credential works — heal
        // expired/exhausted accounts (the poller is the primary probe).
        pool.updateQuota(accountId, result.remainingUnits, now());
        if (result.quotaExpiresAtMs !== undefined) {
          pool.setQuotaExpiry(accountId, result.quotaExpiresAtMs);
        }
        pool.noteSuccess(accountId);
      } else {
        pool.noteFailure(accountId); // poll fail ≠ exhausted — keep state
      }
    } catch {
      pool.noteFailure(accountId); // timeout/network — state untouched
    } finally {
      state.inFlight = false;
    }
  };

  const scheduleNext = (accountId: string, delay?: number): void => {
    const state = states.get(accountId);
    if (!state || !running) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      void pollAccount(accountId).finally(() => {
        const r = pool.runtimeFor(accountId);
        const sick = r?.status === "expired" || r?.status === "exhausted";
        scheduleNext(accountId, sick ? PROBE_INTERVAL_MS : undefined);
      });
    }, delay ?? jitter());
    state.timer.unref?.();
  };

  return {
    start(): void {
      if (running) return;
      running = true;
      // Start timers for accounts already in the pool.
      for (const { id } of pool.labels()) {
        if (!states.has(id)) states.set(id, { timer: null, inFlight: false });
        scheduleNext(id, Math.random() * jitter()); // stagger initial polls
      }
      // Follow store changes (accounts added/removed by CLI mid-run).
      const followTimer = setInterval(async () => {
        if (!running) return;
        const accounts = await store.listAccounts().catch(() => [] as StoredAccount[]);
        const ids = new Set(accounts.map((a) => a.id));
        for (const id of ids) {
          if (!states.has(id)) {
            states.set(id, { timer: null, inFlight: false });
            scheduleNext(id, Math.random() * jitter());
          }
        }
        for (const id of [...states.keys()]) {
          if (!ids.has(id)) {
            const s = states.get(id)!;
            if (s.timer) clearTimeout(s.timer);
            states.delete(id); // removed → stop polling
          }
        }
      }, followIntervalMs);
      (followTimer as { unref?: () => void }).unref?.();
    },

    stop(): void {
      running = false;
      for (const s of states.values()) {
        if (s.timer) clearTimeout(s.timer);
      }
      states.clear();
    },

    async pollNow(accountId: string): Promise<QuotaPollResult> {
      await pollAccount(accountId);
      const r = pool.runtimeFor(accountId);
      return {
        ok: r?.lastPolledAtMs !== undefined,
        remainingUnits: r?.remainingUnits,
        quotaExpiresAtMs: r?.quotaExpiresAtMs,
        lastPolledAtMs: r?.lastPolledAtMs,
      } as QuotaPollResult;
    },

    isRunning(): boolean {
      return running;
    },
  };
}
