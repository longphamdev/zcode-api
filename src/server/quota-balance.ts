/**
 * Minimal billing-balance read for the quota poller (#6).
 *
 * Mirrors the credits-plane call in routes-quota.ts (`zcode-plan/billing/balance`
 * on the claim origin with the account's plan JWT + desktop identity) but
 * returns only what the poller needs: remainingUnits + entitlement expiry.
 */
import type { ProxyConfig } from "../config/types.js";
import type { Credential } from "../auth/types.js";
import type { ModelQuota, QuotaPollResult } from "../auth/quota-poller.js";
import { buildIdentityHeaders, normalizePrintableHeaderValue } from "../proxy/identity.js";
import os from "node:os";

export async function fetchBalanceForCredential(
  config: ProxyConfig,
  cred: Credential,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<QuotaPollResult> {
  if (!cred.jwt) {
    return { ok: false, error: "no plan JWT (re-login to capture it)" };
  }
  const idHeaders = buildIdentityHeaders(config.identity);
  delete idHeaders["X-ZCode-Agent"];
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(idHeaders).filter(([, v]) => typeof v === "string")),
    authorization: `Bearer ${cred.jwt}`,
    Accept: "application/json",
  };
  const origin = config.claim.origin || "https://zcode.z.ai";
  // Mirror routes-quota's query params — the endpoint 400s without them.
  // `platform` is a QUERY param here (not a header — header form 400s).
  const appVersion = config.identity.appVersion;
  const platform = `${normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_PLATFORM) ?? process.platform}-${normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_ARCH) ?? os.arch()}`;
  const resp = await fetchImpl(
    `${origin}/api/v1/zcode-plan/billing/balance?app_version=${encodeURIComponent(appVersion)}&platform=${encodeURIComponent(platform)}`,
    { headers, signal },
  );
  if (!resp.ok) {
    // 401 here is a strong credential-death signal (authenticated plane).
    if (resp.status === 401) return { ok: false, error: "balance: 401 (credential rejected)" };
    return { ok: false, error: `balance: HTTP ${resp.status}` };
  }
  const body = await resp.json().catch(() => null);
  // Upstream shape (live-captured 2026-11-09): `data.balances[]` with
  // snake_case fields, ONE BUCKET PER MODEL (glm-5.3 and glm-5.3-flash are
  // separate grants — never sum them for per-model decisions). Fields:
  //   total_units, used_units, remaining_units, available_units, expires_at,
  //   capabilities: ["model:<id>"], plan_id, entitlement_id.
  // A campaign entitlement may additionally appear in data.plans[].entitlements
  // with effective_at in the future — it has NO bucket until effective, so it
  // is intentionally not counted here (no fake "300M remaining" before it
  // activates).
  const balances = Array.isArray(body?.data?.balances) ? body.data.balances : Array.isArray(body?.balances) ? body.balances : [];
  const models: ModelQuota[] = balances
    .map((b: Record<string, unknown>): ModelQuota => {
      const caps = Array.isArray(b.capabilities) ? b.capabilities.filter((c): c is string => typeof c === "string") : [];
      const modelCap = caps.find((c) => c.startsWith("model:"));
      const toMs = (v: unknown): number | undefined =>
        typeof v === "number" ? (v > 1e12 ? v : v * 1000) : undefined;
      return {
        model: modelCap ?? (typeof b.show_name === "string" ? b.show_name : "unknown"),
        ...(typeof b.total_units === "number" ? { totalUnits: b.total_units } : {}),
        ...(typeof b.used_units === "number" ? { usedUnits: b.used_units } : {}),
        ...(typeof b.remaining_units === "number" ? { remainingUnits: b.remaining_units } : {}),
        ...(toMs(b.expires_at) !== undefined ? { expiresAtMs: toMs(b.expires_at) } : {}),
      };
    })
    .filter((m: { model: string }) => m.model !== "unknown");
  const totalRemaining = models.reduce((sum, m) => sum + (m.remainingUnits ?? 0), 0);
  const expiresAtSec = models
    .map((m) => m.expiresAtMs)
    .filter((e): e is number => typeof e === "number")
    .sort((a, b) => a - b)[0]; // earliest expiry = the daily reset

  return {
    ok: true,
    remainingUnits: totalRemaining,
    ...(expiresAtSec !== undefined ? { quotaExpiresAtMs: expiresAtSec } : {}),
    models,
  };
}
