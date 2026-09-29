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

// src/lib/freshness.js
async function checkLiveFreshness({ storedContentHash, currentText, hashText: hashText2 }) {
  const currentHash = await hashText2(currentText);
  return { checked: true, matches: currentHash === storedContentHash, currentHash };
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
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
});
chrome.runtime.onInstalled.addListener(() => {
  ensureOffscreenDocument().catch((err) => console.error("[background] offscreen setup failed:", err));
});
chrome.runtime.onStartup.addListener(() => {
  getSessionId().catch((err) => console.error("[background] session id init failed:", err));
});
