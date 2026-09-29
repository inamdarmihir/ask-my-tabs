// Retrieval eval: scores embedding configurations on BEIR SciFact through the same chunking,
// sparse-vector, and Qdrant query code the extension uses. See DECISIONS.md for the selection
// rule this feeds, and eval/RESULTS.md for the last run.
//
//   npm run eval                       all configs, 1,000-doc corpus, all 300 test queries
//   npm run eval -- --docs 500 --queries 100 --configs bge-small-q8
//
// Requires local Qdrant (docker compose up -d). Each config runs in its own throwaway collection,
// named with the eval prefix so it can never touch the real library collection.

import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { pipeline, env } from "@huggingface/transformers";
import { makeClient, DENSE_SIZE } from "../src/lib/qdrant.js";
import { chunkText } from "../src/lib/chunk.js";
import { sparseVector } from "../src/lib/sparse.js";
import { chunkPointId } from "../src/lib/ids.js";
import { ndcgAtK, recallAtK, mrrAtK, mean, docRanking, selectConfig } from "./metrics.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(ROOT, ".data", "scifact");
const QDRANT_URL = process.env.QDRANT_URL || "http://127.0.0.1:6333";
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: "; // bge and LEAF-IR

const CONFIGS = [
  { key: "bge-small-fp16", model: "Xenova/bge-small-en-v1.5", dtype: "fp16" },
  { key: "bge-small-q8", model: "Xenova/bge-small-en-v1.5", dtype: "q8" },
  { key: "leaf-ir-fp16", model: "MongoDB/mdbr-leaf-ir", dtype: "fp16" },
  { key: "leaf-ir-q8", model: "MongoDB/mdbr-leaf-ir", dtype: "q8" },
];
const DTYPE_SUFFIX = { fp32: "", fp16: "_fp16", q8: "_quantized" };
// name -> client.query options. The weighted variants are reported for the weights rule in
// DECISIONS.md; they don't feed the model-selection rule.
const MODES = {
  dense: { mode: "dense" },
  sparse: { mode: "sparse" },
  hybrid: { mode: "hybrid" },
  hybrid_w2: { mode: "hybrid", rrfWeights: { dense: 2, sparse: 1 } },
  hybrid_w3: { mode: "hybrid", rrfWeights: { dense: 3, sparse: 1 } },
};

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

// Small seeded PRNG so the corpus subset is identical run to run.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function readJsonl(path) {
  return readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

function loadDataset(maxDocs, maxQueries) {
  if (!existsSync(join(DATA_DIR, "corpus.jsonl"))) {
    throw new Error(
      `SciFact not found at ${DATA_DIR}. Download and unzip ` +
        `https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip into eval/.data/`,
    );
  }
  const corpus = new Map(readJsonl(join(DATA_DIR, "corpus.jsonl")).map((d) => [d._id, d]));
  const queries = new Map(readJsonl(join(DATA_DIR, "queries.jsonl")).map((q) => [q._id, q.text]));
  const qrels = new Map(); // queryId -> Map(docId -> relevance)
  for (const line of readFileSync(join(DATA_DIR, "qrels", "test.tsv"), "utf8").trim().split("\n").slice(1)) {
    const [qid, did, score] = line.split("\t");
    if (Number(score) <= 0) continue;
    if (!qrels.has(qid)) qrels.set(qid, new Map());
    qrels.get(qid).set(did, Number(score));
  }
  let queryIds = Array.from(qrels.keys()).filter((id) => queries.has(id)).sort((a, b) => Number(a) - Number(b));
  if (maxQueries) queryIds = queryIds.slice(0, maxQueries);

  // Corpus = every doc relevant to a kept query, topped up with seeded-random distractors.
  const relevantDocs = new Set(queryIds.flatMap((q) => Array.from(qrels.get(q).keys())));
  const rest = Array.from(corpus.keys()).filter((id) => !relevantDocs.has(id)).sort();
  const rnd = mulberry32(42);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  const docIds = [...relevantDocs, ...rest.slice(0, Math.max(0, maxDocs - relevantDocs.size))];
  return {
    docs: docIds.map((id) => corpus.get(id)),
    queries: queryIds.map((id) => ({ id, text: queries.get(id), relevant: qrels.get(id) })),
  };
}

