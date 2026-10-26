import { build } from "esbuild";

await build({
  entryPoints: { server: "capture/main.ts", "extract-thread": "capture/extract-thread.ts" },
  outdir: "dist/capture", outExtension: { ".js": ".mjs" }, bundle: true,
  platform: "node", target: "node22", format: "esm",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
