// Service worker. Its jobs: (1) pull readable text out of a tab when the user adds it to the
// working set -- chrome.scripting is only available here and in the popup, not in the offscreen
// document -- (2) make sure the offscreen document (where the models and Qdrant client live)
// exists before anything tries to talk to it, and (3) own the working-set lifecycle: a tab
// closing or navigating away must purge its working-set entry so a later-reused tabId can never
// silently inherit an old entry's provenance. Everything model- and retrieval-related happens in
// offscreen.js; this file never touches Qdrant directly.

import { canonicalizeUrl } from "./lib/ids.js";
import { hashText } from "./lib/chunk.js";
import { getConfig, ALL_API_PROVIDERS } from "./lib/config.js";
import { checkLiveFreshness } from "./lib/freshness.js";
import {
  THREADS_KEY, ACTIVE_THREAD_KEY, startTurn, patchMessage, deleteThread, eventToPatch, sweepInterrupted, hasPending,
} from "./lib/threads.js";

const OFFSCREEN_URL = "offscreen.html";
const WORKING_SET_KEY = "workingSet";
const SESSION_ID_KEY = "sessionId";

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["WORKERS"],
    justification:
      "Runs the local embedding model, language model (WebGPU/WASM), and the Qdrant retrieval " +
      "client so indexing and answer generation happen entirely on-device.",
  });
}

// A random ID generated once per browser session (chrome.storage.session is cleared on browser
// restart, unlike chrome.storage.local). Working-set entries record which session they were
// added under. If a tab's stored session doesn't match the current one, its tabId cannot be
// trusted without re-verifying the tab's current URL first -- Chrome reuses tab IDs across
// browser restarts, and without this check a recycled ID could silently attach old provenance
// to whatever page happens to occupy that ID now.
async function getSessionId() {
  const stored = await chrome.storage.session.get(SESSION_ID_KEY);
  if (stored[SESSION_ID_KEY]) return stored[SESSION_ID_KEY];
  const id = crypto.randomUUID();
  await chrome.storage.session.set({ [SESSION_ID_KEY]: id });
  return id;
}

async function getWorkingSet() {
  const stored = await chrome.storage.local.get(WORKING_SET_KEY);
  return stored[WORKING_SET_KEY] || [];
}

async function setWorkingSet(list) {
  await chrome.storage.local.set({ [WORKING_SET_KEY]: list });
}

// Removes a working-set entry by tabId without touching the library (Qdrant). Called on tab
// close, on navigation away from the indexed URL, and by the popup's explicit "Remove from
// working set" action.
async function purgeWorkingSetEntry(tabId) {
  const list = await getWorkingSet();
  const next = list.filter((t) => t.tabId !== tabId);
  if (next.length !== list.length) await setWorkingSet(next);
  return next;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  purgeWorkingSetEntry(tabId).catch((err) => console.error("[background] purge on close failed:", err));
});

// If a working-set tab navigates to a different canonical URL, its old library entry is now
// unrelated to whatever the tab shows -- drop the stale working-set pointer (the library entry
// for the OLD url is untouched and stays archived under that url).
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  (async () => {
    const list = await getWorkingSet();
    const entry = list.find((t) => t.tabId === tabId);
    if (!entry) return;
    let stillSame = false;
    try {
      stillSame = canonicalizeUrl(changeInfo.url) === entry.canonicalUrl;
    } catch {
      stillSame = false;
    }
    if (!stillSame) await purgeWorkingSetEntry(tabId);
  })().catch((err) => console.error("[background] purge on navigate failed:", err));
});

