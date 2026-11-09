/**
 * Verify a credentials.json backup: decrypt it with the CURRENT
 * ZCODE_PROXY_CREDENTIAL_SECRET on a COPY (never touches the original or the
 * live store) and print the account entries. Usage:
 *
 *   BACKUP_FILE=./credentials-backup.json ZCODE_PROXY_CREDENTIAL_SECRET=<secret> \
 *     bun run scripts/verify-credentials-backup.ts
 *
 * A backup you have never decoded is not a backup.
 */
import { mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const backupFile = process.env.BACKUP_FILE;
const secret = process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
if (!backupFile || !secret) {
  console.error("Usage: BACKUP_FILE=<path> ZCODE_PROXY_CREDENTIAL_SECRET=<secret> bun run scripts/verify-credentials-backup.ts");
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "backup-verify-"));
try {
  copyFileSync(backupFile, join(dir, "credentials.json"));
  process.env.ZCODE_PROXY_STORE_DIR = dir;
  const { loadCredential, getStorePath } = await import("../src/auth/store.ts");
  const { listAccounts } = await import("../src/auth/accounts.ts");
  const cred = await loadCredential();
  if (!cred) {
    console.error("FAILED: backup did not decrypt with the provided secret.");
    process.exit(1);
  }
  const accounts = await listAccounts();
  console.log("OK — backup decodes with the provided secret.");
  console.log(`  Accounts: ${accounts.length}`);
  for (const a of accounts) {
    const masked = a.credential.userId ? `${String(a.credential.userId).slice(0, 4)}…${String(a.credential.userId).slice(-4)}` : "(no id)";
    console.log(`  [${a.id}]${a.label ? ` (${a.label})` : ""} user=${masked} provider=${a.credential.provider} jwt=${a.credential.jwt ? "yes" : "no"}`);
  }
  console.log(`  (decoded in temp dir ${dir} — already cleaned up)`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
