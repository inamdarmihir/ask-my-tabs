// Wraps a small sentence-embedding model running entirely in-browser via transformers.js.
// bge-small-en-v1.5 is ~33M parameters, 384-dim -- small enough to load in a couple of seconds
// on WASM and near-instantly on WebGPU, and it's a real retrieval-tuned embedder rather than a
// general-purpose language model pressed into service as one.

import { pipeline, env } from "@huggingface/transformers";
import { hasWebGPU } from "./gpu.js";

env.allowLocalModels = false;

// Load the ONNX runtime from the extension package (copied to dist/ort/ by build.js) instead of
// the default CDN, which the extension CSP blocks. Single-threaded: multi-threaded WASM needs
// cross-origin isolation, which extension pages don't have.
if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
  env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("dist/ort/");
  env.backends.onnx.wasm.numThreads = 1;
}

const MODEL_ID = "Xenova/bge-small-en-v1.5";

let extractorPromise = null;

// Unlike WebLLM (src/lib/llm.js), the embedder has a real WASM fallback, so lack of WebGPU is
// not fatal here -- it's just slower. Checking navigator.gpu up front (instead of always trying
// WebGPU first and catching the failure) avoids a noisy failed-init attempt in the console on
// every machine without a GPU adapter, which on Windows and Linux without a dGPU is common, not
// exotic. This is the same code path on every desktop OS; there is nothing OS-specific here.
async function getExtractor(onProgress) {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      if (await hasWebGPU()) {
        try {
          return await pipeline("feature-extraction", MODEL_ID, {
            device: "webgpu",
            dtype: "fp16",
            progress_callback: onProgress,
          });
        } catch (err) {
          console.warn("[embeddings] WebGPU init failed despite an adapter being present, falling back to WASM:", err);
        }
      }
      return await pipeline("feature-extraction", MODEL_ID, {
        device: "wasm",
        dtype: "fp16",
        progress_callback: onProgress,
      });
    })().catch((err) => {
      extractorPromise = null; // don't cache a failure -- allow retry on the next "Load models" click
      throw err;
    });
  }
  return extractorPromise;
}

export async function loadEmbedder(onProgress) {
  await getExtractor(onProgress);
}

// Returns one Float32Array per input string, mean-pooled and L2-normalized so cosine
// similarity reduces to a plain dot product in the vector store.
// Used for DOCUMENT embedding at index time -- do not add the query prefix here.
export async function embed(texts, onProgress) {
  const extractor = await getExtractor(onProgress);
  const output = await extractor(texts, { pooling: "mean", normalize: true });
  const dim = output.dims[output.dims.length - 1];
  const flat = output.data;
  const vectors = [];
  for (let i = 0; i < texts.length; i++) {
    vectors.push(Float32Array.from(flat.slice(i * dim, (i + 1) * dim)));
  }
  return vectors;
}

// bge-small-en-v1.5 was trained with a query-time instruction prefix that signals to the model
// that the input is a search query, not a passage to be indexed. Omitting it at query time
// measurably degrades query-document alignment (see DECISIONS.md). The prefix is applied here,
// not at the caller site, so no other module needs to know about it.
//
// The model call receives the prefixed text; the returned vectors correspond to the original
// unprefixed texts (one vector per input text in the same order). The prefix is never stored.
const BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

export async function embedQuery(texts, onProgress) {
  const prefixed = texts.map((t) => `${BGE_QUERY_PREFIX}${t}`);
  return embed(prefixed, onProgress);
}
