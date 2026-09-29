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
import { LIBRARY_COLLECTION, DEFAULT_RETRIEVAL_MODE } from "./lib/constants.js";
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

let modelsReady = false;
let loadingPromise = null;

async function ensureModelsLoaded(cfg) {
  // API-provider users never need to load local model weights. The embedder is always needed
  // (it runs locally regardless of LLM choice), but the WebLLM language model is only loaded
  // when the user has explicitly chosen the local WebLLM provider.
  const needsWebLLM = cfg.llmProvider === "webllm";

  if (modelsReady) return;
  if (!loadingPromise) {
    loadingPromise = (async () => {
      broadcast({ type: "MODEL_PROGRESS", stage: "embedder", detail: "Loading embedding model..." });
      await loadEmbedder((p) => broadcast({ type: "MODEL_PROGRESS", stage: "embedder", detail: p }));

      if (needsWebLLM) {
        broadcast({ type: "MODEL_PROGRESS", stage: "llm", detail: "Loading language model (~1.5 GB)..." });
        await loadLLM((p) => broadcast({ type: "MODEL_PROGRESS", stage: "llm", detail: p }));
      }

      modelsReady = true;
      broadcast({ type: "MODELS_READY" });
    })().catch((err) => {
      // Don't cache a failed load: a transient issue (driver update, GPU flag, network hiccup)
      // should be retry-able from the popup's "Load models" button.
      loadingPromise = null;
      throw err;
    });
  }
  return loadingPromise;
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
    sendResponse({ ok: true, modelsReady });
    return false;
  }

  if (message.type === "CONFIG_CHANGED") {
    // Rebuild clients without reloading the offscreen document. Model weights already in memory
    // are kept; only the Qdrant client and LLM provider need to be swapped.
    applyConfig()
      .then((cfg) => {
        // If the user switched from webllm to an API provider, mark models as no longer needed
        // in the old sense -- but don't evict the embedder (always needed).
        if (cfg.llmProvider !== "webllm") modelsReady = false;
        sendResponse({ ok: true });
      })
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
        const cfg = await getConfig();
        await ensureModelsLoaded(cfg);
        await ensureCollectionReady();
        const result = await indexSource(qdrant, LIBRARY_COLLECTION, {
          canonicalUrl: message.url,
          title: message.title,
          text: message.text,
          embed,
          observedTabId: message.tabId,
          observedSessionId: message.sessionId,
        });
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
            embed: embedQuery, // query-time embedding uses the bge instruction prefix
            chatJSON: llmFunctions.chatJSON,
            chatStream: llmFunctions.chatStream,
          },
          (status) => broadcast({ type: "AGENT_STATUS", status }),
          (delta, full) => broadcast({ type: "ANSWER_TOKEN", delta, full }),
        );
        broadcast({ type: "ANSWER_DONE", ...result });
      } catch (err) {
        console.error("[offscreen] answering failed:", err);
        broadcast({ type: "ANSWER_ERROR", error: String(err), qdrant: describeQdrantError(err) });
      }
    })();
    return false;
  }
});
