// src/lib/config.js
var CONFIG_KEY = "ask-my-tabs-config";
var OPENAI_COMPATIBLE_PROVIDERS = {
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-6-luna",
    keyHint: "sk-...",
    keyUrl: "https://platform.openai.com/api-keys"
  },
  groq: {
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    keyHint: "gsk_...",
    keyUrl: "https://console.groq.com/keys"
  }
};
var GEMINI_PROVIDER = {
  gemini: {
    label: "Google Gemini",
    defaultModel: "gemini-1.5-flash",
    keyHint: "AIza...",
    keyUrl: "https://aistudio.google.com/app/apikey"
  }
};
var ALL_API_PROVIDERS = { ...OPENAI_COMPATIBLE_PROVIDERS, ...GEMINI_PROVIDER };
var DEFAULT_CONFIG = {
  // Qdrant connection. An empty apiKey means no Authorization header (local Docker default).
  qdrantUrl: "http://127.0.0.1:6333",
  qdrantApiKey: "",
  // LLM. "webllm" requires WebGPU + a ~0.5 GB one-time model download. API providers need a key.
  llmProvider: "webllm",
  // "openai" | "groq" | "gemini" | "webllm"
  llmApiKey: "",
  llmModel: "",
  // empty = use the provider's defaultModel from OPENAI_COMPATIBLE_PROVIDERS
  // Retrieval mode. Users rarely need to change this; it is exposed in settings for power
  // users who want to compare modes. See src/lib/agent.js and DECISIONS.md for what each means.
  retrievalMode: "hybrid"
  // "hybrid" | "dense" | "sparse"
};
async function getConfig() {
  if (typeof chrome === "undefined" || !chrome?.storage?.local) {
    return { ...DEFAULT_CONFIG };
  }
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  return { ...DEFAULT_CONFIG, ...stored[CONFIG_KEY] || {} };
}
async function saveConfig(patch) {
  if (typeof chrome === "undefined" || !chrome?.storage?.local) return;
  const current = await getConfig();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [CONFIG_KEY]: next });
  return next;
}

