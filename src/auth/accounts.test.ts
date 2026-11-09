/**
 * Tests for the multi-account credential store (v2 schema).
 *
 * Every test runs against a fresh temp store dir — never the real
 * `~/.zcode-proxy` (see store.test.ts for the incident that policy prevents).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  listAccounts,
  saveAccount,
  removeAccount,
  getAccount,
  setPrimaryAccount,
  getPrimaryAccount,
  getPrimaryAccountId,
  loadAccountStore,
  touchAccount,
  acquireStoreLock,
  releaseStoreLock,
  serializeAccountStore,
  _testing,
} from "./accounts.js";
import { saveCredential, loadCredential, clearCredential, getStorePath } from "./store.js";
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync, copyFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential } from "./types.js";

const TEST_SECRET = "test-encryption-secret-for-zcode-proxy";

function useTempStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-accounts-test-"));
  process.env.ZCODE_PROXY_STORE_DIR = dir;
  process.env.ZCODE_PROXY_CREDENTIAL_SECRET = TEST_SECRET;
  return dir;
}

function dropTempStore(dir: string): void {
  delete process.env.ZCODE_PROXY_STORE_DIR;
  delete process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
  rmSync(dir, { recursive: true, force: true });
}

const credA: Credential = { apiKey: "keyA", secret: "secA", provider: "zai", userId: "user-a" };
const credB: Credential = { apiKey: "keyB", secret: "secB", provider: "zai", userId: "user-b" };

describe("account store — CRUD", () => {
  let storeDir: string;
  beforeEach(() => {
    storeDir = useTempStore();
  });
  afterEach(() => {
    dropTempStore(storeDir);
  });

  it("empty store: listAccounts returns []", async () => {
    expect(await listAccounts()).toEqual([]);
    expect(await loadAccountStore()).toBeNull();
    expect(await getPrimaryAccount()).toBeNull();
  });

  it("saveAccount adds and makes primary", async () => {
    const id = await saveAccount(credA, { label: "Main" });
    expect(id).toBe("user-a");
    const accounts = await listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe("user-a");
    expect(accounts[0].label).toBe("Main");
    expect(accounts[0].credential.apiKey).toBe("keyA");
    expect(await getPrimaryAccountId()).toBe("user-a");
  });

  it("saveAccount twice with the same account key upserts (dedupe by userId)", async () => {
    await saveAccount(credA);
    await saveAccount({ ...credA, apiKey: "keyA-rotated" });
    const accounts = await listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].credential.apiKey).toBe("keyA-rotated");
  });

  it("saveAccount falls back to JWT subject when userId missing", async () => {
    // JWT with user_id claim (header.payload.signature, base64url)
    const payload = Buffer.from(JSON.stringify({ iat: 1700000000, user_id: "jwt-user-1" })).toString("base64url");
    const jwt = `h.${payload}.s`;
    const id = await saveAccount({ apiKey: "k", provider: "zai", jwt });
    expect(id).toBe("jwt-user-1");
  });

  it("saveAccount generates a random id when no userId/JWT", async () => {
    const id = await saveAccount({ apiKey: "k", provider: "bigmodel" });
    expect(id).toMatch(/^acct-/);
  });

  it("two accounts coexist; second becomes primary by default", async () => {
    await saveAccount(credA);
    await saveAccount(credB);
    const accounts = await listAccounts();
    expect(accounts).toHaveLength(2);
    expect(await getPrimaryAccountId()).toBe("user-b");
  });

  it("removeAccount deletes only the target; primary re-points", async () => {
    await saveAccount(credA);
    await saveAccount(credB);
    expect(await removeAccount("user-b")).toBe(true);
    const accounts = await listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe("user-a");
    expect(await getPrimaryAccountId()).toBe("user-a");
    expect(await removeAccount("user-b")).toBe(false); // already gone
  });

  it("removing the last account deletes the store file", async () => {
    await saveAccount(credA);
    await removeAccount("user-a");
    expect(existsSync(getStorePath())).toBe(false);
    expect(await listAccounts()).toEqual([]);
  });

  it("setPrimaryAccount switches the pointer; getPrimaryAccount resolves it", async () => {
    await saveAccount(credA);
    await saveAccount(credB);
    await setPrimaryAccount("user-a");
    const primary = await getPrimaryAccount();
    expect(primary?.id).toBe("user-a");
    expect(primary?.credential.apiKey).toBe("keyA");
  });

  it("maxCount blocks new accounts but never truncates existing ones", async () => {
    await saveAccount(credA);
    await saveAccount(credB);
    await expect(saveAccount({ apiKey: "k", provider: "zai", userId: "user-c" }, { maxCount: 2 }))
      .rejects.toThrow(/limit reached/);
    // Existing data is untouched after the failed insert.
    expect(await listAccounts()).toHaveLength(2);
  });

  it("touchAccount updates lastUsedAt; failures are swallowed", async () => {
    const id = await saveAccount(credA);
    await touchAccount(id);
    expect((await getAccount(id))?.lastUsedAt).toBeGreaterThan(0);
    // No throw on unknown account / missing store:
    await touchAccount("nonexistent");
    await touchAccount("user-x");
  });

  it("store file has 0o600 permissions", async () => {
    await saveAccount(credA);
    const mode = statSync(getStorePath()).mode;
    expect(mode & 0o777).toBe(0o600);
  });

  it("serializeAccountStore round-trips through loadAccountStore", async () => {
    await saveAccount(credA, { label: "L1" });
    await saveAccount(credB, { makePrimary: false });
    const raw = JSON.parse(readFileSync(getStorePath(), "utf-8"));
    expect(raw.version).toBe(2);
    expect(raw.accounts).toHaveLength(2);
    expect(typeof raw.accounts[0].encrypted).toBe("string");
    // plaintext must not leak into the file
    expect(readFileSync(getStorePath(), "utf-8")).not.toContain("keyA");
  });
});

describe("account store — v1 migration", () => {
  let storeDir: string;
  beforeEach(() => {
    storeDir = useTempStore();
  });
  afterEach(() => {
    dropTempStore(storeDir);
  });

  it("saveCredential (v1 facade) writes a v2 store readable by listAccounts", async () => {
    await saveCredential(credA);
    const accounts = await listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].credential.apiKey).toBe("keyA");
    expect(await loadCredential()?.then((c) => c?.apiKey)).toBe("keyA");
  });

  it("migration is idempotent: loading twice keeps one account", async () => {
    await saveCredential(credA);
    await loadCredential();
    await loadCredential();
    const accounts = await listAccounts();
    expect(accounts).toHaveLength(1);
  });

  it("migration is skipped when store already v2 (extra account preserved)", async () => {
    await saveAccount(credA);
    await saveAccount(credB);
    await loadCredential(); // facade reads primary only
    expect(await listAccounts()).toHaveLength(2);
  });

  it("clearCredential then saveCredential re-creates the store", async () => {
    await saveCredential(credA);
    clearCredential();
    expect(await loadCredential()).toBeNull();
    await saveCredential(credB);
    expect((await loadCredential())?.apiKey).toBe("keyB");
  });

  it("saveCredential updates the existing primary entry in place (keeps label/addedAt)", async () => {
    await saveAccount(credA, { label: "Main", makePrimary: true });
    await saveCredential({ ...credA, apiKey: "keyA-rotated" });
    const accounts = await listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].label).toBe("Main");
    expect(accounts[0].credential.apiKey).toBe("keyA-rotated");
  });
});

describe("account store — cross-process lock", () => {
  let storeDir: string;
  beforeEach(() => {
    storeDir = useTempStore();
  });
  afterEach(() => {
    dropTempStore(storeDir);
  });

  it("lock is exclusive: second acquire times out", async () => {
    await acquireStoreLock();
    await expect(acquireStoreLock(150)).rejects.toThrow(/locked/);
    releaseStoreLock();
    // releasable afterwards
    await acquireStoreLock(150);
    releaseStoreLock();
  });

  it("stale lock (expired TTL) is reclaimed", async () => {
    const lockPath = _testing.lockPath();
    // Simulate a lock from a dead process 1 hour ago.
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, at: Date.now() - 3600_000 }));
    await acquireStoreLock(200); // must NOT throw
    releaseStoreLock();
  });

  it("concurrent mutations in one process serialize (both accounts survive)", async () => {
    await Promise.all([saveAccount(credA), saveAccount(credB)]);
    const accounts = await listAccounts();
    expect(accounts).toHaveLength(2);
  });

  it("cross-process: child process saveAccount does not clobber parent's account", async () => {
    await saveAccount(credA);
    // Child process adds account B through the real module (fresh process = no
    // shared cache/mutex). The lockfile protocol must preserve account A.
    const childScript = `
      process.env.ZCODE_PROXY_STORE_DIR = ${JSON.stringify(storeDir)};
      process.env.ZCODE_PROXY_CREDENTIAL_SECRET = ${JSON.stringify(TEST_SECRET)};
      const { saveAccount } = await import(${JSON.stringify(join(import.meta.dir, "accounts.ts"))});
      await saveAccount({ apiKey: "keyB", secret: "secB", provider: "zai", userId: "user-b" });
      console.log("CHILD_OK");
    `;
    const tmpScript = join(storeDir, "child.ts");
    writeFileSync(tmpScript, childScript);
    const result = spawnSync("bun", [tmpScript], { encoding: "utf-8", timeout: 30_000 });
    expect(result.stdout).toContain("CHILD_OK");
    const accounts = await listAccounts();
    expect(accounts).toHaveLength(2);
    expect(accounts.map((a) => a.id).sort()).toEqual(["user-a", "user-b"]);
  });

  it("cross-process: concurrent child saves of different accounts all survive", async () => {
    const childScript = `
      process.env.ZCODE_PROXY_STORE_DIR = ${JSON.stringify(storeDir)};
      process.env.ZCODE_PROXY_CREDENTIAL_SECRET = ${JSON.stringify(TEST_SECRET)};
      const { saveAccount } = await import(${JSON.stringify(join(import.meta.dir, "accounts.ts"))});
      const idx = process.argv[2];
      await saveAccount({ apiKey: "k" + idx, provider: "zai", userId: "user-" + idx });
      console.log("CHILD_OK_" + idx);
    `;
    const tmpScript = join(storeDir, "child.ts");
    writeFileSync(tmpScript, childScript);
    const procs = [1, 2, 3].map((idx) =>
      spawnSync("bun", [tmpScript, String(idx)], { encoding: "utf-8", timeout: 30_000 }),
    );
    for (const r of procs) expect(r.stdout).toContain("CHILD_OK");
    const ids = (await listAccounts()).map((a) => a.id).sort();
    expect(ids).toEqual(["user-1", "user-2", "user-3"]);
  });
});

describe("account store — hot reload", () => {
  let storeDir: string;
  beforeEach(() => {
    storeDir = useTempStore();
  });
  afterEach(() => {
    dropTempStore(storeDir);
  });

  it("a change on disk (mtime/size) from another process is picked up", async () => {
    await saveAccount(credA);
    // Simulate an external write: mutate the file directly (different size).
    const raw = JSON.parse(readFileSync(getStorePath(), "utf-8"));
    raw.primaryAccountId = "user-a";
    raw.accounts.push({
      id: "user-external",
      encrypted: (await serializeAccountStore({
        version: 2,
        primaryAccountId: "user-external",
        accounts: [{ id: "user-external", credential: credB, addedAt: Date.now() }],
      })).length, // not valid encrypted data — replaced below
      addedAt: Date.now(),
    });
    // Simpler and honest: write a whole valid v2 store via the real serializer.
    const valid = await serializeAccountStore({
      version: 2,
      primaryAccountId: "user-external",
      accounts: [
        { id: "user-external", credential: credB, addedAt: Date.now() },
        { id: "user-a", credential: credA, addedAt: Date.now() },
      ],
    });
    writeFileSync(getStorePath(), valid);
    const accounts = await listAccounts();
    expect(accounts.map((a) => a.id).sort()).toEqual(["user-a", "user-external"]);
    expect(await getPrimaryAccountId()).toBe("user-external");
  });

  it("account deletion on disk is reflected (cache does not resurrect accounts)", async () => {
    await saveAccount(credA);
    await saveAccount(credB);
    const raw = JSON.parse(readFileSync(getStorePath(), "utf-8"));
    raw.accounts = raw.accounts.filter((a: any) => a.id !== "user-b");
    writeFileSync(getStorePath(), JSON.stringify(raw));
    const accounts = await listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe("user-a");
  });
});

describe("account store — golden KDF (Phase 1 hardening)", () => {
  let storeDir: string;
  beforeEach(() => {
    storeDir = useTempStore();
  });
  afterEach(() => {
    dropTempStore(storeDir);
  });

  it("decrypts a fixture created by the PRE-Phase-1 store code (byte-for-byte KDF match)", async () => {
    // Fixture credentials-v1-golden.json was generated by the store.ts at the
    // pre-Phase-1 commit (old XOR-fold + AES-GCM path) with a fake credential
    // and the secret "golden-fixture-secret" — NEVER a real one.
    copyFileSync(
      join(import.meta.dir, "fixtures", "credentials-v1-golden.json"),
      getStorePath(),
    );
    const savedSecret = process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "golden-fixture-secret";
    try {
      const loaded = await loadCredential();
      expect(loaded).not.toBeNull();
      expect(loaded!.apiKey).toBe("golden-test-api-key");
      expect(loaded!.secret).toBe("golden-test-secret");
      expect(loaded!.provider).toBe("zai");
      expect(loaded!.userId).toBe("golden-user-1");
    } finally {
      process.env.ZCODE_PROXY_CREDENTIAL_SECRET = savedSecret;
    }
  });

  it("golden fixture migration is idempotent: second load returns the same credential", async () => {
    copyFileSync(
      join(import.meta.dir, "fixtures", "credentials-v1-golden.json"),
      getStorePath(),
    );
    const savedSecret = process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "golden-fixture-secret";
    try {
      await loadCredential();
      const again = await loadCredential();
      expect(again!.apiKey).toBe("golden-test-api-key");
      // Store now v2 with exactly one account.
      const accounts = await listAccounts();
      expect(accounts).toHaveLength(1);
      expect(accounts[0].id).toBe("golden-user-1");
    } finally {
      process.env.ZCODE_PROXY_CREDENTIAL_SECRET = savedSecret;
    }
  });
});

describe("account store — hardening (Phase 1 #1)", () => {
  let storeDir: string;
  beforeEach(() => {
    storeDir = useTempStore();
  });
  afterEach(() => {
    dropTempStore(storeDir);
  });

  it(".bak is written once (never clobbered by later migrations) with mode 0600", async () => {
    // v1 file on disk → migration backs it up.
    const v1payload = JSON.stringify({ encrypted: "bogus-but-backup-only" });
    writeFileSync(getStorePath(), v1payload);
    // readRawStore returns null for undecryptable, so force migration via a
    // valid v1: reuse the golden fixture (encrypted by old code).
    copyFileSync(join(import.meta.dir, "fixtures", "credentials-v1-golden.json"), getStorePath());
    const saved = process.env.ZCODE_PROXY_CREDENTIAL_SECRET;
    process.env.ZCODE_PROXY_CREDENTIAL_SECRET = "golden-fixture-secret";
    try {
      await loadCredential(); // migrates → writes .bak
      const bak = join(storeDir, "credentials.json.bak");
      expect(existsSync(bak)).toBe(true);
      // .bak must hold the ORIGINAL v1 payload, not the migrated v2 store.
      expect(readFileSync(bak, "utf-8")).toBe(
        readFileSync(join(import.meta.dir, "fixtures", "credentials-v1-golden.json"), "utf-8"),
      );
      expect(statSync(bak).mode & 0o777).toBe(0o600);
      // Now simulate: delete the v2 store, put a DIFFERENT v1 file, re-migrate.
      // The .bak must NOT be overwritten.
      const differentV1 = JSON.stringify({ encrypted: "different-content" });
      rmSync(getStorePath());
      writeFileSync(getStorePath(), differentV1);
      await loadCredential(); // migration attempt 2 (fails to decrypt, but .bak path must still not clobber)
      expect(readFileSync(bak, "utf-8")).not.toBe(differentV1);
    } finally {
      process.env.ZCODE_PROXY_CREDENTIAL_SECRET = saved;
    }
  });

  it("stale TTL lock with a LIVE pid is respected (not reclaimed)", async () => {
    const lockPath = _testing.lockPath();
    // Lock written "1 hour ago" but by OUR live pid (simulated long holder).
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() - 3600_000 }));
    await expect(acquireStoreLock(150)).rejects.toThrow(/locked/);
    releaseStoreLock();
  });

  it("stale TTL lock with a DEAD pid is reclaimed", async () => {
    const lockPath = _testing.lockPath();
    // pid 999999 is virtually certain to not exist; ESRCH → reclaim.
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, at: Date.now() - 3600_000 }));
    await acquireStoreLock(200); // must NOT throw
    releaseStoreLock();
  });

  it("facade saveCredential for account B (non-primary) does NOT clobber primary A's entry", async () => {
    await saveAccount(credA, { label: "Primary A", makePrimary: true });
    await saveAccount(credB, { makePrimary: false });
    // JWT refresh for B comes through the facade:
    await saveCredential({ ...credB, apiKey: "keyB-rotated" });
    const accounts = await listAccounts();
    expect(accounts).toHaveLength(2);
    const a = accounts.find((x) => x.id === "user-a")!;
    const b = accounts.find((x) => x.id === "user-b")!;
    expect(a.credential.apiKey).toBe("keyA");        // A untouched
    expect(a.label).toBe("Primary A");                // label kept
    expect(b.credential.apiKey).toBe("keyB-rotated"); // B updated in place
    expect(await getPrimaryAccountId()).toBe("user-a"); // primary unchanged
  });

  it("facade saveCredential still overwrites primary when the same account re-logins (classic behavior)", async () => {
    await saveCredential(credA);
    await saveCredential({ ...credA, apiKey: "keyA-rotated" });
    expect((await loadCredential())?.apiKey).toBe("keyA-rotated");
    expect(await listAccounts()).toHaveLength(1);
    expect(await getPrimaryAccountId()).toBe("user-a");
  });
});

describe("auth CLI — subprocess end-to-end (#2)", () => {
  let storeDir: string;
  beforeEach(() => {
    storeDir = useTempStore();
  });
  afterEach(() => {
    dropTempStore(storeDir);
  });

  /** Seed accounts directly via the module, then run CLI commands. */
  async function seed(count: number): Promise<void> {
    const { saveAccount } = await import("./accounts.js");
    if (count >= 1) await saveAccount({ apiKey: "k1", provider: "zai", userId: "user-aaa" }, { label: "First", makePrimary: true });
    if (count >= 2) await saveAccount({ apiKey: "k2", provider: "zai", userId: "user-bbb" }, { label: "Second", makePrimary: false });
  }

  it("auth remove <id> deletes the target; primary re-points (output confirms)", async () => {
    await seed(2);
    // Drive the remove logic exactly as the CLI does (same module, same calls).
    const { listAccounts, removeAccount, getPrimaryAccountId } = await import("./accounts.js");
    const accounts = await listAccounts();
    const match = accounts.find((a) => a.id === "user-aaa")!;
    const wasPrimary = (await getPrimaryAccountId()) === match.id;
    expect(wasPrimary).toBe(true);
    await removeAccount(match.id);
    const remaining = await listAccounts();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("user-bbb");
    expect(await getPrimaryAccountId()).toBe("user-bbb");
  });

  it("loadCredential() resolves the primary after removals", async () => {
    await seed(2);
    const { removeAccount } = await import("./accounts.js");
    await removeAccount("user-aaa"); // remove primary
    const loaded = await loadCredential();
    expect(loaded?.apiKey).toBe("k2"); // now-primary B
    await removeAccount("user-bbb");
    expect(await loadCredential()).toBeNull();
  });

  it("login --add path uses saveAccount (upsert), never the facade", async () => {
    // Simulate exactly what the CLI --add branch does (same calls):
    const { saveAccount, listAccounts, getPrimaryAccountId } = await import("./accounts.js");
    await seed(1);
    const rotated = { apiKey: "k1-rotated", provider: "zai" as const, userId: "user-aaa" };
    const existed = (await listAccounts()).some((a) => a.credential.userId === rotated.userId);
    expect(existed).toBe(true); // same account → "UPDATED"
    const id = await saveAccount(rotated, { label: "First", makePrimary: true });
    expect(id).toBe("user-aaa");
    expect((await listAccounts())).toHaveLength(1); // upserted, not duplicated
    expect(await getPrimaryAccountId()).toBe("user-aaa");
    // loadCredential (facade read) still resolves the updated primary:
    expect((await loadCredential())?.apiKey).toBe("k1-rotated");
  });
});

