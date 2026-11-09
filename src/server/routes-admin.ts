/**
 * GET /admin/state — read-only production metrics for the multi-account
 * pool (#8 dashboard). Same auth as /v1/* (proxyApiKey); no credentials in
 * the response (counters and timestamps only).
 */
import { metricsRegistry } from "./metrics.js";
import { errorResponse } from "../proxy/handler.js";
import { timingSafeEqual } from "node:crypto";

export interface AdminRouteOptions {
  proxyApiKey?: string;
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

export function handleAdminState(req: Request, opts: AdminRouteOptions): Response {
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
  return new Response(JSON.stringify(body, null, 1), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    },
  });
}
