// Where the actual work happens: the embedding model, the LLM, the Qdrant client, and the agent
// loop all live here. This document is created once by background.js via chrome.offscreen and
// stays alive independently of whether the popup is open, so model weights only load once per
// browser session, not every time the user clicks the toolbar icon.
//
// All user-configurable values (Qdrant URL, API key, LLM provider) are read from config at
// startup and whenever a CONFIG_CHANGED message arrives. Nothing here hardcodes a URL or
// provider string -- those live exclusively in src/lib/config.js.

import { loadEmbedder, embed } from "./lib/embeddings.js";
import { loadLLM, chatJSON as chatJSONWebLLM, chatStream as chatStreamWebLLM } from "./lib/llm.js";
import { chatJSONApi, chatStreamApi } from "./lib/llm-api.js";
import { makeClient, QdrantConnectionError, QdrantSchemaError } from "./lib/qdrant.js";
import { indexSource, removeSourceFromLibrary, listLibrarySources } from "./lib/library.js";
import { answerQuestion } from "./lib/agent.js";
import { getConfig } from "./lib/config.js";
import { libraryCollectionName, DEFAULT_RETRIEVAL_MODE } from "./lib/constants.js";
import { EMBEDDING_MODEL } from "./lib/embedding-model.js";

const LIBRARY_COLLECTION = libraryCollectionName(EMBEDDING_MODEL.key);
import { embedQuery } from "./lib/embeddings.js";

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
    chatJSON: (messages) => chatJSONApi(messages, { provider, apiKey, model }),
    chatStream: (messages, onToken) => chatStreamApi(messages, { provider, apiKey, model }, onToken),
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

// transformers.js reports {status, file, progress: 0-100}; WebLLM reports {progress: 0-1, text}.
// Returns a short human string, or null for events not worth showing.
function describeProgress(label, p) {
  if (typeof p === "string") return p;
  if (!p) return null;
  // WebLLM: {progress: 0-1, text}. Its text is a long file-by-file log line; show a clean percent.
  if (typeof p.text === "string") {
    return typeof p.progress === "number" && p.progress > 0 && p.progress < 1
      ? `Loading ${label} model... ${Math.round(p.progress * 100)}%`
      : p.text;
  }
  if (p.status === "progress" && typeof p.progress === "number") {
    return `Downloading ${label} model... ${Math.round(p.progress)}%`;
  }
  return null;
}

function reportModelProgress(stage, label, p) {
  const detail = describeProgress(label, p);
  if (detail) broadcast({ type: "MODEL_PROGRESS", stage, detail });
}

function ensureEmbedderLoaded() {
  if (embedderReady) return Promise.resolve();
  if (!embedderPromise) {
    broadcast({ type: "MODEL_PROGRESS", stage: "embedder", detail: "Loading embedding model..." });
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
    broadcast({ type: "MODEL_PROGRESS", stage: "llm", detail: "Loading language model (~0.5 GB, one-time)..." });
    llmPromise = loadLLM((p) => reportModelProgress("llm", "language", p))
      .then(() => {
        llmReady = true;
      })
      .catch((err) => {
        llmPromise = null;
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
    getConfig()
      .then((cfg) => sendResponse({ ok: true, modelsReady: modelsReadyFor(cfg), embedderReady }))
      .catch(() => sendResponse({ ok: true, modelsReady: false, embedderReady }));
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
        const result = await answerQuestion(
          message.question,
          {
            client: qdrant,
            collection: LIBRARY_COLLECTION,
            mode: message.mode || cfg.retrievalMode || DEFAULT_RETRIEVAL_MODE,
            filter: message.filter,
            tabTitles: message.tabTitles,
            sourceCount: message.sourceCount ?? null,
            history: message.history || [],
            capable: cfg.llmProvider !== "webllm",
            embed: embedQuery, // query-time embedding uses the bge instruction prefix
            chatJSON: llmFunctions.chatJSON,
            chatStream: llmFunctions.chatStream,
          },
          (status) => broadcast({ type: "AGENT_STATUS", requestId: message.requestId, status }),
          (delta, full) => broadcast({ type: "ANSWER_TOKEN", requestId: message.requestId, delta, full }),
        );
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
