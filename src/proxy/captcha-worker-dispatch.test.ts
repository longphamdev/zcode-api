import { afterAll, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  __resetCaptchaWorkerDispatchForTest,
  solveViaWorkerOrInProcess,
} from "./captcha-worker-dispatch.js";

// The dispatch layer must degrade, not fail, when the worker path is
// unusable. Worker mode is exercised with a REAL worker_threads round trip
// against a canned fixture entry (no happy-dom, no network); the fallback
// cases replace the in-process solver with a mock. Module-level caches are
// reset between cases via the test hook. (This file deliberately does NOT
// import captcha-solver.js: captcha-pool.test.ts registers a process-wide
// mock.module for that specifier, which would shadow the real exports.)
describe("captcha worker dispatch (worker / in-process)", () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-worker-"));
  const fixturePath = path.join(fixtureDir, "fixture-worker.mjs");
  fs.writeFileSync(
    fixturePath,
    [
      'import { parentPort } from "node:worker_threads";',
      "if (!parentPort) throw new Error('fixture requires parent port');",
      "parentPort.on('message', (m) => {",
      "  parentPort.postMessage({ id: m.id, ok: true, param: `fixture-param:${m.scene}:${m.region}` });",
      "});",
    ].join("\n"),
    "utf8",
  );
  afterAll(() => {
    try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch {}
  });

  test("solves via a real worker when the entry asset resolves", async () => {
    mock.module("./captcha-worker-asset.js", () => ({ default: fixturePath }));
    __resetCaptchaWorkerDispatchForTest();
    const param = await solveViaWorkerOrInProcess({ scene: "sc1", region: "rg1", prefix: "pf1" });
    expect(param).toBe("fixture-param:sc1:rg1");
  });

  test("falls back to in-process solving when the entry is unavailable", async () => {
    mock.module("./captcha-worker-asset.js", () => ({ default: null }));
    mock.module("./captcha-happy.js", () => ({
      solveTraceless: async (opts: { scene: string }) => `inproc-param:${opts.scene}`,
    }));
    __resetCaptchaWorkerDispatchForTest();
    const param = await solveViaWorkerOrInProcess({ scene: "sc2", region: "rg2", prefix: "pf2" });
    expect(param).toBe("inproc-param:sc2");
  });

  test("an unloadable worker entry degrades to in-process solving", async () => {
    // A path that cannot be loaded as a worker module (a directory): Bun
    // reports it via the worker 'error' event as a module-not-found, which
    // must fall back, not reject (a runtime crash inside a LOADED worker,
    // by contrast, stays a hard failure handled by the pool's retry ladder).
    mock.module("./captcha-worker-asset.js", () => ({ default: fixtureDir }));
    mock.module("./captcha-happy.js", () => ({
      solveTraceless: async (opts: { scene: string }) => `inproc-param:${opts.scene}`,
    }));
    __resetCaptchaWorkerDispatchForTest();
    const param = await solveViaWorkerOrInProcess({ scene: "sc3", region: "rg3", prefix: "pf3" });
    expect(param).toBe("inproc-param:sc3");
  });
});
