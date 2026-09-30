var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/lib/config.js
var config_exports = {};
__export(config_exports, {
  ALL_API_PROVIDERS: () => ALL_API_PROVIDERS,
  CONFIG_KEY: () => CONFIG_KEY,
  DEFAULT_CONFIG: () => DEFAULT_CONFIG,
  GEMINI_PROVIDER: () => GEMINI_PROVIDER,
  OPENAI_COMPATIBLE_PROVIDERS: () => OPENAI_COMPATIBLE_PROVIDERS,
  getConfig: () => getConfig,
  saveConfig: () => saveConfig
});
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
var CONFIG_KEY, OPENAI_COMPATIBLE_PROVIDERS, GEMINI_PROVIDER, ALL_API_PROVIDERS, DEFAULT_CONFIG;
var init_config = __esm({
  "src/lib/config.js"() {
    CONFIG_KEY = "ask-my-tabs-config";
    OPENAI_COMPATIBLE_PROVIDERS = {
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
    GEMINI_PROVIDER = {
      gemini: {
        label: "Google Gemini",
        defaultModel: "gemini-1.5-flash",
        keyHint: "AIza...",
        keyUrl: "https://aistudio.google.com/app/apikey"
      }
    };
    ALL_API_PROVIDERS = { ...OPENAI_COMPATIBLE_PROVIDERS, ...GEMINI_PROVIDER };
    DEFAULT_CONFIG = {
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
  }
});

// src/lib/ids.js
var DEFAULT_TRACKING_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
  "igshid"
];
function canonicalizeUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Not a valid absolute URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported scheme for a library source: ${url.protocol}`);
  }
  const scheme = url.protocol.toLowerCase();
  const host = url.hostname.toLowerCase();
  const isDefaultPort = scheme === "http:" && (url.port === "" || url.port === "80") || scheme === "https:" && (url.port === "" || url.port === "443");
  const port = isDefaultPort ? "" : `:${url.port}`;
  const params = new URLSearchParams(url.search);
  for (const key of DEFAULT_TRACKING_PARAMS) params.delete(key);
  const query = params.toString();
  let path = url.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (path === "") path = "/";
  return `${scheme}//${host}${port}${path}${query ? `?${query}` : ""}`;
}

