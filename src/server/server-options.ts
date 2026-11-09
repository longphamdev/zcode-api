/**
 * `startServer` option assembly shared by every entry that boots the proxy
 * in-process (serve / android / tui).
 */
import type { ProxyConfig } from "../config/types.js";
import type { AuthManager } from "../auth/manager.js";
import { ResponseStore } from "../responses/store.js";
import { createAccountPool, type AccountPool } from "../auth/pool.js";
import { createQuotaPoller, type QuotaPoller } from "../auth/quota-poller.js";
import { listAccounts } from "../auth/accounts.js";
import { metricsRegistry } from "./metrics.js";

/** Build `startServer` options, wiring the Responses store when its config gate is on. */
export function buildServerOptions(
  config: ProxyConfig,
  auth: AuthManager,
  debug: boolean,
): { config: ProxyConfig; auth: AuthManager; debug: boolean; responseStore?: ResponseStore; accountPool?: AccountPool; quotaPoller?: QuotaPoller } {
  const opts: { config: ProxyConfig; auth: AuthManager; debug: boolean; responseStore?: ResponseStore; accountPool?: AccountPool; quotaPoller?: QuotaPoller } = { config, auth, debug };
  if (config.responses.enabled) {
    opts.responseStore = new ResponseStore({ maxEntries: config.responses.storeMaxEntries, ttlMs: config.responses.storeTtlMs });
  }
  // Multi-account pool: always wired when the store is available; the pool
  // itself degrades to pass-through for a single account, so behavior is
  // unchanged there. Sync failure is non-fatal — the handler falls back to
  // the legacy `auth.getCredential()` path when no pool is provided.
  try {
    const pool = createAccountPool({
      maxInFlightPerAccount: config.accounts?.maxInFlightPerAccount,
      queueTimeoutMs: config.accounts?.queueTimeoutMs,
      rateLimitCooldownMs: config.accounts?.rateLimitCooldownMs,
      reservationTimeoutMs: config.accounts?.reservationTimeoutMs,
    });
    pool.setStrategy(config.accounts?.pickStrategy ?? "round-robin");
    // Metrics registry wiring (#8 dashboard) — global hook avoids a
    // pool → metrics import cycle.
    (globalThis as { __poolMetricsHooks?: { onTransition?: (id: string, f: string, t: string, r: string) => void; onPoll?: (id: string, models: Array<{ model: string; remainingUnits?: number; usedUnits?: number }>) => void } }).__poolMetricsHooks = {
      onTransition: (id, f, t, r) => metricsRegistry.recordTransition(id, f, t, r),
      onPoll: (id, models) => metricsRegistry.recordPoll(id, models),
    };
    opts.accountPool = pool;
    opts.accountPool = pool;
    void pool.syncWithStore(); // async warm-up; first request syncs again if pending
    // Per-account quota poller (#6): feeds remainingUnits/health into the pool.
    opts.quotaPoller = createQuotaPoller(
      pool,
      { listAccounts },
      // Live billing read — reuse the routes-quota collector's upstream call
      // shape via a minimal balance fetch. Full snapshot collection would also
      // work but the poller only needs the balance plane.
      async (cred, signal) => {
        try {
          const { fetchBalanceForCredential } = await import("./quota-balance.js");
          return await fetchBalanceForCredential(config, cred, signal, fetch);
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      },
      { intervalMs: 5 * 60_000, timeoutMs: 10_000 },
    );
  } catch (e) {
    console.warn(`account pool unavailable (single-credential fallback): ${(e as Error).message}`);
  }
  return opts;
}
