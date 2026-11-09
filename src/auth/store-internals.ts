/**
 * Shared internals for the credential stores (single-credential v1 in
 * `store.ts` and the multi-account v2 in `accounts.ts`): paths, AES-GCM
 * encryption, key derivation, and the atomic file write. Not a public API.
 */
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

const ENV_SECRET = "ZCODE_PROXY_CREDENTIAL_SECRET";
/**
 * Store directory override. Production always uses `~/.zcode-proxy`; this seam
 * exists so tests can point the store at an isolated temp dir — module-level
 * path constants forced store.test.ts onto the REAL user store, and running
 * the suite on a logged-in machine deleted the user's credentials
 * (`clearCredential` in test hooks, observed 2026-09-18). Evaluated per call
 * so the env var works even when set after module load.
 */
const ENV_STORE_DIR = "ZCODE_PROXY_STORE_DIR";

export function storeDir(): string {
  return process.env[ENV_STORE_DIR]?.trim() || join(homedir(), ".zcode-proxy");
}

export function storeFile(): string {
  return join(storeDir(), "credentials.json");
}

/**
 * Derive the AES-GCM key as SHA-256(seed) (audit R2-13). The previous XOR-fold
 * construction was a pseudo-KDF: a seed shorter than 32 bytes left zero blocks
 * in the key. Scope note: on default machine-derived seeds the security gain
 * is ~0 (any same-user process can re-derive the seed either way, 0o600 only
 * stops other users) — the motivation is structural: env-secret deployments
 * (`ZCODE_PROXY_CREDENTIAL_SECRET`) get real 32-byte diffusion, and the
 * misleading "KDF" is gone.
 */
export function getEncryptionKey(): Uint8Array {
  const seed = process.env[ENV_SECRET] ?? `${homedir()}-${process.platform}-${process.arch}`;
  return new Uint8Array(createHash("sha256").update(seed, "utf-8").digest());
}

/**
 * Legacy XOR-fold key (pre-SHA-256 store format). Kept ONLY for one-shot
 * migration decrypts — never used for new writes.
 */
export function getLegacyEncryptionKey(): Uint8Array {
  const hash = new Uint8Array(new ArrayBuffer(32));
  const encoder = new TextEncoder();

  const seed = process.env[ENV_SECRET] ?? `${homedir()}-${process.platform}-${process.arch}`;
  const seedBytes = encoder.encode(seed);
  // NOTE: loop over the full seed (not 32) — byte i lands on hash[i % 32], so
  // seeds longer than 32 bytes fold back and change the key. Must match the
  // pre-SHA-256 implementation byte-for-byte or legacy files won't decrypt.
  for (let i = 0; i < seedBytes.length; i++) {
    hash[i % 32] ^= seedBytes[i];
  }
  return hash;
}

/** Atomic store write: temp file (0o600) + rename over the target. */
export function atomicWriteStore(contents: string): void {
  const target = storeFile();
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, target);
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  // Copy into a plain ArrayBuffer: bun-types types Uint8Array as
  // ArrayBufferLike, which is not assignable to BufferSource.
  const ab = new ArrayBuffer(raw.byteLength);
  new Uint8Array(ab).set(raw);
  return crypto.subtle.importKey(
    "raw",
    ab,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptWith(key: Uint8Array, plaintext: string): Promise<string> {
  const aesKey = await importAesKey(key);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    encoder.encode(plaintext),
  );

  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);

  return Buffer.from(combined).toString("base64");
}

export async function decryptWith(key: Uint8Array, ciphertext: string): Promise<string> {
  const aesKey = await importAesKey(key);

  const combined = Buffer.from(ciphertext, "base64");
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    aesKey,
    data,
  );

  return new TextDecoder().decode(decrypted);
}
