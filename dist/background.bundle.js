// src/background.js
var OFFSCREEN_URL = "offscreen.html";
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
    justification: "Runs the local embedding model and language model (WebGPU/WASM) so retrieval and answer generation happen entirely on-device."
  });
}
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
});
chrome.runtime.onInstalled.addListener(() => {
  ensureOffscreenDocument().catch((err) => console.error("[background] offscreen setup failed:", err));
});
