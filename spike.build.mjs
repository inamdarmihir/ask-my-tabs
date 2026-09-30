import * as esbuild from "esbuild";
const nodeBuiltins = /^(node:)?(fs|fs\/promises|path|util|os|url|crypto|stream|events|child_process|http|https|net|tls|zlib|buffer|assert|module|worker_threads|async_hooks|readline|perf_hooks|string_decoder|querystring|process|vm)$/;
const stub = { name: "stub-node", setup(b) { b.onResolve({ filter: nodeBuiltins }, () => ({ path: new URL("./shims/empty.js", import.meta.url).pathname })); } };
await esbuild.build({ entryPoints: ["spike.tmp.js"], bundle: true, format: "esm", platform: "browser", conditions: ["browser"], outfile: "spike.out.tmp.js", plugins: [stub], logLevel: "warning", minify: true, inject: ["./shims/process.js"], define: { "process.env.NODE_ENV": '"production"' } });
