// Service worker. Its jobs: (1) pull readable text out of a tab when the user adds it to the
// working set -- chrome.scripting is only available here and in the popup, not in the offscreen
// document -- (2) make sure the offscreen document (where the models and Qdrant client live)
// exists before anything tries to talk to it, and (3) own the working-set lifecycle: a tab
// closing or navigating away must purge its working-set entry so a later-reused tabId can never
// silently inherit an old entry's provenance. Everything model- and retrieval-related happens in
// offscreen.js; this file never touches Qdrant directly.

import { canonicalizeUrl } from "./lib/ids.js";
import { hashText } from "./lib/chunk.js";
import { checkLiveFreshness } from "./lib/freshness.js";

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
function extractPageText() {
  const clone = document.body.cloneNode(true);
  clone.querySelectorAll("script, style, nav, header, footer, aside, noscript, svg, iframe").forEach((el) => el.remove());
  const text = (clone.innerText || "").replace(/\s+/g, " ").trim();
  return { title: document.title, text };
}

async function extractTabText(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractPageText,
  });
  return result;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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

chrome.runtime.onInstalled.addListener((details) => {
  ensureOffscreenDocument().catch((err) => console.error("[background] offscreen setup failed:", err));
  // Open onboarding only on a genuine first install, never on extension updates.
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") }).catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(() => {
  // New browser session -- force a fresh session ID so any working-set entries left over from
  // chrome.storage.local (which does survive a restart, unlike chrome.storage.session) are
  // recognized as needing tab re-verification before their tabId is trusted again.
  getSessionId().catch((err) => console.error("[background] session id init failed:", err));
});