// src/lib/qdrant.js
var DENSE_VECTOR_NAME = "dense";
var SPARSE_VECTOR_NAME = "sparse";
var DENSE_SIZE = 384;
var DEFAULT_RRF_K = 60;
var DEFAULT_RRF_WEIGHTS = { dense: 1, sparse: 1 };
var QdrantConnectionError = class extends Error {
  constructor(url, cause) {
    super(
      `Can't reach Qdrant at ${url}. If using local Docker, run "docker compose up -d" in the project root. If using Qdrant Cloud, check your URL and API key in Settings.`
    );
    this.name = "QdrantConnectionError";
    this.cause = cause;
  }
};
var QdrantSchemaError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "QdrantSchemaError";
  }
};
var QdrantApiError = class extends Error {
  constructor(status, body) {
    super(`Qdrant API error ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
    this.name = "QdrantApiError";
    this.status = status;
    this.body = body;
  }
};
function makeClient({ url = "http://127.0.0.1:6333", apiKey = "" } = {}) {
  const baseUrl = url;
  const authHeaders = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  async function request(path, { method = "GET", body } = {}) {
    let res;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...authHeaders,
          ...body ? { "Content-Type": "application/json" } : {}
        },
        body: body ? JSON.stringify(body) : void 0
      });
    } catch (err) {
      throw new QdrantConnectionError(baseUrl, err);
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      throw new QdrantApiError(res.status, json?.status?.error ?? json ?? text);
    }
    return json;
  }
  return {
    baseUrl,
    // Bounded, fast liveness check for the UI's "Qdrant down" banner. Distinguishes
    // "unreachable" from "reachable but not ready yet" so the guidance can differ.
    // Auth headers are included because Qdrant Cloud requires them on all endpoints.
    async health() {
      try {
        const res = await fetch(`${baseUrl}/readyz`, { method: "GET", headers: authHeaders });
        return { reachable: true, ready: res.ok };
      } catch (err) {
        return { reachable: false, ready: false, error: String(err) };
      }
    },
    async listCollections() {
      const res = await request("/collections");
      return res.result.collections.map((c) => c.name);
    },
    async getCollection(name) {
      try {
        const res = await request(`/collections/${encodeURIComponent(name)}`);
        return res.result;
      } catch (err) {
        if (err instanceof QdrantApiError && err.status === 404) return null;
        throw err;
      }
    },
    // Idempotent: creates the collection with the schema this project needs if it doesn't
    // exist; if it already exists, verifies the dense vector's dimension/distance and the
    // sparse vector's presence match what's expected, and THROWS instead of silently deleting
    // or recreating on mismatch -- per explicit instruction, incompatible schema is detected,
    // never silently wiped.
    async ensureCollection(name, { denseSize = DENSE_SIZE } = {}) {
      const existing = await this.getCollection(name);
      if (!existing) {
        await request(`/collections/${encodeURIComponent(name)}`, {
          method: "PUT",
          body: {
            vectors: {
              [DENSE_VECTOR_NAME]: { size: denseSize, distance: "Cosine" }
            },
            // Qdrant applies IDF at query time from live collection statistics, turning the
            // client's log-TF vectors (src/lib/sparse.js) into TF-IDF scoring without any
            // client-side corpus state.
            sparse_vectors: {
              [SPARSE_VECTOR_NAME]: { index: { on_disk: false }, modifier: "idf" }
            }
          }
        });
      } else {
        const denseCfg = existing.config?.params?.vectors?.[DENSE_VECTOR_NAME];
        const sparseCfg = existing.config?.params?.sparse_vectors?.[SPARSE_VECTOR_NAME];
        if (!denseCfg) {
          throw new QdrantSchemaError(
            `Collection "${name}" exists but has no "${DENSE_VECTOR_NAME}" named vector. Refusing to touch it automatically -- inspect it manually or use a different collection name.`
          );
        }
        if (denseCfg.size !== denseSize) {
          throw new QdrantSchemaError(
            `Collection "${name}" has dense vector size ${denseCfg.size}, expected ${denseSize}. This usually means it was created with a different embedding model. Refusing to delete or recreate it automatically -- back it up, drop it manually with "docker compose down -v" (destroys ALL collections) or the Qdrant API, then retry.`
          );
        }
        if ((denseCfg.distance || "").toLowerCase() !== "cosine") {
          throw new QdrantSchemaError(
            `Collection "${name}" has dense distance metric "${denseCfg.distance}", expected "Cosine". Refusing to modify it automatically.`
          );
        }
        if (!sparseCfg) {
          throw new QdrantSchemaError(
            `Collection "${name}" exists but has no "${SPARSE_VECTOR_NAME}" sparse vector configured -- it predates hybrid retrieval support. Refusing to modify it automatically; create a fresh collection instead.`
          );
        }
        if (sparseCfg.modifier !== "idf") {
          await request(`/collections/${encodeURIComponent(name)}`, {
            method: "PATCH",
            body: { sparse_vectors: { [SPARSE_VECTOR_NAME]: { modifier: "idf" } } }
          });
        }
      }
      const indexes = [
        ["sourceKey", "keyword"],
        ["domain", "keyword"],
        ["indexedAt", "integer"],
        ["contentHash", "keyword"],
        ["chunkIndex", "integer"],
        ["corpusMode", "keyword"]
      ];
      for (const [field, schema] of indexes) {
        await request(`/collections/${encodeURIComponent(name)}/index`, {
          method: "PUT",
          body: { field_name: field, field_schema: schema }
        });
      }
      return { created: !existing };
    },
    async deleteCollection(name) {
      await request(`/collections/${encodeURIComponent(name)}`, { method: "DELETE" });
    },
    // Upsert is the only write path for chunk points. Point IDs are deterministic (see
    // src/lib/ids.js), so re-upserting the same (source, snapshot, chunk index) overwrites in
    // place rather than duplicating.
    // `wait=true` on both write paths below: without it Qdrant acknowledges the write and
    // returns before the change is guaranteed visible to a subsequent query, which was caught
    // live in this project's own integration tests (a query issued immediately after an upsert
    // intermittently missed the just-written point). Correctness > raw write throughput at this
    // project's scale.
    async upsertPoints(collection, points) {
      if (points.length === 0) return;
      await request(`/collections/${encodeURIComponent(collection)}/points?wait=true`, {
        method: "PUT",
        body: {
          points: points.map((p) => ({
            id: p.id,
            vector: { [DENSE_VECTOR_NAME]: p.dense, [SPARSE_VECTOR_NAME]: p.sparse },
            payload: p.payload
          }))
        }
      });
    },
    async deletePointsByFilter(collection, filter) {
      await request(`/collections/${encodeURIComponent(collection)}/points/delete?wait=true`, {
        method: "POST",
        body: { filter }
      });
    },
    async deleteBySourceKey(collection, sourceKey) {
      await this.deletePointsByFilter(collection, {
        must: [{ key: "sourceKey", match: { value: sourceKey } }]
      });
    },
    // Scrolls every point matching an (optional) filter, returning only the requested payload
    // fields. Used for library listing (distinct sources/domains/dates) and for the eval
    // harness's ground-truth lookups. Fine at this project's corpus size (hundreds of chunks,
    // not millions); would need real pagination-aware batching at a scale this project
    // explicitly isn't targeting.
    async scrollAll(collection, { filter, withPayload = true, withVector = false, batchSize = 256 } = {}) {
      const out = [];
      let offset;
      while (true) {
        const res = await request(`/collections/${encodeURIComponent(collection)}/points/scroll`, {
          method: "POST",
          body: { filter, limit: batchSize, offset, with_payload: withPayload, with_vector: withVector }
        });
        out.push(...res.result.points);
        offset = res.result.next_page_offset;
        if (!offset || res.result.points.length === 0) break;
      }
      return out;
    },
    // Core retrieval entry point. `mode` is one of "dense", "sparse", "hybrid" -- see
    // src/lib/agent.js and eval/PROTOCOL.md for what each means and how they're compared.
    // `filter` is a Qdrant filter object (already built by the caller, e.g. scoping to a
    // working set's source keys and/or a domain/date range) applied identically regardless of
    // mode, so variants are compared at the same eligible corpus.
    //
    // Hybrid mode fuses dense and sparse prefetches with weighted RRF (`rrfK`, `rrfWeights`).
    // When `groupBy` is set, results go through /points/query/groups so at most `groupSize`
    // hits come from each distinct payload value (e.g. per source), which keeps one long page
    // from crowding every other source out of the context. Grouped results are flattened back
    // into a single score-sorted list so callers don't need to know grouping happened.
    async query(collection, {
      mode,
      dense,
      sparse,
      filter,
      limit = 8,
      prefetchLimit = 40,
      rrfK = DEFAULT_RRF_K,
      rrfWeights = DEFAULT_RRF_WEIGHTS,
      groupBy = null,
      groupSize = 2
    }) {
      const body = { filter, limit, with_payload: true, with_vector: false };
      if (mode === "dense") {
        body.query = dense;
        body.using = DENSE_VECTOR_NAME;
      } else if (mode === "sparse") {
        body.query = sparse;
        body.using = SPARSE_VECTOR_NAME;
      } else if (mode === "hybrid") {
        body.prefetch = [
          { query: dense, using: DENSE_VECTOR_NAME, limit: prefetchLimit, filter },
          { query: sparse, using: SPARSE_VECTOR_NAME, limit: prefetchLimit, filter }
        ];
        body.query = { rrf: { k: rrfK, weights: [rrfWeights.dense, rrfWeights.sparse] } };
        delete body.filter;
      } else {
        throw new Error(`Unknown retrieval mode: ${mode}`);
      }
      const toHit = (p) => ({ id: p.id, score: p.score, payload: p.payload });
      if (groupBy) {
        const res2 = await request(`/collections/${encodeURIComponent(collection)}/points/query/groups`, {
          method: "POST",
          body: { ...body, group_by: groupBy, group_size: groupSize }
        });
        return res2.result.groups.flatMap((g) => g.hits.map(toHit)).sort((a, b) => b.score - a.score);
      }
      const res = await request(`/collections/${encodeURIComponent(collection)}/points/query`, {
        method: "POST",
        body
      });
      return res.result.points.map(toHit);
    }
  };
}

// src/lib/llm-api.js
function resolveModel(provider, model) {
  if (model) return model;
  return OPENAI_COMPATIBLE_PROVIDERS[provider]?.defaultModel || "gpt-6-luna";
}
function providerBaseUrl(provider) {
  return OPENAI_COMPATIBLE_PROVIDERS[provider]?.baseUrl;
}
async function testApiKey({ provider, apiKey, model }) {
  if (!apiKey) return { ok: false, message: "Enter an API key first." };
  const resolvedModel = resolveModel(provider, model);
  let url;
  let headers = {};
  if (provider === "gemini") {
    url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=1000`;
  } else if (providerBaseUrl(provider)) {
    url = `${providerBaseUrl(provider)}/models`;
    headers = { Authorization: `Bearer ${apiKey}` };
  } else {
    return { ok: false, message: `Unknown provider "${provider}".` };
  }
  let res;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    return { ok: false, message: "Couldn't reach the provider. Check your connection." };
  }
  if (res.status === 401 || res.status === 403 || provider === "gemini" && res.status === 400) {
    return { ok: false, message: "The provider rejected this key." };
  }
  if (!res.ok) return { ok: false, message: `The provider returned an error (${res.status}).` };
  try {
    const json = await res.json();
    const ids = provider === "gemini" ? (json.models || []).map((m) => String(m.name).replace(/^models\//, "")) : (json.data || []).map((m) => m.id);
    if (ids.length && !ids.includes(resolvedModel)) {
      return { ok: true, message: `Key works, but "${resolvedModel}" isn't in this account's model list.` };
    }
  } catch {
  }
  return { ok: true, message: `Key works. Using ${resolvedModel}.` };
}

// src/onboarding.js
var LOCAL_QDRANT_URL = "http://127.0.0.1:6333";
var ALL_PROVIDERS = { ...OPENAI_COMPATIBLE_PROVIDERS, ...GEMINI_PROVIDER };
var el = {
  qdrantModeRadios: document.querySelectorAll('input[name="obQdrantMode"]'),
  qdrantCloudFields: document.getElementById("ob-qdrant-cloud-fields"),
  qdrantUrl: document.getElementById("ob-qdrant-url"),
  qdrantApiKey: document.getElementById("ob-qdrant-apikey"),
  step1Btn: document.getElementById("ob-step1-btn"),
  qdrantStatus: document.getElementById("ob-qdrant-status"),
  step1Card: document.getElementById("step-1"),
  llmTypeRadios: document.querySelectorAll('input[name="obLlmType"]'),
  llmApiFields: document.getElementById("ob-llm-api-fields"),
  llmProvider: document.getElementById("ob-llm-provider"),
  llmApiKey: document.getElementById("ob-llm-apikey"),
  llmKeyUrl: document.getElementById("ob-llm-key-url"),
  llmModel: document.getElementById("ob-llm-model"),
  llmModelHint: document.getElementById("ob-llm-model-hint"),
  testLlmBtn: document.getElementById("ob-test-llm-btn"),
  llmStatus: document.getElementById("ob-llm-status"),
  qdrantDetected: document.getElementById("ob-qdrant-detected"),
  step2Btn: document.getElementById("ob-step2-btn"),
  step2Card: document.getElementById("step-2"),
  step3Card: document.getElementById("step-3"),
  doneBtn: document.getElementById("ob-done-btn")
};
function updateQdrantVisibility() {
  const mode = document.querySelector('input[name="obQdrantMode"]:checked').value;
  el.qdrantCloudFields.hidden = mode === "local";
}
function updateLLMVisibility() {
  const type = document.querySelector('input[name="obLlmType"]:checked').value;
  el.llmApiFields.hidden = type === "local";
}
function updateLLMProviderHints() {
  const provider = el.llmProvider.value;
  const config = ALL_PROVIDERS[provider];
  if (!config) return;
  el.llmApiKey.placeholder = config.keyHint;
  el.llmKeyUrl.href = config.keyUrl;
  el.llmModelHint.textContent = `Default: ${config.defaultModel}`;
  el.llmStatus.textContent = "";
}
async function handleTestLLM() {
  el.testLlmBtn.disabled = true;
  el.llmStatus.className = "status-badge";
  el.llmStatus.textContent = "Testing...";
  const r = await testApiKey({
    provider: el.llmProvider.value,
    apiKey: el.llmApiKey.value.trim(),
    model: el.llmModel.value.trim()
  });
  el.llmStatus.className = `status-badge ${r.ok ? "success" : "error"}`;
  el.llmStatus.textContent = `${r.ok ? "\u2713" : "\u2717"} ${r.message}`;
  el.testLlmBtn.disabled = false;
}
async function detectLocalQdrant() {
  try {
    const res = await makeClient({ url: LOCAL_QDRANT_URL }).health();
    if (res.reachable && res.ready) {
      document.querySelector('input[name="obQdrantMode"][value="local"]').checked = true;
      el.qdrantDetected.hidden = false;
      updateQdrantVisibility();
    }
  } catch {
  }
}
async function handleStep1() {
  const mode = document.querySelector('input[name="obQdrantMode"]:checked').value;
  const url = mode === "local" ? LOCAL_QDRANT_URL : el.qdrantUrl.value.trim();
  const apiKey = mode === "local" ? "" : el.qdrantApiKey.value.trim();
  if (mode === "cloud" && !url) {
    el.qdrantStatus.className = "status-badge error";
    el.qdrantStatus.textContent = "URL required";
    return;
  }
  el.step1Btn.disabled = true;
  el.step1Btn.textContent = "Testing...";
  el.qdrantStatus.className = "status-badge";
  el.qdrantStatus.textContent = "";
  try {
    const client = makeClient({ url, apiKey });
    const res = await client.health();
    if (res.reachable && res.ready) {
      el.qdrantStatus.className = "status-badge success";
      el.qdrantStatus.textContent = "Connected \u2713";
      const patch = { qdrantUrl: url, qdrantApiKey: apiKey };
      await saveConfig(patch);
      await chrome.runtime.sendMessage({ type: "SET_CONFIG", patch });
      el.step2Card.classList.remove("locked");
      el.step1Btn.hidden = true;
    } else {
      el.qdrantStatus.className = "status-badge error";
      el.qdrantStatus.textContent = "Connection failed";
      el.step1Btn.disabled = false;
      el.step1Btn.textContent = "Test & Continue \u2192";
    }
  } catch (err) {
    el.qdrantStatus.className = "status-badge error";
    el.qdrantStatus.textContent = "Connection failed";
    el.step1Btn.disabled = false;
    el.step1Btn.textContent = "Test & Continue \u2192";
  }
}
async function handleStep2() {
  const type = document.querySelector('input[name="obLlmType"]:checked').value;
  const patch = {
    llmProvider: type === "local" ? "webllm" : el.llmProvider.value,
    llmApiKey: type === "local" ? "" : el.llmApiKey.value.trim(),
    llmModel: type === "local" ? "" : el.llmModel.value.trim()
  };
  el.step2Btn.disabled = true;
  el.step2Btn.textContent = "Saving...";
  await saveConfig(patch);
  await chrome.runtime.sendMessage({ type: "SET_CONFIG", patch });
  el.step1Card.hidden = true;
  el.step2Card.hidden = true;
  el.step3Card.hidden = false;
}
el.qdrantModeRadios.forEach((r) => r.addEventListener("change", updateQdrantVisibility));
el.llmTypeRadios.forEach((r) => r.addEventListener("change", updateLLMVisibility));
el.llmProvider.addEventListener("change", updateLLMProviderHints);
el.step1Btn.addEventListener("click", handleStep1);
el.step2Btn.addEventListener("click", handleStep2);
el.testLlmBtn.addEventListener("click", handleTestLLM);
el.doneBtn.addEventListener("click", () => {
  window.close();
});
document.addEventListener("DOMContentLoaded", () => {
  updateQdrantVisibility();
  updateLLMVisibility();
  updateLLMProviderHints();
  detectLocalQdrant();
});
