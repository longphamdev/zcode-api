import { describe, it, expect } from "bun:test";
import { handleAdminState } from "./routes-admin.js";
import { metricsRegistry } from "./metrics.js";

describe("GET /admin/state (#8 dashboard)", () => {
  const reg = metricsRegistry;
  it("requires the proxy API key when configured", async () => {
    const resp = await handleAdminState(new Request("http://x/admin/state"), { proxyApiKey: "secret-key" });
    expect(resp.status).toBe(401);
    const resp2 = await handleAdminState(new Request("http://x/admin/state", { headers: { authorization: "Bearer wrong" } }), { proxyApiKey: "secret-key" });
    expect(resp2.status).toBe(401);
    const resp3 = await handleAdminState(new Request("http://x/admin/state", { headers: { "x-api-key": "secret-key" } }), { proxyApiKey: "secret-key" });
    expect(resp3.status).toBe(200);
  });

  it("open when no proxyApiKey configured", async () => {
    const resp = await handleAdminState(new Request("http://x/admin/state"), {});
    expect(resp.status).toBe(200);
  });

  it("records requests + outcomes per (account, model)", async () => {
    reg.reset();
    reg.recordRequest("acc-a", "glm-5.3-flash");
    reg.recordRequest("acc-a", "glm-5.3-flash");
    reg.recordOutcome("acc-a", "glm-5.3-flash", "success", { tokensUsed: 306 });
    reg.recordOutcome("acc-b", "glm-5.3-flash", "quota1005");
    reg.recordOutcome("acc-b", "glm-5.3-flash", "rate429", { retryAfterSec: 90 });
    reg.recordBusyGlobal("glm-5.3-flash");
    reg.recordPoll("acc-a", [{ model: "model:glm-5.3-flash", remainingUnits: 250_000_000, usedUnits: 50 }]);
    reg.recordTransition("acc-a", "healthy", "exhausted", "biz-1005");
    const snap = reg.snapshot();
    const a = snap.accounts.find((x) => x.id === "acc-a")!;
    expect(a.models["glm-5.3-flash"].requests).toBe(2);
    expect(a.models["glm-5.3-flash"].success).toBe(1);
    expect(a.models["glm-5.3-flash"].tokensUsed).toBe(306);
    expect(snap.accounts.find((x) => x.id === "acc-b")!.models["glm-5.3-flash"].quota1005).toBe(1);
    expect(snap.accounts.find((x) => x.id === "acc-b")!.models["glm-5.3-flash"].lastRetryAfterSec).toBe(90);
    expect(snap.pollHistory["acc-a"]).toHaveLength(1);
    expect(snap.transitions).toHaveLength(1);
    expect(snap.busyGlobal).toBe(1);
    // No credentials anywhere:
    expect(JSON.stringify(snap)).not.toContain("apiKey");
    expect(JSON.stringify(snap)).not.toContain("jwt");
  });
});
