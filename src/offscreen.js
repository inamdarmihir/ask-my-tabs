// Where the actual work happens: the embedding model, the LLM, the Qdrant client, and the agent
// loop all live here. This document is created once by background.js via chrome.offscreen and
// stays alive independently of whether the popup is open, so model weights only load once per
// browser session, not every time the user clicks the toolbar icon.
//
// All user-configurable values (Qdrant URL, API key, LLM provider) are read from config at
// startup and whenever a CONFIG_CHANGED message arrives. Nothing here hardcodes a URL or
// provider string -- those live exclusively in src/lib/config.js.

import "../shims/process-global.js"; // must stay first: LangChain reads `process` at load time
import { loadEmbedder, embed } from "./lib/embeddings.js";
import { loadLLM, chatJSON as chatJSONWebLLM, chatStream as chatStreamWebLLM } from "./lib/llm.js";
import { chatJSONApi, chatStreamApi } from "./lib/llm-api.js";
import { makeClient, QdrantConnectionError, QdrantSchemaError } from "./lib/qdrant.js";
import { indexSource, removeSourceFromLibrary, listLibrarySources } from "./lib/library.js";
import { answerQuestion } from "./lib/agent.js";
import { answerWithDeepAgent } from "./lib/deep-agent.js";
import { OPENAI_COMPATIBLE_PROVIDERS } from "./lib/config.js";
import { DEFAULT_CONFIG } from "./lib/config.js";
import { libraryCollectionName, DEFAULT_RETRIEVAL_MODE } from "./lib/constants.js";
import { EMBEDDING_MODEL } from "./lib/embedding-model.js";
import { SPARSE_ALGORITHM_VERSION } from "./lib/sparse.js";
import { normalizeProgress } from "./lib/model-progress.js";

const LIBRARY_COLLECTION = libraryCollectionName(EMBEDDING_MODEL.key, SPARSE_ALGORITHM_VERSION);
import { embedQuery } from "./lib/embeddings.js";

// Offscreen documents have no chrome.storage (only chrome.runtime), so lib/config.js's getConfig()
// silently returns the built-in defaults here -- which meant the user's API key, provider and Qdrant
// URL were never applied to answering. The service worker can read storage; ask it.
async function getConfig() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_CONFIG" });
    if (res?.ok && res.config) return res.config;
  } catch (err) {
    console.warn("[offscreen] couldn't read settings from the background:", err);
  }
  return { ...DEFAULT_CONFIG };
}

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    /* no listener (popup closed) -- best-effort UI feedback */
  });
}

// ─── Config-driven client construction ───────────────────────────────────────

// Both are rebuilt whenever the config changes. They are module-level so every message handler
// closes over the same (always-current) references.
let qdrant = makeClient({ url: "http://127.0.0.1:6333", apiKey: "" });
let collectionReady = false;

// Build the chatJSON / chatStream pair appropriate for the current config. WebLLM is the
// default (and the only option that was previously available); API providers are the new path.
// The returned functions have the same signatures as their llm.js counterparts so the agent
// loop in agent.js needs no special-casing.
function buildLLMFunctions(cfg) {
  if (cfg.llmProvider === "webllm") {
    return {
      chatJSON: chatJSONWebLLM,
      chatStream: chatStreamWebLLM,
    };
  }
  const { llmProvider: provider, llmApiKey: apiKey, llmModel: model } = cfg;
  return {
    chatJSON: (messages) => chatJSONApi(messages, { provider, apiKey, model, baseUrl: cfg.llmBaseUrl }),
    chatStream: (messages, onToken) => chatStreamApi(messages, { provider, apiKey, model, baseUrl: cfg.llmBaseUrl }, onToken),
  };
}

let llmFunctions = { chatJSON: chatJSONWebLLM, chatStream: chatStreamWebLLM };

// Reads the current config and rebuilds the Qdrant client and LLM functions. Called on startup
// and on every CONFIG_CHANGED message. Collection-readiness is invalidated on rebuild because
// the URL or key may have changed, pointing at a different (or newly-accessible) Qdrant instance.
async function applyConfig() {
  const cfg = await getConfig();
  qdrant = makeClient({ url: cfg.qdrantUrl, apiKey: cfg.qdrantApiKey });
  llmFunctions = buildLLMFunctions(cfg);
  collectionReady = false; // re-verify on next operation -- URL may have changed
  return cfg;
}