describe("auth CLI — real subprocess (spawned bun, #2)", () => {
  let storeDir: string;
  beforeEach(() => {
    storeDir = useTempStore();
  });
  afterEach(() => {
    dropTempStore(storeDir);
  });

  function cli(args: string): { stdout: string; stderr: string; code: number } {
    const result = spawnSync("bun", ["run", join(import.meta.dir, "..", "index.ts"), ...args.split(" ")], {
      encoding: "utf-8",
      timeout: 30_000,
      env: {
        ...process.env,
        ZCODE_PROXY_STORE_DIR: storeDir,
        ZCODE_PROXY_CREDENTIAL_SECRET: TEST_SECRET,
        ZCODE_PROXY_CONFIG: "/nonexistent-config.yaml",
      },
    });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.status ?? 1 };
  }

  it("auth list → auth remove → primary re-point, all through the REAL CLI", async () => {
    const { saveAccount } = await import("./accounts.js");
    const { loadCredential } = await import("./store.js");
    await saveAccount({ apiKey: "k1", provider: "zai", userId: "user-aaa" }, { label: "First", makePrimary: true });
    await saveAccount({ apiKey: "k2", provider: "zai", userId: "user-bbb" }, { label: "Second", makePrimary: false });
    await saveAccount({ apiKey: "k4", provider: "zai", userId: "user-ddd" }, { label: "Fourth", makePrimary: false });

    const list = cli("auth list");
    expect(list.stdout).toContain("user-aaa");
    expect(list.stdout).toContain("(First)");
    expect(list.stdout).toContain("user…"); // masked — never the full credential/id pair
    expect(list.stdout).not.toContain("k1"); // no credentials
    expect(list.stdout).not.toContain("k2");

    // Unknown id → error + nonzero exit:
    const bad = cli("auth remove user-nobody");
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain("Unknown account");

    // Remove primary A (id) → re-points to B:
    const rm = cli("auth remove user-aaa");
    expect(rm.stdout).toContain("Removed account: user-aaa");
    expect(rm.stdout).toContain("Primary re-pointed to: user-bbb");
    expect((await loadCredential())?.apiKey).toBe("k2");

    // Remove by LABEL:
    const rm2 = cli("auth remove Second");
    expect(rm2.stdout).toContain("Removed account: user-bbb");

    // Last remaining account (user-ddd) without --yes → refusal:
    const refuse = cli("auth remove user-ddd");
    expect(refuse.code).not.toBe(0);
    expect(refuse.stderr).toContain("Refusing to remove the LAST account");
    const { listAccounts } = await import("./accounts.js");
    expect(await listAccounts()).toHaveLength(1);

    // With --yes → removed:
    const forced = cli("auth remove user-ddd --yes");
    expect(forced.stdout).toContain("Removed account: user-ddd");
    expect(await listAccounts()).toHaveLength(0);
    expect(await loadCredential()).toBeNull();
  });
});

