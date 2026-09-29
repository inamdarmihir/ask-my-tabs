// Where the actual work happens: the embedding model, the LLM, the Qdrant client, and the agent
// loop all live here. This document is created once by background.js via chrome.offscreen and
// stays alive independently of whether the popup is open, so the ~1.1GB of model weights only
// get loaded once per browser session, not every time the user clicks the toolbar icon.

import { loadEmbedder, embed } from "./lib/embeddings.js";
import { loadLLM, chatJSON, chatStream } from "./lib/llm.js";
import { makeClient, QdrantConnectionError, QdrantSchemaError } from "./lib/qdrant.js";
import { indexSource, removeSourceFromLibrary, listLibrarySources } from "./lib/library.js";
import { answerQuestion } from "./lib/agent.js";
import { QDRANT_URL, LIBRARY_COLLECTION, DEFAULT_RETRIEVAL_MODE } from "./lib/constants.js";

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    /* no listener currently open (e.g. popup closed) -- fine, this is best-effort UI feedback */
  });
}

const qdrant = makeClient(QDRANT_URL);
let collectionReady = false;

async function ensureCollectionReady() {
  if (collectionReady) return;
  await qdrant.ensureCollection(LIBRARY_COLLECTION);
  collectionReady = true;
}

let modelsReady = false;
let loadingPromise = null;

async function ensureModelsLoaded() {
  if (modelsReady) return;
  if (!loadingPromise) {
    loadingPromise = (async () => {
      broadcast({ type: "MODEL_PROGRESS", stage: "embedder", detail: "Loading embedding model..." });
      await loadEmbedder((p) => broadcast({ type: "MODEL_PROGRESS", stage: "embedder", detail: p }));

      broadcast({ type: "MODEL_PROGRESS", stage: "llm", detail: "Loading language model..." });
      await loadLLM((p) => broadcast({ type: "MODEL_PROGRESS", stage: "llm", detail: p }));

      modelsReady = true;
      broadcast({ type: "MODELS_READY" });
    })().catch((err) => {
      // Don't cache a failed load: a missing-WebGPU or transient network failure should be
      // retry-able from the popup's "Load models" button, not stuck replaying the first error
      // for the rest of the browser session.
      loadingPromise = null;
      throw err;
    });
  }
  return loadingPromise;
}

function describeQdrantError(err) {
  if (err instanceof QdrantConnectionError) return { kind: "down", message: err.message };
  if (err instanceof QdrantSchemaError) return { kind: "schema", message: err.message };
  return { kind: "other", message: String(err?.message || err) };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_STATE") {
    sendResponse({ ok: true, modelsReady });
    return false;
  }

  if (message.type === "QDRANT_HEALTH") {
    qdrant
      .health()
      .then((health) => sendResponse({ ok: true, health }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === "LOAD_MODELS") {
    ensureModelsLoaded()
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
        await ensureModelsLoaded();
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
    sendResponse({ ok: true, started: true }); // ack immediately, real output streams via broadcast
    (async () => {
      try {
        await ensureModelsLoaded();
        await ensureCollectionReady();
        const result = await answerQuestion(
          message.question,
          {
            client: qdrant,
            collection: LIBRARY_COLLECTION,
            mode: message.mode || DEFAULT_RETRIEVAL_MODE,
            filter: message.filter,
            tabTitles: message.tabTitles,
            embed,
            chatJSON,
            chatStream,
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
