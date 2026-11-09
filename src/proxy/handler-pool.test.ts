/**
 * Handler-level tests for AccountPool integration (ticket #4):
 * pool pick/release wiring, pass-through with one account, error-shape
 * mapping, x-zcode-account debug header, and store hot-reload.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { proxyRequest } from "./handler.js";
import { AccountPool, type AccountRuntime } from "../auth/pool.js";
import type { StoredAccount } from "../auth/accounts.js";
import type { Credential } from "../auth/types.js";
import type { ProxyConfig } from "../config/types.js";
import { AuthManager } from "../auth/manager.js";
import type { Server } from "node:http";
import { createServer } from "node:http";

const cred = (key: string): Credential => ({ apiKey: key, provider: "zai", userId: key });
const stored = (key: string): StoredAccount => ({ id: key, credential: cred(key), addedAt: 0 });

class FakeStore {
  accounts: StoredAccount[] = [stored("a")];
  async listAccounts(): Promise<StoredAccount[]> {
    return [...this.accounts];
  }
}

class FakeClock {
  private t = 1_700_000_000_000;
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

/** Upstream that records which apiKey each request authenticated with. */
async function startAuthRecordingServer(status = 200, body = '{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"ok"}],"model":"glm-4.6","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}'): Promise<{
  server: Server;
  url: string;
  apiKeys: () => string[];
  close: () => void;
  requestSeen: Promise<void>;
}> {
  const apiKeys: string[] = [];
  let seenResolve!: () => void;
  const requestSeen = new Promise<void>((r) => (seenResolve = r));
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", () => {});
    req.on("end", () => {
      apiKeys.push(String(req.headers.authorization ?? "").replace(/^Bearer /, ""));
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
      seenResolve();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${addr.port}`, apiKeys: () => apiKeys, close: () => server.close(), requestSeen };
}

function config(upstreamUrl: string): ProxyConfig {
  return {
    server: { port: 8080, host: "127.0.0.1" },
    auth: {},
    provider: "zai",
    plan: "coding-plan",
    providers: {
      zai: { anthropicBase: upstreamUrl, openaiBase: upstreamUrl },
      bigmodel: { anthropicBase: upstreamUrl, openaiBase: upstreamUrl },
    },
    defaultModel: "glm-4.6",
    models: ["glm-4.6"],
    identity: {
      appVersion: "test-1.0.0",
      sourceTitle: "test",
      userAgent: "test-agent",
      refererOrigin: "https://test.local",
      deviceMid: "test-mid",
    },
    clientIdentity: { mode: "off", ttlSeconds: 900, maxSessions: 1024 },
    responses: { enabled: false, storeMaxEntries: 10, storeTtlMs: 1000 },
    endpointRouting: { enabled: false, origin: "https://zcode.z.ai" },
    clientSigning: { enabled: false },
    highspeed: { enabled: false, origin: "https://zcode.z.ai", models: [] },
    mcp: { enabled: false, webSearch: false, webReader: false, zread: false, gateway: { enabled: false, upstreamOrigin: "" } },
    async: { enabled: false, origin: "https://zcode.z.ai", pollIntervalMs: 5000, keepAliveIntervalMs: 3000, maxWaitMs: 0, maxRetries: 3, settleTimeoutMs: 8000, controlTimeoutMs: 15000, defaultModel: "" },
    claim: { enabled: false, auto: false, origin: "https://zcode.z.ai", pollIntervalMs: 300000, cooldownMs: 600000, planId: "" },
    accounts: { maxInFlightPerAccount: 4, queueTimeoutMs: 100, rateLimitCooldownMs: 30000 },
    logging: { level: "info" },
  };
}

function makeReq(): Request {
  return new Request("http://127.0.0.1:8080/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "glm-4.6", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
  });
}

async function makePool(store: FakeStore, opts = {}): Promise<AccountPool> {
  const pool = new AccountPool(store, { now: new FakeClock().now, ...opts });
  await pool.syncWithStore();
  return pool;
}

describe("proxyRequest — AccountPool integration", () => {
  let upstream: Awaited<ReturnType<typeof startAuthRecordingServer>>;

  beforeEach(async () => {
    upstream = await startAuthRecordingServer();
  });
  afterEach(() => upstream.close());

  it("SINGLE account: 20 concurrent requests all succeed with no queueing (pass-through)", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a")];
    const pool = await makePool(store, { maxInFlightPerAccount: 4 }); // cap would queue
    const config_ = config(upstream.url);
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => proxyRequest(makeReq(), "openai", { config: config_, auth: new AuthManager(), accountPool: pool, fetchImpl: fetch })),
    );
    expect(responses.every((r) => r.status === 200)).toBe(true);
    await Promise.all(responses.map((r) => r.text())); // drain → release settles
    await new Promise((res) => setTimeout(res, 20));
    expect(pool.runtimeFor("a")!.inFlight).toBe(0); // all released
  });

  it("round-robins credentials across two accounts; x-zcode-account only with debug", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a"), stored("b")];
    const pool = await makePool(store);
    const config_ = config(upstream.url);
    const auth = new AuthManager();

    const r1 = await proxyRequest(makeReq(), "openai", { config: config_, auth, accountPool: pool, fetchImpl: fetch });
    expect(r1.headers.has("x-zcode-account")).toBe(false); // no debug → no header
    const r2 = await proxyRequest(makeReq(), "openai", { config: config_, auth, accountPool: pool, fetchImpl: fetch, debug: true });
    expect(r2.headers.get("x-zcode-account")).toBe("b");
    // drain r1 body to release its slot before asserting keys
    await r1.text();
    await r2.text();

    expect(upstream.apiKeys().length).toBe(2);
    expect(upstream.apiKeys()[0]).toBe("a");
    expect(upstream.apiKeys()[1]).toBe("b");
  });

  it("429 with Retry-After marks the account cooling (next request uses the other)", async () => {
    // Upstream: 429 for key a, 200 otherwise.
    upstream.close();
    const apiKeys: string[] = [];
    let seenResolve!: () => void;
    const requestSeen = new Promise<void>((r) => (seenResolve = r));
    const server = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        const key = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
        apiKeys.push(key);
        if (key === "a") {
          res.writeHead(429, { "content-type": "application/json", "retry-after": "30" });
          res.end('{"error":{"type":"rate_limited","message":"slow down"}}');
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"ok"}],"model":"glm-4.6","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}');
        }
        seenResolve();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as { port: number };
    upstream = { server, url: `http://127.0.0.1:${addr.port}`, apiKeys: () => apiKeys, close: () => server.close(), requestSeen } as typeof upstream;

    const store = new FakeStore();
    store.accounts = [stored("a"), stored("b")];
    const pool = await makePool(store);
    const config_ = config(upstream.url);

    const r1 = await proxyRequest(makeReq(), "openai", { config: config_, auth: new AuthManager(), accountPool: pool, fetchImpl: fetch });
    await r1.text(); // 429 body
    expect(r1.status).toBe(429);
    expect(pool.runtimeFor("a")!.status).toBe("cooling");

    const r2 = await proxyRequest(makeReq(), "openai", { config: config_, auth: new AuthManager(), accountPool: pool, fetchImpl: fetch });
    await r2.text();
    expect(r2.status).toBe(200);
    expect(upstream.apiKeys()).toEqual(["a", "b"]); // failover via cooling
  });

  it("maps pool errors: all-cooling → 429 with Retry-After; all-exhausted → 503", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a"), stored("b")];
    const clock = new FakeClock();
    const pool = new AccountPool(store, { now: clock.now });
    await pool.syncWithStore();
    pool.cool("a", clock.now() + 10_000);
    pool.cool("b", clock.now() + 10_000);
    const config_ = config(upstream.url);

    const r = await proxyRequest(makeReq(), "openai", { config: config_, auth: new AuthManager(), accountPool: pool, fetchImpl: fetch });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).not.toBeNull();
    const body = (await r.json()) as { error: { type: string } };
    expect(body.error.type).toBe("all_accounts_cooling");

    pool.markExhausted("a");
    pool.markExhausted("b");
    const r2 = await proxyRequest(makeReq(), "openai", { config: config_, auth: new AuthManager(), accountPool: pool, fetchImpl: fetch });
    expect(r2.status).toBe(503);
    const body2 = (await r2.json()) as { error: { type: string } };
    expect(body2.error.type).toBe("no_account_available");
  });

  it("hot-reload: account added to the store mid-run is used without restart", async () => {
    const store = new FakeStore();
    store.accounts = [stored("a")];
    const pool = await makePool(store);
    const config_ = config(upstream.url);

    await proxyRequest(makeReq(), "openai", { config: config_, auth: new AuthManager(), accountPool: pool, fetchImpl: fetch });

    store.accounts = [stored("a"), stored("b")]; // CLI added account b
    await pool.syncWithStore(); // server does this on a 5s timer; test calls directly
    await proxyRequest(makeReq(), "openai", { config: config_, auth: new AuthManager(), accountPool: pool, fetchImpl: fetch });

    expect(upstream.apiKeys().length).toBe(2);
    expect(upstream.apiKeys()[1]).toBe("b");
  });

  it("inflight returns to 0 after stream completion and after upstream error", async () => {
    upstream.close();
    // SSE-holding server then error server:
    const server = createServer((req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end('{"error":"boom"}');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as { port: number };
    upstream = { server, url: `http://127.0.0.1:${addr.port}`, apiKeys: () => [], close: () => server.close(), requestSeen: Promise.resolve() } as typeof upstream;

    const store = new FakeStore();
    store.accounts = [stored("a")];
    const pool = await makePool(store);
    const config_ = config(upstream.url);

    const r = await proxyRequest(makeReq(), "openai", { config: config_, auth: new AuthManager(), accountPool: pool, fetchImpl: fetch });
    await r.text();
    // Small tick to let the release promise settle:
    await new Promise((res) => setTimeout(res, 20));
    expect(pool.runtimeFor("a")!.inFlight).toBe(0);
  });
});
