/**
 * Optional web panel for headless deployments (issue #58).
 *
 * `serve` has no TUI, and inside Docker there is no terminal to render one
 * into — today the only way to see quota, switch provider/plan or read live
 * logs is `docker exec` plus hand-editing `config.yaml` and restarting. This
 * module exposes the *existing* localhost control protocol
 * (`src/android/control.ts`, already used by the Android shell) through a
 * token-guarded HTTP surface plus one embedded page. It adds no new state and
 * no new upstream calls:
 *
 *   browser → panel (token) → POST /api/control → 127.0.0.1:<controlPort>/control
 *
 * Security model (deliberate, see the discussion on #58):
 *  - off by default: `ZCODE_PANEL_ENABLED` must be set to a truthy value;
 *  - a non-empty `ZCODE_PANEL_TOKEN` is mandatory — no token, no listener;
 *  - binds loopback only, and never touches `auth.proxyApiKey` or `/v1/*`,
 *    so enabling the panel does not change the proxy's own auth surface;
 *  - `/api/*` requires `Authorization: Bearer <token>` or `X-Panel-Token`,
 *    compared with `timingSafeEqual`;
 *  - the control listener keeps its own loopback check and its own port, so a
 *    reachable panel is not a privilege escalation of the `/webui` exemption;
 *  - `GET /` and `GET /healthz` are tokenless because a browser cannot attach
 *    a header to a top-level navigation: `/` returns the static shell (no
 *    account data) and `/healthz` returns a fixed `{"ok":true}`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import panelHtml from "./panel-page.txt" with { type: "text" };

/** Env flag that enables the panel. Empty / `0` / `false` / `no` / `off` = off. */
export const PANEL_ENABLED_ENV = "ZCODE_PANEL_ENABLED";
/** Shared secret for `/api/*`. Required whenever the panel is enabled. */
export const PANEL_TOKEN_ENV = "ZCODE_PANEL_TOKEN";
/** Panel listen port (loopback). */
export const PANEL_PORT_ENV = "ZCODE_PANEL_PORT";
/** Loopback port of the control listener the panel forwards to. */
export const PANEL_CONTROL_PORT_ENV = "ZCODE_PANEL_CONTROL_PORT";

/** Defaults mirror the Android entry's wiring so operators only set one thing. */
export const DEFAULT_PANEL_PORT = 8090;
export const DEFAULT_PANEL_CONTROL_PORT = 8091;

/** Control commands are small JSON documents; anything bigger is a mistake. */
const MAX_BODY_BYTES = 64 * 1024;
/** A `quota` command can hit two upstream planes, so allow a slow answer. */
const CONTROL_TIMEOUT_MS = 30_000;

export interface PanelOptions {
  /** HTTP port. `0` picks a free port (used by tests). */
  port: number;
  /** Shared secret required on `/api/*`; must be non-empty. */
  token: string;
  /** Loopback port of the control listener to forward commands to. */
  controlPort: number;
  /** Bind address. Loopback by default and intentionally not configurable. */
  hostname?: string;
}

/** Handle for a running panel; `close()` releases the port. */
export interface PanelServer {
  hostname: string;
  port: number;
  close(): Promise<void>;
}

/** Fully resolved panel settings; only produced when the panel should run. */
export interface PanelSettings {
  token: string;
  port: number;
  controlPort: number;
}

/** Request handler produced by {@link createPanelHandler}. */
export type PanelHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/**
 * True when `ZCODE_PANEL_ENABLED` asks for the panel. Kept deliberately strict
 * and case-insensitive so `ZCODE_PANEL_ENABLED=0`/`false` stay off.
 */
export function isPanelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[PANEL_ENABLED_ENV] ?? "").trim().toLowerCase();
  return raw !== "" && raw !== "0" && raw !== "false" && raw !== "no" && raw !== "off";
}

/**
 * Resolve the panel configuration from the environment. Returns `null` when the
 * panel must not start — either it was not requested, or it was requested
 * without a token / with a port collision, both of which are configuration
 * mistakes worth a loud message rather than an unauthenticated listener.
 */
