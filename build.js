import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");

const entryPoints = [
  { in: "src/background.js", out: "background" },
  { in: "src/offscreen.js", out: "offscreen" },
  { in: "src/popup/main.jsx", out: "popup" },
  { in: "src/settings.js", out: "settings" },
  { in: "src/onboarding.js", out: "onboarding" },
];

// onnxruntime-web (used by transformers.js) loads its WASM runtime at run time. By default it
// fetches it from a CDN, which the extension's CSP (script-src 'self') blocks. Ship the files
// with the extension and point ONNX at them (see src/lib/embeddings.js).
function copyOrtRuntime() {
  mkdirSync("dist/ort", { recursive: true });
  for (const f of ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"]) {
    copyFileSync(`node_modules/@huggingface/transformers/dist/${f}`, `dist/ort/${f}`);
  }
}
copyOrtRuntime();

const options = {
  entryPoints: Object.fromEntries(entryPoints.map((e) => [e.out, e.in])),
  bundle: true,
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  format: "esm",
  target: "chrome120",
  platform: "browser",
  conditions: ["browser"],
  outdir: "dist",
  entryNames: "[name].bundle",
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  await esbuild.build(options);
}
