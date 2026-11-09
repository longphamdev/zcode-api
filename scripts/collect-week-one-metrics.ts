/**
 * Week-one metrics collector (#8). Run against the LIVE container's logs:
 *
 *   bun run scripts/collect-week-one-metrics.ts [--since "2026-11-10"]
 *
 * Grep-based counts over the fixed structured log lines — no credentials in
 * output (account ids are UUIDs; user ids never appear in pool lines).
 */
import { execSync } from "node:child_process";

const since = process.argv.includes("--since") ? process.argv[process.argv.indexOf("--since") + 1] : "";
const container = process.env.ZCODE_PROXY_CONTAINER ?? "zcode-api-zcode-proxy-1";

let logs: string;
try {
  logs = execSync(`docker logs ${container} 2>&1${since ? ` --since "${since}"` : ""}`, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  console.error(`Failed to read logs from ${container}: ${(e as Error).message}`);
  process.exit(1);
}

const count = (re: RegExp): number => (logs.match(re) ?? []).length;
const transitions = [...logs.matchAll(/pool: account=(\S+) from=(\S+) to=(\S+) reason=(.+)$/gm)];

console.log("=== Week-one metrics (#8) ===\n");

// 1. AccountsBusyError rate
const busy = count(/accounts_busy/g);
const total429 = count(/HTTP: 429|batch  \|  429/g);
console.log(`1. AccountsBusyError: ${busy} (429 responses total: ${total429})`);
console.log("   → high? raise queueTimeoutMs to 20-30s (NOT the cap)");

// 2. State flapping per account
const perAccount = new Map<string, number>();
for (const [, id, from, to] of transitions) {
  if (from === to) continue;
  perAccount.set(id, (perAccount.get(id) ?? 0) + 1);
}
console.log(`\n2. State transitions (flapping): ${transitions.length} total`);
for (const [id, n] of perAccount) console.log(`   ${id.slice(0, 12)}…: ${n} transitions`);
console.log("   → high for one account? misclassification — investigate reasons below");
const reasons = new Map<string, number>();
for (const [, , , reason] of transitions) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
for (const [r, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`   reason="${r}": ${n}`);

// 3. Retry-After values (from debug lines when debug enabled, else count cooling)
const retryAfterVals = [...logs.matchAll(/upstream Retry-After: (\d+)s/g)].map((m) => Number(m[1]));
console.log(`\n3. Retry-After samples: ${retryAfterVals.length}`);
if (retryAfterVals.length > 0) {
  const sorted = [...retryAfterVals].sort((a, b) => a - b);
  console.log(`   min=${sorted[0]}s median=${sorted[Math.floor(sorted.length / 2)]}s max=${sorted[sorted.length - 1]}s`);
  console.log("   → enough samples? finalize the 6h clamp + global thresholds");
} else {
  console.log("   none captured — enable debug mode to log them");
}

// 4. Half-open probe outcomes
const probes = count(/to=healthy reason=(request succeeded|half-open probe|successful request)/g);
const reExhausts = count(/from=exhausted to=exhausted|quota gone \(biz-1005\)/g);
console.log(`\n4. Half-open probe heals: ${probes}, re-exhaustions: ${reExhausts}`);
console.log("   → heal-then-immediately-dead cycles = account genuinely out of quota");

// 5. Balance reliability
const unreliable = count(/remainingUnreliable/g);
const exhaustedCount = count(/biz-1005|biz 1005/g);
console.log(`\n5. Balance unreliability: exhausted-marks ${exhaustedCount}, unreliable-flagged polls (debug) ${unreliable}`);

console.log("\n=== Unknown errors (redact before posting) ===");
const unknowns = logs.match(/pool: unknown upstream error.*/g) ?? [];
for (const u of unknowns.slice(0, 20)) {
  console.log(u.replace(/authorization[^,}]*/gi, "[redacted]").replace(/x-api-key[^,}]*/gi, "[redacted]"));
}
if (unknowns.length > 20) console.log(`… and ${unknowns.length - 20} more`);
