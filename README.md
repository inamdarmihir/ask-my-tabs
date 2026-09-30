# Ask My Tabs

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Build](https://github.com/inamdarmihir/ask-my-tabs/actions/workflows/build.yml/badge.svg)](https://github.com/inamdarmihir/ask-my-tabs/actions/workflows/build.yml)
![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-informational)

**Ask questions across the web pages you are reading and get cited answers.**

Ask My Tabs is a Chrome extension that turns your tabs into a searchable knowledge base. Add the
pages you are working with, ask a question, and an agent searches across all of them and writes an
answer with numbered citations that link back to the source tab.

You bring your own backend. There is no Ask My Tabs server: the extension talks directly to a
vector database and a language model that you choose.

<img src="docs/screenshot-popup.png" alt="Ask My Tabs popup showing the model banner, working set, and question box" width="360" />

## Features

- **Cited answers.** Every claim is tagged `[1]`, `[2]`, ... and mapped back to the page it came
  from. Out-of-range or invented citations are detected and flagged.
- **Agentic RAG with deepagents.** With an OpenAI-compatible provider, a LangGraph research agent
  plans, searches (hybrid BM25 + dense) and reads your pages as needed, then answers with citations that
  are verified against what it actually retrieved. Falls back to a fast fixed pipeline. Toggle in Settings.
- **Multi-hop retrieval.** The agent splits a comparative question into per-topic queries, checks
  whether the results are sufficient, and issues one refined follow-up search when they are not.
- **Hybrid search in Qdrant.** Dense embeddings (`mdbr-leaf-ir`) and BM25 (stemmed, k1=1.2, b=0.75,
  IDF computed by Qdrant from live collection statistics) are fused with weighted Reciprocal Rank Fusion in a single Query API call.
  Dense-only and sparse-only modes are available in settings.
- **Source-diverse results.** Results are grouped by source, so one long page cannot crowd the
  other tabs out of an answer.
- **Working set or library.** Query only the tabs you added, or everything you have ever indexed.
  Filter the library by domain or by date indexed.
- **Durable sources.** Pages are keyed by normalized URL, not by Chrome's reusable `tabId`.
  Re-adding an unchanged page is a no-op, and changed pages replace their previous snapshot.
- **Flexible backends.** Local or cloud vector storage, and on-device or hosted language models.
- **Prompt-injection guard.** Page text is passed to the model as untrusted data, with an explicit
  instruction not to follow anything inside it.

## Quick start

`dist/` is committed pre-built, so you can load the extension without installing Node.

1. Start a vector database. The simplest option is local Qdrant:

   ```bash
   docker compose up -d
   ```

   Or skip this step and use a [Qdrant Cloud](https://cloud.qdrant.io) cluster (see
   [Configuration](#configuration)).
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select this repository folder (the one containing `manifest.json`).
4. Follow the onboarding page, or open **Settings** from the popup (⚙) to choose your backends.
5. Open a few pages, click **+ Add current tab** for each, type a question, and press **Ask**.

Requirements: a Chromium browser with WebGPU (Chrome 113+ or an equivalent Edge build) if you use
the on-device language model. Hosted language models do not need WebGPU.

## Configuration

All settings live in the extension's Settings page and are stored in `chrome.storage.local`.

### Vector storage

| Option | Setup | Notes |
| --- | --- | --- |
| **Local Qdrant** (default) | `docker compose up -d`, URL `http://127.0.0.1:6333` | Qdrant v1.19.1, bound to `127.0.0.1` only. Pinned by tag and digest; supports `amd64` and `arm64`. |
| **Qdrant Cloud** | Enter your cluster URL and API key, then click **Test Connection** | Requires Qdrant v1.17 or later. Chunk text, URLs, and titles are stored in your cluster. |

### Language model

| Provider | Default model | Requirements |
| --- | --- | --- |
| **On-device (WebLLM)** (default) | `Qwen3-0.6B-q4f16_1-MLC` (thinking disabled) | WebGPU, ~0.5 GB one-time download |
| OpenAI | `gpt-6-luna` | API key |
| Groq | `llama-3.3-70b-versatile` | API key |
| Google Gemini | `gemini-1.5-flash` | API key |

The model field can be set to any model the provider supports, and **Test key** checks the key
and model without spending tokens. Embeddings always run in the browser, regardless of the
provider you pick.

## Privacy

What leaves your machine depends on the backends you choose:

| Data | Local Qdrant + on-device model | Qdrant Cloud | Hosted LLM API |
| --- | --- | --- | --- |
| Page text, URLs, titles | Stays on your machine | Sent to your Qdrant cluster | Retrieved snippets are sent with each question |
| Your questions | Stay on your machine | Stay on your machine | Sent to the provider |
| API keys | Stored in `chrome.storage.local` | Stored in `chrome.storage.local` | Stored in `chrome.storage.local` |

Additional notes:

- The extension has no analytics or telemetry, and the project runs no servers.
- The embedding model ships inside the extension. Only the optional on-device language model is
  downloaded (from the WebLLM model CDN, on first use). That request does not include your data.
- Local Qdrant is reachable by any software running as your user. Do not index sensitive pages on a
  shared machine.
- See [`privacy-policy.html`](privacy-policy.html) and [`store/permissions.md`](store/permissions.md)
  for the full policy and a justification of each permission.

## How it works

**Indexing.** Adding a tab extracts its readable text, splits it into overlapping ~180-word
chunks, embeds each chunk in the browser with a 23 MB model that ships inside the extension (no
download, works offline), and upserts the chunks to Qdrant as named dense and sparse vectors. Point IDs are deterministic hashes of the source key and chunk index.

**Answering.** The agent in [`src/lib/agent.js`](src/lib/agent.js) runs at most two hops:

1. The language model plans one to three search queries from the question.
2. Each query is embedded and searched in Qdrant in one Query API call: dense and sparse
   prefetches, weighted RRF fusion, and grouping by source.
3. A sufficiency check looks at the score distribution and asks the model whether the snippets
   cover the question. If not, one refined follow-up search runs.
4. The top snippets are passed to the model as numbered context, and it writes a cited answer.

**Architecture.** Models and the agent loop live in a Chrome
[offscreen document](https://developer.chrome.com/docs/extensions/reference/api/offscreen), which
outlives the popup and, unlike an MV3 service worker, has reliable DOM and WebGPU access.
`background.js` is a thin router that reads tab content and creates the offscreen document.

```
popup / settings / onboarding  <->  background (service worker)  <->  offscreen document
                                                                        ├─ embeddings (transformers.js)
                                                                        ├─ LLM (WebLLM or provider API)
                                                                        └─ agent loop -> Qdrant
```

Design rationale and verified behaviors are recorded in [`DECISIONS.md`](DECISIONS.md).

## Platform support

| Platform | Status |
| --- | --- |
| Chrome / Edge on Windows and macOS | Supported |
| Chrome on Linux / ChromeOS | Expected to work; not regularly tested |
| Chrome on iOS, iPadOS, and Android | Not possible. These browsers do not support Chrome extensions. |

The on-device language model needs a working WebGPU adapter, which depends on your GPU, drivers,
and any organization policy. If none is available, the popup explains how to check `chrome://gpu`,
or you can switch to a hosted provider. The embedder runs on WASM and never needs a GPU.

## Development

Requires Node.js 18+ and npm.

```bash
npm install            # install dependencies
npm run build          # bundle src/ into dist/
npm run watch          # rebuild on change
npm test               # unit tests (no services required)
npm run test:integration   # integration tests against live Qdrant (docker compose up -d)
npm run eval               # retrieval eval on BEIR SciFact; needs Qdrant, writes eval/RESULTS.md
```

After rebuilding, reload the extension from `chrome://extensions`. Chrome does not watch `dist/`.

### Project layout

```
manifest.json            Extension manifest (MV3)
popup.* / settings.* / onboarding.html    UI pages
offscreen.html           Hosts the models and agent loop
privacy-policy.html      Privacy policy page
src/
  background.js          Service worker: tab access, offscreen lifecycle
  offscreen.js           Embedder, LLM, and agent loop host
  popup.js / settings.js / onboarding.js
  lib/
    agent.js             Multi-hop retrieval and answer generation
    qdrant.js            Qdrant REST adapter (collections, upsert, hybrid query)
    library.js           Indexing, snapshot replacement, source management
    embeddings.js        Dense embedding model wrapper (loads the bundled model)
    embedding-model.js   The one place that names the embedding model
    sparse.js            BM25 sparse vectors (stemmed, hashed, Qdrant-side IDF)
    llm.js               On-device WebLLM wrapper
    llm-api.js           OpenAI, Groq, and Gemini clients
    config.js            Settings schema and storage
    chunk.js, ids.js, filters.js, freshness.js, gpu.js, constants.js
models/                  Bundled embedding model (see scripts/fetch-models.js)
eval/                    Retrieval eval harness and results
scripts/                 Developer scripts
tests/                   unit, integration, and e2e tests
store/                   Chrome Web Store listing and permission justifications
docker-compose.yml       Local Qdrant
dist/                    Pre-built bundles
```

## Known limitations

- Text extraction removes scripts and page chrome but is not Readability-grade. Client-rendered
  sites, paywalled pages, and content behind interaction may extract poorly.
- The library keeps only the latest snapshot of each source, not its history.
- Navigating a tab after adding it does not re-index it. Remove and re-add the tab to refresh.
- Upgrading from the earlier IndexedDB-only version does not migrate existing data.
- The on-device model is small (1.5B parameters). Expect weaker synthesis than a hosted model.
- Retrieval quality is measured on scientific abstracts (BEIR SciFact), where hybrid search did not
  beat dense-only. See [`eval/RESULTS.md`](eval/RESULTS.md) and [`DECISIONS.md`](DECISIONS.md).

## Contributing

Issues and pull requests are welcome. Please run `npm test` and `npm run build` before opening a
PR, and commit rebuilt `dist/` bundles when you change `src/`. A screenshot or GIF of an answered
question would be a valuable contribution.

## License

[MIT](LICENSE)
