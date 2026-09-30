# Decisions log

This file records deviations from the original request, judgment calls, and things verified
against real APIs/behavior rather than assumed from documentation. Newest entries at the top of
each section-in-progress; entries are append-only once the milestone that produced them ships.

## Environment facts verified before writing code (Milestone 0)

- **No GPU in the build/dev sandbox used for this work.** `lspci` shows no VGA controller,
  `/dev/dri` doesn't exist, `nvidia-smi` is absent. This means **WebGPU is unavailable** in this
  environment, and per the existing `src/lib/llm.js`/README, WebLLM's answer-generation path
  requires WebGPU. Consequence: the full "download WebLLM, ask a question, get a cited answer"
  path (Milestone 5 / acceptance criterion) **cannot be verified live from this sandbox**, exactly
  as the pre-existing README already disclosed for the *previous* pass. This is not new bad news;
  it is the same gap, now with a root cause. Chrome itself (`google-chrome 148`) is installed and
  runs headless/Xvfb fine, so extension loading, offscreen-document creation, embedding (WASM
  fallback), and Qdrant fetch/CORS *can* be verified live here even though WebLLM cannot. See the
  Milestone 5 report for exactly what was and wasn't run.
- **Docker works** after `apt-get install docker.io` + manually starting `dockerd` (no systemd in
  this sandbox) and installing the `docker compose` CLI plugin manually (not in the base apt
  repos here). `qdrant/qdrant:v1.11.0` pulls fine and resolves to digest
  `sha256:cc802bd2841ec2026725e19619075982311ce4d7182dc8c03a0c8e6817bb9170`. This means Milestones
  1-3's Qdrant integration tests run against a **real** local Qdrant, not a mock.
- **Qdrant Query API confirmed against the actual v1.11.0 REST API** (checked docs for the
  version installed, not assumed): `POST /collections/{name}/points/query` with `prefetch: [...]`
  and `query: {"fusion": "rrf"}` is the real hybrid syntax (available since v1.10). Named vectors
  go under `vectors: {dense: {size, distance}}` and sparse vectors under a separate
  `sparse_vectors: {sparse: {...}}` map on collection creation — they are not siblings under
  `vectors`. Confirmed by exercising this repo's `docker-compose.yml` against a live container,
  not by reading docs alone.
- **Network egress works** (npm registry, huggingface.co, Docker Hub all reachable), so
  `npm install`, `npm run build`, and the Node-based eval harness (which reuses
  `@huggingface/transformers` to embed fixture text) all run for real in this sandbox.

## `SUFFICIENCY_SCORE_FLOOR` (agent.js)

