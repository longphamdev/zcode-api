/**
 * HighSpeed 加速卡管理 — mirrors ZCode 3.15.1 `HighspeedCardService`
 * (host chunk-3JWYEFTD `wo`; transport `Ar` = createHighspeedHttpTransport).
 *
 * 官方语义（`_reverse/NOTEPAD.md` §C）：
 * - 每条消息提交时尝试 `POST {origin}/api/v1/highspeed/draw`（1s 预算，
 *   mock `Ys=1e3`）；命中获得限时加速卡（mock `expires_at = now + 3e5` ≈ 5min），
 *   未命中/冷却由服务端 `next_draw_at`（mock ≈ 2min）节流。
 * - 单卡槽：持卡期间不再抽；卡绑 task_id（官方=会话/任务）。
 * - 鉴权（`Js` buildHighspeedCodingPlanAuthHeaders，与 MCP relay 同配方）：
 *   Authorization: Bearer <zcode JWT> + X-Bigmodel-Authorization: Bearer <coding-plan
 *   token> + Bigmodel-Target-Type。2026-10-10 实弹：API-key 配方同样过 auth 层。
 *
 * 反代偏差（deliberate deviations，官方为"每消息尝试、卡绑单任务"）：
 * - 抽卡由合格请求到达触发（懒启动 worker），不逐消息阻塞；
 * - task_id 复用 client-session affinity 推断（`upstreamSessionId`），无会话时
 *   每次抽卡用随机 UUID；
 * - 持卡窗口内的所有合格请求共享该卡（官方仅卡所属任务可用；推理路径只带
 *   X-Highspeed-Card-ID，无服务端 task 校验证据）。
 * - 503/biz 3404（账号未灰度，2026-10-10 实弹稳态）负缓存 10min，避免 12.6s
 *   级联延迟反复触发。
 */
import { randomUUID } from "node:crypto";
import type { UpstreamHeaderPair } from "../proxy/upstream.js";
import type { Credential } from "../auth/types.js";
import { credentialString } from "../auth/types.js";

const DRAW_PATH = "/api/v1/highspeed/draw";
const DRAW_TIMEOUT_MS = 5_000;
/** Negative cache after account-level unavailability (503 / biz 3404). */
const UNAVAILABLE_MS = 10 * 60_000;
/** Backoff after an HTTP 429 (measured token bucket ≈ capacity 8, refill 1/s). */
const RATE_LIMIT_BACKOFF_MS = 30_000;
/** Fallback cooldown when the server does not send next_draw_at. */
const DEFAULT_COOLDOWN_MS = 2 * 60_000;
/** Cooldown after transport failure (network / timeout). */
const TRANSPORT_FAILURE_MS = 60_000;
/** Skip applying a card with less than this left on its window. */
const CARD_MIN_REMAINING_MS = 10_000;

export interface HighspeedCard {
  cardId: string;
  taskId: string;
  model: string;
  issuedAt: number;
  expiresAt: number;
}

export interface HighspeedAuth {
  /** zcode plan JWT (`Credential.jwt`) — required for both draw and card headers. */
  jwt: string;
  /** Coding-plan credential string for X-Bigmodel-Authorization. */
  codingPlanAuth: string;
  /** Provider family of the active coding plan. */
  family: "zai" | "bigmodel";
}

interface DrawResponseBody {
  code?: unknown;
  msg?: unknown;
  data?: { card?: DrawCardWire | null; next_draw_at?: unknown };
}

interface DrawCardWire {
  card_id?: unknown;
  task_id?: unknown;
  provider?: unknown;
  model?: unknown;
  issued_at?: unknown;
  expires_at?: unknown;
}

export class HighspeedManager {
  private readonly origin: string;
  private readonly models: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly notedKeys = new Set<string>();
  onEvent?: (message: string) => void;

  private card: HighspeedCard | null = null;
  private nextDrawAt = 0;
  private unavailableUntil = 0;
  private drawInFlight: { model: string; taskId: string; auth: HighspeedAuth; promise: Promise<void> } | null = null;

  constructor(opts: {
    origin: string;
    models: string[];
    fetchImpl?: typeof fetch;
    now?: () => number;
    onEvent?: (message: string) => void;
  }) {
    this.origin = opts.origin.replace(/\/+$/u, "");
    this.models = opts.models.map((m) => m.trim().toLowerCase()).filter(Boolean);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.onEvent = opts.onEvent;
  }

