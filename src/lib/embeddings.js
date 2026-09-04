// Wraps a small sentence-embedding model running entirely in-browser via transformers.js.
// bge-small-en-v1.5 is ~33M parameters, 384-dim -- small enough to load in a couple of seconds
// on WASM and near-instantly on WebGPU, and it's a real retrieval-tuned embedder rather than a
// general-purpose language model pressed into service as one.

import { pipeline, env } from "@huggingface/transformers";

env.allowLocalModels = false;

const MODEL_ID = "Xenova/bge-small-en-v1.5";

let extractorPromise = null;

async function getExtractor(onProgress) {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      try {
        return await pipeline("feature-extraction", MODEL_ID, {
          device: "webgpu",
          dtype: "fp16",
          progress_callback: onProgress,
        });
      } catch (err) {
        console.warn("[embeddings] WebGPU unavailable, falling back to WASM:", err);
        return await pipeline("feature-extraction", MODEL_ID, {
          device: "wasm",
          dtype: "fp16",
          progress_callback: onProgress,
        });
      }
    })();
  }
  return extractorPromise;
}

export async function loadEmbedder(onProgress) {
  await getExtractor(onProgress);
}

// Returns one Float32Array per input string, mean-pooled and L2-normalized so cosine
// similarity reduces to a plain dot product in the vector store.
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
