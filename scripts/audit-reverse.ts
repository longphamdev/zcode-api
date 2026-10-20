/** Offline evidence extraction. Does not execute the client bundles or contact upstream. */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const targets = [
  { path: "_reverse/glm/zcode.cjs", anchors: ["function HUs(", "function DGs(", "function s5s(", "WD_CLIENT_SIGN_KDF_SALT", "account_uuid", "disable_parallel_tool_use", "budget_tokens", "oauth/cli/init", "off-peak"] },
  { path: "_reverse/app/out/host/index.js", anchors: ["Bh=class", "function vee(", "function oN(", "foreign-card", "next_draw_at", "/billing/claim"] },
  { path: "_reverse/app/out/host/chunk-XLKRUNM2.js", anchors: ["requestVerificationClaimHeaders", "access_tokens", "off-peak"] },
];
for (const target of targets) {
  const source = readFileSync(target.path, "utf8");
  console.log(JSON.stringify({ path: target.path, bytes: Buffer.byteLength(source), sha256: createHash("sha256").update(source).digest("hex") }));
  for (const anchor of target.anchors) {
    const offset = source.indexOf(anchor);
    console.log(JSON.stringify({ anchor, offset, excerpt: offset < 0 ? null : source.slice(Math.max(0, offset - 100), offset + 1600) }));
  }
}

// Literal presence is a drift signal, not a substitute for reconstructing the
// client's dynamic section selection and joins. Keep failures visible.
const bundle = readFileSync("_reverse/glm/zcode.cjs", "utf8");
const literalView = bundle.replace(/\\u([\da-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  .replace(/\\`/g, "`");
const sidecar = JSON.parse(readFileSync("src/proxy/zcode_system.json", "utf8"));
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}
const promptLines = [...new Set(strings(sidecar).flatMap(s => s.split("\n")).filter(s => s.length > 30))];
const missing = promptLines.filter(s => !literalView.includes(s) && !literalView.includes(JSON.stringify(s).slice(1, -1)));
console.log(JSON.stringify({ check: "prompt-literal-presence", checked: promptLines.length, missing }));
const poweredBy = literalView.indexOf("You are powered by the model named");
console.log(JSON.stringify({ check: "dynamic-model-line", offset: poweredBy, excerpt: poweredBy < 0 ? null : literalView.slice(Math.max(0, poweredBy - 100), poweredBy + 220) }));
