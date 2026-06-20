/**
 * Aliyun Captcha V3 headless solver via jsdom.
 *
 * Uses the local AliyunCaptcha.js SDK (bundled from _reverse/) in a jsdom
 * fake DOM. No browser binary needed — the SDK only uses document/window/
 * XMLHttpRequest, all of which jsdom provides natively.
 *
 * Token lifecycle: solved via traceless verification (no UI), cached ~45s,
 * sent on every start-plan request as x-aliyun-captcha-verify-param +
 * x-aliyun-captcha-verify-region. On 403 — re-solve and retry.
 *
 * @see _reverse/zcode.cjs `o5r()` / `createZcodePlanCaptchaEmptyStreamBusinessError`
 * @see _reverse/AliyunCaptcha.js (local SDK, 219KB)
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CAPTCHA_HEADER = "x-aliyun-captcha-verify-param";
const REGION_HEADER = "x-aliyun-captcha-verify-region";
const CONFIGS_API = "https://zcode.z.ai/api/v1/client/configs";
const TOKEN_TTL_MS = 45_000;

const __dirname = dirname(fileURLToPath(import.meta.url));

let sdkCache: string | null = null;
function loadSdkSource(): string {
  if (sdkCache) return sdkCache;
  sdkCache = readFileSync(join(__dirname, "AliyunCaptcha.js"), "utf-8");
  return sdkCache;
}

interface FetchedCaptchaConfig {
  enabled: boolean;
  prefix: string;
  sceneId: string;
  region: string;
}

let cachedConfig: { value: FetchedCaptchaConfig | null; expiresAt: number } = { value: null, expiresAt: 0 };
let cachedToken: { verifyParam: string; region: string; expiresAt: number } | null = null;

export function detectCaptchaChallenge(resp: Response): string | null {
  const v = resp.headers.get(CAPTCHA_HEADER);
  if (!v) return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function fetchCaptchaConfig(): Promise<FetchedCaptchaConfig | null> {
  if (cachedConfig.value && cachedConfig.expiresAt > Date.now()) {
    return cachedConfig.value;
  }
  try {
    const url = `${CONFIGS_API}?app_version=3.1.1&platform=win32-x64`;
    const resp = await fetch(url);
    const json = (await resp.json()) as { code?: number; data?: { configs?: { captcha?: FetchedCaptchaConfig } } };
    const cfg = json?.data?.configs?.captcha ?? null;
    cachedConfig = { value: cfg, expiresAt: Date.now() + 60000 };
    return cfg;
  } catch {
    return null;
  }
}

/**
 * Get a valid captcha token, solving if needed. Cached for ~45s per Aliyun spec.
 */
export async function getCaptchaToken(): Promise<{ verifyParam: string; region: string }> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return { verifyParam: cachedToken.verifyParam, region: cachedToken.region };
  }

  const cfg = await fetchCaptchaConfig();
  if (!cfg || !cfg.enabled || !cfg.prefix || !cfg.sceneId) {
    throw new Error("Captcha config unavailable from ZCode API");
  }

  const verifyParam = await solveInJsdom(cfg);
  cachedToken = { verifyParam, region: cfg.region, expiresAt: Date.now() + TOKEN_TTL_MS };
  return { verifyParam, region: cfg.region };
}

async function solveInJsdom(cfg: FetchedCaptchaConfig): Promise<string> {
  const { JSDOM } = await loadJsdom();
  const sdkSource = loadSdkSource();

  const dom = new JSDOM(
    `<!DOCTYPE html><html><head></head><body><div id="captcha-element"></div><button id="captcha-button">verify</button></body></html>`,
    {
      url: "https://zcode.z.ai/",
      runScripts: "outside-only",
      resources: "usable",
      pretendToBeVisual: true,
    },
  );

  const w = dom.window as unknown as {
    AliyunCaptchaConfig?: { region: string; prefix: string };
    initAliyunCaptcha?: (opts: Record<string, unknown>) => Promise<unknown> | unknown;
    eval?: (code: string) => void;
  };

  w.AliyunCaptchaConfig = { region: cfg.region, prefix: cfg.prefix };

  const scriptEl = dom.window.document.createElement("script");
  scriptEl.textContent = sdkSource;
  dom.window.document.head.appendChild(scriptEl);

  if (typeof w.initAliyunCaptcha !== "function") {
    throw new Error("AliyunCaptcha.js failed to expose initAliyunCaptcha in jsdom");
  }

  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("captcha solve timeout after 30s"));
    }, 30000);

    w.initAliyunCaptcha!({
      SceneId: cfg.sceneId,
      prefix: cfg.prefix,
      mode: "popup",
      language: "cn",
      showErrorTip: false,
      element: "#captcha-element",
      button: "#captcha-button",
      getInstance: () => {},
      success: (param: string) => {
        clearTimeout(timeout);
        resolve(param);
      },
      fail: (err: unknown) => {
        clearTimeout(timeout);
        reject(new Error(`Aliyun SDK fail: ${JSON.stringify(err)}`));
      },
      onError: (err: unknown) => {
        clearTimeout(timeout);
        reject(new Error(`Aliyun SDK error: ${JSON.stringify(err)}`));
      },
    });
  });
}

async function loadJsdom(): Promise<{ JSDOM: typeof import("jsdom").JSDOM }> {
  try {
    return await import("jsdom");
  } catch {
    throw new Error(
      "jsdom is not installed. Install with: bun add jsdom",
    );
  }
}

export function invalidateCaptchaToken(): void {
  cachedToken = null;
}

export const RETRY_HEADERS = { PARAM: CAPTCHA_HEADER, REGION: REGION_HEADER };
