// @ts-nocheck -- the `with { type: "file" }` asset import below is a Bun-only
// extension with no type declaration, and its target exists only after
// scripts/build-fork-worker.ts has run (gitignored build input).
/**
 * captcha-worker-asset.ts — sole carrier of Bun's file-asset import.
 *
 * The `with { type: "file" }` attribute is what embeds the pre-bundled worker
 * into `bun build --compile` single-file binaries (extracted to a temp path at
 * runtime; `new Worker(new URL(...))` does not survive compilation). Two
 * constraints shape this module's isolation:
 *
 * - esbuild (the Android server bundle) REJECTS the attribute at parse time
 *   ("Importing with a type attribute of 'file' is not supported"), so this
 *   file must be kept out of the esbuild graph: build:android-bundle marks it
 *   --external, and consumers may only reach it via dynamic import.
 * - The asset file is absent on a fresh checkout, so a static import would
 *   break `bun run dev` and the Docker image (both run TS sources) at module
 *   load. Consumers must therefore dynamic-import THIS module and treat any
 *   failure as "worker path unavailable" (fall back to in-process solving).
 */
import entryPath from "./captcha-worker-entry.bundle.js" with { type: "file" };

export default entryPath;
