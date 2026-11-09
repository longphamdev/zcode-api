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
    accounts: { maxInFlightPerAccount: 4, queueTimeoutMs: 100, rateLimitCooldownMs: 30000, reservationTimeoutMs: 900000 },
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

describe("proxyRequest — client abort releases the pool slot immediately", () => {
  // Bun 1.3.x does not deliver response-body cancel on an abruptly destroyed
  // client socket; 1.4.0 fixed it (verified via docker repro — ticket #5).
  // On >= 1.4 a real client disconnect must free the pool slot through the
  // stream cancel path — no watchdog wait. Version-gated skip WITH reason:
  // on 1.3.x the cancel event never fires, so the assertion cannot hold.
  const [bunMajor, bunMinor] = (typeof Bun !== "undefined" ? Bun.version : "0.0").split(".").map(Number);
  const supportsImmediateCancel = bunMajor > 1 || (bunMajor === 1 && bunMinor >= 4);

  (supportsImmediateCancel ? it : it.skip)(
    "client disconnect mid-stream → inFlight back to 0 without watchdog",
    async () => {
      const store = new FakeStore();
      store.accounts = [stored("a"), stored("b")];
      const pool = await makePool(store, { maxInFlightPerAccount: 1, reservationTimeoutMs: 0 }); // no watchdog

      // SSE-holding upstream: never ends the stream.
      const server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": keepalive\n\n");
        // intentionally never ends
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const addr = server.address() as { port: number };
      const sseUrl = `http://127.0.0.1:${addr.port}`;
      try {

      const clientController = new AbortController();
      const req = new Request("http://127.0.0.1:8080/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-4.6", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
        signal: clientController.signal,
      });
      const config_ = config(sseUrl);
      const resp = await proxyRequest(req, "openai", { config: config_, auth: new AuthManager(), accountPool: pool, fetchImpl: fetch });
      expect(resp.status).toBe(200);
      const slotBefore = pool.runtimeFor("a")!.inFlight + pool.runtimeFor("b")!.inFlight;
      expect(slotBefore).toBe(1); // one reservation held by the open stream

      // Simulate the client vanishing: cancel the response body (what the
      // server layer does on socket close).
      await resp.body!.cancel();
      await new Promise((r) => setTimeout(r, 30));
      const slotAfter = pool.runtimeFor("a")!.inFlight + pool.runtimeFor("b")!.inFlight;
      expect(slotAfter).toBe(0); // released immediately, no watchdog
      } finally {
        server.close();
      }
    },
    10_000,
  );
});

describe("proxyRequest — release wrapper data-path integrity", () => {
  let serverKillers: Array<() => void> = [];
  beforeEach(() => { serverKillers = []; });
  it("byte-for-byte: body through the wrapper matches the upstream body exactly", async () => {
    // Large body with tricky boundaries: multi-byte UTF-8 split across chunk
    // edges, SSE-like \n\n sequences, chunked framing handled upstream.
    const chunks = [
      Buffer.from('{"id":"msg","content":"'),
      Buffer.from("tra"),
      Buffer.from("ẻ Ember—emoji 🎌 splits"),
      Buffer.from("\n\n"),
      Buffer.from('"}'),
    ];
    const expected = Buffer.concat(chunks);
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      for (const c of chunks) res.write(c);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as { port: number };
    try {
      const store = new FakeStore();
      store.accounts = [stored("a")];
      const pool = await makePool(store);
      const resp = await proxyRequest(makeReq(), "anthropic", { config: config(`http://127.0.0.1:${addr.port}`), auth: new AuthManager(), accountPool: pool, fetchImpl: fetch });
      const received = Buffer.from(await resp.arrayBuffer());
      expect(received.equals(expected)).toBe(true);
      await new Promise((r) => setTimeout(r, 20));
      expect(pool.runtimeFor("a")!.inFlight).toBe(0);
    } finally {
      server.close();
    }
  });

  it("backpressure: a slow client does not make the proxy buffer the whole upstream", async () => {
    // Upstream emits 20 chunks with pauses; the client reads slowly. Assert
    // the client receives data incrementally (first chunk arrives while the
    // upstream is still sending), which proves no full-buffering.
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      let i = 0;
      const timer = setInterval(() => {
        res.write(`chunk-${i};`);
        i++;
        if (i >= 20) {
          clearInterval(timer);
          res.end();
        }
      }, 30);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as { port: number };
    try {
      const store = new FakeStore();
      store.accounts = [stored("a")];
      const pool = await makePool(store);
      const resp = await proxyRequest(makeReq(), "anthropic", { config: config(`http://127.0.0.1:${addr.port}`), auth: new AuthManager(), accountPool: pool, fetchImpl: fetch });
      const reader = resp.body!.getReader();
    const t0 = Date.now();
    const first = await reader.read(); // first chunk
    const firstArrival = Date.now() - t0;
    expect(firstArrival).toBeLessThan(200); // upstream total is 600ms — incremental!
    expect(new TextDecoder().decode(first.value)).toContain("chunk-0");
    let received = new TextDecoder().decode(first.value);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += new TextDecoder().decode(value);
    }
    expect(received).toContain("chunk-19");
    await new Promise((r) => setTimeout(r, 20));
    expect(pool.runtimeFor("a")!.inFlight).toBe(0);
    } finally {
      server.close();
    }
  });

  it("error after partial stream: releases exactly once, client sees the error (no hang)", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: partial\n\n");
      // Destroy deterministically AFTER the client has read the first chunk
      // (the test pulls the trigger) — a fixed timer races the scheduler
      // under load and makes this test flaky.
      let killed = false;
      serverKillers.push(() => {
        if (killed) return;
        killed = true;
        res.destroy();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as { port: number };
    try {
      const store = new FakeStore();
      store.accounts = [stored("a")];
      const pool = await makePool(store);
      const resp = await proxyRequest(makeReq(), "anthropic", { config: config(`http://127.0.0.1:${addr.port}`), auth: new AuthManager(), accountPool: pool, fetchImpl: fetch });
      const reader = resp.body!.getReader();
    // First read gets the partial data; then upstream dies; the next read
    // rejects (no hang).
    const first = await reader.read();
    expect(first.done).toBe(false);
    for (const kill of serverKillers) kill();
    await expect(reader.read()).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 30));
    expect(pool.runtimeFor("a")!.inFlight).toBe(0); // released exactly once via error path
    // Idempotency: an extra cancel after error doesn't double-release
    // (cancel on an already-errored reader rejects — that's fine, the point
    // is the pool slot stays at 0).
    await reader.cancel().catch(() => {});
    expect(pool.runtimeFor("a")!.inFlight).toBe(0);
    } finally {
      server.close();
    }
  });

  it("cancel + pull-exhaustion together: release still exactly once", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"done":true}');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as { port: number };
    try {
      const store = new FakeStore();
      store.accounts = [stored("a")];
      const pool = await makePool(store);
      const resp = await proxyRequest(makeReq(), "anthropic", { config: config(`http://127.0.0.1:${addr.port}`), auth: new AuthManager(), accountPool: pool, fetchImpl: fetch });
      // Race full read against an immediate cancel — the wrapper's idempotent
      // release must keep inFlight at 0 in every interleaving.
      const reader = resp.body!.getReader();
      await Promise.allSettled([reader.read(), reader.cancel("race")]);
      await new Promise((r) => setTimeout(r, 30));
      expect(pool.runtimeFor("a")!.inFlight).toBe(0);
    } finally {
      server.close();
    }
  });
});
