/**
 * Minimal billing-balance read for the quota poller (#6).
 *
 * Mirrors the credits-plane call in routes-quota.ts (`zcode-plan/billing/balance`
 * on the claim origin with the account's plan JWT + desktop identity) but
 * returns only what the poller needs: remainingUnits + entitlement expiry.
 */
import type { ProxyConfig } from "../config/types.js";
import type { Credential } from "../auth/types.js";
import type { QuotaPollResult } from "../auth/quota-poller.js";
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
    ...idHeaders,
    authorization: `Bearer ${cred.jwt}`,
    Accept: "application/json",
  };
  const platform = `${normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_PLATFORM) ?? process.platform}-${normalizePrintableHeaderValue(process.env.ZCODE_IDENTITY_ARCH) ?? os.arch()}`;
  headers["x-device-mid"] = config.identity.deviceMid;
  headers["x-platform"] = platform;

  const origin = config.claim.origin || "https://zcode.z.ai";
  const resp = await fetchImpl(`${origin}/api/v1/zcode-plan/billing/balance`, { headers, signal });
  if (!resp.ok) {
    // 401 here is a strong credential-death signal (authenticated plane).
    if (resp.status === 401) return { ok: false, error: "balance: 401 (credential rejected)" };
    return { ok: false, error: `balance: HTTP ${resp.status}` };
  }
  const body = await resp.json().catch(() => null);
  const balances = Array.isArray(body?.data?.balances) ? body.data.balances : Array.isArray(body?.balances) ? body.balances : [];
  const totalRemaining = balances.reduce((sum: number, b: { remainingUnits?: number }) => sum + (typeof b.remainingUnits === "number" ? b.remainingUnits : 0), 0);
  const expiresAtSec = balances
    .map((b: { expiresAt?: number }) => b.expiresAt)
    .filter((e: number | undefined): e is number => typeof e === "number")
    .sort((a: number, b: number) => b - a)[0]; // latest expiry

  return {
    ok: true,
    remainingUnits: totalRemaining,
    ...(expiresAtSec !== undefined ? { quotaExpiresAtMs: expiresAtSec > 1e12 ? expiresAtSec : expiresAtSec * 1000 } : {}),
  };
}
