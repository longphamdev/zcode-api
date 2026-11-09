/**
 * GET /admin/state — read-only production metrics for the multi-account
 * pool (#8 dashboard). Same auth as /v1/* (proxyApiKey); no credentials in
 * the response (counters and timestamps only).
 */
import { metricsRegistry } from "./metrics.js";
import { errorResponse } from "../proxy/handler.js";
import { timingSafeEqual } from "node:crypto";
import { listAccounts } from "../auth/accounts.js";

export interface AdminRouteOptions {
  proxyApiKey?: string;
}

/**
 * POST /admin/claim — trigger an immediate claim for ONE account (or all
 * accounts in rotation). Runs a one-shot claim through the claim client.
 * Auth: proxy API key (header only). Phase-2 scope note: when write
 * endpoints gain a separate admin key + CSRF, this moves under that.
 */
export async function handleAdminClaim(req: Request, opts: AdminRouteOptions): Promise<Response> {
  if (opts.proxyApiKey) {
    const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
    const xKey = req.headers.get("x-api-key") ?? null;
    const ok = (bearer !== null && keyMatches(bearer, opts.proxyApiKey))
      || (xKey !== null && keyMatches(xKey, opts.proxyApiKey));
    if (!ok) {
      return errorResponse(401, "authentication_error", "Invalid or missing proxy API key");
    }
  }
  let body: { accountId?: string } = {};
  try {
    body = (await req.json().catch(() => ({}))) as { accountId?: string };
  } catch {
    body = {};
  }
  const accounts = await listAccounts().catch(() => []);
  const targets = body.accountId
    ? accounts.filter((a) => a.id === body.accountId)
    : accounts;
  if (accounts.length === 0) {
    return errorResponse(400, "not_logged_in", "No accounts stored. Run: zcode-proxy auth login zai --add");
  }
  if (body.accountId && targets.length === 0) {
    return errorResponse(400, "unknown_account", `Unknown account: ${body.accountId}`);
  }

  const { runOneShotClaim } = await import("../claim/runtime.js");
  const config = (await import("../config/loader.js")).loadConfig(process.env.ZCODE_PROXY_CONFIG ?? "config.yaml");
  const results: Array<{ accountId: string; result: string; detail?: string }> = [];
  for (const a of targets) {
    const r = await runOneShotClaim(config, a.credential, a.id);
    results.push({ accountId: a.id, result: r.ok ? "ok" : "failed", ...(r.detail ? { detail: r.detail } : {}) });
  }
  return new Response(JSON.stringify({ results }, null, 1), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    },
  });
}

/** Constant-time string compare (padded to equal length to avoid length leaks). */
function keyMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still burn a compare to keep timing uniform, then fail.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export async function handleAdminState(req: Request, opts: AdminRouteOptions): Promise<Response> {
  // Same auth model as /v1/* — the proxy API key via Authorization or
  // x-api-key HEADER ONLY. Keys in query strings leak into browser history,
  // reverse-proxy logs, and the Referer header — never accept them here.
  // Constant-time compare; the 401 response NEVER echoes the header values.
  if (opts.proxyApiKey) {
    const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
    const xKey = req.headers.get("x-api-key") ?? null;
    const ok = (bearer !== null && keyMatches(bearer, opts.proxyApiKey))
      || (xKey !== null && keyMatches(xKey, opts.proxyApiKey));
    if (!ok) {
      return errorResponse(401, "authentication_error", "Invalid or missing proxy API key");
    }
  }
  const body = metricsRegistry.snapshot();
  // Merge labels from the account store (metrics counters don't carry them —
  // they're keyed by accountId only).
  const accounts = await listAccounts().catch(() => []);
  const labels = new Map(accounts.map((a) => [a.id, a.label]));
  for (const a of body.accounts) {
    const label = labels.get(a.id);
    if (label) a.label = label;
  }
  return new Response(JSON.stringify(body, null, 1), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    },
  });
}