// Runs inside the target page. Must be self-contained: no references to outer-scope
// variables, since chrome.scripting serializes this function and executes it in the page.
//
// Keeps the page's STRUCTURE (one line per block/table row, "## " headings, "- " list items) instead
// of flattening everything to one line: which words are a headline, which are its points and comment
// count, and where one item ends are exactly what a model needs to summarize a feed like Hacker News.
function extractPageText() {
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "IFRAME", "NAV", "FOOTER", "ASIDE", "TEMPLATE", "CANVAS", "FORM", "BUTTON", "SELECT", "INPUT", "TEXTAREA"]);
  const BLOCK = new Set(["P", "DIV", "SECTION", "ARTICLE", "MAIN", "UL", "OL", "TR", "TABLE", "BLOCKQUOTE", "PRE", "DT", "DD", "FIGURE", "FIGCAPTION", "DETAILS", "SUMMARY", "HEADER"]);
  const MAX_CHARS = 250000;

  const bodyLen = (document.body.innerText || "").length;
  const main = document.querySelector("main, article, [role=main]");
  const root = main && (main.innerText || "").length > bodyLen * 0.4 ? main : document.body;

  const out = [];
  let size = 0;
  let linkChars = 0;
  const push = (t) => {
    out.push(t);
    size += t.length;
  };

  function walk(node) {
    if (size > MAX_CHARS) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.nodeValue.replace(/\s+/g, " ");
      if (t.trim()) {
        push(t);
        if (node.parentElement && node.parentElement.closest("a")) linkChars += t.length;
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName;
    if (SKIP.has(tag)) return;
    if (tag === "HEADER" && !node.closest("article")) return; // site chrome, not content
    if (node.hidden || node.getAttribute("aria-hidden") === "true") return;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return;

    if (/^H[1-6]$/.test(tag)) {
      push("\n\n## ");
      node.childNodes.forEach(walk);
      push("\n\n");
    } else if (tag === "LI") {
      push("\n- ");
      node.childNodes.forEach(walk);
      push("\n");
    } else if (tag === "BR") {
      push("\n");
    } else if (tag === "TD" || tag === "TH" || tag === "A" || tag === "SPAN" || tag === "B" || tag === "I" || tag === "EM" || tag === "STRONG" || tag === "SMALL") {
      // Inline boundary: keep neighbours apart ("bryan0" + "5 hours ago" must not fuse).
      push(" ");
      node.childNodes.forEach(walk);
      push(" ");
    } else if (BLOCK.has(tag)) {
      push("\n");
      node.childNodes.forEach(walk);
      push("\n");
    } else {
      node.childNodes.forEach(walk);
    }
  }
  walk(root);

  const text = out
    .join("")
    .split("\n")
    .map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter(Boolean) // one line per block; structure comes from the lines and "## " headings
    .join("\n")
    .replace(/ +([,.;:!?)\]])/g, "$1")
    .replace(/([(\[]) +/g, "$1")
    .replace(/^(\d{1,3}\.)\n(?=\S)/gm, "$1 ") // list rank on its own line -> same line as its title
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // "feed" = a list of many short, link-heavy items (Hacker News, Reddit, search results).
  const lines = text.split("\n").filter(Boolean);
  const kind = lines.length >= 25 && linkChars / Math.max(text.length, 1) > 0.3 && text.length / lines.length < 140 ? "feed" : "article";
  return { title: document.title, text, kind };
}

async function extractTabText(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractPageText,
  });
  return result;
}

// The offscreen bundle is large, so right after createDocument() its message listener may not be
// registered yet and sendMessage rejects with "Receiving end does not exist". Retry briefly.
async function sendToOffscreen(message, attempts = 10) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await chrome.runtime.sendMessage(message);
      if (res !== undefined) return res;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 300 * (i + 1)));
  }
  throw lastErr || new Error("The extension's background page did not respond.");
}

