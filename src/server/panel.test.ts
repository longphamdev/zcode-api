/**
 * Tests for the optional web panel (issue #58): token enforcement, the
 * pass-through to the loopback control listener, and the tokenless static
 * routes that a browser navigation cannot attach headers to.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:http";
import {
  DEFAULT_PANEL_CONTROL_PORT,
  DEFAULT_PANEL_PORT,
  PANEL_CONTROL_PORT_ENV,
  PANEL_ENABLED_ENV,
  PANEL_PORT_ENV,
  PANEL_TOKEN_ENV,
  isPanelEnabled,
  resolvePanelSettings,
  startPanelServer,
  type PanelServer,
} from "./panel.js";

const TOKEN = "panel-token-for-tests";
const CONTROL_OK = JSON.stringify({ ok: true, event: "proxyStopped" });

interface StubControl {
  port: number;
  /** Bodies the panel actually forwarded, in order. */
  bodies: string[];
  /** Canned answer the stub returns for the next request. */
  reply: { status: number; body: string };
  close(): Promise<void>;
}

/** Minimal stand-in for `startControlListener` (same POST /control contract). */
async function startStubControl(): Promise<StubControl> {
  const stub: StubControl = {
    port: 0,
    bodies: [],
    reply: { status: 200, body: CONTROL_OK },
    close: async () => {},
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      stub.bodies.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(stub.reply.status, { "content-type": "application/json" });
      res.end(stub.reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  stub.port = typeof address === "object" && address ? address.port : 0;
  stub.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return stub;
}

let panels: PanelServer[] = [];
let stubs: StubControl[] = [];

afterEach(async () => {
  await Promise.all(panels.map((panel) => panel.close().catch(() => {})));
  await Promise.all(stubs.map((stub) => stub.close()));
  panels = [];
  stubs = [];
});

/** Panel bound to a free port; the token is always the test token. */
async function startPanel(controlPort: number): Promise<PanelServer> {
  const panel = await startPanelServer({ port: 0, token: TOKEN, controlPort });
  panels.push(panel);
  return panel;
}

async function startStub(): Promise<StubControl> {
  const stub = await startStubControl();
  stubs.push(stub);
  return stub;
}

function panelUrl(panel: PanelServer, path: string): string {
  return `http://127.0.0.1:${panel.port}${path}`;
}

function controlRequest(panel: PanelServer, init: RequestInit = {}): Promise<Response> {
  return fetch(panelUrl(panel, "/api/control"), {
    method: "POST",
    body: JSON.stringify({ cmd: "status" }),
    ...init,
  });
}

describe("isPanelEnabled", () => {
  it("stays off unless the flag is explicitly truthy", () => {
    expect(isPanelEnabled({})).toBe(false);
    expect(isPanelEnabled({ [PANEL_ENABLED_ENV]: "" })).toBe(false);
    expect(isPanelEnabled({ [PANEL_ENABLED_ENV]: "   " })).toBe(false);
    expect(isPanelEnabled({ [PANEL_ENABLED_ENV]: "0" })).toBe(false);
    expect(isPanelEnabled({ [PANEL_ENABLED_ENV]: "false" })).toBe(false);
    expect(isPanelEnabled({ [PANEL_ENABLED_ENV]: "FALSE" })).toBe(false);
    expect(isPanelEnabled({ [PANEL_ENABLED_ENV]: "no" })).toBe(false);
    expect(isPanelEnabled({ [PANEL_ENABLED_ENV]: "off" })).toBe(false);
  });

  it("accepts the usual truthy spellings, case-insensitively", () => {
    expect(isPanelEnabled({ [PANEL_ENABLED_ENV]: "1" })).toBe(true);
    expect(isPanelEnabled({ [PANEL_ENABLED_ENV]: "true" })).toBe(true);
    expect(isPanelEnabled({ [PANEL_ENABLED_ENV]: "ON" })).toBe(true);
  });
});

describe("resolvePanelSettings", () => {
  it("returns null while the panel is off, whatever else is set", () => {
    expect(resolvePanelSettings({ [PANEL_TOKEN_ENV]: TOKEN })).toBeNull();
  });

  it("falls back to the default ports", () => {
    expect(resolvePanelSettings({ [PANEL_ENABLED_ENV]: "1", [PANEL_TOKEN_ENV]: ` ${TOKEN} ` })).toEqual({
      token: TOKEN,
      port: DEFAULT_PANEL_PORT,
      controlPort: DEFAULT_PANEL_CONTROL_PORT,
    });
  });

  it("honours explicit ports", () => {
    expect(
      resolvePanelSettings({
        [PANEL_ENABLED_ENV]: "true",
        [PANEL_TOKEN_ENV]: TOKEN,
        [PANEL_PORT_ENV]: "9100",
        [PANEL_CONTROL_PORT_ENV]: "9101",
      }),
    ).toEqual({ token: TOKEN, port: 9100, controlPort: 9101 });
  });

  it("refuses to start without a token rather than serving an open control plane", () => {
    expect(resolvePanelSettings({ [PANEL_ENABLED_ENV]: "1" })).toBeNull();
    expect(resolvePanelSettings({ [PANEL_ENABLED_ENV]: "1", [PANEL_TOKEN_ENV]: "  " })).toBeNull();
  });

  it("refuses a port collision with the control listener", () => {
    expect(
      resolvePanelSettings({
        [PANEL_ENABLED_ENV]: "1",
        [PANEL_TOKEN_ENV]: TOKEN,
        [PANEL_PORT_ENV]: "8091",
        [PANEL_CONTROL_PORT_ENV]: "8091",
      }),
    ).toBeNull();
  });
});

describe("startPanelServer", () => {
  it("refuses to start without a token", async () => {
    await expect(startPanelServer({ port: 0, token: "", controlPort: 1 })).rejects.toThrow(
      /panel token required/,
    );
    await expect(startPanelServer({ port: 0, token: "  ", controlPort: 1 })).rejects.toThrow(
      /panel token required/,
    );
  });

  it("binds loopback on a free port and reports the real one", async () => {
    const panel = await startPanel(1);
    expect(panel.hostname).toBe("127.0.0.1");
    expect(panel.port).toBeGreaterThan(0);
  });

  it("frees the port on close", async () => {
    const panel = await startPanel(1);
    const port = panel.port;
    await panel.close();
    panels = panels.filter((candidate) => candidate !== panel);
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  });
});

describe("panel static routes", () => {
  it("serves the shell and the liveness probe without a token", async () => {
    const panel = await startPanel(1);

    for (const path of ["/", "/panel"]) {
      const res = await fetch(panelUrl(panel, path));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain("<title>ZCode Proxy");
      expect(html).toContain("/api/control");
    }

    const health = await fetch(panelUrl(panel, "/healthz"));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, service: "zcode-panel" });
  });

  it("answers unknown paths with 404 and a non-POST control call with 405", async () => {
    const panel = await startPanel(1);

    const missing = await fetch(panelUrl(panel, "/nope"));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ ok: false, error: "not_found: GET /nope" });

    const wrongMethod = await fetch(panelUrl(panel, "/api/control"));
    expect(wrongMethod.status).toBe(405);
    expect(await wrongMethod.json()).toEqual({ ok: false, error: "method_not_allowed" });
  });
});