// ─── Model loading ────────────────────────────────────────────────────────────

// The embedder and the LLM load independently. Indexing a tab only needs the embedder (small),
// so it must never wait on the WebLLM download (hundreds of MB) even when local answers are
// selected. Answering needs both (the LLM only when the provider is "webllm").
let embedderReady = false;
let embedderPromise = null;
let llmReady = false;
let llmPromise = null;

// Latest progress of the on-device answer model, so a popup opened mid-download can show a live bar
// instead of waiting for the next event.
let lastLLMProgress = null;

function reportModelProgress(stage, label, p) {
  const progress = normalizeProgress(label, p);
  if (!progress) return;
  if (stage === "llm") lastLLMProgress = progress;
  broadcast({ type: "MODEL_PROGRESS", stage, ...progress });
}

function ensureEmbedderLoaded() {
  if (embedderReady) return Promise.resolve();
  if (!embedderPromise) {
    broadcast({ type: "MODEL_PROGRESS", stage: "embedder", pct: null, phase: "init", mb: null, detail: "Loading embedding model..." });
    embedderPromise = loadEmbedder((p) => reportModelProgress("embedder", "embedding", p))
      .then(() => {
        embedderReady = true;
      })
      .catch((err) => {
        // Don't cache a failed load: a transient issue (network hiccup, GPU flag) should be
        // retry-able without reloading the extension.
        embedderPromise = null;
        throw err;
      });
  }
  return embedderPromise;
}

function ensureLLMLoaded(cfg) {
  if (cfg.llmProvider !== "webllm" || llmReady) return Promise.resolve();
  if (!llmPromise) {
    lastLLMProgress = { pct: null, phase: "init", mb: null, detail: "Loading language model (~0.5 GB, one-time)..." };
    broadcast({ type: "MODEL_PROGRESS", stage: "llm", ...lastLLMProgress });
    llmPromise = loadLLM((p) => reportModelProgress("llm", "language", p))
      .then(() => {
        llmReady = true;
        lastLLMProgress = null;
      })
      .catch((err) => {
        llmPromise = null;
        lastLLMProgress = null;
        throw err;
      });
  }
  return llmPromise;
}

async function ensureModelsLoaded(cfg) {
  await Promise.all([ensureEmbedderLoaded(), ensureLLMLoaded(cfg)]);
  broadcast({ type: "MODELS_READY" });
}

function modelsReadyFor(cfg) {
  return embedderReady && (cfg.llmProvider !== "webllm" || llmReady);
}

async function ensureCollectionReady() {
  if (collectionReady) return;
  await qdrant.ensureCollection(LIBRARY_COLLECTION);
  collectionReady = true;
}

// ─── Error classification ─────────────────────────────────────────────────────

function describeQdrantError(err) {
  if (err instanceof QdrantConnectionError) return { kind: "down", message: err.message };
  if (err instanceof QdrantSchemaError) return { kind: "schema", message: err.message };
  return { kind: "other", message: String(err?.message || err) };
}

// ─── Message handlers ─────────────────────────────────────────────────────────

