# Ask My Tabs

A Chrome extension for the specific moment where you've got six tabs open comparing something
and you're tired of clicking between them to check one fact. Add the tabs you're working with,
ask a question, and it searches across all of them and writes an answer with citations back to
the tab each claim came from.

Everything runs on your machine. The embedding model and the language model both execute
in-browser via WebGPU/WASM. No tab content, no question, no answer ever leaves your computer --
there's no server in this picture at all.

## What's here

```
manifest.json          extension manifest (MV3)
popup.html / .css       the toolbar UI
offscreen.html          hosts the models -- see "Why offscreen" below
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

## Running it

Chrome, `chrome://extensions`, enable Developer mode, "Load unpacked", pick this folder. That's
it -- `dist/` is already built, so there's no npm install required just to try it.

Click the toolbar icon, hit "Load models" (downloads happen once, then stay cached in Chrome's
own storage), add the tabs you want to search across, and ask something.

To modify the source: `npm install && npm run build` (or `npm run watch` while iterating), then
reload the extension from `chrome://extensions`.

## How it works

Adding a tab extracts its readable text (strips nav/header/footer/script), splits it into ~180
word overlapping chunks, embeds each chunk with a small retrieval model
([`bge-small-en-v1.5`](https://huggingface.co/Xenova/bge-small-en-v1.5), 33M params, running
through [transformers.js](https://huggingface.co/docs/transformers.js)), and stores the
chunk/vector pairs in IndexedDB. Re-adding a tab whose content hasn't changed is a no-op --
there's a content hash check before anything gets re-embedded.

Asking a question kicks off the agent loop in `src/lib/agent.js`:

1. A small local LLM ([`Qwen2.5-1.5B-Instruct`](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct),
   running through [WebLLM](https://github.com/mlc-ai/web-llm)) breaks the question into 1-3
   search queries. A question comparing two things becomes two queries, one per thing, instead
   of one blurry query that muddles both.
2. Each query gets embedded and searched against the working set's chunks.
3. The model looks at what came back and decides if it's enough. If the best match is weak, or
   the model itself says the snippets don't cover the question, it issues one refined follow-up
   search before giving up on finding more.
4. The top matches get handed to the LLM as numbered context, and it writes an answer citing
   `[1]`, `[2]`, etc. back to specific tabs.

Two hops, not an open-ended loop. Enough to actually help on "compare X and Y," not enough to
wander off searching forever.

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

## What's actually verified vs. what needs your own testing

The embedding half of this was tested live in a real browser, not just written and assumed to
work: `bge-small-en-v1.5` loaded via transformers.js, correctly separated a similar sentence pair
(cosine 0.59) from an unrelated one (cosine 0.30), and ran on WebGPU without falling back to WASM.

That test caught a real bug before it shipped. The obvious move for a smaller download is
`dtype: "q8"` (8-bit quantization) -- and it loaded fine, three times faster, and quietly broke
retrieval: the unrelated sentence pair scored a *higher* cosine similarity (0.69) than the
actually-similar pair (0.62). Silently wrong ranking, not a crash, which is the worse kind of bug
to ship. `fp16` turned out to be the right middle ground: meaningfully smaller than the full fp32
weights, and the similar/unrelated ranking stayed correct (0.59 vs. 0.30) when tested the same
way. That's what's shipped.

What isn't verified end-to-end: the WebLLM half, running inside a real `chrome.offscreen`
document in an actual loaded extension. transformers.js was testable directly in a browser tab
with no extension APIs involved; `chrome.offscreen`, `chrome.scripting`, and a several-hundred-MB
WebLLM model download aren't something a sandboxed test page can stand in for. Load this unpacked
in real Chrome and you're the first real test of that path -- if the model download stalls or
`chatJSON`'s query planning comes back malformed, `src/lib/agent.js` already has a defensive
fallback (treat the raw question as a single query) precisely because small local models are
inconsistent about following a "respond with JSON only" instruction under load.

## Known limitations

- Page-text extraction is a blunt strip-scripts-and-chrome-elements pass, not real Readability-
  style content detection. Sites with unusual layouts (heavy client-side rendering, paywalls,
  content behind interaction) may extract poorly or come back empty.
- The working set doesn't survive a tab closing -- it tracks `tabId`, and Chrome reuses those.
  Closing a tab you'd added just leaves a stale entry pointing nowhere; removing it manually is
  the only cleanup right now.
- No re-indexing on navigation. If you add a tab, then navigate it somewhere else, the old
  content stays indexed under that `tabId` until you remove and re-add it.
