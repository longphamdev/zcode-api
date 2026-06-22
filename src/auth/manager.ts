/**
 * Auth manager — picks the right credential source based on mode.
 * @see .omo/plans/zcode-proxy.md Task 4
 */
import type { AuthMode, Credential } from "./types.js";
import { createApiKeyCredential } from "./apikey.js";
import type { ProviderId } from "../provider/types.js";

/** Options for constructing an `AuthManager`. */
interface AuthManagerOptions {
  mode: AuthMode;
  provider: ProviderId;
  /** Raw credential string for apikey mode (`{apiKey}` or `{apiKey}.{secret}`). */
  apiKey?: string;
}

/**
 * Resolves the upstream credential to inject into proxied requests.
 *
 * In `apikey` mode: returns a static credential parsed from the config string.
 * In `oauth` mode: throws "not implemented" until T9/T10 land.
 */
export class AuthManager {
  private mode: AuthMode;
  private provider: ProviderId;
  private cachedApiKeyCred: Credential | null = null;
  private oauthCred: Credential | null = null;

  constructor(opts: AuthManagerOptions) {
    this.mode = opts.mode;
    this.provider = opts.provider;
    if (opts.mode === "apikey" && opts.apiKey) {
      this.cachedApiKeyCred = createApiKeyCredential(this.provider, opts.apiKey);
    }
  }

  /** Returns the current credential, refreshing if necessary. */
  async getCredential(): Promise<Credential> {
    if (this.mode === "apikey") {
      if (this.cachedApiKeyCred) return this.cachedApiKeyCred;
      throw new Error("apikey mode configured but no credential was set");
    }

    // oauth mode
    if (this.oauthCred) {
      if (this.oauthCred.expiresAt && Date.now() >= this.oauthCred.expiresAt) {
        this.oauthCred = null;
        throw new Error("OAuth credential expired; re-authentication required (T9/T10 not yet implemented)");
      }
      return this.oauthCred;
    }
    throw new Error("OAuth credential not available — run login flow first (T9/T10 not yet implemented)");
  }

  /** Set the OAuth credential (used by T9/T10 OAuth flow). */
  setOAuthCredential(cred: Credential): void {
    this.oauthCred = cred;
  }

  /** Current auth mode. */
  getMode(): AuthMode {
    return this.mode;
  }
}