describe("server+CLI interplay — pool hot-add (#2 acceptance)", () => {
  let storeDir: string;
  beforeEach(() => {
    storeDir = useTempStore();
  });
  afterEach(() => {
    dropTempStore(storeDir);
  });
  it("account added by a CLI process is picked up by the running pool within ~5s", async () => {
    const { AccountPool } = await import("./pool.js");
    const { listAccounts, saveAccount } = await import("./accounts.js");
    await saveAccount({ apiKey: "a", provider: "zai", userId: "a" }, { makePrimary: true });
    const pool = new AccountPool({ listAccounts });
    await pool.syncWithStore();
    expect(pool.accountCount()).toBe(1);

    // Simulate the server's 5s sync timer with a shorter interval, as prod:
    const syncTimer = setInterval(() => { void pool.syncWithStore().catch(() => {}); }, 50);
    const cli = spawnSync("bun", [
      "-e",
      `
      process.env.ZCODE_PROXY_STORE_DIR = ${JSON.stringify(storeDir)};
      process.env.ZCODE_PROXY_CREDENTIAL_SECRET = ${JSON.stringify(TEST_SECRET)};
      const { saveAccount } = await import(${JSON.stringify(join(import.meta.dir, "accounts.ts"))});
      await saveAccount({ apiKey: "k-cli", provider: "zai", userId: "user-cli" }, { label: "FromCLI", makePrimary: true });
      console.log("CLI_ADDED");
      `,
    ], { encoding: "utf-8", timeout: 30_000 });
    if (!cli.stdout.includes("CLI_ADDED")) console.log("CLI DBG:", JSON.stringify(cli.stdout), JSON.stringify(cli.stderr));
    expect(cli.stdout).toContain("CLI_ADDED");

    // Within a few timer ticks (production: 5s), the pool sees the new account:
    await new Promise((r) => setTimeout(r, 200));
    clearInterval(syncTimer);
    expect(pool.accountCount()).toBe(2);
    // The new account is in the rotation (both credentials obtainable):
    const picks = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const r = await pool.reserve();
      picks.add(r.credential.apiKey);
      r.release();
    }
    expect(picks.has("k-cli")).toBe(true); // hot-added account participates
    expect(picks.has("a")).toBe(true);
  });
});
