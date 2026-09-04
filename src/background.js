// Service worker. Its only two jobs: (1) pull readable text out of a tab when the user adds it
// to the working set -- chrome.scripting is only available here and in the popup, not in the
// offscreen document -- and (2) make sure the offscreen document (where the actual models live)
// exists before anything tries to talk to it. Everything model-related happens in offscreen.js.

const OFFSCREEN_URL = "offscreen.html";

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
      "Runs the local embedding model and language model (WebGPU/WASM) so retrieval and " +
      "answer generation happen entirely on-device.",
  });
}

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
});

chrome.runtime.onInstalled.addListener(() => {
  ensureOffscreenDocument().catch((err) => console.error("[background] offscreen setup failed:", err));
});
