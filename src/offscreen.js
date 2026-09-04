// Where the actual work happens: the embedding model, the LLM, the vector store, and the agent
// loop all live here. This document is created once by background.js via chrome.offscreen and
// stays alive independently of whether the popup is open, so the ~1GB of model weights only get
// loaded once per browser session, not every time the user clicks the toolbar icon.

import { loadEmbedder, embed } from "./lib/embeddings.js";
import { loadLLM } from "./lib/llm.js";
import { putChunks, deleteTab, getTabContentHash } from "./lib/vectorstore.js";
import { chunkText, hashText } from "./lib/chunk.js";
import { answerQuestion } from "./lib/agent.js";

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    /* no listener currently open (e.g. popup closed) -- fine, this is best-effort UI feedback */
  });
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
    })();
  }
  return loadingPromise;
}

async function indexTab({ tabId, title, url, text }) {
  const contentHash = await hashText(text);
  const existingHash = await getTabContentHash(tabId);
  if (existingHash === contentHash) {
    return { skipped: true, reason: "unchanged since last indexed" };
  }

  await deleteTab(tabId); // drop any stale chunks from a previous version of this page
  const pieces = chunkText(text);
  if (pieces.length === 0) return { skipped: true, reason: "no extractable text" };

  const vectors = await embed(pieces);
  const records = pieces.map((chunkTextValue, i) => ({
    id: `${tabId}:${i}`,
    tabId,
    tabTitle: title,
    tabUrl: url,
    contentHash,
    chunkIndex: i,
    text: chunkTextValue,
    embedding: Array.from(vectors[i]), // plain array: structured-clones/serializes cleanly
  }));
  await putChunks(records);
  return { skipped: false, chunkCount: records.length };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_STATE") {
    sendResponse({ ok: true, modelsReady });
    return false;
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

  if (message.type === "INDEX_TAB") {
    (async () => {
      try {
        await ensureModelsLoaded();
        const result = await indexTab(message);
        sendResponse({ ok: true, ...result });
      } catch (err) {
        console.error("[offscreen] indexing failed:", err);
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  if (message.type === "REMOVE_TAB") {
    deleteTab(message.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === "ASK") {
    sendResponse({ ok: true, started: true }); // ack immediately, real output streams via broadcast
    (async () => {
      try {
        await ensureModelsLoaded();
        const { answer, citations } = await answerQuestion(
          message.question,
          { tabIds: message.tabIds, tabTitles: message.tabTitles },
          (status) => broadcast({ type: "AGENT_STATUS", status }),
          (delta, full) => broadcast({ type: "ANSWER_TOKEN", delta, full }),
        );
        broadcast({ type: "ANSWER_DONE", answer, citations });
      } catch (err) {
        console.error("[offscreen] answering failed:", err);
        broadcast({ type: "ANSWER_ERROR", error: String(err) });
      }
    })();
    return false;
  }
});
