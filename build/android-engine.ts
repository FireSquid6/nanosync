// Build-time only: the entrypoint graph contains no Bun/Node APIs or tests.
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dir, "..");
const outdir = resolve(root, "apps/android/app/src/main/assets");
await mkdir(outdir, { recursive: true });
const result = await Bun.build({ entrypoints: [resolve(root, "apps/android/engine/index.ts")], outdir, naming: "engine.js", target: "browser", format: "iife", minify: true });
if (!result.success) throw new AggregateError(result.logs, "Android engine bundle failed");
await Bun.write(resolve(outdir, "engine.html"), Bun.file(resolve(root, "apps/android/engine/engine.html")));
console.log(`Bundled Android engine into ${outdir}`);