// Adds a tab end to end: read its text, index it, and record it in the working set. This lives
// in the service worker (not the popup) so it completes even if the popup is closed mid-index.
async function indexTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:\/\//.test(tab.url || "")) {
    throw new Error("Only regular web pages (http/https) can be added.");
  }
  const extraction = await extractTabText(tabId);
  if (!extraction.text || extraction.text.length < 50) {
    throw new Error("Not enough readable text on this page.");
  }

  await ensureOffscreenDocument();
  const sessionId = await getSessionId();
  const result = await sendToOffscreen({
    type: "INDEX_SOURCE",
    tabId,
    sessionId,
    title: extraction.title,
    url: tab.url,
    text: extraction.text,
    pageKind: extraction.kind,
  });
  if (!result?.ok) {
    if (result?.qdrant?.kind === "down") throw new Error(result.qdrant.message);
    throw new Error(result?.error || "Indexing failed.");
  }

  const list = await getWorkingSet();
  const dupe = list.find((t) => t.sourceKey === result.sourceKey);
  if (dupe) {
    // Same source already tracked under a different tab -- repoint it instead of adding a
    // second working-set entry for the same source (avoids duplicate-source answer inflation).
    dupe.tabId = tabId;
    dupe.title = extraction.title;
    await setWorkingSet(list);
  } else if (!list.some((t) => t.tabId === tabId)) {
    list.push({
      tabId,
      sourceKey: result.sourceKey,
      canonicalUrl: result.canonicalUrl,
      title: extraction.title,
      domain: result.domain,
      addedAt: Date.now(),
    });
    await setWorkingSet(list);
  }
  return {
    sourceKey: result.sourceKey,
    title: extraction.title,
    skipped: !!result.skipped,
    chunkCount: result.chunkCount ?? null,
    timings: result.timings,
  };
}

// ─── Chat threads ─────────────────────────────────────────────────────────────
// This worker owns every in-flight answer. The offscreen document streams events; they are folded
// into the stored thread here, so the popup can close and reopen mid-answer (or the browser can
// restart) without losing anything. The popup only reads storage.

let threadWrites = Promise.resolve();
function mutateThreads(fn) {
  const run = threadWrites.then(async () => {
    const stored = await chrome.storage.local.get(THREADS_KEY);
    const next = fn(stored[THREADS_KEY] || []);
    await chrome.storage.local.set({ [THREADS_KEY]: next });
    return next;
  });
  threadWrites = run.catch((err) => console.error("[background] thread write failed:", err));
  return run;
}

// The one answer currently being produced, and streamed patches waiting to be written. Tokens
// arrive many times a second; writing each would thrash storage, so they are flushed at most
// every FLUSH_MS.
const FLUSH_MS = 250;
let active = null; // { threadId, messageId }
let buffered = null;
let flushTimer = null;
let activeMessage = { content: "" }; // running copy, so token deltas can be appended without a read

function flushActive() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (!active || !buffered) return Promise.resolve();
  const { threadId, messageId } = active;
  const patch = buffered;
  buffered = null;
  return mutateThreads((list) => patchMessage(list, threadId, messageId, patch, Date.now()));
}

function queuePatch(patch, { immediate = false } = {}) {
  activeMessage = { ...activeMessage, ...patch };
  buffered = { ...buffered, ...patch };
  if (immediate) return flushActive();
  if (!flushTimer) flushTimer = setTimeout(flushActive, FLUSH_MS);
  return Promise.resolve();
}

function handleAnswerEvent(event) {
  if (!active || (event.requestId && event.requestId !== active.messageId)) return;
  const patch = eventToPatch(event, activeMessage);
  if (!patch) return;
  const finished = event.type === "ANSWER_DONE" || event.type === "ANSWER_ERROR";
  queuePatch(patch, { immediate: finished }).then(() => {
    if (finished) active = null;
  });
}