// Apply config on first load so the Qdrant client and LLM functions are correct before any
// message arrives. Errors here are non-fatal: the client falls back to localhost defaults.
applyConfig().catch((err) => console.warn("[offscreen] config load on startup failed:", err));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_STATE") {
    const llmState = { llmLoading: !!llmPromise && !llmReady, llmProgress: lastLLMProgress };
    getConfig()
      .then((cfg) => sendResponse({ ok: true, modelsReady: modelsReadyFor(cfg), embedderReady, ...llmState }))
      .catch(() => sendResponse({ ok: true, modelsReady: false, embedderReady, ...llmState }));
    return true;
  }

  // Start loading the embedder early (popup open) so the first "Add tab" doesn't pay for it.
  // Best-effort: failures surface on the real operation, which retries the load.
  if (message.type === "WARM_EMBEDDER") {
    ensureEmbedderLoaded().catch((err) => console.warn("[offscreen] warm-up failed:", err));
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "CONFIG_CHANGED") {
    // Rebuild clients without reloading the offscreen document. Model weights already in memory
    // are kept; only the Qdrant client and LLM provider need to be swapped.
    applyConfig()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === "QDRANT_HEALTH") {
    qdrant
      .health()
      .then((health) => sendResponse({ ok: true, health }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === "LOAD_MODELS") {
    getConfig()
      .then((cfg) => ensureModelsLoaded(cfg))
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error("[offscreen] model load failed:", err);
        broadcast({ type: "MODEL_ERROR", error: String(err) });
        sendResponse({ ok: false, error: String(err) });
      });
    return true;
  }

  if (message.type === "INDEX_SOURCE") {
    (async () => {
      try {
        // Indexing only needs the embedder, never the LLM.
        await ensureEmbedderLoaded();
        await ensureCollectionReady();
        const result = await indexSource(qdrant, LIBRARY_COLLECTION, {
          canonicalUrl: message.url,
          title: message.title,
          text: message.text,
          embed,
          pageKind: message.pageKind,
          observedTabId: message.tabId,
          observedSessionId: message.sessionId,
          onProgress: (p) => broadcast({ type: "INDEX_PROGRESS", tabId: message.tabId, ...p }),
        });
        console.info("[offscreen] indexed", message.url, result.skipped ? "(unchanged)" : `${result.chunkCount} chunks`, result.timings);
        sendResponse({ ok: true, ...result });
      } catch (err) {
        console.error("[offscreen] indexing failed:", err);
        sendResponse({ ok: false, error: String(err), qdrant: describeQdrantError(err) });
      }
    })();
    return true;
  }

  if (message.type === "DELETE_FROM_LIBRARY") {
    (async () => {
      try {
        await ensureCollectionReady();
        const result = await removeSourceFromLibrary(qdrant, LIBRARY_COLLECTION, message.url);
        sendResponse({ ok: true, ...result });
      } catch (err) {
        sendResponse({ ok: false, error: String(err), qdrant: describeQdrantError(err) });
      }
    })();
    return true;
  }

  if (message.type === "LIST_LIBRARY") {
    (async () => {
      try {
        await ensureCollectionReady();
        const sources = await listLibrarySources(qdrant, LIBRARY_COLLECTION, message.filter || {});
        sendResponse({ ok: true, sources });
      } catch (err) {
        sendResponse({ ok: false, error: String(err), qdrant: describeQdrantError(err) });
      }
    })();
    return true;
  }

  if (message.type === "ASK") {
    sendResponse({ ok: true, started: true }); // ack immediately; real output streams via broadcast
    (async () => {
      try {
        const cfg = await getConfig();
        await ensureModelsLoaded(cfg);
        await ensureCollectionReady();
        const status = (text) => broadcast({ type: "AGENT_STATUS", requestId: message.requestId, status: text });
        const token = (delta, full) => broadcast({ type: "ANSWER_TOKEN", requestId: message.requestId, delta, full });
        const mode = message.mode || cfg.retrievalMode || DEFAULT_RETRIEVAL_MODE;
        const deep = cfg.agentMode !== "pipeline" && !!OPENAI_COMPATIBLE_PROVIDERS[cfg.llmProvider] && !!cfg.llmApiKey;

        let result = null;
        if (deep) {
          try {
            result = await answerWithDeepAgent(
              { cfg, client: qdrant, collection: LIBRARY_COLLECTION, mode, filter: message.filter, embed: embedQuery, sourceCount: message.sourceCount ?? null, history: message.history || [], question: message.question },
              status,
              token,
            );
          } catch (err) {
            // Never leave the user without an answer: fall back to the fixed pipeline.
            console.warn("[offscreen] deep agent failed, using the pipeline:", err);
            status(`The research agent hit a problem (${String(err?.message || err).slice(0, 80)}). Using the fast path...`);
          }
        }
        if (!result) {
          result = await answerQuestion(
            message.question,
            {
              client: qdrant,
              collection: LIBRARY_COLLECTION,
              mode,
              filter: message.filter,
              tabTitles: message.tabTitles,
              sourceCount: message.sourceCount ?? null,
              history: message.history || [],
              capable: cfg.llmProvider !== "webllm",
              embed: embedQuery, // query-time embedding uses the bge instruction prefix
              chatJSON: llmFunctions.chatJSON,
              chatStream: llmFunctions.chatStream,
            },
            status,
            token,
          );
        }
        console.info("[offscreen] answered", result.timings);
        broadcast({ type: "ANSWER_DONE", requestId: message.requestId, ...result });
      } catch (err) {
        console.error("[offscreen] answering failed:", err);
        broadcast({ type: "ANSWER_ERROR", requestId: message.requestId, error: String(err?.message || err), qdrant: describeQdrantError(err) });
      }
    })();
    return false;
  }
});
