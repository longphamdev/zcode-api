#!/usr/bin/env node
// Verifies package.json version === src/index.ts VERSION const. Run manually:
//   node Android-APP/scripts/check-version-sync.mjs
// The Android versionName is NOT compared: release CI injects it from the tag
// (ORG_GRADLE_PROJECT_androidApp_versionName → build.gradle.kts `prop()`
// lookup) while local builds intentionally fall back to the "3.0.0-android"
// dev sentinel — UpdateChecker treats dev builds as outdated by design.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..");

const pkgVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")).version;
const srcContent = readFileSync(join(repoRoot, "src/index.ts"), "utf-8");
const srcMatch = srcContent.match(/VERSION\s*=\s*"([^"]+)"/);
if (!srcMatch) throw new Error("Version not found in src/index.ts (pattern: /VERSION\\s*=\\s*\"([^\"]+)\"/)");
const srcVersion = srcMatch[1];

console.log(`package.json:           ${pkgVersion}`);
console.log(`src/index.ts VERSION:   ${srcVersion}`);

if (pkgVersion !== srcVersion) {
  console.error(`MISMATCH: package.json=${pkgVersion} vs src/index.ts=${srcVersion}`);
  process.exit(1);
}
console.log("OK: package.json and src/index.ts versions in sync.");
