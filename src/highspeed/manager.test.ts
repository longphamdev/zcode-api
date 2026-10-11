import { describe, expect, it } from "bun:test";
import {
  HighspeedManager,
  applyHighspeedCardHeaders,
  isHighspeedCardRejection,
  rewriteBodyModel,
  type HighspeedAuth,
} from "./manager.js";
import type { UpstreamHeaderPair } from "../proxy/upstream.js";

const AUTH: HighspeedAuth = { jwt: "test-jwt", codingPlanAuth: "testkey.testsecret", family: "zai" };
const DRAW_URL = "https://zcode.z.ai/api/v1/highspeed/draw";
const SESSION_TASK = "11111111-2222-3333-4444-555555555555";

interface DrawCall { url: string; body: Record<string, unknown>; headers: Headers; }

function drawResponse(card: Record<string, unknown> | null, nextDrawAt: number): Response {
  return new Response(JSON.stringify({ code: 0, msg: "success", data: { card, next_draw_at: nextDrawAt } }), { status: 200 });
}

function hitCard(now: number, model = "glm-5.3-highspeed"): Record<string, unknown> {
  return { card_id: "hsc_test_1", task_id: SESSION_TASK, provider: "builtin:zai-coding-plan", model, issued_at: now, expires_at: now + 300_000 };
}

function makeManager(fetchImpl: typeof fetch, clock: { now: number }) {
  return new HighspeedManager({
    origin: "https://zcode.z.ai",
    models: ["glm-5.3", "glm-5.2", "glm-5.1"],
    fetchImpl,
    now: () => clock.now,
  });
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5));
}

describe("HighspeedManager", () => {
  it("draws on eligible request, holds the card, and reuses it without redrawing", async () => {
    const clock = { now: 1_000_000 };
    const calls: DrawCall[] = [];
    const manager = makeManager((async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: new Headers(init?.headers) });
      return drawResponse(hitCard(clock.now), clock.now + 120_000);
    }) as unknown as typeof fetch, clock);

    manager.onRequest("glm-5.1", SESSION_TASK, AUTH);
    await settle();
    const card = manager.activeCard();
    expect(card?.cardId).toBe("hsc_test_1");
    expect(card?.model).toBe("glm-5.3-highspeed");

    // second eligible request while holding → no new draw
    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    await settle();
    expect(calls.length).toBe(1);

    // draw request shape: auth trio + body fields (official contract)
    expect(calls[0]!.url).toBe(DRAW_URL);
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer test-jwt");
    expect(calls[0]!.headers.get("x-bigmodel-authorization")).toBe("Bearer testkey.testsecret");
    expect(calls[0]!.headers.get("bigmodel-target-type")).toBe("PERSONAL");
    expect(calls[0]!.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[0]!.body.task_id).toBe(SESSION_TASK);
    expect(calls[0]!.body.provider).toBe("builtin:zai-coding-plan");
    expect(calls[0]!.body.model).toBe("glm-5.1");
  });

  it("treats a miss as cooldown: no redraw until server next_draw_at", async () => {
    const clock = { now: 1_000_000 };
    let fetches = 0;
    const manager = makeManager((async () => {
      fetches++;
      return drawResponse(null, clock.now + 120_000);
    }) as unknown as typeof fetch, clock);

    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    await settle();
    clock.now += 60_000;
    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    await settle();
    expect(fetches).toBe(1); // still cooling down

    clock.now += 61_000; // past next_draw_at
    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    await settle();
    expect(fetches).toBe(2);
  });

  it("negative-caches account unavailability (503 / biz 3404) for 10 minutes", async () => {
    const clock = { now: 1_000_000 };
    let fetches = 0;
    const manager = makeManager((async () => {
      fetches++;
      return new Response(JSON.stringify({ code: 3404, msg: "highspeed is temporarily unavailable" }), { status: 503 });
    }) as unknown as typeof fetch, clock);

    manager.onRequest("glm-5.2", SESSION_TASK, AUTH);
    await settle();
    clock.now += 120_000; // past a normal cooldown
    manager.onRequest("glm-5.2", SESSION_TASK, AUTH);
    await settle();
    expect(fetches).toBe(1); // still negative-cached

    clock.now += 10 * 60_000 + 1_000;
    manager.onRequest("glm-5.2", SESSION_TASK, AUTH);
    await settle();
    expect(fetches).toBe(2);
  });

  it("backs off 30s on HTTP 429", async () => {
    const clock = { now: 1_000_000 };
    let fetches = 0;
    const manager = makeManager((async () => {
      fetches++;
      return new Response("", { status: 429 });
    }) as unknown as typeof fetch, clock);

    manager.onRequest("glm-5.1", SESSION_TASK, AUTH);
    await settle();
    clock.now += 20_000;
    manager.onRequest("glm-5.1", SESSION_TASK, AUTH);
    await settle();
    expect(fetches).toBe(1);
    clock.now += 11_000;
    manager.onRequest("glm-5.1", SESSION_TASK, AUTH);
    await settle();
    expect(fetches).toBe(2);
  });

  it("expires cards and applies a minimum-remaining window", async () => {
    const clock = { now: 1_000_000 };
    const manager = makeManager((async () => drawResponse(hitCard(clock.now), clock.now + 120_000)) as unknown as typeof fetch, clock);
    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    await settle();
    expect(manager.activeCard()).toBeDefined();

    clock.now += 295_000; // 5s left on the window
    expect(manager.activeCard()).toBeNull(); // under the 10s minimum-remaining guard

    clock.now += 10_000; // past expires_at
    manager.onRequest("glm-5.3", SESSION_TASK, AUTH); // redraw allowed
    await settle();
    // second draw fired (fetch mock returns a fresh card each call)
  });

  it("deduplicates concurrent draws into a single fetch", async () => {
    const clock = { now: 1_000_000 };
    let fetches = 0;
    const manager = makeManager((async () => {
      fetches++;
      await new Promise((r) => setTimeout(r, 10));
      return drawResponse(hitCard(clock.now), clock.now + 120_000);
    }) as unknown as typeof fetch, clock);

    manager.onRequest("glm-5.3", SESSION_TASK, AUTH);
    manager.onRequest("glm-5.3", "another-task", AUTH);
    manager.onRequest("glm-5.3", "third-task", AUTH);
    await settle();
    await settle();
    expect(fetches).toBe(1);
  });

  it("skips drawing without a JWT and matches only configured model prefixes", async () => {
    let fetches = 0;
    const manager = makeManager((async () => {
      fetches++;
      return drawResponse(null, 0);
    }) as unknown as typeof fetch, { now: 1_000_000 });

    manager.onRequest("glm-5.3", SESSION_TASK, { ...AUTH, jwt: "  " });
    await settle();
    expect(fetches).toBe(0);

    expect(manager.isEligibleModel("glm-5.3")).toBeTrue();
    expect(manager.isEligibleModel("GLM-5.3-Flash")).toBeTrue();
    expect(manager.isEligibleModel("glm-4.6")).toBeFalse();
    expect(manager.isEligibleModel(undefined)).toBeFalse();
    manager.onRequest("glm-4.6", SESSION_TASK, AUTH);
    await settle();
    expect(fetches).toBe(0);
  });
});

