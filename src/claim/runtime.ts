/**
 * Wiring between the claim subsystem and the rest of the proxy: builds a
 * scheduler from a loaded `ProxyConfig` + `AuthManager` (serve path) and
 * implements the one-shot CLI flow (`zcode-proxy claim [list|now]`).
 */
import type { AuthManager } from "../auth/manager.js";
import type { ProxyConfig } from "../config/types.js";
import type { ClaimablePlan, ClaimOutcome } from "./types.js";
import type { Credential } from "../auth/types.js";
import { credentialString } from "../auth/types.js";
import { createClaimClient, ClaimPreviewError } from "./client.js";
import { listAccounts, type StoredAccount } from "../auth/accounts.js";
import { ClaimScheduler } from "./scheduler.js";
import { getCaptchaToken } from "../proxy/captcha.js";
import { metricsRegistry } from "../server/metrics.js";
import { loadCredential } from "../auth/store.js";
import { getDefaultEndpointRouting, requiresClaimCaptcha } from "../proxy/endpoint-routing.js";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

/** `${process.platform}-${process.arch}` — mirrors the client's `TH()`. */
function claimPlatform(): string {
  return `${process.platform}-${process.arch}`;
}

/**
 * Stable UUID for the marketing face (`marketing/touch` uuid.parse's the
 * X-Device-Mid header — required there even with the billing campaign gate
 * off). Derived deterministically from the home dir so it survives restarts
 * (fingerprint stability: never randomized per request/run).
 */
function stableMarketingDeviceMid(): string {
  const h = createHash("sha256").update(`${homedir()}|zcode-proxy|marketing-device-mid`).digest("hex");
  return [h.slice(0, 8), h.slice(8, 12), "4" + h.slice(13, 16), "8" + h.slice(17, 20), h.slice(20, 32)].join("-");
}

function claimCaptchaRequired(config: ProxyConfig, resolveCredential: () => Promise<Credential | null>): Promise<boolean> {
  const routing = getDefaultEndpointRouting(config);
  if (!routing) return Promise.resolve(true);
  return resolveCredential()
    .then((cred) => routing.getRequestVerificationConfig(cred ? credentialString(cred) : undefined))
    .then((cfg) => requiresClaimCaptcha(cfg))
    .catch(() => true);
}

export function startAutoClaim(config: ProxyConfig, auth: AuthManager): ClaimScheduler {
  // Multi-account rotation: cycle through ALL stored accounts, one per tick.
  // Each account claims hours apart (tick cadence × account count) — captcha
  // solves from one IP across N accounts in a burst is the ban-risk pattern;
  // spacing reduces correlation. Falls back to the AuthManager credential
  // when the store is empty (Android boot flow).
  let rotationIndex = 0;
  const schedConfig = {
    planId: config.claim.planId || undefined,
    pollIntervalMs: config.claim.pollIntervalMs,
    cooldownMs: config.claim.cooldownMs,
  };
  const scheduler = new ClaimScheduler({
    nextAccount: async () => {
      const accounts: StoredAccount[] = await listAccounts().catch(() => []);
      // Rotation spacing: recompute the tick interval each cycle — the SAME
      // account is attempted again after accounts.length × pollIntervalMs,
      // which must land on spacingHours.
      schedConfig.pollIntervalMs = Math.max(
        config.claim.pollIntervalMs,
        Math.round((config.claim.spacingHours * 3600_000) / Math.max(1, accounts.length)),
      );
      if (accounts.length === 0) {
        // Android boot flow: credential may exist in the AuthManager before
        // the store is populated.
        try {
          const cred = await auth.getCredential();
          if (cred.jwt) return { accountId: cred.userId ?? "primary", jwt: cred.jwt };
        } catch { /* fall through */ }
        return null;
      }
      const account = accounts[rotationIndex % accounts.length];
      rotationIndex = (rotationIndex + 1) % accounts.length;
      // Re-read the credential to get the JWT (store entries are encrypted
      // individually — listAccounts already decrypted them).
      return { accountId: account.id, jwt: account.credential.jwt };
    },
    createClient: (jwt) =>
      createClaimClient({
        origin: config.claim.origin,
        jwt,
        appVersion: config.identity.appVersion,
        platform: claimPlatform(),
        deviceMid: config.identity.deviceMid,
        marketingDeviceMid: config.identity.deviceMid ?? stableMarketingDeviceMid(),
      }),
    getCaptcha: async () => {
      const token = await getCaptchaToken(config.identity.appVersion);
      if (!token) throw new Error("captcha config flipped to disabled between gate and mint");
      return { verifyParam: token.verifyParam, region: token.region || undefined };
    },
    onClaimable: (accountId, plans) => metricsRegistry.recordClaimable(accountId, plans),
    captchaRequired: (accountId?: string) =>
      claimCaptchaRequired(config, async () => {
        const accounts: StoredAccount[] = await listAccounts().catch(() => []);
        const match = accountId ? accounts.find((a) => a.id === accountId) : undefined;
        if (match) return match.credential;
        try {
          return await auth.getCredential();
        } catch {
          return await loadCredential().catch(() => null);
        }
      }),
    config: schedConfig,
    log: (message) => console.log(`[claim] ${message}`),
  });
  scheduler.start();
  return scheduler;
}

const FAILURE_LABELS: Record<string, string> = {
  not_found: "plan does not exist",
  unavailable: "campaign ended or not claimable yet",
  already_claimed: "already claimed on this account",
  ineligible: "account or client version not eligible (needs appVersion >= campaign minimum)",
  quota_exhausted: "daily claim quota exhausted",
  invalid_request: "invalid request",
  captcha: "captcha verification failed",
  login_required: "not logged in",
  http_error: "HTTP error",
  unknown: "unknown failure",
};

