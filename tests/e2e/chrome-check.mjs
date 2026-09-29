// Best-effort automated real-Chrome smoke check for the parts of the extension that DON'T
// require WebGPU (extension load, offscreen document creation, Qdrant fetch/CORS from the
// offscreen document, WASM-fallback embedding). This is NOT a substitute for the full manual
// WebLLM E2E path described in README.md/RESULTS.md -- see Milestone 5 there for what remains
// UNVERIFIED and exactly why (no GPU in this environment).
//
// Uses Puppeteer's `browser.installExtension()` (not the `--load-extension` CLI flag): branded
// Chrome >=137 silently ignores that flag entirely (verified live in this project -- see
// DECISIONS.md), so a script that just passed `--load-extension` would report a false negative
// for reasons that have nothing to do with this extension. `installExtension` uses the
// Chrome DevTools Protocol Extensions domain instead, which still works.
//
// Usage: node tests/e2e/chrome-check.mjs
// Requires: `npm install --no-save puppeteer` (not a project dependency -- this is a one-off
// verification tool, not something the extension or its build needs) and, for the Qdrant-fetch
// check, `docker compose up -d` already running.
import puppeteer from "puppeteer";
import { setTimeout as sleep } from "node:timers/promises";

const EXTENSION_PATH = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

function log(...args) {
  console.log("[chrome-check]", ...args);
}

async function main() {
  const results = [];
  const record = (name, ok, detail) => {
    results.push({ name, ok, detail });
    log(ok ? "PASS" : "FAIL", "-", name, "-", detail ?? "");
  };

  log("Extension path:", EXTENSION_PATH);

  const browser = await puppeteer.launch({
    headless: false, // extension service workers are unreliable under some headless configs
    pipe: true, // required by installExtension
    enableExtensions: true, // adds --enable-unsafe-extension-debugging
    userDataDir: "/tmp/ask-my-tabs-e2e-puppeteer-profile",
    args: ["--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check"],
  });

  try {
    const version = await browser.version();
    record("Puppeteer launches a real Chrome build", true, version);

    let extensionId;
    try {
      extensionId = await browser.installExtension(EXTENSION_PATH);
      record("Extension installs via CDP Extensions.loadUnpacked (browser.installExtension)", true, `id=${extensionId}`);
    } catch (err) {
      record("Extension installs via CDP Extensions.loadUnpacked (browser.installExtension)", false, String(err));
      return results;
    }

    let offscreenTarget = null;
    for (let i = 0; i < 30 && !offscreenTarget; i++) {
      const targets = await browser.targets();
      offscreenTarget = targets.find((t) => t.url() === `chrome-extension://${extensionId}/offscreen.html`);
      if (!offscreenTarget) await sleep(500);
    }
    record("chrome.offscreen document is created automatically on install", !!offscreenTarget, offscreenTarget?.url());
    if (!offscreenTarget) return results;

    const offscreenPage = await offscreenTarget.asPage();

    // IMPORTANT: chrome.runtime.sendMessage does not deliver a message back to a listener
    // registered in the SAME document/context that sent it (verified live -- a first version
    // of this script sent LOAD_MODELS and listened from inside the offscreen document itself,
    // and received literally nothing back, including from the synchronous-response GET_STATE
    // handler, even though offscreen.js's own handler code runs and responds correctly in real
    // usage). The real production flow is popup.js (a DIFFERENT document) sending messages to
    // offscreen.js and listening for its broadcasts -- so the message-based checks below open
    // the actual popup page and drive it from there, exactly like a real user's click would.
    const popupPage = await browser.newPage();
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);

    const pingResult = await popupPage.evaluate(async () => {
      try {
        const res = await chrome.runtime.sendMessage({ type: "GET_STATE" });
        return { ok: true, res };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    });
    record(
      "Popup <-> offscreen message round trip works (GET_STATE)",
      pingResult.ok === true && typeof pingResult.res?.modelsReady === "boolean",
      JSON.stringify(pingResult),
    );

    const probe = await offscreenPage.evaluate(() => ({
      hasChromeRuntime: typeof chrome !== "undefined" && !!chrome.runtime,
      location: location.href,
    }));
    record("Offscreen document has a working chrome.runtime context", probe.hasChromeRuntime === true, JSON.stringify(probe));

    // Qdrant fetch/CORS check FROM INSIDE the offscreen document -- the actual claim that needs
    // live-browser proof, not just "host_permissions includes <all_urls>".
    const qdrantResult = await offscreenPage.evaluate(async () => {
      try {
        const res = await fetch("http://127.0.0.1:6333/readyz");
        return { ok: true, status: res.status, text: await res.text() };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    });
    record(
      "Offscreen document can fetch() Qdrant at http://127.0.0.1:6333 (real CORS/MV3 check)",
      qdrantResult?.ok === true,
      JSON.stringify(qdrantResult),
    );

    // Real embedding-model load through the ACTUAL bundled message flow (LOAD_MODELS), not a
    // raw unbundled import (embeddings.js uses a bare "@huggingface/transformers" specifier
    // that only resolves after esbuild bundling). Driven from the popup page (see note above).
    // Waits for the "embedder" -> "llm" stage transition as evidence the embedder finished;
    // does not wait for WebLLM (no GPU here).
    const embedResult = await popupPage.evaluate(async () => {
      const events = [];
      let resolveDone;
      const done = new Promise((resolve) => { resolveDone = resolve; });
      const timeout = setTimeout(() => resolveDone({ timedOut: true }), 120000);
      chrome.runtime.onMessage.addListener((message) => {
        events.push({
          type: message.type,
          stage: message.stage,
          detail: typeof message.detail === "string" ? message.detail : undefined,
          error: message.error,
        });
        if (message.type === "MODEL_PROGRESS" && message.stage === "llm") {
          clearTimeout(timeout);
          resolveDone({ embedderReachedLlmStage: true });
        }
        if (message.type === "MODEL_ERROR" || message.type === "MODELS_READY") {
          clearTimeout(timeout);
          resolveDone({ finished: true });
        }
      });
      chrome.runtime.sendMessage({ type: "LOAD_MODELS" }).catch(() => {});
      const outcome = await done;
      return { outcome, events };
    });
    const embedderLoaded =
      embedResult?.outcome?.embedderReachedLlmStage === true ||
      embedResult?.events?.some((e) => e.type === "MODEL_PROGRESS" && e.stage === "llm");
    record(
      "Embedding model (bge-small-en-v1.5) loads to completion inside the real bundled offscreen doc",
      embedderLoaded,
      JSON.stringify(embedResult?.outcome) + " events=" + JSON.stringify(embedResult?.events?.slice(0, 10)),
    );
    const llmErrorEvent = embedResult?.events?.find((e) => e.type === "MODEL_ERROR");
    if (llmErrorEvent) log("WebLLM load failed as expected in this no-GPU environment:", llmErrorEvent.error);
  } finally {
    await browser.close();
  }

  return results;
}

main()
  .then((results) => {
    const failed = results.filter((r) => !r.ok);
    console.log("\n=== chrome-check summary ===");
    for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
    process.exit(failed.length > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error("[chrome-check] fatal:", err);
    process.exit(1);
  });
