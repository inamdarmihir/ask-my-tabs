// One-time dev script: downloads the embedding model the extension bundles, at a pinned Hugging
// Face revision, into models/<repo>/ in the layout transformers.js expects for local models.
// The result is committed, so load-unpacked from a clone works with zero downloads at run time.
//
//   node scripts/fetch-models.js --model MongoDB/mdbr-leaf-ir --dtype q8
//   node scripts/fetch-models.js --model Xenova/bge-small-en-v1.5 --dtype q8 --revision <sha>
//
// Without --revision, the current head SHA is resolved and printed so it can be recorded in
// DECISIONS.md and src/lib/embeddings.js. Existing files with the right size are kept, so an
// interrupted download can simply be re-run.

import { mkdirSync, existsSync, statSync, createWriteStream, rmSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DTYPE_SUFFIX = { fp32: "", fp16: "_fp16", q8: "_quantized" };
const SMALL_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "vocab.txt"];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const model = arg("model");
const dtype = arg("dtype", "q8");
if (!model || !(dtype in DTYPE_SUFFIX)) {
  console.error("usage: node scripts/fetch-models.js --model <org/name> --dtype fp32|fp16|q8 [--revision <sha>]");
  process.exit(1);
}

const info = await (await fetch(`https://huggingface.co/api/models/${model}?blobs=true`)).json();
const revision = arg("revision", info.sha);
const listing = new Map((info.siblings || []).map((s) => [s.rfilename, s.size]));

const onnx = `onnx/model${DTYPE_SUFFIX[dtype]}.onnx`;
const wanted = [...SMALL_FILES, onnx, `${onnx}_data`].filter((f) => listing.has(f));
if (!listing.has(onnx)) {
  console.error(`${model} has no ${onnx}. Available: ${[...listing.keys()].filter((f) => f.startsWith("onnx/")).join(", ")}`);
  process.exit(1);
}

const outDir = join(ROOT, "models", model);
console.log(`model ${model}  dtype ${dtype}  revision ${revision}`);
for (const file of wanted) {
  const dest = join(outDir, file);
  const expected = listing.get(file);
  if (existsSync(dest) && statSync(dest).size === expected) {
    console.log(`  keep   ${file}`);
    continue;
  }
  mkdirSync(dirname(dest), { recursive: true });
  // Resumable with retries: a dropped connection keeps the bytes already written and continues
  // from there with a Range request, so a flaky network doesn't restart a 23 MB download.
  const partial = `${dest}.part`;
  for (let attempt = 1; ; attempt++) {
    try {
      const have = existsSync(partial) ? statSync(partial).size : 0;
      const res = await fetch(`https://huggingface.co/${model}/resolve/${revision}/${file}`, {
        headers: have ? { Range: `bytes=${have}-` } : {},
      });
      if (!res.ok && res.status !== 206) throw new Error(`${file}: HTTP ${res.status}`);
      const append = res.status === 206;
      await pipeline(Readable.fromWeb(res.body), createWriteStream(partial, { flags: append ? "a" : "w" }));
      renameSync(partial, dest);
      break;
    } catch (err) {
      if (attempt >= 8) throw err;
      console.log(`  retry  ${file} (attempt ${attempt} failed: ${err.cause?.code || err.message})`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  const size = statSync(dest).size;
  if (expected && size !== expected) {
    rmSync(dest, { force: true });
    throw new Error(`${file}: got ${size} bytes, expected ${expected}`);
  }
  console.log(`  fetch  ${file}  ${(size / 1e6).toFixed(1)} MB`);
}
console.log(`\nDone. Record this in DECISIONS.md: ${model}@${revision} (${dtype}).`);
