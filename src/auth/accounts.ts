/**
 * Multi-account credential store (v2 schema).
 *
 * Complements the single-credential store (`store.ts`): the v2 file
 * `credentials.json` carries `{ version: 2, primaryAccountId, accounts: [...] }`
 * with each account's `Credential` encrypted with the same AES-GCM scheme and
 * `ZCODE_PROXY_CREDENTIAL_SECRET` key derivation. A v1 file (bare `{encrypted}`
 * single credential) migrates idempotently on first load; a `.bak` copy is
 * written once before the first migration so the one-way move is reversible.
 *
 * Cross-process safety: every mutation runs
 * `acquire lockfile → read latest → modify → atomic write → release`,
 * so concurrent writers never clobber each other with stale snapshots.
 * Stale locks (pid + timestamp, TTL expired) are reclaimed.
 *
 * Hot reload: readers cache by (mtime, size); a change on disk (another
 * process ran `auth login --add`) re-parses the file transparently.
 *
 * Persisted per account: identity fingerprint fields only — never runtime
 * health state (that lives in the AccountPool, Phase 2).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync, statSync, openSync, closeSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { encryptWith, decryptWith, atomicWriteStore, storeFile, storeDir, getEncryptionKey, getLegacyEncryptionKey } from "./store-internals.js";
import type { Credential } from "./types.js";

/** Stored per-account record — persistent data only (no runtime health). */
export interface StoredAccount {
  /** Stable alias. Derived from the credential's userId/JWT subject when available. */
  id: string;
  label?: string;
  credential: Credential;
  addedAt: number;
  lastUsedAt?: number;
  /** Per-account identity overrides (deviceMid etc.) for future use. */
  identity?: { deviceMid?: string };
}

/** v2 store file shape. */
export interface AccountStoreFile {
  version: 2;
  /** The account legacy single-credential consumers resolve to. */
  primaryAccountId: string;
  accounts: StoredAccount[];
}