  /** Prefix match against the configured eligible families (glm-5.3/5.2/5.1 …). */
  isEligibleModel(model: string | undefined): boolean {
    if (!model) return false;
    const m = model.trim().toLowerCase();
    return this.models.some((prefix) => m === prefix || m.startsWith(`${prefix}-`));
  }

  /**
   * Fire-and-forget draw trigger — call on every eligible coding-plan request.
   * Respects the single card slot, server cooldown and the unavailability
   * window; concurrent calls deduplicate into one in-flight draw.
   */
  onRequest(model: string, sessionTaskId: string | undefined, auth: HighspeedAuth): void {
    if (!this.isEligibleModel(model)) return;
    const now = this.now();
    this.expireCard(now);
    if (this.card) return;
    if (now < this.nextDrawAt || now < this.unavailableUntil) return;
    if (this.drawInFlight) return;
    if (!auth.jwt.trim()) {
      this.noteOnce("no-jwt", "credential has no zcode JWT — highspeed disabled until re-login");
      return;
    }
    const taskId = sessionTaskId ?? randomUUID();
    const promise = this.draw(model, taskId, auth)
      .catch(() => {
        // draw() never throws (all outcomes map to cooldown windows); network
        // throws land here as an extra guard.
        this.nextDrawAt = this.now() + TRANSPORT_FAILURE_MS;
      })
      .finally(() => {
        if (this.drawInFlight?.promise === promise) this.drawInFlight = null;
      });
    this.drawInFlight = { model, taskId, auth, promise };
  }

  /** The active card, or null when outside the window (expiry-checked). */
  activeCard(): HighspeedCard | null {
    this.expireCard(this.now());
    if (!this.card) return null;
    if (this.card.expiresAt - this.now() < CARD_MIN_REMAINING_MS) return null;
    return this.card;
  }

  /** Drop the card after an upstream rejection (401 / biz 3402) — official selectionFallback. */
  dropCard(reason: string): void {
    if (!this.card) return;
    this.card = null;
    this.onEvent?.(`highspeed: card dropped (${reason})`);
  }

  private expireCard(now: number): void {
    if (this.card && this.card.expiresAt <= now) {
      this.onEvent?.(`highspeed: card ${this.card.cardId} expired`);
      this.card = null;
    }
  }

