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
  // Optional OpenAI-compatible endpoint (Azure, Ollama, LM Studio, a proxy). Empty = the provider's own URL.
  llmBaseUrl: "",
  // Retrieval mode. Users rarely need to change this; it is exposed in settings for power
  // users who want to compare modes. See src/lib/agent.js and DECISIONS.md for what each means.
  retrievalMode: "hybrid",
  // "hybrid" | "dense" | "sparse"
  // How answers are produced. "deep" = a tool-using research agent (deepagents/LangGraph) that plans,
  // searches and reads your pages as needed; used only with OpenAI-compatible providers. "pipeline" =
  // the fixed fast path (plan, read or search, write). Anything the deep agent can't run falls back to it.
  agentMode: "deep"
  // "deep" | "pipeline"
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
            // client's BM25 term weights (src/lib/sparse.js) into full BM25 scoring without any
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
          // withPayload: true | false | ["field", ...] (only those fields, e.g. to skip chunk text)
          body: { filter, limit: batchSize, offset, with_payload: Array.isArray(withPayload) ? { include: withPayload } : withPayload, with_vector: withVector }
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
function providerBaseUrl(provider, override) {
  return (override || "").replace(/\/+$/, "") || OPENAI_COMPATIBLE_PROVIDERS[provider]?.baseUrl;
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
var NON_CHAT = /embed|whisper|tts|transcribe|dall-e|image|moderation|realtime|audio|davinci|babbage|search|similarity/i;
async function listModels({ provider, apiKey }) {
  if (!apiKey) return { ok: false, message: "Enter an API key first.", models: [] };
  const url = provider === "gemini" ? `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=1000` : providerBaseUrl(provider) ? `${providerBaseUrl(provider)}/models` : null;
  if (!url) return { ok: false, message: `Unknown provider "${provider}".`, models: [] };
  try {
    const res = await fetch(url, provider === "gemini" ? {} : { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) return { ok: false, message: res.status === 401 || res.status === 403 ? "The provider rejected this key." : `Provider error (${res.status}).`, models: [] };
    const json = await res.json();
    const ids = provider === "gemini" ? (json.models || []).filter((m) => (m.supportedGenerationMethods || []).includes("generateContent")).map((m) => String(m.name).replace(/^models\//, "")) : (json.data || []).map((m) => m.id);
    return { ok: true, models: ids.filter((id) => !NON_CHAT.test(id)).sort() };
  } catch {
    return { ok: false, message: "Couldn't reach the provider.", models: [] };
  }
}

// src/settings.js
var ALL_PROVIDERS = { ...OPENAI_COMPATIBLE_PROVIDERS, ...GEMINI_PROVIDER };
var el = {
  qdrantModeRadios: document.querySelectorAll('input[name="qdrantMode"]'),
  qdrantCloudFields: document.getElementById("qdrant-cloud-fields"),
  qdrantUrl: document.getElementById("qdrant-url"),
  qdrantApiKey: document.getElementById("qdrant-apikey"),
  testQdrantBtn: document.getElementById("test-qdrant-btn"),
  qdrantStatus: document.getElementById("qdrant-status"),
  llmTypeRadios: document.querySelectorAll('input[name="llmType"]'),
  llmApiFields: document.getElementById("llm-api-fields"),
  llmLocalFields: document.getElementById("llm-local-fields"),
  llmProvider: document.getElementById("llm-provider"),
  llmApiKey: document.getElementById("llm-apikey"),
  llmModel: document.getElementById("llm-model"),
  llmModelHint: document.getElementById("llm-model-hint"),
  llmBaseUrl: document.getElementById("llm-baseurl"),
  agentMode: document.getElementById("agent-mode"),
  llmKeyUrl: document.getElementById("llm-key-url"),
  testLlmBtn: document.getElementById("test-llm-btn"),
  llmStatus: document.getElementById("llm-status"),
  listModelsBtn: document.getElementById("list-models-btn"),
  modelList: document.getElementById("llm-model-list"),
  saveBtn: document.getElementById("save-btn"),
  saveStatus: document.getElementById("save-status"),
  resetBtn: document.getElementById("reset-btn")
};
function updateQdrantVisibility() {
  const mode = document.querySelector('input[name="qdrantMode"]:checked').value;
  el.qdrantCloudFields.hidden = mode === "local";
}
function updateLLMVisibility() {
  const type = document.querySelector('input[name="llmType"]:checked').value;
  el.llmApiFields.hidden = type === "local";
  el.llmLocalFields.hidden = type === "api";
}
function updateLLMProviderHints() {
  const provider = el.llmProvider.value;
  const config = ALL_PROVIDERS[provider];
  if (!config) return;
  el.llmModelHint.textContent = `Default: ${config.defaultModel}`;
  el.llmApiKey.placeholder = config.keyHint;
  el.llmKeyUrl.href = config.keyUrl;
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
async function loadSettings() {
  const cfg = await getConfig();
  const isLocalQdrant = cfg.qdrantUrl === "http://127.0.0.1:6333" && !cfg.qdrantApiKey;
  document.querySelector(`input[name="qdrantMode"][value="${isLocalQdrant ? "local" : "cloud"}"]`).checked = true;
  el.qdrantUrl.value = cfg.qdrantUrl === "http://127.0.0.1:6333" ? "" : cfg.qdrantUrl;
  el.qdrantApiKey.value = cfg.qdrantApiKey || "";
  updateQdrantVisibility();
  const isLocalLLM = cfg.llmProvider === "webllm";
  document.querySelector(`input[name="llmType"][value="${isLocalLLM ? "local" : "api"}"]`).checked = true;
  if (!isLocalLLM) {
    el.llmProvider.value = cfg.llmProvider;
  }
  el.llmApiKey.value = cfg.llmApiKey || "";
  el.llmModel.value = cfg.llmModel || "";
  el.llmBaseUrl.value = cfg.llmBaseUrl || "";
  el.agentMode.value = cfg.agentMode || "deep";
  updateLLMVisibility();
  updateLLMProviderHints();
}
async function handleSave() {
  el.saveBtn.disabled = true;
  el.saveBtn.textContent = "Saving...";
  const qdrantMode = document.querySelector('input[name="qdrantMode"]:checked').value;
  const llmType = document.querySelector('input[name="llmType"]:checked').value;
  const patch = {
    qdrantUrl: qdrantMode === "local" ? "http://127.0.0.1:6333" : el.qdrantUrl.value.trim() || "http://127.0.0.1:6333",
    qdrantApiKey: qdrantMode === "local" ? "" : el.qdrantApiKey.value.trim(),
    llmProvider: llmType === "local" ? "webllm" : el.llmProvider.value,
    llmApiKey: llmType === "local" ? "" : el.llmApiKey.value.trim(),
    llmModel: llmType === "local" ? "" : el.llmModel.value.trim(),
    llmBaseUrl: llmType === "local" ? "" : el.llmBaseUrl.value.trim(),
    agentMode: el.agentMode.value
  };
  await saveConfig(patch);
  await chrome.runtime.sendMessage({ type: "SET_CONFIG", patch });
  el.saveBtn.disabled = false;
  el.saveBtn.textContent = "Save Settings";
  el.saveStatus.classList.add("show");
  setTimeout(() => el.saveStatus.classList.remove("show"), 2500);
}
async function handleListModels() {
  el.listModelsBtn.disabled = true;
  el.llmStatus.className = "status-badge";
  el.llmStatus.textContent = "Loading models...";
  const r = await listModels({ provider: el.llmProvider.value, apiKey: el.llmApiKey.value.trim() });
  el.modelList.innerHTML = "";
  for (const id of r.models) el.modelList.appendChild(Object.assign(document.createElement("option"), { value: id }));
  el.llmStatus.className = `status-badge ${r.ok ? "success" : "error"}`;
  el.llmStatus.textContent = r.ok ? `\u2713 ${r.models.length} models. Click the Model box to choose one.` : `\u2717 ${r.message}`;
  el.listModelsBtn.disabled = false;
}
async function handleTestQdrant() {
  el.testQdrantBtn.disabled = true;
  el.qdrantStatus.className = "status-badge";
  el.qdrantStatus.textContent = "Testing...";
  const mode = document.querySelector('input[name="qdrantMode"]:checked').value;
  const url = mode === "local" ? "http://127.0.0.1:6333" : el.qdrantUrl.value.trim();
  const apiKey = mode === "local" ? "" : el.qdrantApiKey.value.trim();
  if (mode === "cloud" && !url) {
    el.qdrantStatus.className = "status-badge error";
    el.qdrantStatus.textContent = "\u{1F534} URL required";
    el.testQdrantBtn.disabled = false;
    return;
  }
  try {
    const client = makeClient({ url, apiKey });
    const res = await client.health();
    if (res.reachable && res.ready) {
      el.qdrantStatus.className = "status-badge success";
      el.qdrantStatus.textContent = "\u{1F7E2} Connected";
    } else if (res.reachable && !res.ready) {
      el.qdrantStatus.className = "status-badge error";
      el.qdrantStatus.textContent = "\u{1F534} Reached, but not ready";
    } else {
      el.qdrantStatus.className = "status-badge error";
      el.qdrantStatus.textContent = "\u{1F534} Unreachable";
    }
  } catch (err) {
    el.qdrantStatus.className = "status-badge error";
    el.qdrantStatus.textContent = "\u{1F534} Error";
  }
  el.testQdrantBtn.disabled = false;
}
el.qdrantModeRadios.forEach((r) => r.addEventListener("change", updateQdrantVisibility));
el.llmTypeRadios.forEach((r) => r.addEventListener("change", updateLLMVisibility));
el.llmProvider.addEventListener("change", updateLLMProviderHints);
el.testQdrantBtn.addEventListener("click", handleTestQdrant);
el.testLlmBtn.addEventListener("click", handleTestLLM);
el.listModelsBtn.addEventListener("click", handleListModels);
el.saveBtn.addEventListener("click", handleSave);
el.resetBtn.addEventListener("click", async (e) => {
  e.preventDefault();
  if (confirm("Reset all settings to default?")) {
    await saveConfig(DEFAULT_CONFIG);
    await chrome.runtime.sendMessage({ type: "SET_CONFIG", patch: DEFAULT_CONFIG });
    loadSettings();
  }
});
document.addEventListener("DOMContentLoaded", loadSettings);
