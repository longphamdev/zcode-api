/**
 * In-memory production metrics for the multi-account pool (#8 dashboard).
 *
 * Volatile by design: counters reset on restart (stated on /admin/state).
 * Scoped to what #8's week-one review needs:
 *  - per (account, model): requests, success, 1005, 429 (+ last Retry-After),
 *    401, AccountsBusy — and TOKENS consumed (from response usage)
 *  - poll history per (account, bucket): timestamped remaining units
 *  - recent state transitions (pool.logTransition feeds these)
 *
 * No credentials anywhere in this data. Not persisted.
 */

export interface ModelCounters {
  requests: number;
  success: number;
  quota1005: number;
  rate429: number;
  lastRetryAfterSec?: number;
  auth401: number;
  busy: number;
  tokensUsed: number;
}

export interface AccountMetrics {
  id: string;
  label?: string;
  totals: ModelCounters;
  /** Per-model counters keyed by requested model id (e.g. "glm-5.3-flash"). */
  models: Record<string, ModelCounters>;
  /** Hourly request counts (ISO hour → count), bounded to last 48h. */
  hourly: Record<string, number>;
}

export interface PollSample {
  at: number;
  model: string;
  remainingUnits?: number;
  usedUnits?: number;
}

export interface TransitionLog {
  at: number;
  accountId: string;
  from: string;
  to: string;
  reason: string;
}

function emptyCounters(): ModelCounters {
  return { requests: 0, success: 0, quota1005: 0, rate429: 0, auth401: 0, busy: 0, tokensUsed: 0 };
}

const MAX_TRANSITIONS = 50;
const MAX_POLL_SAMPLES_PER_ACCOUNT = 40;
const HOURLY_WINDOW_MS = 48 * 3600_000;

export class MetricsRegistry {
  private accounts = new Map<string, AccountMetrics>();
  private polls = new Map<string, PollSample[]>();
  private transitions: TransitionLog[] = [];

  private account(id: string, label?: string): AccountMetrics {
    let m = this.accounts.get(id);
    if (!m) {
      m = { id, ...(label ? { label } : {}), totals: emptyCounters(), models: {}, hourly: {} };
      this.accounts.set(id, m);
    } else if (label && !m.label) {
      m.label = label;
    }
    return m;
  }

  /** Bounded model-key set — model comes from requests (external input);
   *  a hostile client could invent thousands of distinct model strings. */
  private static MAX_MODEL_KEYS = 50;

  /** Record one proxied request for (account, requested model). */
  recordRequest(accountId: string, model: string, label?: string): void {
    const m = this.account(accountId, label);
    m.totals.requests++;
    const key = model || "unknown";
    if (!m.models[key] && Object.keys(m.models).length >= MetricsRegistry.MAX_MODEL_KEYS) {
      // Over cap: attribute to "unknown" instead of growing unbounded.
      m.models.unknown ??= emptyCounters();
      m.models.unknown.requests++;
      const hour = new Date().toISOString().slice(0, 13);
      m.hourly[hour] = (m.hourly[hour] ?? 0) + 1;
      this.pruneHourly(m);
      return;
    }
    m.models[key] ??= emptyCounters();
    m.models[key].requests++;
    const hour = new Date().toISOString().slice(0, 13);
    m.hourly[hour] = (m.hourly[hour] ?? 0) + 1;
    this.pruneHourly(m);
  }

  recordOutcome(
    accountId: string,
    model: string,
    outcome: "success" | "quota1005" | "rate429" | "auth401" | "busy",
    opts: { retryAfterSec?: number; tokensUsed?: number } = {},
  ): void {
    const m = this.account(accountId);
    const key = model || "unknown";
    m.models[key] ??= emptyCounters();
    const c = m.models[key];
    m.totals[outcome]++;
    c[outcome]++;
    if (outcome === "success" || outcome === "quota1005" || outcome === "rate429") m.totals.success += outcome === "success" ? 0 : 0;
    if (opts.retryAfterSec !== undefined) {
      c.lastRetryAfterSec = opts.retryAfterSec;
      m.totals.lastRetryAfterSec = opts.retryAfterSec;
    }
    if (opts.tokensUsed !== undefined && Number.isFinite(opts.tokensUsed)) {
      c.tokensUsed += opts.tokensUsed;
      m.totals.tokensUsed += opts.tokensUsed;
    }
  }

  /** Global busy counter (no account — the request never got a slot). */
  busyGlobal = 0;
  recordBusyGlobal(_model: string): void {
    this.busyGlobal++;
  }

  /** Manual/auto claim outcomes per account. */
  claims = new Map<string, { claimed: number; failed: number; lastPlan?: string; lastAt?: number }>();
  recordClaim(accountId: string, result: "claimed" | "failed", planId?: string): void {
    const c = this.claims.get(accountId) ?? { claimed: 0, failed: 0 };
    c[result === "claimed" ? "claimed" : "failed"]++;
    if (planId) c.lastPlan = planId;
    c.lastAt = Date.now();
    this.claims.set(accountId, c);
  }

  /** Record a balance-poll sample (per account, per bucket). */
  recordPoll(accountId: string, samples: Array<{ model: string; remainingUnits?: number; usedUnits?: number }>, at = Date.now()): void {
    const list = this.polls.get(accountId) ?? [];
    for (const s of samples) {
      list.push({ at, model: s.model, ...(s.remainingUnits !== undefined ? { remainingUnits: s.remainingUnits } : {}), ...(s.usedUnits !== undefined ? { usedUnits: s.usedUnits } : {}) });
    }
    // Bounded: keep the most recent samples per account.
    while (list.length > MAX_POLL_SAMPLES_PER_ACCOUNT) list.shift();
    this.polls.set(accountId, list);
  }

  /** Record a pool state transition (from logTransition). */
  recordTransition(accountId: string, from: string, to: string, reason: string, at = Date.now()): void {
    this.transitions.push({ at, accountId, from, to, reason });
    while (this.transitions.length > MAX_TRANSITIONS) this.transitions.shift();
  }

  /** Wire target for pool.logTransition — the pool calls this on change. */
  onTransition?: (accountId: string, from: string, to: string, reason: string) => void;

  private pruneHourly(m: AccountMetrics): void {
    const cutoff = Date.now() - HOURLY_WINDOW_MS;
    for (const hour of Object.keys(m.hourly)) {
      if (new Date(`${hour}:00:00Z`).getTime() < cutoff) delete m.hourly[hour];
    }
  }

  /** Test/ops reset — clears all counters (volatile by design). */
  reset(): void {
    this.accounts.clear();
    this.polls.clear();
    this.transitions = [];
    this.busyGlobal = 0;
  }

  snapshot(): {
    accounts: AccountMetrics[];
    pollHistory: Record<string, PollSample[]>;
    transitions: TransitionLog[];
    claims: Record<string, { claimed: number; failed: number; lastPlan?: string; lastAt?: number }>;
    busyGlobal: number;
    note: string;
  } {
    return {
      accounts: [...this.accounts.values()],
      pollHistory: Object.fromEntries([...this.polls.entries()]),
      transitions: [...this.transitions],
      claims: Object.fromEntries([...this.claims.entries()]),
      busyGlobal: this.busyGlobal,
      note: "In-memory counters — reset on proxy restart. Tokens from response usage where available.",
    };
  }
}

/** Process-wide registry (one proxy = one pool = one registry). */
export const metricsRegistry = new MetricsRegistry();