// Size of the model file the extension would bundle for this dtype (weights file + external data).
function modelSizeMB({ model, dtype }) {
  const base = join(env.cacheDir, model, "onnx", `model${DTYPE_SUFFIX[dtype]}.onnx`);
  let bytes = 0;
  for (const f of [base, `${base}_data`]) if (existsSync(f)) bytes += statSync(f).size;
  return bytes / 1e6;
}

async function embedAll(extractor, texts, batch = 16) {
  const out = [];
  for (let i = 0; i < texts.length; i += batch) {
    const res = await extractor(texts.slice(i, i + batch), { pooling: "mean", normalize: true });
    const dim = res.dims[res.dims.length - 1];
    if (dim !== DENSE_SIZE) throw new Error(`model outputs ${dim} dims, collection expects ${DENSE_SIZE}`);
    for (let j = 0; j < res.dims[0]; j++) out.push(Array.from(res.data.slice(j * dim, (j + 1) * dim)));
  }
  return out;
}

async function evalConfig(client, cfg, data) {
  const t0 = performance.now();
  const extractor = await pipeline("feature-extraction", cfg.model, { dtype: cfg.dtype, device: "cpu" });
  const loadMs = performance.now() - t0;

  // Same chunking as the extension. Document text = title + abstract.
  const chunks = [];
  for (const d of data.docs) {
    chunkText(`${d.title}. ${d.text}`).forEach((text, i) => chunks.push({ docId: d._id, chunkIndex: i, text }));
  }
  let s = performance.now();
  const docVecs = await embedAll(extractor, chunks.map((c) => c.text));
  const embedMsPerChunk = (performance.now() - s) / chunks.length;

  s = performance.now();
  const queryVecs = await embedAll(extractor, data.queries.map((q) => QUERY_PREFIX + q.text));
  const embedMsPerQuery = (performance.now() - s) / data.queries.length;

  const collection = `ask_my_tabs_eval_${cfg.key}_${Date.now()}`;
  try {
    await client.ensureCollection(collection);
    const points = [];
    for (let i = 0; i < chunks.length; i++) {
      points.push({
        id: await chunkPointId(chunks[i].docId, "eval", chunks[i].chunkIndex),
        dense: docVecs[i],
        sparse: sparseVector(chunks[i].text),
        payload: { docId: chunks[i].docId },
      });
    }
    for (let i = 0; i < points.length; i += 64) await client.upsertPoints(collection, points.slice(i, i + 64));

    const result = { ...cfg, sizeMB: modelSizeMB(cfg), loadMs, chunks: chunks.length, embedMsPerChunk, embedMsPerQuery };
    for (const [modeName, modeOpts] of Object.entries(MODES)) {
      const ndcg = [], recall = [], mrr = [];
      s = performance.now();
      for (let qi = 0; qi < data.queries.length; qi++) {
        const q = data.queries[qi];
        const hits = await client.query(collection, {
          ...modeOpts,
          dense: queryVecs[qi],
          sparse: sparseVector(q.text),
          limit: 50,
          prefetchLimit: 100,
        });
        const ranked = docRanking(hits, (h) => h.payload.docId);
        ndcg.push(ndcgAtK(ranked, q.relevant, 10));
        recall.push(recallAtK(ranked, q.relevant, 10));
        mrr.push(mrrAtK(ranked, q.relevant, 10));
      }
      result[modeName] = {
        ndcg: mean(ndcg),
        recall: mean(recall),
        mrr: mean(mrr),
        qdrantMsPerQuery: (performance.now() - s) / data.queries.length,
      };
    }
    return result;
  } finally {
    await client.deleteCollection(collection).catch(() => {});
  }
}

