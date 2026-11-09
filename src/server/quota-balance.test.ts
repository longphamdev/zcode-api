/**
 * Tests for the quota poller's balance parser — driven by a live-captured
 * fixture (redacted). Key contract: per-model buckets, snake_case fields,
 * campaign entitlements with future effective_at are NOT counted.
 */
import { describe, it, expect } from "bun:test";
import { fetchBalanceForCredential } from "./quota-balance.js";
import type { ProxyConfig } from "../config/types.js";

const FIXTURE = JSON.parse(
  JSON.stringify(await import("./fixtures/balance-response-sample.json")),
).body;

const CONFIG: ProxyConfig = {
  server: { port: 8080, host: "127.0.0.1" },
  auth: {},
  provider: "zai",
  plan: "start-plan",
  providers: {
    zai: { anthropicBase: "http://x", openaiBase: "http://x" },
    bigmodel: { anthropicBase: "http://x", openaiBase: "http://x" },
  },
  defaultModel: "glm-5.3-flash",
  models: ["glm-5.3-flash"],
  identity: { appVersion: "3.17.2", sourceTitle: "t", refererOrigin: "https://t", deviceMid: "mid" },
  clientIdentity: { mode: "off", ttlSeconds: 900, maxSessions: 1024 },
  responses: { enabled: false, storeMaxEntries: 10, storeTtlMs: 1000 },
  endpointRouting: { enabled: false, origin: "" },
  clientSigning: { enabled: false },
  highspeed: { enabled: false, origin: "", models: [] },
  mcp: { enabled: false, webSearch: false, webReader: false, zread: false, gateway: { enabled: false, upstreamOrigin: "" } },
  async: { enabled: false, origin: "", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
  claim: { enabled: false, auto: false, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, planId: "", spacingHours: 4, },
  accounts: { pickStrategy: "round-robin" as const, maxInFlightPerAccount: 2, queueTimeoutMs: 5000, rateLimitCooldownMs: 30000, reservationTimeoutMs: 900000 },
  logging: { level: "info" },
};

const CRED = { apiKey: "k", provider: "zai" as const, userId: "u", jwt: "h.p.s" };

function makeFetch(body: unknown, status = 200): typeof fetch {
  const fn = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
  return fn;
}

describe("fetchBalanceForCredential — parser (#7 live shape)", () => {
  it("parses the live fixture: per-model buckets, snake_case, daily reset expiry", async () => {
    const result = await fetchBalanceForCredential(CONFIG, CRED, new AbortController().signal, makeFetch(FIXTURE));
    expect(result.ok).toBe(true);
    expect(result.models).toHaveLength(2);
    const glm53 = result.models!.find((m) => m.model === "model:glm-5.3")!;
    const flash = result.models!.find((m) => m.model === "model:glm-5.3-flash")!;
    // snake_case mapped: remaining_units → remainingUnits
    expect(glm53.remainingUnits).toBe(3000000);
    expect(glm53.usedUnits).toBe(0);
    expect(flash.remainingUnits).toBe(4992806);
    expect(flash.usedUnits).toBe(7194);
    // daily reset deadline from expires_at (seconds → ms)
    expect(result.quotaExpiresAtMs).toBe(1794239999 * 1000);
    // aggregate = sum across models (display only)
    expect(result.remainingUnits).toBe(3000000 + 4992806);
  });

  it("campaign entitlement with future effective_at is NOT counted (no bucket yet)", async () => {
    const result = await fetchBalanceForCredential(CONFIG, CRED, new AbortController().signal, makeFetch(FIXTURE));
    // The 300M campaign grant lives in plans[].entitlements, has NO bucket in
    // balances[] (effective_at 15:00 UTC future). Only the two 0817 buckets count.
    expect(result.models!.some((m) => m.remainingUnits === 300000000)).toBe(false);
  });

  it("unknown/foreign balance fields are tolerated (model identified, no crash)", async () => {
    // There is no camelCase upstream variant — this pins that unexpected field
    // shapes don't crash the parser (model from capabilities, numbers missing).
    const foreignBody = {
      data: {
        balances: [
          {
            bucket_id: "b1",
            show_name: "GLM-5.3-Flash",
            capabilities: ["model:glm-5.3-flash"],
            totalUnits: 5000000,
            usedUnits: 100,
            remainingUnits: 4999900,
            expiresAt: 1794239999,
          },
        ],
      },
    };
    const result = await fetchBalanceForCredential(CONFIG, CRED, new AbortController().signal, makeFetch(foreignBody));
    expect(result.ok).toBe(true);
    expect(result.models).toHaveLength(1);
    expect(result.models![0].model).toBe("model:glm-5.3-flash");
    // snake_case fields absent → numbers undefined, never fabricated:
    expect(result.models![0].remainingUnits).toBeUndefined();
    expect(result.remainingUnits).toBe(0);
  });

  it("HTTP 401 → not ok (credential death signal)", async () => {
    const result = await fetchBalanceForCredential(CONFIG, CRED, new AbortController().signal, makeFetch({ error: "x" }, 401));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("401");
  });
});
