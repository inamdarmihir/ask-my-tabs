# Ask My Tabs

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Build](https://github.com/inamdarmihir/ask-my-tabs/actions/workflows/build.yml/badge.svg)](https://github.com/inamdarmihir/ask-my-tabs/actions/workflows/build.yml)
![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-informational)

A Chrome extension for the specific moment where you've got six tabs open comparing something
and you're tired of clicking between them to check one fact. Add the tabs you're working with,
ask a question, and it searches across all of them and writes an answer with citations back to
the tab each claim came from. Everything -- the embedding model and the language model -- runs
in-browser via WebGPU/WASM: no server, no API key, no tab content or question ever leaves your
machine.

## Screenshots

<img src="docs/screenshot-popup.png" alt="Ask My Tabs popup in its default state: model-status banner, empty working set, and a question box" width="360" />

The popup's default state, loaded unpacked in real Chrome (no models downloaded yet -- that's
what "Load models" does on first click). There's no screenshot of an answered question yet since
that requires the ~1.1GB model download described below; if you try it and want to contribute
one, a PR updating `docs/screenshot-popup.png` (or adding a second screenshot/GIF) would be
welcome.

## Try it (no build required)

`dist/` is committed pre-built, so you can load the extension straight from a clone or a
downloaded zip -- no Node, no npm, no build step.

1. Download or clone this repo.
2. Open `chrome://extensions` in Chrome (or another Chromium browser with WebGPU support, e.g.
   Edge).
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the repo folder (the one containing `manifest.json`).
5. Click the toolbar icon, hit **Load models** (see download sizes below -- one-time, then
   cached by Chrome), add a couple of tabs, and ask a question.

