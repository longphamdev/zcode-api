/**
 * Encrypted file-based credential store (single-credential, v1 facade).
 *
 * Since the multi-account store (`accounts.ts`) this module is a thin
 * compatibility facade: it reads/writes the primary account through the
 * shared v2 file format, so old single-credential callers
 * (`loadCredential`/`saveCredential`/`clearCredential`) and new multi-account
 * callers operate on the same on-disk store. A bare v1 file on disk migrates
 * to v2 on first load (with a one-time `.bak` backup).
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import {
  encryptWith,
  decryptWith,
  atomicWriteStore,
  storeFile,
  storeDir,
  getEncryptionKey,
  getLegacyEncryptionKey,
} from "./store-internals.js";
import {
  getPrimaryAccount,
  mutateAccountStore,
  _testing,
} from "./accounts.js";
import type { Credential } from "./types.js";

/** The v2 account store path (same file the facade reads/writes). */
export function getStorePath(): string {
  return storeFile();
}

/**
 * Resolve the primary account as a single credential. Reads through the
 * account store's hot-reload cache, so a multi-account write from another
 * process is picked up here too.
 */
export async function loadCredential(): Promise<Credential | null> {
  const account = await getPrimaryAccount();
  return account?.credential ?? null;
}

/**
 * Write a credential through the single-credential facade.
 *
 * Matches the entry by the credential's **account key** (userId/JWT subject),
 * not blindly by primaryAccountId: a JWT refresh for a non-primary account
 * saved through this facade must update that account's own entry, never
 * clobber the primary's. The entry keeps its label/addedAt. When the account
 * is new it is added; it becomes primary only when no primary exists yet
 * (preserving the classic single-account behavior of overwrite-on-login).
 */
export async function saveCredential(cred: Credential): Promise<void> {
  const key = _testing.accountKey(cred);
  await mutateAccountStore(async (current) => {
    const store = current ?? { version: 2 as const, primaryAccountId: "", accounts: [] };
    const accounts = [...store.accounts];
    const idx = accounts.findIndex((a) => a.id === key);
    if (idx >= 0) {
      accounts[idx] = { ...accounts[idx], credential: cred };
    } else {
      accounts.push({ id: key, credential: cred, addedAt: Date.now() });
    }
    // Primary stays put unless it was empty (first login ever) or the matched
    // entry IS the primary — rotating that credential keeps it primary.
    const primaryAccountId =
      !store.primaryAccountId || store.primaryAccountId === key
        ? key
        : store.primaryAccountId;
    return { version: 2, primaryAccountId, accounts };
  });
}

export function clearCredential(): void {
  if (existsSync(storeFile())) {
    unlinkSync(storeFile());
  }
}