async function sendQuestion(message) {
  if (active) throw new Error("Still answering the previous question. Wait for it to finish.");
  let ids;
  let history = [];
  const cfg = await getConfig();
  const provider = ALL_API_PROVIDERS[cfg.llmProvider];
  const model = provider ? `${provider.label} ${cfg.llmModel || provider.defaultModel}` : "On-device (Qwen3-0.6B)";
  await mutateThreads((list) => {
    // Completed question/answer pairs so far, so follow-ups ("and then?") keep their context.
    const prior = list.find((t) => t.id === message.threadId);
    history = (prior?.messages || []).flatMap((m, i, all) =>
      m.role === "assistant" && m.status === "done" && m.content && !m.abstained && all[i - 1]?.role === "user" ? [{ q: all[i - 1].content, a: m.content }] : [],
    );
    const turn = startTurn(list, {
      threadId: message.threadId,
      question: message.question,
      scope: message.scope,
      now: Date.now(),
      newId: () => crypto.randomUUID(),
      model,
    });
    ids = turn;
    return turn.list;
  });
  active = { threadId: ids.threadId, messageId: ids.messageId };
  activeMessage = { content: "" };
  buffered = null;
  await chrome.storage.local.set({ [ACTIVE_THREAD_KEY]: ids.threadId });

  try {
    await ensureOffscreenDocument();
    const ack = await sendToOffscreen({
      type: "ASK",
      requestId: ids.messageId,
      question: message.question,
      filter: message.filter,
      tabTitles: message.tabTitles,
      sourceCount: message.sourceCount,
      history,
    });
    if (!ack?.ok) throw new Error("The answer engine didn't start.");
  } catch (err) {
    handleAnswerEvent({ type: "ANSWER_ERROR", requestId: ids.messageId, error: err?.message || String(err) });
  }
  return { threadId: ids.threadId, messageId: ids.messageId };
}

// At browser start nothing can still be running, so any pending answer is a leftover.
async function sweepPendingThreads() {
  await mutateThreads((list) => (hasPending(list) ? sweepInterrupted(list, Date.now()) : list));
}

// ─── Indexing jobs ────────────────────────────────────────────────────────────
// "Add current tab" and "Add all" both run here as a job whose progress is kept in
// chrome.storage.session, so the popup can close and reopen mid-index and still show it.

const INDEX_JOB_KEY = "indexJob";
let jobRunning = false;
let jobState = null;

function setJob(patch) {
  jobState = { ...jobState, ...patch };
  return chrome.storage.session.set({ [INDEX_JOB_KEY]: jobState }).catch(() => {});
}

async function runIndexJob(tabs) {
  if (jobRunning) throw new Error("Already indexing. Wait for the current job to finish.");
  jobRunning = true;
  jobState = { running: true, total: tabs.length, done: 0, added: 0, unchanged: 0, failures: [], current: null, startedAt: Date.now(), finishedAt: null };
  await setJob({});
  (async () => {
    for (const tab of tabs) {
      await setJob({ current: { tabId: tab.id, title: tab.title || tab.url, stage: "reading", done: 0, total: 0 } });
      try {
        const res = await indexTab(tab.id);
        await setJob(res.skipped ? { unchanged: jobState.unchanged + 1 } : { added: jobState.added + 1 });
      } catch (err) {
        await setJob({ failures: [...jobState.failures, { title: tab.title || tab.url, error: err?.message || String(err) }] });
      }
      await setJob({ done: jobState.done + 1 });
    }
    await setJob({ running: false, current: null, finishedAt: Date.now() });
    jobRunning = false;
  })().catch((err) => {
    console.error("[background] index job crashed:", err);
    jobRunning = false;
    setJob({ running: false, current: null, finishedAt: Date.now() });
  });
}