export function resolvePanelSettings(env: NodeJS.ProcessEnv = process.env): PanelSettings | null {
  if (!isPanelEnabled(env)) return null;

  const token = (env[PANEL_TOKEN_ENV] ?? "").trim();
  if (!token) {
    console.error(`[panel] ${PANEL_ENABLED_ENV} is set but ${PANEL_TOKEN_ENV} is empty — panel not started`);
    return null;
  }

  const port = Number(env[PANEL_PORT_ENV] ?? DEFAULT_PANEL_PORT) || DEFAULT_PANEL_PORT;
  const controlPort =
    Number(env[PANEL_CONTROL_PORT_ENV] ?? DEFAULT_PANEL_CONTROL_PORT) || DEFAULT_PANEL_CONTROL_PORT;
  if (port === controlPort) {
    console.error(
      `[panel] ${PANEL_PORT_ENV} and ${PANEL_CONTROL_PORT_ENV} must differ (both ${port}) — panel not started`,
    );
    return null;
  }

  return { token, port, controlPort };
}

/** First value of a possibly-repeated request header. */
function headerValue(raw: string | string[] | undefined): string | undefined {
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

/** Constant-time token comparison (only the length is revealed). */
function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Accept either `Authorization: Bearer <token>` or `X-Panel-Token: <token>`. */
function extractToken(req: IncomingMessage): string | undefined {
  const direct = headerValue(req.headers["x-panel-token"]);
  if (direct) return direct.trim();
  const auth = headerValue(req.headers["authorization"]);
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
  });
  res.end(html);
}

/**
 * Read the request body, rejecting anything above {@link MAX_BODY_BYTES}.
 * The oversized case keeps draining the socket before answering: replying
 * while the client is still writing can reset the connection and lose the 413.
 * Returns `null` when the body is too large.
 */
async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
      continue;
    }
    chunks.push(buf);
  }
  return tooLarge ? null : Buffer.concat(chunks).toString("utf8");
}

/**
 * Forward one command to the control listener. Status and body are passed
 * through unchanged, so the panel speaks exactly the documented protocol
 * (`{ok:true,...}` / `{ok:false,error}`) and never invents a shape.
 */
async function forwardToControl(
  controlPort: number,
  body: string,
): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONTROL_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${controlPort}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: controller.signal,
    });
    return { status: res.status, body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the panel request handler. Exported separately from
 * {@link startPanelServer} so tests can drive it without binding a port.
 */
export function createPanelHandler(opts: PanelOptions): PanelHandler {
  const token = opts.token;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    const path = url.split("?")[0] ?? "/";

    // Static shell + liveness: tokenless by design (see the file header).
    if (method === "GET" && (path === "/" || path === "/panel")) {
      sendHtml(res, panelHtml);
      return;
    }
    if (method === "GET" && (path === "/healthz" || path === "/api/panel/health")) {
      sendJson(res, 200, { ok: true, service: "zcode-panel" });
      return;
    }

    if (path !== "/api/control") {
      sendJson(res, 404, { ok: false, error: `not_found: ${method} ${path}` });
      return;
    }
    if (method !== "POST") {
      sendJson(res, 405, { ok: false, error: "method_not_allowed" });
      return;
    }
    if (!tokenMatches(extractToken(req), token)) {
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }

    const body = await readBody(req);
    if (body === null) {
      sendJson(res, 413, { ok: false, error: "request_too_large" });
      return;
    }

    try {
      const upstream = await forwardToControl(opts.controlPort, body);
      const payload = upstream.body;
      res.writeHead(upstream.status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(payload),
        "cache-control": "no-store",
      });
      res.end(payload);
    } catch (err) {
      // The control listener is not up (wrong port, crashed, timed out): say so
      // instead of returning a bare 500, because that is the common misconfig.
      sendJson(res, 502, {
        ok: false,
        error: `control_unavailable: ${(err as Error).message}`,
      });
    }
  };
}

/**
 * Start the panel on the loopback interface. Throws when the token is missing
 * (silently starting an unauthenticated panel is the one outcome this module
 * refuses to allow) or when the port cannot be bound.
 */
export async function startPanelServer(opts: PanelOptions): Promise<PanelServer> {
  const token = (opts.token ?? "").trim();
  if (!token) throw new Error(`panel token required (set ${PANEL_TOKEN_ENV})`);
  const hostname = opts.hostname ?? "127.0.0.1";
  const handler = createPanelHandler({ ...opts, token });
  const server: Server = createServer((req, res) => {
    void handler(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen(opts.port, hostname, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : opts.port;
  return {
    hostname,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