// src/lib/chunk.js
async function hashText(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// src/background.js
init_config();

// src/lib/freshness.js
async function checkLiveFreshness({ storedContentHash, currentText, hashText: hashText2 }) {
  const currentHash = await hashText2(currentText);
  return { checked: true, matches: currentHash === storedContentHash, currentHash };
}

// src/lib/threads.js
var THREADS_KEY = "threads";
var ACTIVE_THREAD_KEY = "activeThreadId";
var MAX_THREADS = 60;
var STALE_PENDING_MS = 5 * 60 * 1e3;
var CITATION_TEXT_CHARS = 400;
var INTERRUPTED_MESSAGE = "This answer was interrupted before it finished. Ask again to retry.";
function titleFrom(question) {
  const t = (question || "").replace(/\s+/g, " ").trim();
  return t.length > 60 ? `${t.slice(0, 57)}...` : t || "New chat";
}
function sortAndPrune(list) {
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_THREADS);
}
function startTurn(list, { threadId, question, scope, now, newId, model = null }) {
  const messageId = newId();
  const user = { id: newId(), role: "user", content: question, createdAt: now, scope };
  const assistant = { id: messageId, role: "assistant", content: "", createdAt: now, status: "pending", statusText: "Starting...", startedAt: now, model };
  const existing = list.find((t) => t.id === threadId);
  const thread = existing ? { ...existing, updatedAt: now, messages: [...existing.messages, user, assistant] } : { id: newId(), title: titleFrom(question), createdAt: now, updatedAt: now, messages: [user, assistant] };
  const rest = list.filter((t) => t.id !== thread.id);
  return { list: sortAndPrune([thread, ...rest]), threadId: thread.id, messageId };
}
function patchMessage(list, threadId, messageId, patch, now) {
  return list.map(
    (t) => t.id !== threadId ? t : { ...t, updatedAt: now, messages: t.messages.map((m) => m.id === messageId ? { ...m, ...patch } : m) }
  );
}
function deleteThread(list, threadId) {
  return list.filter((t) => t.id !== threadId);
}
function trimCitations(citations) {
  return (citations || []).map((c) => ({
    ...c,
    text: typeof c.text === "string" && c.text.length > CITATION_TEXT_CHARS ? `${c.text.slice(0, CITATION_TEXT_CHARS)}...` : c.text
  }));
}
function eventToPatch(event, message) {
  switch (event.type) {
    case "MODEL_PROGRESS":
      return { statusText: typeof event.detail === "string" ? event.detail : `Loading ${event.stage}...` };
    case "AGENT_STATUS":
      return { statusText: event.status };
    case "ANSWER_TOKEN":
      return { content: event.full ?? `${message?.content || ""}${event.delta}`, statusText: "Writing an answer..." };
    case "ANSWER_DONE": {
      const invalid = event.citationValidation?.invalid || [];
      return {
        content: event.answer ?? message?.content ?? "",
        status: "done",
        statusText: "",
        citations: trimCitations(event.citations),
        timings: event.timings || null,
        abstained: !!event.abstained,
        invalidCitations: invalid
      };
    }
    case "ANSWER_ERROR":
      return {
        status: "error",
        statusText: "",
        error: event.qdrant?.kind === "down" ? event.qdrant.message : String(event.error || "Something went wrong."),
        qdrantDown: event.qdrant?.kind === "down"
      };
    default:
      return null;
  }
}
function sweepInterrupted(list, now, olderThanMs = 0) {
  let changed = false;
  const next = list.map((t) => {
    if (!t.messages.some((m) => m.status === "pending" && now - (m.startedAt ?? m.createdAt) >= olderThanMs)) return t;
    changed = true;
    return {
      ...t,
      messages: t.messages.map(
        (m) => m.status === "pending" && now - (m.startedAt ?? m.createdAt) >= olderThanMs ? { ...m, status: "error", statusText: "", error: INTERRUPTED_MESSAGE } : m
      )
    };
  });
  return changed ? next : list;
}
function hasPending(list) {
  return list.some((t) => t.messages.some((m) => m.status === "pending"));
}