describe("highspeed helpers", () => {
  it("rewriteBodyModel swaps the model field and tolerates non-JSON", () => {
    expect(rewriteBodyModel('{"model":"glm-5.1","messages":[]}', "glm-5.3-highspeed"))
      .toBe('{"model":"glm-5.3-highspeed","messages":[]}');
    expect(rewriteBodyModel("not json", "glm-5.3-highspeed")).toBe("not json");
    expect(rewriteBodyModel('{"messages":[]}', "x")).toBe('{"messages":[]}');
  });

  it("applyHighspeedCardHeaders swaps the coding-plan dual auth and appends the card set", () => {
    const pairs: UpstreamHeaderPair[] = [
      ["content-type", "application/json"],
      ["x-api-key", "testkey.testsecret"],
      ["authorization", "Bearer testkey.testsecret"],
    ];
    const out = applyHighspeedCardHeaders(pairs, {
      cardId: "hsc_1", taskId: "t", model: "glm-5.3-highspeed", issuedAt: 0, expiresAt: 1,
    }, AUTH);
    expect(out.find(([k]) => k.toLowerCase() === "x-api-key")?.[1]).toBe("test-jwt");
    expect(out.find(([k]) => k.toLowerCase() === "authorization")?.[1]).toBe("Bearer test-jwt");
    expect(out.find(([k]) => k === "X-Bigmodel-Authorization")?.[1]).toBe("Bearer testkey.testsecret");
    expect(out.find(([k]) => k === "Bigmodel-Target-Type")?.[1]).toBe("PERSONAL");
    expect(out.find(([k]) => k === "X-Highspeed-Card-ID")?.[1]).toBe("hsc_1");
    expect(out.length).toBe(pairs.length + 3);
  });

  it("isHighspeedCardRejection matches 401 and biz-3402 envelopes only", async () => {
    expect(await isHighspeedCardRejection(new Response("nope", { status: 401 }))).toBeTrue();
    expect(await isHighspeedCardRejection(new Response(JSON.stringify({ code: 3402, msg: "highspeed_card_expired" }), { status: 400 }))).toBeTrue();
    expect(await isHighspeedCardRejection(new Response(JSON.stringify({ code: 3007 }), { status: 400 }))).toBeFalse();
    expect(await isHighspeedCardRejection(new Response("data: hi\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }))).toBeFalse();
    expect(await isHighspeedCardRejection(new Response("plain", { status: 400 }))).toBeFalse();
  });
});