function renderResults(results, data, meta, selection) {
  const f = (x) => x.toFixed(3);
  const rows = results.map((r) =>
    `| ${r.key} | ${r.sizeMB.toFixed(0)} | ${f(r.dense.ndcg)} | ${f(r.sparse.ndcg)} | **${f(r.hybrid.ndcg)}** | ${f(r.hybrid.recall)} | ${f(r.hybrid.mrr)} | ${r.embedMsPerChunk.toFixed(0)} | ${r.embedMsPerQuery.toFixed(0)} | ${r.hybrid.qdrantMsPerQuery.toFixed(0)} |`,
  );
  return `# Retrieval eval results

Generated by \`npm run eval\` on ${meta.date}. Do not edit by hand.

- **Dataset:** BEIR SciFact test split, ${data.queries.length} queries over a ${data.docs.length}-document corpus (${meta.chunks} chunks at 180 words / 30 overlap). Every document relevant to a query is in the corpus; the rest is seeded-random distractors.
- **Pipeline:** the extension's own \`chunkText\`, \`sparseVector\`, and \`client.query\` against Qdrant ${meta.qdrant} (server-side IDF, weighted RRF (equal weights unless a weights table says otherwise), no source grouping). Documents are ranked by their best chunk.
- **Runtime:** transformers.js ${meta.transformers} on Node/CPU (${meta.cpu}). Latency columns are Node numbers, not browser numbers.
- **Metrics:** nDCG@10 by mode, plus recall@10 and MRR@10 for hybrid. Higher is better.

| Config | Size MB | nDCG dense | nDCG sparse | nDCG hybrid | Recall@10 hybrid | MRR@10 hybrid | embed ms/chunk | embed ms/query | Qdrant ms/query |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

### Hybrid fusion weights (dense:sparse), nDCG@10

| Config | 1:1 | 2:1 | 3:1 |
| --- | --- | --- | --- |
${results.map((r) => `| ${r.key} | ${f(r.hybrid.ndcg)} | ${f(r.hybrid_w2.ndcg)} | ${f(r.hybrid_w3.ndcg)} |`).join("\n")}

## Decision (rule in DECISIONS.md)

- Best hybrid nDCG@10 among valid configs: **${selection.best.key}** (${f(selection.best.hybrid.ndcg)}).
- Excluded as broken exports: ${selection.excluded.length ? selection.excluded.map((r) => r.key).join(", ") : "none"}.
- Within 0.010 of the best: ${selection.eligible.map((r) => `${r.key} (${r.sizeMB.toFixed(0)} MB)`).join(", ")}.
- **Chosen: ${selection.chosen.key}** (${selection.chosen.model}, ${selection.chosen.dtype}, ${selection.chosen.sizeMB.toFixed(0)} MB).
`;
}

async function main() {
  const maxDocs = Number(arg("docs", 1000));
  const maxQueries = Number(arg("queries", 300));
  const only = arg("configs", "").split(",").filter(Boolean);
  const configs = only.length ? CONFIGS.filter((c) => only.includes(c.key)) : CONFIGS;

  const client = makeClient({ url: QDRANT_URL });
  const health = await client.health();
  if (!health.reachable || !health.ready) throw new Error(`Qdrant not ready at ${QDRANT_URL} (docker compose up -d)`);

  const data = loadDataset(maxDocs, maxQueries);
  console.log(`corpus: ${data.docs.length} docs, ${data.queries.length} queries, ${configs.length} configs`);

  const results = [];
  for (const cfg of configs) {
    console.log(`\n== ${cfg.key}`);
    try {
      const r = await evalConfig(client, cfg, data);
      results.push(r);
      console.log(
        `   size ${r.sizeMB.toFixed(0)} MB | nDCG@10 dense ${r.dense.ndcg.toFixed(3)} sparse ${r.sparse.ndcg.toFixed(3)} hybrid ${r.hybrid.ndcg.toFixed(3)} | embed ${r.embedMsPerChunk.toFixed(0)} ms/chunk`,
      );
    } catch (err) {
      console.error(`   FAILED: ${err.message}`);
    }
  }
  if (results.length === 0) throw new Error("no config completed");

  const selection = selectConfig(results);
  const info = await (await fetch(`${QDRANT_URL}/`)).json();
  const pkg = JSON.parse(readFileSync(join(ROOT, "..", "node_modules/@huggingface/transformers/package.json"), "utf8"));
  const cpu = execFileSync("sysctl", ["-n", "machdep.cpu.brand_string"]).toString().trim();
  const md = renderResults(
    results,
    data,
    { date: new Date().toISOString().slice(0, 10), qdrant: info.version, transformers: pkg.version, cpu, chunks: results[0].chunks },
    selection,
  );
  writeFileSync(join(ROOT, "RESULTS.md"), md);
  writeFileSync(join(ROOT, "results.json"), JSON.stringify(results, null, 2));
  console.log(`\nChosen: ${selection.chosen.key}. Wrote eval/RESULTS.md`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
