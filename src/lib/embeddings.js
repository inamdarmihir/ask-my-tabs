// Wraps the small sentence-embedding model (see embedding-model.js) running entirely in-browser
// via transformers.js. The model files ship inside the extension (models/), so indexing needs no
// network, works offline, and never waits on a Hugging Face download.

import { pipeline, env } from "@huggingface/transformers";
import { EMBEDDING_MODEL } from "./embedding-model.js";

env.allowLocalModels = true;

// Load the ONNX runtime and the model from the extension package instead of a CDN or the Hugging
// Face hub (the extension CSP blocks the CDN; the runtime is copied to dist/ort/ by build.js and
// the model to models/ by scripts/fetch-models.js). Remote loading stays allowed only as a
// fallback if the bundled files are missing. Bundled files skip the browser cache: they are
// already local, and caching would just duplicate them.
if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
  env.localModelPath = chrome.runtime.getURL("models/");
  env.useBrowserCache = false;
  env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("dist/ort/");
  // Multi-threaded WASM needs cross-origin isolation (see manifest.json); otherwise one thread.
  env.backends.onnx.wasm.numThreads = self.crossOriginIsolated
    ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1))
    : 1;
}

const MODEL_ID = EMBEDDING_MODEL.id;
const DTYPE = EMBEDDING_MODEL.dtype;

let extractorPromise = null;

// Always WASM. The bundled model is 8-bit quantized (best size/quality/speed in eval/RESULTS.md);
// quantized integer operators run well on the WASM backend but are not reliably supported by
// WebGPU, and running on the CPU leaves the GPU free for the on-device language model.
async function getExtractor(onProgress) {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", MODEL_ID, {
      device: "wasm",
      dtype: DTYPE,
      progress_callback: onProgress,
    }).catch((err) => {
      extractorPromise = null; // don't cache a failure -- allow retry on the next attempt
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

// The model expects a query-time instruction prefix (EMBEDDING_MODEL.queryPrefix) that signals the
// input is a search query, not a passage to be indexed; the eval applies the same prefix, so
// omitting it would make production retrieval differ from the measured numbers. The prefix is
// applied here, not at the caller site, so no other module needs to know about it.
//
// The model call receives the prefixed text; the returned vectors correspond to the original
// unprefixed texts (one vector per input text in the same order). The prefix is never stored.

export async function embedQuery(texts, onProgress) {
  const prefixed = texts.map((t) => `${EMBEDDING_MODEL.queryPrefix}${t}`);
  return embed(prefixed, onProgress);
}