/**
 * One-shot claim for a SPECIFIC credential (admin dashboard manual claim).
 * Returns ok + a human detail line per account; never throws.
 */
export async function runOneShotClaim(
  config: ProxyConfig,
  cred: Credential,
  accountId: string,
): Promise<{ ok: boolean; detail?: string }> {
  const jwt = cred.jwt;
  if (!jwt) return { ok: false, detail: "no JWT (re-login required)" };
  const client = createClaimClient({
    origin: config.claim.origin,
    jwt,
    appVersion: config.identity.appVersion,
    platform: claimPlatform(),
    deviceMid: config.identity.deviceMid,
    marketingDeviceMid: config.identity.deviceMid ?? stableMarketingDeviceMid(),
  });
  try {
    const plans = await client.listPlans();
    if (plans.length === 0) return { ok: false, detail: "no claimable plans" };
    const target = plans.sort((a, b) => b.priority - a.priority)[0];
    let captcha: { verifyParam: string; region?: string } | undefined;
    try {
      const token = await getCaptchaToken(config.identity.appVersion);
      if (token) captcha = { verifyParam: token.verifyParam, region: token.region || undefined };
    } catch { /* gate may be disabled — proceed captcha-less */ }
    const outcome = await client.claim(target.planId, captcha);
    metricsRegistry.recordClaim(accountId, outcome.ok ? "claimed" : "failed", outcome.ok ? target.planId : undefined);
    return outcome.ok
      ? { ok: true, detail: `claimed ${target.planId}` }
      : { ok: false, detail: `claim failed: ${outcome.code} ${outcome.message}` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

/** One-shot CLI: `list` prints previews; `now` claims the target plan. */
export async function runClaimCli(config: ProxyConfig, mode: "list" | "now"): Promise<void> {
  const cred = await loadCredential();
  const jwt = cred?.jwt;
  if (!jwt) {
    console.error("Claim requires a logged-in oauth credential (no JWT stored). Run: zcode-proxy auth login <zai|bigmodel>");
    process.exit(1);
  }
  const client = createClaimClient({
    origin: config.claim.origin,
    jwt,
    appVersion: config.identity.appVersion,
    platform: claimPlatform(),
    deviceMid: config.identity.deviceMid,
    marketingDeviceMid: config.identity.deviceMid ?? stableMarketingDeviceMid(),
  });

  let plans: ClaimablePlan[];
  try {
    plans = await client.listPlans();
  } catch (err) {
    if (err instanceof ClaimPreviewError && err.status === 404) {
      console.log("No claimable plans: the campaign endpoint is not deployed yet (404).");
      console.log("Weekend campaigns typically go live shortly before the window — keep the proxy");
      console.log("serving with claim.enabled, or re-run this command later.");
      return;
    }
    throw err;
  }
  if (plans.length === 0) {
    console.log("No claimable plans right now.");
    return;
  }
  printPlans(plans);

  if (mode === "list") return;

  const wanted = config.claim.planId.trim();
  const target = wanted ? plans.find((p) => p.planId === wanted) : [...plans].sort((a, b) => b.priority - a.priority)[0];
  if (!target) {
    console.error(`Configured claim.planId "${wanted}" not in the preview list.`);
    process.exit(1);
  }
  if (target.planId !== plans[0].planId) console.log(`Claiming configured plan: ${target.planId}`);

  const captchaRequired = await claimCaptchaRequired(config, async () => cred);
  let captcha: { verifyParam: string; region?: string } | undefined;
  if (captchaRequired) {
    const token = await getCaptchaToken(config.identity.appVersion);
    if (!token) throw new Error("captcha config flipped to disabled between gate and mint");
    captcha = { verifyParam: token.verifyParam, region: token.region || undefined };
  }
  const outcome = await client.claim(target.planId, captcha);
  printOutcome(outcome);
  if (!outcome.ok) process.exit(1);
}

function printPlans(plans: ClaimablePlan[]): void {
  console.log(`Claimable plans (${plans.length}):`);
  for (const p of plans) {
    const window = [fmtTime(p.startsAt), fmtTime(p.endsAt)].filter(Boolean).join(" → ");
    const source = p.source === "banner" ? "  [banner]" : "";
    console.log(`  - ${p.planId}  "${p.name}"  priority=${p.priority}${window ? `  ${window}` : ""}${source}`);
    for (const e of p.entitlements) {
      const quota = e.grantUnits > 0 ? ` ${e.grantUnits} ${e.unitType}` : "";
      const activate = e.effectiveAt !== undefined ? ` (activates ${new Date(e.effectiveAt * 1000).toISOString()})` : "";
      console.log(`      · ${e.showName || e.entitlementId}${quota}${activate}`);
    }
  }
}

function printOutcome(outcome: ClaimOutcome): void {
  if (outcome.ok) {
    console.log(`\nClaimed: ${outcome.planId}`);
    if (outcome.startsAt !== undefined) console.log(`  activates: ${new Date(outcome.startsAt * 1000).toISOString()}`);
    if (outcome.endsAt !== undefined) console.log(`  expires:   ${new Date(outcome.endsAt * 1000).toISOString()}`);
    if (outcome.startsAt === undefined && outcome.endsAt === undefined) console.log("  active immediately");
    return;
  }
  const label = FAILURE_LABELS[outcome.failureKind] ?? FAILURE_LABELS.unknown;
  console.error(`\nClaim failed: ${label} (code ${String(outcome.code)}) — ${outcome.message}`);
  if (outcome.failureEndsAt !== undefined) {
    console.error(`  retry window opens: ${new Date(outcome.failureEndsAt * 1000).toISOString()}`);
  }
}

function fmtTime(sec: number | undefined): string {
  return sec === undefined ? "" : new Date(sec * 1000).toISOString();
}