describe("panel control authentication", () => {
  it("rejects a missing or wrong token and never talks to the control listener", async () => {
    const stub = await startStub();
    const panel = await startPanel(stub.port);

    const attempts: RequestInit[] = [
      {},
      { headers: { authorization: "Bearer wrong" } },
      { headers: { "x-panel-token": "wrong" } },
      { headers: { authorization: TOKEN } }, // missing the "Bearer " prefix
    ];
    for (const init of attempts) {
      const res = await controlRequest(panel, init);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
    }
    expect(stub.bodies).toEqual([]);
  });

  it("accepts either header spelling and forwards the body verbatim", async () => {
    const stub = await startStub();
    const panel = await startPanel(stub.port);
    stub.reply = {
      status: 200,
      body: JSON.stringify({ ok: true, event: "quota", quota: { provider: "zai" } }),
    };

    const viaHeader = await controlRequest(panel, {
      headers: { "content-type": "application/json", "x-panel-token": TOKEN },
      body: JSON.stringify({ cmd: "quota" }),
    });
    expect(viaHeader.status).toBe(200);
    expect(await viaHeader.json()).toEqual({
      ok: true,
      event: "quota",
      quota: { provider: "zai" },
    });

    const viaBearer = await controlRequest(panel, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(viaBearer.status).toBe(200);

    expect(stub.bodies).toEqual(['{"cmd":"quota"}', '{"cmd":"status"}']);
  });

  it("passes a control-layer error status and body through unchanged", async () => {
    const stub = await startStub();
    const panel = await startPanel(stub.port);
    stub.reply = { status: 400, body: JSON.stringify({ ok: false, error: "invalid_json" }) };

    const res = await controlRequest(panel, {
      headers: { authorization: `Bearer ${TOKEN}` },
      body: "not json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "invalid_json" });
    expect(stub.bodies).toEqual(["not json"]);
  });

  it("reports control_unavailable when the control listener is down", async () => {
    const stub = await startStub();
    const controlPort = stub.port;
    await stub.close();

    const panel = await startPanel(controlPort);
    const res = await controlRequest(panel, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("control_unavailable");
  });

  it("rejects an oversized command body", async () => {
    const stub = await startStub();
    const panel = await startPanel(stub.port);

    const res = await controlRequest(panel, {
      headers: { authorization: `Bearer ${TOKEN}` },
      body: "x".repeat(70 * 1024),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ ok: false, error: "request_too_large" });
    expect(stub.bodies).toEqual([]);
  });
});