function handleIndexProgress(event) {
  if (!jobRunning || jobState?.current?.tabId !== event.tabId) return;
  setJob({ current: { ...jobState.current, stage: event.stage, done: event.done ?? 0, total: event.total ?? 0 } });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // The offscreen document can't read chrome.storage, so it gets settings from here.
  if (message.type === "GET_CONFIG") {
    getConfig()
      .then((config) => sendResponse({ ok: true, config }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === "SEND_QUESTION") {
    sendQuestion(message)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (message.type === "DELETE_THREAD") {
    mutateThreads((list) => deleteThread(list, message.threadId))
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === "START_INDEX_JOB") {
    (async () => {
      try {
        // `tabIds` lets the UI index exactly the tabs the user picked; otherwise the active tab or the whole window.
        const tabs = message.tabIds?.length
          ? await Promise.all(message.tabIds.map((id) => chrome.tabs.get(id).catch(() => null)))
          : await chrome.tabs.query(message.all ? { currentWindow: true } : { active: true, currentWindow: true });
        const eligible = tabs.filter((t) => t && /^https?:\/\//.test(t.url || ""));
        if (eligible.length === 0) throw new Error("No regular web pages (http/https) to add.");
        await runIndexJob(eligible);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  if (message.type === "MODEL_PROGRESS" && active) {
    handleAnswerEvent({ ...message, requestId: active.messageId });
    return false;
  }
  if (message.type === "AGENT_STATUS" || message.type === "ANSWER_TOKEN" || message.type === "ANSWER_DONE" || message.type === "ANSWER_ERROR") {
    handleAnswerEvent(message);
    return false;
  }
  if (message.type === "INDEX_PROGRESS") {
    handleIndexProgress(message);
    return false;
  }

  if (message.type === "INDEX_TAB") {
    indexTab(message.tabId)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (message.type === "EXTRACT_TAB_TEXT") {
    extractTabText(message.tabId)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // keep the channel open for the async response
  }

  if (message.type === "ENSURE_OFFSCREEN") {
    ensureOffscreenDocument()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === "GET_SESSION_ID") {
    getSessionId()
      .then((sessionId) => sendResponse({ ok: true, sessionId }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  // Bounded, explicit, permission-aware live freshness check: only ever runs against a tab
  // that is CURRENTLY OPEN right now (chrome.tabs.get throws if it isn't) and only compares a
  // freshly-extracted content hash to the one already stored -- it never re-indexes, never
  // polls, and never claims to check a closed tab or a tab outside host permissions.
  if (message.type === "CHECK_FRESHNESS") {
    (async () => {
      try {
        const tab = await chrome.tabs.get(message.tabId); // throws if the tab is gone
        let currentCanonical;
        try {
          currentCanonical = canonicalizeUrl(tab.url);
        } catch {
          sendResponse({ ok: false, error: "Tab URL is not checkable (not http/https)." });
          return;
        }
        if (currentCanonical !== message.canonicalUrl) {
          sendResponse({
            ok: true,
            checked: false,
            reason: "This tab has navigated away from the cited URL; cannot verify live freshness.",
          });
          return;
        }
        const extraction = await extractTabText(message.tabId);
        const result = await checkLiveFreshness({
          storedContentHash: message.storedContentHash,
          currentText: extraction.text,
          hashText,
        });
        sendResponse({ ok: true, ...result });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  if (message.type === "REMOVE_FROM_WORKING_SET") {
    purgeWorkingSetEntry(message.tabId)
      .then((list) => sendResponse({ ok: true, workingSet: list }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  // Saves a config patch and signals the offscreen document to rebuild its clients immediately.
  if (message.type === "SET_CONFIG") {
    (async () => {
      try {
        const { saveConfig } = await import("./lib/config.js");
        await saveConfig(message.patch);
        if (await hasOffscreenDocument()) {
          await chrome.runtime.sendMessage({ type: "CONFIG_CHANGED" }).catch(() => {});
        }
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  sweepPendingThreads().catch(() => {});
  // An extension reload/update keeps an already-open offscreen document, which then keeps running
  // the OLD bundle (old agent, old prompts). Close it so the new code is what actually runs.
  if (details.reason !== "install" && (await hasOffscreenDocument())) {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
  ensureOffscreenDocument().catch((err) => console.error("[background] offscreen setup failed:", err));
  // Open onboarding only on a genuine first install, never on extension updates.
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") }).catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(() => {
  sweepPendingThreads().catch((err) => console.error("[background] sweep failed:", err));
  // New browser session -- force a fresh session ID so any working-set entries left over from
  // chrome.storage.local (which does survive a restart, unlike chrome.storage.session) are
  // recognized as needing tab re-verification before their tabId is trusted again.
  getSessionId().catch((err) => console.error("[background] session id init failed:", err));
});