The original code used `SUFFICIENCY_SCORE_FLOOR = 0.45` as a hard floor on cosine similarity to
decide whether retrieval needs a second hop. This is invalid once retrieval can return an RRF rank
score (unbounded, fusion-dependent, not comparable to cosine's `[-1, 1]` range) instead of cosine.
Fix: the floor is removed. Sufficiency is now decided by (a) whether *any* hits were returned at
all, (b) a **method-agnostic** relative-margin heuristic (is the top hit meaningfully better than
background noise for *this* query, measured by score dispersion/rank within the same result set,
never by an absolute magnitude that assumes a particular scoring scale), and (c) the existing
LLM-based sufficiency judgment, which was already method-agnostic. Unit tests cover this directly
under `tests/unit/sufficiency.test.js` for both cosine-like and RRF-like score distributions.

## Sparse representation: now BM25 (supersedes the earlier "not BM25" rule)

The earlier hashed log-TF vector was deliberately not called BM25 because it lacked length
normalization and k1 saturation. `src/lib/sparse.js` now implements Okapi BM25 and is called that:
document vectors carry `tf*(k1+1)/(tf + k1*(1-b+b*dl/avgdl))` (k1=1.2, b=0.75), query vectors weigh
each distinct term 1, and Qdrant's `modifier: "idf"` supplies IDF from live collection statistics
(the split Qdrant documents for BM25). Tokens are Porter-stemmed unless they are identifiers.
One approximation versus textbook BM25: `avgdl` is a fixed estimate (100 tokens per chunk), because a
stored vector cannot follow the corpus average as pages come and go.

Measured on the same SciFact harness (300 queries, 1000 docs, leaf-ir-q8): sparse-only nDCG@10
0.750 -> 0.795, hybrid 0.818 -> 0.842. All four candidate embedders gained 0.010-0.028 hybrid.
The sparse algorithm version is part of the collection name
(`ask_my_tabs_library__<model>__bm25-stem-hash-v1`), so pages indexed under the old scoring must be
re-added; the old collection is simply left unused.

## Deep agent (deepagents / LangGraph) for agentic RAG

With an OpenAI-compatible provider the default answer path is a tool-using research agent built with
`deepagents` (LangChain's agent harness on LangGraph) in `src/lib/deep-agent.js`. Tools: `list_sources`,
`search_pages` (the hybrid dense + BM25 query), `read_page` (windowed, in order). deepagents adds
`write_todos` planning and a `researcher` subagent (used for multi-part questions). Every snippet a tool
returns is numbered in a shared registry; the final answer's `[n]` are renumbered by first use and any
number no tool returned is removed, so a citation always resolves to a stored snippet.
- Runs in the offscreen document. deepagents ships a `browser` entry; its Node-only imports (file backends,
  sandboxes, AsyncLocalStorage) are stubbed at build time (`shims/`, `build.js`) and a minimal `process` is
  provided by `shims/process-global.js`. Verified in Chrome: real tool loop, streaming, subagent-capable.
- Cost/latency: 3+ model calls per question, so `agentMode` in Settings can switch to the fixed pipeline.
  Any deep-agent failure (or no API key, or a non-OpenAI-compatible provider) falls back to the pipeline.
- Not covered: Gemini and the on-device model use the pipeline; the deep agent needs a model with reliable
  tool calling.

## Bug found while verifying: settings never reached the offscreen document

`chrome.storage` does not exist in an offscreen document, so `getConfig()` there returned the built-in
defaults. The API key, provider, model, Qdrant URL and retrieval mode saved in Settings were ignored for
answering (the popup, which can read storage, still displayed them). The offscreen entry now asks the
service worker (`GET_CONFIG`); `tests/unit/offscreen-config.test.js` guards against reintroducing it.
Found by pointing the extension at a local mock OpenAI server and observing that it was never called.

## Durable identity

Chrome `tabId` is reused across tab lifetimes and is explicitly documented by Chrome as not
durable, so it cannot be the library's primary key. Decision: the durable **source key** is the
canonical URL (documented normalization: strip fragment, strip a fixed list of known tracking
query params, lowercase scheme+host, strip default ports, strip trailing slash except for root).
`tabId` is retained only as a *working-set* pointer (which live tab instance currently maps to
which source), never as a document identity in Qdrant. Point IDs are deterministic UUIDv5-style
values derived from `sha256(sourceKey + "::" + chunkIndex)` truncated/formatted as a valid UUID
(v4-shaped, deterministically derived — Qdrant requires UUID-shaped string IDs or unsigned
integers; it does not implement RFC 4122 v5 validation, so a deterministic hash-derived UUID
string is accepted and is what's used here), never the raw URL or title, per the prompt's explicit
instruction not to put raw URL/title in the ID.

## Library snapshot retention policy

Decision: **library mode retains only the latest snapshot per source key**, not full version
history. Rationale: keeping every historical snapshot indefinitely would need its own retention/
GC policy, storage growth bookkeeping, and a "which snapshot is authoritative for citations"
resolution rule that this scope doesn't need to get right to make a fair retrieval/citation claim.
When content changes, the previous snapshot's points are deleted **after** the new snapshot's
points are confirmed upserted (see Milestone 2's atomic-enough replacement order), and the payload
records `supersedes: previousSnapshotId` momentarily during the swap for a recovery path, but no
separate "superseded" points are kept around long-term. This is disclosed in the README as a
scoping decision, not hidden. The "stale" citation flag is about *time since indexed* /
*content-hash mismatch on revisit*, not about multi-version retention.

## Freshness ranking ablation

A ranking-time recency boost on `indexedAt` is implemented as an explicit, off-by-default
*experimental variant* (`retrieval variant: hybrid+freshness`), never blended silently into the
default ranking. Given the corpus size in this project (tens of pages, not a moving news feed),
most fixture pages don't have naturally meaningfully different `indexedAt` spread — see
`eval/PROTOCOL.md` and `RESULTS.md` for whether/how this ablation is scientifically meaningful on
the corpus actually used, and the explicit limitation if it isn't.

## Scope cuts (explicit, not silent)

- No Qdrant Cloud path, no analytics, no remote tab upload. Only named in README as a possible
  *future* variant with a changed privacy story.
- No IndexedDB→Qdrant migration of old chunk data. The old IndexedDB store is simply no longer
  read; existing users start with an empty library. Disclosed in README, not implemented, because
  building and testing a real migration is separate scope from the retrieval/citation study this
  task is about.
- No model training, no distributed system, no ANN performance claims on a corpus sized in the
  tens-to-low-hundreds of chunks — if raw brute-force dense (the *old* code path) is fast enough at
  this scale, the eval report says so plainly instead of implying Qdrant's approximate index is
  winning on speed at a scale where it can't.

## A real bug this pass found (Milestone 1, `src/lib/qdrant.js`)

The first version of the Qdrant adapter's `upsertPoints`/`deletePointsByFilter` used Qdrant's
default write behavior (no `wait` query param). Against a **live** container, a query issued
immediately after an upsert intermittently returned zero results for the just-written point --
`dense`- and `sparse`-mode queries came back empty while a `hybrid` query against the same data
in the same process, moments later, found it. This is a genuine async-acknowledgement gap
(Qdrant's default REST write returns once the operation is *accepted*, not necessarily once it's
*visible to search*), not a mistake in the query bodies. Fixed by adding `?wait=true` to both
write paths. Caught by actually running requests against `docker compose up`'s container in a
loop, not by reading the Qdrant docs -- this is the kind of bug source review alone would have
missed, and exactly why Milestone 1's gate requires live integration tests, not just unit tests
against a mock.

## A second real bug this pass found (Milestone 2, `src/lib/library.js`)

The first version of `indexSource`'s no-op detection asked "what is the content hash of the
MOST RECENTLY written chunk for this source" (by comparing `indexedAt` timestamps) to decide
whether new text is unchanged. This is racy: it ties whenever two writes for the same source
land in the same millisecond, and a tie silently picks an arbitrary (insertion-order) hash
instead of the actually-latest one. This is exactly the kind of bug that only shows up once you
chain "index v1, fail a cleanup delete on v2, retry" into one fast-running test -- it reproduced
immediately in the unit test for that sequence (`tests/unit/library.test.js`), because a fast
local test suite has no natural delay between writes. Fixed by replacing the timestamp
comparison with a timing-independent check: "does a chunk with this EXACT content hash already
exist for this source" (set membership over all currently-stored hashes for the source), which
also self-heals a previously-failed cleanup by deleting other stale hashes as a side effect of a
successful no-op check. `qdrant.js`'s now-unused `getContentHash` (the racy timestamp-based
helper) was deleted rather than left around unused.

## Cross-platform Chrome support (Windows / macOS / iPad) -- explicit user request

Investigated on request: "make sure this extension works in Chrome no matter Windows, Mac, or
tablet/iPad." Findings, verified rather than assumed:

- **The codebase has zero OS-specific branches.** Grepped `src/` for `navigator.platform`,
  `userAgent`, `win32`/`darwin`, etc. -- none exist. Every API used (`chrome.offscreen`,
  `chrome.scripting`, `chrome.storage.session`, `chrome.tabs.onRemoved`/`onUpdated`, WebGPU,
  WASM, `fetch`) is a standard desktop-Chrome feature identical on Windows, macOS, and Linux.
  `manifest.json`/`popup.html`/`offscreen.html` all reference bundle paths with forward slashes,
  which is correct and required regardless of host OS (these are URL paths inside the extension's
  own origin, not filesystem paths -- there was never a backslash risk here to begin with).
- **The pinned Qdrant image is genuinely multi-platform under the one pinned digest.** Ran
  `docker manifest inspect qdrant/qdrant@sha256:cc802bd...` (the exact digest in
  `docker-compose.yml`) and confirmed it resolves to an OCI image *index* containing both a
  `linux/amd64` and a `linux/arm64` manifest -- not a single-architecture digest that would quietly
  break (or silently run under slow emulation) on Apple Silicon Macs while working fine on Intel
  Macs/Windows. This was checked directly against the real registry, not assumed from the tag.
- **WebLLM (`src/lib/llm.js`) had no capability pre-check and no way to retry after a failed
  load.** Added `src/lib/gpu.js` (`hasWebGPU()`, checking `navigator.gpu.requestAdapter()`) so a
  missing/disabled GPU adapter surfaces as one clear, actionable, deliberately OS-neutral message
  instead of a raw WASM-backend error several layers inside WebLLM. This is a per-machine fact
  (driver, hardware, org policy), never a per-OS one -- the message and tests (`tests/unit/gpu.test.js`)
  explicitly avoid singling out Windows, macOS, or Linux. Also fixed: `loadLLM()`, `getExtractor()`
  (`src/lib/embeddings.js`), and `ensureModelsLoaded()` (`src/offscreen.js`) all used to cache a
  **failed** load promise forever, so a transient/fixable failure (updating a driver, closing a
  GPU-heavy tab, flipping a `chrome://flags` entry) could never be retried within the same browser
  session without reloading the whole extension. All three now clear their cached promise on
  failure, and the popup's "Load models" button re-enables itself (`Retry load`) on `MODEL_ERROR`
  instead of staying disabled with a stale "Loading..." label. This bug was platform-agnostic but
  most likely to actually bite on Windows machines with no discrete GPU or GPU access disabled by
  IT policy, which is a common real-world case, not an edge case.
- **Chrome on iPad/iPhone (and Chrome on Android) cannot run this extension, or any Chrome
  extension, at all -- verified against Apple's and Google's own stated platform constraints, not
  assumed.** Apple requires every iOS/iPadOS browser, including Chrome, to use WebKit rather than
  Chrome's own Blink engine (App Store review policy); Manifest V3 extension APIs
  (`chrome.offscreen`, `chrome.scripting`, etc.) are Blink-only and do not exist in Chrome for iOS
  at all -- there is no flag, permission, or code change in this repo that can add a Blink-only
  API surface to a WebKit-based browser. Google's own support content separately confirms Chrome
  for Android also does not implement the desktop extension API, so this is "extensions are a
  desktop-Chrome-only feature," not an iOS-specific gap. Disclosed honestly in README's new
  "Platform support" table rather than silently ignored or claimed as "supported." If tablet
  support is ever actually required, it needs a different product (web app or native app, or
  relying on a third-party WebKit browser like Orion/Teak that reimplements a subset of the MV3
  surface itself) -- explicitly out of scope for this version, matching the original prompt's "no
  store listing, no cloud path this version" scoping philosophy.

## Qdrant v1.19 retrieval upgrade (Phase A)

- **Qdrant pinned to v1.19.1** (tag and digest in `docker-compose.yml` and CI). Qdrant only
  guarantees on-disk migration from the previous minor version; the local volume was empty, so it
  was recreated rather than stepped through 1.12-1.18.
- **Server-side IDF on the sparse vector** (`modifier: "idf"`). The client still sends log-TF
  vectors; Qdrant applies IDF from live collection statistics at query time, so there is still no
  client-side corpus state to keep in sync. Existing collections are upgraded in place with a
  `PATCH` (scoring-only change, no re-index). Verified live: a term present in every document no
  longer outweighs a rare one (`tests/integration`).
- **Weighted RRF** (`query: { rrf: { k, weights } }`, v1.17+). Defaults are `k = 60` and equal
  weights, which is identical to the previous plain RRF. The parameters exist so the eval can tune
  them; they were not changed without numbers.
- **Per-source result grouping** (`/points/query/groups`, `group_by: "sourceKey"`). Previously one
  long page could fill every top-k slot and a comparison question would cite only one tab. The
  per-source cap is `max(2, ceil(topK / sourceCount))`, so a working set with a single source still
  gets full recall, and library scope (unknown source count) uses 2.
- Payload indexes on `sourceKey`, `domain`, `indexedAt`, etc. already existed and were kept.

## Embedding model selection rule (written before running the eval)

Candidates: `Xenova/bge-small-en-v1.5` and `MongoDB/mdbr-leaf-ir`, each in fp16 and q8, scored by
`npm run eval` (`eval/run-eval.js`) on BEIR SciFact through the real chunking, sparse-vector and
Qdrant query code, in dense-only, sparse-only and hybrid modes. **Rule:** among configurations
whose **hybrid nDCG@10 is within 0.010 (1.0 point) of the best configuration**, pick the one with
the smallest model file on disk (it is bundled inside the extension and loaded on every browser
start); ties go to the higher nDCG@10. The default hybrid weights are not tuned in this run.
A candidate whose dense-only score is implausibly low (< 0.5 x the best dense score) is treated as
a broken export (e.g. a missing projection layer) and excluded, not ranked. Results and the
decision are recorded in `eval/RESULTS.md`.

### Hybrid weights rule (written after the first eval run, before the second)

The first run showed hybrid at equal RRF weights scoring slightly *below* dense-only for every
config (about 0.818 vs 0.83), so equal weights may be over-crediting the weaker lexical retriever.
The eval now also reports hybrid with dense:sparse weights of 2:1 and 3:1. **Rule:** the shipped
default weights move off 1:1 only if, for the chosen model, one of these beats 1:1 hybrid nDCG@10
by at least 0.010; if both do, take the smaller weight that is within 0.005 of the better one.
Otherwise keep 1:1. SciFact is one scientific-abstract corpus, so any change is a modest prior,
not a tuned optimum for web pages; the weights stay a parameter of `client.query` for that reason.

### Outcome (eval run 2026-09-29, `eval/RESULTS.md`)

- **Model: `MongoDB/mdbr-leaf-ir`, q8, 23 MB**, pinned at revision
  `4262131b32c3182bd06e67e92ae69d7bd66e0c5c` and bundled in `models/`. All four candidates land
  within 0.006 hybrid nDCG@10 of each other (0.814-0.820), so the rule reduces to "smallest file",
  and q8 of LEAF-IR is also the fastest to embed (18 ms/chunk vs 83 for bge-small fp16 in Node).
  The earlier ad-hoc q8 failure with bge-small did not reproduce on SciFact (0.814 vs 0.818);
  runs differ by about 0.003 from Qdrant's IDF statistics, so gaps under 0.005 are noise.
- **Weights: keep 1:1.** Neither 2:1 nor 3:1 beat 1:1 by 0.010 for LEAF-IR q8 (0.816, 0.815 vs
  0.818).
- **Honest caveat: hybrid did not beat dense-only on this corpus** (dense 0.835 vs hybrid 0.818
  for the chosen model). SciFact is scientific abstracts, where paraphrase matches dominate.
  Hybrid is kept because web pages carry exact identifiers, versions and error strings that
  lexical matching exists for, but that benefit is not measured here. Retrieval mode remains a
  setting; a fixture set of real pages with identifier-style queries is the right next eval.
- **Embeddings run on WASM, not WebGPU.** The q8 model uses integer operators that WebGPU does not
  reliably support, and the CPU path leaves the GPU to the on-device language model. This is
  unverified in a real browser (the eval ran on Node/CPU); measure it on first load.
- **Cross-origin isolation** (`cross_origin_embedder_policy: require-corp`, `same-origin` opener)
  is enabled in `manifest.json` so the WASM backend can use up to 4 threads. Unverified in Chrome.
  If any cross-origin request (Qdrant Cloud, an LLM API, the WebLLM model CDN) starts failing,
  remove those two manifest keys first; the embedder then falls back to one thread.
- **Collections are keyed by model** (`ask_my_tabs_library__leaf-ir-q8`). The previous
  `ask_my_tabs_library` collection is left untouched and no longer read; there is no migration
  (it was empty for the only known install).

## Findings moved from the README

- **Embedding precision.** `dtype: "q8"` loaded about three times faster but silently broke
  retrieval: an unrelated sentence pair scored a higher cosine (0.69) than a similar pair (0.62).
  `fp16` kept the correct ordering (0.59 similar vs. 0.30 unrelated), so `src/lib/embeddings.js`
  uses `fp16`.
- **Missing `offscreen` permission.** An early `manifest.json` omitted `"offscreen"`, which left
  `chrome.offscreen` undefined and made `createDocument()` throw on every install. Found by
  loading the extension unpacked; fixed by adding the permission.
- **Why an offscreen document.** Popups are destroyed on blur and MV3 service workers are
  ephemeral with inconsistent WebGPU access, so models and the agent loop live in a
  `chrome.offscreen` document.
- **Why not a WASM vector index.** At a few hundred chunks, brute-force search is already
  microseconds; storage moved to Qdrant for durability, filtering, and hybrid fusion instead.

(Further entries appended per milestone below.)