/** Account-level identity key: prefer credential.userId, then JWT `user_id`/`sub`. */
function accountKey(cred: Credential): string {
  if (cred.userId && cred.userId.trim()) return cred.userId.trim();
  if (cred.jwt) {
    const parts = cred.jwt.split(".");
    if (parts.length === 3) {
      try {
        const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
        const payload = JSON.parse(Buffer.from(b64 + pad, "base64").toString("utf8")) as { user_id?: string; sub?: string };
        if (typeof payload.user_id === "string" && payload.user_id.trim()) return payload.user_id.trim();
        if (typeof payload.sub === "string" && payload.sub.trim()) return payload.sub.trim();
      } catch {
        // fall through to random id
      }
    }
  }
  return `acct-${randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Lockfile (cross-process, stale-recoverable)
// ---------------------------------------------------------------------------

const LOCK_TTL_MS = 10_000;
const LOCK_POLL_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;

function lockFile(): string {
  return `${storeFile()}.lock`;
}

/**
 * Try once to acquire the lock; false when held by a live process.
 *
 * ENOENT distinction matters: the store dir may not exist yet (first login
 * ever) — that is not "another process holds the lock". The dir is created
 * up front so a missing dir can never send this into a retry loop.
 */
/**
 * A lock is stale only when its holder is dead. TTL alone is not enough: a
 * long-lived holder process (a hung server) must keep its lock past the TTL.
 * `kill(pid, 0)` throws ESRCH for a dead/unknown pid — that is the reclaim
 * signal. Same-pid locks (crashed then restarted in-place tests aside) are
 * our own and stale by definition when the TTL passed.
 */
function holderIsAlive(holder: { pid?: number; at?: number }): boolean {
  if (typeof holder.pid !== "number" || holder.pid <= 0) {
    // Unparseable/missing pid — fall back to the TTL rule only.
    return !(typeof holder.at === "number" && Date.now() - holder.at > LOCK_TTL_MS);
  }
  if (holder.pid === process.pid) return true; // our own live lock
  try {
    process.kill(holder.pid, 0); // signal probe: no delivery, liveness only
    return true; // process exists
  } catch (e: any) {
    if (e?.code === "ESRCH") return false; // dead → stale
    if (e?.code === "EPERM") return true; // exists but owned by another user
    // Unknown probe error — conservatively treat as alive (no clobber).
    return true;
  }
}

function tryAcquireLock(): boolean {
  try {
    // O_EXCL-style atomic create: fail when the file already exists.
    const fd = openSync(lockFile(), "wx");
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    closeSync(fd);
    return true;
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      // Store dir missing (first login) — create it and let the caller retry.
      mkdirSync(dirname(lockFile()), { recursive: true });
      return false;
    }
    // File exists — check staleness.
    try {
      const raw = readFileSync(lockFile(), "utf-8");
      const holder = JSON.parse(raw) as { pid?: number; at?: number };
      if (!holderIsAlive(holder)) {
        rmSync(lockFile());
        return false; // reclaimed; caller retries and normally wins
      }
      // Held by a live process — respect it.
      return false;
    } catch (e2: any) {
      if (e2?.code === "ENOENT") return false; // vanished — caller retries
      // Unparseable but fresh — respect it rather than clobbering a live lock.
      return false;
    }
  }
}

/** Acquire the cross-process store lock or throw after LOCK_TIMEOUT_MS. */
export async function acquireStoreLock(timeoutMs = LOCK_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!tryAcquireLock()) {
    if (Date.now() >= deadline) {
      throw new Error(`credential store is locked (timeout after ${timeoutMs}ms)`);
    }
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
}

export function releaseStoreLock(): void {
  try {
    unlinkSync(lockFile());
  } catch {
    // Already gone (crash recovery reclaimed it) — nothing to do.
  }
}

/** Run `fn` while holding the store lock; always releases (including on throw). */
export async function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  await acquireStoreLock();
  try {
    return await fn();
  } finally {
    releaseStoreLock();
  }
}

// ---------------------------------------------------------------------------
// Read / migrate / write
// ---------------------------------------------------------------------------

/** One-time pre-migration backup of a v1 file (mode 0600, never overwritten). */
function backupV1File(): void {
  const src = storeFile();
  const dst = `${src}.bak`;
  try {
    if (existsSync(dst)) return; // one-shot: never clobber the original backup
    writeFileSync(dst, readFileSync(src), { mode: 0o600 });
  } catch (e) {
    console.warn(`credentials backup before migration failed (continuing): ${(e as Error).message}`);
  }
}

/**
 * Read + parse + decrypt the store file in whatever schema it currently is.
 * Returns null when no file / undecryptable.
 *
 * When a v1 file is found (and decryptable), `migrateOnRead` persists it as v2
 * immediately — mirroring the old store's "load migrates" contract: the on-disk
 * ciphertext changes shape (v2, per-account encryption) while the credential
 * stays intact, and a `.bak` copy is written first.
 */
async function readRawStore(migrateOnRead = false): Promise<AccountStoreFile | null> {
  const path = storeFile();
  if (!existsSync(path)) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    console.warn(`Ignoring corrupted credential store at ${path}: ${(e as Error).message}`);
    return null;
  }

  const key = getEncryptionKey();
  const decryptOne = async (ciphertext: string): Promise<Credential | null> => {
    for (const k of [key, getLegacyEncryptionKey()]) {
      try {
        return JSON.parse(await decryptWith(k, ciphertext)) as Credential;
      } catch {
        // try next key
      }
    }
    return null;
  };

  // v2 schema.
  if (parsed && parsed.version === 2 && Array.isArray(parsed.accounts)) {
    const accounts: StoredAccount[] = [];
    for (const entry of parsed.accounts) {
      if (!entry || typeof entry.encrypted !== "string") continue;
      const cred = await decryptOne(entry.encrypted);
      if (!cred) continue; // undecryptable entry — skip, keep the rest
      accounts.push({
        id: typeof entry.id === "string" && entry.id ? entry.id : accountKey(cred),
        ...(typeof entry.label === "string" ? { label: entry.label } : {}),
        credential: cred,
        ...(typeof entry.addedAt === "number" ? { addedAt: entry.addedAt } : { addedAt: 0 }),
        ...(typeof entry.lastUsedAt === "number" ? { lastUsedAt: entry.lastUsedAt } : {}),
        ...(entry.identity && typeof entry.identity === "object" ? { identity: entry.identity } : {}),
      });
    }
    const ids = new Set(accounts.map((a) => a.id));
    return {
      version: 2,
      primaryAccountId:
        typeof parsed.primaryAccountId === "string" && ids.has(parsed.primaryAccountId)
          ? parsed.primaryAccountId
          : (accounts[0]?.id ?? ""),
      accounts,
    };
  }

  // v1 schema (bare {encrypted}) — migrate.
  if (parsed && typeof parsed.encrypted === "string") {
    const cred = await decryptOne(parsed.encrypted);
    if (!cred) return null;
    // Migrate re-encrypts under the current KDF; the ciphertext on disk changes
    // shape but the credential is intact, so back up the original first.
    backupV1File();
    const account: StoredAccount = {
      id: accountKey(cred),
      credential: cred,
      addedAt: Date.now(),
    };
    const migrated: AccountStoreFile = { version: 2, primaryAccountId: account.id, accounts: [account] };
    if (migrateOnRead) {
      // Persist under lock. Re-check by reading the RAW JSON (not the
      // v1→v2-converted shape) so "another process already migrated" is
      // detected by the actual file schema, not by our in-memory conversion.
      await withStoreLock(async () => {
        const raw = JSON.parse(readFileSync(storeFile(), "utf-8")) as { version?: number };
        if (raw.version === 2) return;
        atomicWriteStore(await serializeAccountStore(migrated));
      });
    }
    return migrated;
  }

  return null;
}

// Hot-reload cache: re-read only when (mtime, size) changed.
let cache: { mtimeMs: number; size: number; store: AccountStoreFile | null } | null = null;

function fileStamp(): { mtimeMs: number; size: number } | null {
  try {
    const st = statSync(storeFile());
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/**
 * Load the account store (cached by mtime+size; a disk change from another
 * process hot-reloads transparently). Returns null when no store exists.
 */
export async function loadAccountStore(): Promise<AccountStoreFile | null> {
  const stamp = fileStamp();
  if (!stamp) {
    cache = null;
    return null;
  }
  if (cache && cache.mtimeMs === stamp.mtimeMs && cache.size === stamp.size) {
    return cache.store;
  }
  const store = await readRawStore(true);
  cache = { ...stamp, store };
  return store;
}

function invalidateCache(): void {
  cache = null;
}

/**
 * Serialize the store to the encrypted v2 file shape.
 * Each credential is encrypted individually so updating one account never
 * re-encrypts (or depends on the plaintext of) another.
 */
export async function serializeAccountStore(store: AccountStoreFile): Promise<string> {
  const key = getEncryptionKey();
  const entries = await Promise.all(
    store.accounts.map(async (a) => ({
      id: a.id,
      ...(a.label ? { label: a.label } : {}),
      encrypted: await encryptWith(key, JSON.stringify(a.credential)),
      addedAt: a.addedAt,
      ...(a.lastUsedAt !== undefined ? { lastUsedAt: a.lastUsedAt } : {}),
      ...(a.identity ? { identity: a.identity } : {}),
    })),
  );
  return JSON.stringify({
    version: 2,
    primaryAccountId: store.primaryAccountId,
    accounts: entries,
  } satisfies Omit<AccountStoreFile, "accounts"> & { accounts: unknown[] });
}

/**
 * Full write under lock: read latest from disk, apply `mutate`, atomic write.
 * `mutate` receives the freshest store (null when absent) and returns the
 * next state (or null to delete the file).
 */
export async function mutateAccountStore(
  mutate: (current: AccountStoreFile | null) => Promise<AccountStoreFile | null>,
): Promise<void> {
  await withStoreLock(async () => {
    const latest = await readRawStore();
    const next = await mutate(latest);
    mkdirSync(dirname(storeFile()), { recursive: true });
    if (next === null) {
      if (existsSync(storeFile())) unlinkSync(storeFile());
    } else {
      atomicWriteStore(await serializeAccountStore(next));
    }
    invalidateCache();
  });
}

// ---------------------------------------------------------------------------
// Account CRUD
// ---------------------------------------------------------------------------

/** List all accounts (null store → empty array). */
export async function listAccounts(): Promise<StoredAccount[]> {
  return (await loadAccountStore())?.accounts ?? [];
}

/** Get one account by id. */
export async function getAccount(id: string): Promise<StoredAccount | null> {
  return (await loadAccountStore())?.accounts.find((a) => a.id === id) ?? null;
}

export interface UpsertOptions {
  /** Error when the account count would exceed this (existing data is never truncated). */
  maxCount?: number;
  /** Update an existing same-key account instead of erroring (default true). */
  upsert?: boolean;
  /** Promote the written account to primary. */
  makePrimary?: boolean;
  /** Display label; sets it on insert or when replacing a label-less entry. */
  label?: string;
}

/**
 * Add or update an account. Dedupe key: accountKey(cred) (userId/JWT subject),
 * so logging in twice with the same account updates the entry instead of
 * duplicating it.
 *
 * Returns the stored account id.
 */
export async function saveAccount(cred: Credential, opts: UpsertOptions = {}): Promise<string> {
  const { maxCount, upsert = true, makePrimary = true, label } = opts;
  const key = accountKey(cred);
  let resultId = key;

  await mutateAccountStore(async (current) => {
    const accounts = current?.accounts ?? [];
    const existingIdx = accounts.findIndex((a) => a.id === key);

    if (existingIdx === -1 && maxCount !== undefined && accounts.length >= maxCount) {
      throw new Error(`account limit reached (max ${maxCount}); remove an account first`);
    }

    if (existingIdx >= 0) {
      if (!upsert) throw new Error(`account ${key} already exists`);
      accounts[existingIdx] = {
        ...accounts[existingIdx],
        credential: cred,
        ...(label !== undefined ? { label } : {}),
        lastUsedAt: Date.now(),
      };
      resultId = accounts[existingIdx].id;
    } else {
      accounts.push({ id: key, credential: cred, addedAt: Date.now(), ...(label !== undefined ? { label } : {}) });
    }

    const primaryAccountId =
      makePrimary || !current ? key : (current.primaryAccountId ?? accounts[0].id);
    return { version: 2, primaryAccountId, accounts };
  });

  return resultId;
}

/** Remove an account by id. Returns true when it existed. */
export async function removeAccount(id: string): Promise<boolean> {
  let removed = false;
  await mutateAccountStore(async (current) => {
    if (!current) return null;
    const accounts = current.accounts.filter((a) => {
      const match = a.id === id;
      if (match) removed = true;
      return !match;
    });
    if (!removed) return current;
    if (accounts.length === 0) return null; // empty store → delete file
    return {
      version: 2,
      primaryAccountId: current.primaryAccountId === id ? accounts[0].id : current.primaryAccountId,
      accounts,
    };
  });
  return removed;
}

/** Update the primary account pointer. */
export async function setPrimaryAccount(id: string): Promise<void> {
  await mutateAccountStore(async (current) => {
    if (!current) throw new Error("no account store");
    if (!current.accounts.some((a) => a.id === id)) throw new Error(`unknown account: ${id}`);
    return { ...current, primaryAccountId: id };
  });
}

/** The stable account legacy single-credential consumers resolve to. */
export async function getPrimaryAccountId(): Promise<string | null> {
  return (await loadAccountStore())?.primaryAccountId ?? null;
}

/** The primary account, or null. */
export async function getPrimaryAccount(): Promise<StoredAccount | null> {
  const store = await loadAccountStore();
  if (!store) return null;
  return store.accounts.find((a) => a.id === store.primaryAccountId) ?? store.accounts[0] ?? null;
}

/** Touch lastUsedAt for an account (best-effort; never throws). */
export async function touchAccount(id: string): Promise<void> {
  try {
    await mutateAccountStore(async (current) => {
      if (!current) return current;
      const accounts = current.accounts.map((a) => (a.id === id ? { ...a, lastUsedAt: Date.now() } : a));
      return { ...current, accounts };
    });
  } catch {
    // lastUsedAt is informational — a failed touch must never break traffic.
  }
}

// Test-only helpers (used by store.test.ts to seed exact on-disk shapes).
export const _testing = {
  accountKey,
  invalidateCache,
  lockPath: lockFile,
  storeDirOverride: () => process.env.ZCODE_PROXY_STORE_DIR ?? join(homedir(), ".zcode-proxy"),
};