**Before you do:** read [What's verified vs. what isn't](#whats-verified-vs-what-isnt) below.
Short version: the extension now loads cleanly and creates its offscreen document without
errors (confirmed live, see below), and the embedding/retrieval path has been tested live too --
but nobody has yet run the full "download the ~1GB language model and get a written, cited
answer" path start-to-finish. Loading this unpacked makes you one of the first real tests of
that specific step. Worst case if it breaks: the popup shows an error and nothing outside your
machine is affected -- there's no server for anything to leak to.

## How it works

Adding a tab extracts its readable text (strips nav/header/footer/script), splits it into ~180
word overlapping chunks, embeds each chunk with a small retrieval model, and stores the
chunk/vector pairs in IndexedDB. Re-adding a tab whose content hasn't changed is a no-op --
there's a content hash check before anything gets re-embedded.

Asking a question kicks off the agent loop in `src/lib/agent.js`:

1. A small local LLM breaks the question into 1-3 search queries. A question comparing two
   things becomes two queries, one per thing, instead of one blurry query that muddles both.
2. Each query gets embedded and searched against the working set's chunks.
3. The model looks at what came back and decides if it's enough. If the best match is weak, or
   the model itself says the snippets don't cover the question, it issues one refined follow-up
   search before giving up on finding more.
4. The top matches get handed to the LLM as numbered context, and it writes an answer citing
   `[1]`, `[2]`, etc. back to specific tabs.

Two hops, not an open-ended loop. Enough to actually help on "compare X and Y," not enough to
wander off searching forever.

### Pinned models

| Role | Model ID | Params | Runtime | Precision | Approx. download |
| --- | --- | --- | --- | --- | --- |
| Embeddings | [`Xenova/bge-small-en-v1.5`](https://huggingface.co/Xenova/bge-small-en-v1.5) | 33M | [transformers.js](https://huggingface.co/docs/transformers.js) | fp16 | ~65 MB |
| Answer generation | [`Qwen2.5-1.5B-Instruct-q4f16_1-MLC`](https://huggingface.co/mlc-ai/Qwen2.5-1.5B-Instruct-q4f16_1-MLC) | 1.5B | [WebLLM](https://github.com/mlc-ai/web-llm) | 4-bit (q4f16_1) | ~1.0 GB |

Combined first-run download is roughly **1.1 GB**, which is what the popup's "Load models"
button tells you up front. Both are cached by the browser after the first load, so it's a
one-time cost per Chrome profile (until the cache is cleared).

### Why offscreen, not the popup or the background worker

The models take real memory and take a while to load, so they need to survive the popup being
closed -- popups get destroyed the moment you click away, and reloading ~1GB of weights every
time you open the toolbar icon would be miserable. The service worker looks like the obvious
place to keep them alive instead, but MV3 service workers are ephemeral and historically
inconsistent about WebGPU access. Chrome's actual answer to "I need a persistent context with
full DOM/GPU access from an extension" is `chrome.offscreen` -- an invisible document that lives
independently of both the popup and the service worker's lifecycle. That's where the embedder,
the LLM, and the whole agent loop live. `background.js` is just a thin router: it does the two
things offscreen documents can't (read tab content via `chrome.scripting`, create the offscreen
document itself) and otherwise stays out of the way.

### Why no WASM vector database

The original plan called for something like Voy or Orama for the vector store. A research session
realistically has a handful of tabs and a few hundred chunks, and brute-force cosine similarity
over a plain JS array is microseconds at that size -- there's nothing for an approximate-nearest-
neighbor index to buy you here, and it's one less WASM binary to package and debug. IndexedDB is
only there so the working set survives the offscreen document restarting, not for search speed.
This is a deliberate choice, not a missing feature -- see [Known limitations](#known-limitations)
for what that trade-off does and doesn't cost you.

## What's verified vs. what isn't

Being upfront about this: parts of this pipeline have been exercised in a real, loaded copy of
the extension; the most expensive part (actually downloading and running the local LLM) hasn't.

| Path | Status | Evidence |
| --- | --- | --- |
| Embeddings (`bge-small-en-v1.5` via transformers.js) | ✅ Verified live | Loaded via transformers.js and ran on WebGPU without falling back to WASM. Correctly separated a similar sentence pair (cosine 0.59) from an unrelated one (cosine 0.30). See details below. |
| Vector store / retrieval (`src/lib/vectorstore.js`) | ✅ Exercised as part of the above | Same test run: brute-force cosine search over the embedded vectors returned the expected ranking. |
| Extension loads unpacked, no console errors (`manifest.json`) | ✅ Verified live | Loaded unpacked in real Chrome via `chrome://extensions`. See "A real bug this pass found and fixed" below -- this used to fail immediately. |
| `chrome.offscreen` document creation (`background.js`) | ✅ Verified live | Confirmed via Chrome's own "Inspect views" list on the extension's card, which shows `offscreen.html` as a live, inspectable view after load -- the offscreen document is actually being created, not just attempted. |
| WebLLM model download + answer generation (`src/lib/llm.js`) | ⚠️ Not verified end-to-end | Deliberately not exercised in this pass -- it triggers a ~1GB one-time download, which isn't something to trigger automatically. Written and reasoned about, but nobody has confirmed a full question-to-answer run yet. |
| Agent loop query planning / sufficiency check (`src/lib/agent.js`) | ⚠️ Not verified end-to-end | Depends on the WebLLM path above. Has a defensive fallback (treat the raw question as a single query) for when the model's JSON output is malformed, since small local models are inconsistent about following "respond with JSON only" under load. |

**Why the split:** transformers.js runs fine in a plain browser tab, and `chrome.offscreen`
document creation is cheap and instant to check, so both were verified directly. Actually running
WebLLM means committing to a ~1GB download before you can observe anything -- that's a
deliberate, informed gap in this pass, not an oversight. If you hit it, the model download
stalling or `chatJSON`'s query planning coming back malformed are the most likely failure modes,
and the fallback above is what's supposed to catch the latter.

### A real bug this pass found and fixed

Before this round of polish, `manifest.json`'s `permissions` array didn't include `"offscreen"`.
Chrome gates the entire `chrome.offscreen` namespace behind that permission -- without it,
`chrome.offscreen` is `undefined`, not an empty/no-op object, so `background.js`'s call to
`chrome.offscreen.createDocument()` threw `TypeError: Cannot read properties of undefined
(reading 'createDocument')` the instant the extension installed. That's not an edge case: it
broke on every load, for everyone, before any model, tab, or question was ever involved. Loading
the extension unpacked and checking `chrome://extensions` for errors is what caught it. It's
fixed now (`"offscreen"` is in the permissions list) and confirmed working live -- see the table
above -- but it's a good illustration of exactly the kind of thing "written but never loaded in
real Chrome" can hide.

### The embedding test in more detail

The obvious move for a smaller download is `dtype: "q8"` (8-bit quantization) -- and it loaded
fine, three times faster, and quietly broke retrieval: the unrelated sentence pair scored a
*higher* cosine similarity (0.69) than the actually-similar pair (0.62). Silently wrong ranking,
not a crash, which is the worse kind of bug to ship. `fp16` turned out to be the right middle
ground: meaningfully smaller than the full fp32 weights, and the similar/unrelated ranking
stayed correct (0.59 vs. 0.30) when tested the same way. That's what's shipped, and that test is
the reason `dtype: "fp16"` appears in `src/lib/embeddings.js` instead of the smaller `q8`.

## Platform support

Short version: **this works the same way on Chrome for Windows and Chrome for macOS, and cannot
work on Chrome for iPad/iPhone (or Chrome for Android) no matter what code changes here** -- that
last part is Apple's/Google's platform policy, not a bug in this extension.

| Platform | Status | Why |
| --- | --- | --- |
| Chrome on Windows (desktop) | ✅ Supported | MV3 (`chrome.offscreen`, `chrome.scripting`, `chrome.storage.session`), WebGPU, and WASM are all standard desktop-Chrome features -- nothing in this codebase branches on OS. See below for the one real caveat (WebGPU driver/policy availability). |
| Chrome on macOS (desktop) | ✅ Supported | Same as Windows -- same MV3 APIs, same WebGPU/WASM stack. Verified: the pinned local Qdrant image (`qdrant/qdrant:v1.11.0`, see `docker-compose.yml`) is a real **multi-platform** manifest with both `linux/amd64` and `linux/arm64` builds under the pinned digest (checked with `docker manifest inspect`, not assumed), so Docker Desktop on Apple Silicon and Intel Macs both pull the correct native image, not an emulated one. |
| Chrome on Linux (desktop) / ChromeOS | ⚠️ Likely fine, not explicitly tested this pass | Same MV3/WebGPU/WASM stack; this whole project was *developed* in a Linux sandbox, just one without a GPU (see `DECISIONS.md`), so the extension-loading and Qdrant-fetch paths are exercised on Linux already -- WebGPU itself just wasn't available to test there. |
| **Chrome on iPad / iPhone (iOS/iPadOS)** | ❌ **Not possible, architecturally** | Apple requires every browser on iOS/iPadOS -- including Chrome -- to use Apple's WebKit engine, not Chrome's own Blink engine. Chrome extensions (Manifest V3, `chrome.offscreen`, `chrome.scripting`, etc.) are Blink APIs that don't exist in Chrome-for-iOS at all. This is true for *every* Chrome extension, not something specific to this one, and no change to this repo's code can add an API that Chrome-for-iOS doesn't expose. If tablet use matters, the only paths are a fundamentally different product (a web app, or a native iOS app) or a third-party WebKit browser that reimplements a subset of the MV3 extension surface itself (e.g. Orion, Teak) -- outside this repo's scope. |
| Chrome on Android (phone/tablet) | ❌ Not possible, same reason | Google's own support docs confirm Chrome for Android does not implement the desktop extension API either -- this is not iOS-specific, it's "extensions are a desktop-Chrome feature." |

**The one real Windows/macOS caveat -- and it's per-machine, not per-OS:** `src/lib/llm.js`
(WebLLM, the answer-writing model) requires a working WebGPU adapter and has no fallback. Whether
that's available depends on the machine's GPU, drivers, and any org policy disabling GPU access
in Chrome -- exactly as likely on a Windows laptop with an old integrated GPU as on a Mac with GPU
access restricted by MDM. `src/lib/gpu.js` checks `navigator.gpu.requestAdapter()` up front so a
missing adapter surfaces as one clear message in the popup (check `chrome://gpu`, update drivers,
check org policy) instead of a cryptic WASM-backend error several layers down in WebLLM. The
embedder (`src/lib/embeddings.js`) does not have this problem -- it has a real WASM fallback and
runs (more slowly) even with no GPU at all, on any of the three desktop OSes.

**Docker/Qdrant is also a per-machine, not per-OS, requirement.** `docker-compose.yml` needs
Docker Desktop (or another Docker Engine) running on whichever machine hosts the extension's
browser profile -- Windows via WSL2 or Hyper-V, macOS via Apple's Virtualization framework -- and
binds Qdrant to `127.0.0.1` only, which both platforms' Docker Desktop support natively. This
repo doesn't (and can't, without a fundamentally different architecture) make Qdrant reachable
from a *different* machine than the one Chrome is running on, including a tablet -- see
[Known limitations](#known-limitations) for what "iPad support" would actually require if it were
ever in scope, which it is not for this version.

## Known limitations

- **WebLLM's model download and answer generation are unverified end-to-end** (see table above)
  -- the extension itself is confirmed to load and set up its offscreen document correctly, but
  nobody has yet run a full question through the local LLM and gotten an answer back.
- Page-text extraction is a blunt strip-scripts-and-chrome-elements pass, not real Readability-
  style content detection. Sites with unusual layouts (heavy client-side rendering, paywalls,
  content behind interaction) may extract poorly or come back empty.
- The working set doesn't survive a tab closing -- it tracks `tabId`, and Chrome reuses those.
  Closing a tab you'd added just leaves a stale entry pointing nowhere; removing it manually is
  the only cleanup right now.
- No re-indexing on navigation. If you add a tab, then navigate it somewhere else, the old
  content stays indexed under that `tabId` until you remove and re-add it.
- Requires a Chromium browser with WebGPU (Chrome 113+, or Edge with the same engine version).
  Falls back to WASM for the embedder if WebGPU is unavailable, but WebLLM's answer-generation
  path currently requires WebGPU.
- No automated tests yet -- see [Verified vs. what isn't](#whats-verified-vs-what-isnt) for
  exactly what's been exercised and how.

## Develop

To modify the source, you'll need Node.js (18+) and npm.

```bash
npm install              # installs esbuild, transformers.js, web-llm
npm run build             # bundles src/ into dist/ once
npm run watch              # rebuild on every file save, for iterating
```

Then reload the extension from `chrome://extensions` (the reload icon on the extension's card)
to pick up the new `dist/` bundles -- Chrome doesn't watch the filesystem for you.

`build.js` uses esbuild to bundle each entry point in `src/` (`background.js`, `offscreen.js`,
`popup.js`) into a matching `dist/*.bundle.js`, in ESM format targeting Chrome 120. All paths
referenced from `manifest.json`, `popup.html`, and `offscreen.html` point at those `dist/`
bundles, not at `src/` directly -- the browser never loads unbundled source.

### Project layout

```
manifest.json          extension manifest (MV3)
popup.html / .css       the toolbar UI
offscreen.html          hosts the models -- see "Why offscreen" above
src/
  background.js          service worker: reads tab content, keeps the offscreen doc alive
  offscreen.js            owns the embedder, the LLM, and the agent loop
  popup.js                toolbar UI logic
  lib/
    embeddings.js          wraps the embedding model
    llm.js                 wraps the language model
    agent.js                the actual agentic retrieval loop
    vectorstore.js          IndexedDB-backed flat cosine search
    chunk.js                text chunking + content hashing
build.js                bundles src/ into dist/ with esbuild
icons/
dist/                   pre-built bundles -- load this unpacked and it just works
```

## License

[MIT](LICENSE)