// src/background.js
var OFFSCREEN_URL = "offscreen.html";
var WORKING_SET_KEY = "workingSet";
var SESSION_ID_KEY = "sessionId";
async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  return contexts.length > 0;
}
async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["WORKERS"],
    justification: "Runs the local embedding model, language model (WebGPU/WASM), and the Qdrant retrieval client so indexing and answer generation happen entirely on-device."
  });
}
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
async function purgeWorkingSetEntry(tabId) {
  const list = await getWorkingSet();
  const next = list.filter((t) => t.tabId !== tabId);
  if (next.length !== list.length) await setWorkingSet(next);
  return next;
}
chrome.tabs.onRemoved.addListener((tabId) => {
  purgeWorkingSetEntry(tabId).catch((err) => console.error("[background] purge on close failed:", err));
});
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
function extractPageText() {
  const clone = document.body.cloneNode(true);
  clone.querySelectorAll("script, style, nav, header, footer, aside, noscript, svg, iframe").forEach((el) => el.remove());
  const text = (clone.innerText || "").replace(/\s+/g, " ").trim();
  return { title: document.title, text };
}
async function extractTabText(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractPageText
  });
  return result;
}
async function sendToOffscreen(message, attempts = 10) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await chrome.runtime.sendMessage(message);
      if (res !== void 0) return res;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 300 * (i + 1)));
  }
  throw lastErr || new Error("The extension's background page did not respond.");
}
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
    text: extraction.text
  });
  if (!result?.ok) {
    if (result?.qdrant?.kind === "down") throw new Error(result.qdrant.message);
    throw new Error(result?.error || "Indexing failed.");
  }
  const list = await getWorkingSet();
  const dupe = list.find((t) => t.sourceKey === result.sourceKey);
  if (dupe) {
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
      addedAt: Date.now()
    });
    await setWorkingSet(list);
  }
  return {
    sourceKey: result.sourceKey,
    title: extraction.title,
    skipped: !!result.skipped,
    chunkCount: result.chunkCount ?? null,
    timings: result.timings
  };
}
var threadWrites = Promise.resolve();
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
var FLUSH_MS = 250;
var active = null;
var buffered = null;
var flushTimer = null;
var activeMessage = { content: "" };
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
  if (!active || event.requestId && event.requestId !== active.messageId) return;
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
  const cfg = await getConfig();
  const provider = ALL_API_PROVIDERS[cfg.llmProvider];
  const model = provider ? `${provider.label} ${cfg.llmModel || provider.defaultModel}` : "On-device (Qwen3-0.6B)";
  await mutateThreads((list) => {
    const turn = startTurn(list, {
      threadId: message.threadId,
      question: message.question,
      scope: message.scope,
      now: Date.now(),
      newId: () => crypto.randomUUID(),
      model
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
      sourceCount: message.sourceCount
    });
    if (!ack?.ok) throw new Error("The answer engine didn't start.");
  } catch (err) {
    handleAnswerEvent({ type: "ANSWER_ERROR", requestId: ids.messageId, error: err?.message || String(err) });
  }
  return { threadId: ids.threadId, messageId: ids.messageId };
}
async function sweepPendingThreads() {
  await mutateThreads((list) => hasPending(list) ? sweepInterrupted(list, Date.now()) : list);
}
var INDEX_JOB_KEY = "indexJob";
var jobRunning = false;
var jobState = null;
function setJob(patch) {
  jobState = { ...jobState, ...patch };
  return chrome.storage.session.set({ [INDEX_JOB_KEY]: jobState }).catch(() => {
  });
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
  if (message.type === "SEND_QUESTION") {
    sendQuestion(message).then((r) => sendResponse({ ok: true, ...r })).catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (message.type === "DELETE_THREAD") {
    mutateThreads((list) => deleteThread(list, message.threadId)).then(() => sendResponse({ ok: true })).catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (message.type === "START_INDEX_JOB") {
    (async () => {
      try {
        const tabs = await chrome.tabs.query(message.all ? { currentWindow: true } : { active: true, currentWindow: true });
        const eligible = tabs.filter((t) => /^https?:\/\//.test(t.url || ""));
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
    indexTab(message.tabId).then((result) => sendResponse({ ok: true, ...result })).catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (message.type === "EXTRACT_TAB_TEXT") {
    extractTabText(message.tabId).then((result) => sendResponse({ ok: true, ...result })).catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (message.type === "ENSURE_OFFSCREEN") {
    ensureOffscreenDocument().then(() => sendResponse({ ok: true })).catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (message.type === "GET_SESSION_ID") {
    getSessionId().then((sessionId) => sendResponse({ ok: true, sessionId })).catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (message.type === "CHECK_FRESHNESS") {
    (async () => {
      try {
        const tab = await chrome.tabs.get(message.tabId);
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
            reason: "This tab has navigated away from the cited URL; cannot verify live freshness."
          });
          return;
        }
        const extraction = await extractTabText(message.tabId);
        const result = await checkLiveFreshness({
          storedContentHash: message.storedContentHash,
          currentText: extraction.text,
          hashText
        });
        sendResponse({ ok: true, ...result });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }
  if (message.type === "REMOVE_FROM_WORKING_SET") {
    purgeWorkingSetEntry(message.tabId).then((list) => sendResponse({ ok: true, workingSet: list })).catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (message.type === "SET_CONFIG") {
    (async () => {
      try {
        const { saveConfig: saveConfig2 } = await Promise.resolve().then(() => (init_config(), config_exports));
        await saveConfig2(message.patch);
        if (await hasOffscreenDocument()) {
          await chrome.runtime.sendMessage({ type: "CONFIG_CHANGED" }).catch(() => {
          });
        }
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }
});
chrome.runtime.onInstalled.addListener((details) => {
  sweepPendingThreads().catch(() => {
  });
  ensureOffscreenDocument().catch((err) => console.error("[background] offscreen setup failed:", err));
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") }).catch(() => {
    });
  }
});
chrome.runtime.onStartup.addListener(() => {
  sweepPendingThreads().catch((err) => console.error("[background] sweep failed:", err));
  getSessionId().catch((err) => console.error("[background] session id init failed:", err));
});
