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

// LangChain/deepagents reference Node built-ins in code paths that never run in a browser (file
// backends, sandboxes, AsyncLocalStorage). Resolve them to an empty module so the bundle builds.
const NODE_BUILTINS = /^(node:)?(fs|fs\/promises|path|util|os|url|crypto|stream|events|child_process|http|https|net|tls|zlib|buffer|assert|module|worker_threads|async_hooks|readline|perf_hooks|string_decoder|querystring|process|vm)$/;
const stubNodeBuiltins = {
  name: "stub-node-builtins",
  setup(build) {
    build.onResolve({ filter: NODE_BUILTINS }, () => ({ path: new URL("./shims/empty.js", import.meta.url).pathname }));
  },
};

const options = {
  plugins: [stubNodeBuiltins],
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

// The offscreen bundle carries the models' runtimes plus LangChain/deepagents and loads on every
// browser session, so it is minified in release builds; the small bundles stay readable.
const offscreenOnly = { ...options, entryPoints: { offscreen: "src/offscreen.js" } };
const rest = { ...options, entryPoints: Object.fromEntries(entryPoints.filter((e) => e.out !== "offscreen").map((e) => [e.out, e.in])) };

if (watch) {
  for (const o of [offscreenOnly, rest]) await (await esbuild.context(o)).watch();
  console.log("Watching for changes...");
} else {
  await Promise.all([esbuild.build({ ...offscreenOnly, minify: true }), esbuild.build(rest)]);
}