  private async draw(model: string, taskId: string, auth: HighspeedAuth): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DRAW_TIMEOUT_MS);
    let status = 0;
    let body: DrawResponseBody | null = null;
    try {
      const resp = await this.fetchImpl(`${this.origin}${DRAW_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Authorization": auth.jwt.startsWith("Bearer ") ? auth.jwt : `Bearer ${auth.jwt}`,
          "X-Bigmodel-Authorization": `Bearer ${auth.codingPlanAuth}`,
          "Bigmodel-Target-Type": "PERSONAL",
          "x-request-id": randomUUID(),
        },
        body: JSON.stringify({
          task_id: taskId,
          provider: `builtin:${auth.family}-coding-plan`,
          model,
        }),
        redirect: "manual",
        signal: controller.signal,
      });
      status = resp.status;
      try {
        body = await resp.json() as DrawResponseBody;
      } catch {
        body = null;
      }
    } catch {
      this.nextDrawAt = this.now() + TRANSPORT_FAILURE_MS;
      this.noteOnce("transport", "highspeed draw failed (network/timeout) — retrying later");
      return;
    } finally {
      clearTimeout(timer);
    }

    const now = this.now();
    if (status === 429) {
      this.nextDrawAt = now + RATE_LIMIT_BACKOFF_MS;
      this.noteOnce("429", "highspeed draw rate-limited (429) — backing off 30s");
      return;
    }
    if (status !== 200 || !body) {
      this.unavailableUntil = now + UNAVAILABLE_MS;
      this.noteOnce(`http${status}`, `highspeed draw unavailable (HTTP ${status}) — negative-cached 10min`);
      return;
    }
    const code = typeof body.code === "number" ? body.code : null;
    if (code !== 0) {
      // 3404 = account-level "highspeed temporarily unavailable" (live 2026-10-10).
      // Any other business code is treated the same: negative-cache, never spin.
      this.unavailableUntil = now + UNAVAILABLE_MS;
      this.noteOnce(`biz${code}`, `highspeed draw rejected (code=${code} ${String(body.msg ?? "").slice(0, 60)}) — negative-cached 10min`);
      return;
    }
    const data = body.data ?? {};
    this.nextDrawAt = typeof data.next_draw_at === "number" && data.next_draw_at > now
      ? data.next_draw_at
      : now + DEFAULT_COOLDOWN_MS;
    const wire = data.card;
    if (wire && typeof wire.card_id === "string" && wire.card_id
      && typeof wire.model === "string" && wire.model
      && typeof wire.expires_at === "number" && wire.expires_at > now) {
      this.card = {
        cardId: wire.card_id,
        taskId: typeof wire.task_id === "string" ? wire.task_id : taskId,
        model: wire.model,
        issuedAt: typeof wire.issued_at === "number" ? wire.issued_at : now,
        expiresAt: wire.expires_at,
      };
      this.onEvent?.(`highspeed: card drawn (${this.card.cardId.slice(0, 12)}… model=${this.card.model} window=${Math.round((this.card.expiresAt - now) / 1000)}s)`);
    } else {
      this.noteOnce("miss", "highspeed draw miss (card=null) — honoring next_draw_at cooldown");
    }
  }

  private noteOnce(key: string, message: string): void {
    if (this.notedKeys.has(key)) return;
    this.notedKeys.add(key);
    this.onEvent?.(`highspeed: ${message}`);
  }
}

/** Rewrite the `model` field of a JSON request body (parse failure → unchanged). */
export function rewriteBodyModel(body: string, model: string): string {
  try {
    const parsed = JSON.parse(body) as { model?: unknown };
    if (!parsed || typeof parsed !== "object" || typeof parsed.model !== "string") return body;
    parsed.model = model;
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

/**
 * Apply the official highspeed auth shape to upstream header pairs
 * (`buildHighspeedTurnExecution` requestAuth): the coding-plan dual
 * `x-api-key`/`Authorization` values are replaced by the zcode JWT, and the
 * coding-plan / card headers are appended.
 */
export function applyHighspeedCardHeaders(
  pairs: UpstreamHeaderPair[],
  card: HighspeedCard,
  auth: HighspeedAuth,
): UpstreamHeaderPair[] {
  const bare = auth.jwt.startsWith("Bearer ") ? auth.jwt.slice(7).trim() : auth.jwt;
  const bearer = `Bearer ${bare}`;
  const swapped = pairs.map(([name, value]): UpstreamHeaderPair => {
    const lower = name.toLowerCase();
    // official requestAuth: apiKey slot (SDK x-api-key) carries the bare JWT,
    // the Authorization header carries the Bearer form
    if (lower === "x-api-key") return [name, bare];
    if (lower === "authorization") return [name, bearer];
    return [name, value];
  });
  return [
    ...swapped,
    ["X-Bigmodel-Authorization", `Bearer ${auth.codingPlanAuth}`],
    ["Bigmodel-Target-Type", "PERSONAL"],
    ["X-Highspeed-Card-ID", card.cardId],
  ];
}

/** True when an upstream response is a card-auth rejection (HTTP 401 or biz 3402). */
export async function isHighspeedCardRejection(resp: Response): Promise<boolean> {
  if (resp.status === 401) return true;
  if (resp.status !== 200 && resp.status < 500) {
    try {
      const body = await resp.clone().json() as { code?: unknown };
      if (body?.code === 3402) return true;
    } catch {
      // non-JSON — not a card rejection
    }
  }
  return false;
}

/** Credential → HighspeedAuth (returns null when the JWT needed for draw is missing). */
export function highspeedAuthFrom(cred: Credential): HighspeedAuth | null {
  if (!cred.jwt?.trim()) return null;
  return {
    jwt: cred.jwt,
    codingPlanAuth: credentialString(cred),
    family: cred.provider === "bigmodel" ? "bigmodel" : "zai",
  };
}

let defaultManager: HighspeedManager | null = null;
let defaultManagerKey = "";

/**
 * Process-wide manager (single card slot, like the official host service).
 * Returns null when `highspeed.enabled` is false. Recreated when origin/models
 * change (Android `setConfig`).
 */
export function getDefaultHighspeedManager(config: {
  highspeed: { enabled: boolean; origin: string; models: string[] };
}): HighspeedManager | null {
  if (!config.highspeed.enabled) return null;
  const key = `${config.highspeed.origin}\n${config.highspeed.models.join(",")}`;
  if (!defaultManager || key !== defaultManagerKey) {
    defaultManager = new HighspeedManager({
      origin: config.highspeed.origin,
      models: config.highspeed.models,
      // State transitions (drawn / miss / cooldown / dropped) are otherwise
      // silent in production — surface each once per kind.
      onEvent: (message) => console.log(`client-${message}`),
    });
    defaultManagerKey = key;
  }
  return defaultManager;
}
