/**
 * GET /admin/state — read-only production metrics for the multi-account
 * pool (#8 dashboard). Same auth as /v1/* (proxyApiKey); no credentials in
 * the response (counters and timestamps only).
 */
import { metricsRegistry } from "./metrics.js";
import { errorResponse } from "../proxy/handler.js";

export interface AdminRouteOptions {
  proxyApiKey?: string;
}

export function handleAdminState(req: Request, opts: AdminRouteOptions): Response {
  // Same auth model as /v1/* — the proxy API key. Accept either header.
  if (opts.proxyApiKey) {
    const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    const xKey = req.headers.get("x-api-key");
    if (bearer !== opts.proxyApiKey && xKey !== opts.proxyApiKey) {
      return errorResponse(401, "authentication_error", "Invalid or missing proxy API key");
    }
  }
  const body = metricsRegistry.snapshot();
  return new Response(JSON.stringify(body, null, 1), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
