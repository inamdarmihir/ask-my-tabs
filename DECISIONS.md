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

## Sparse representation naming

Per the prompt's explicit instruction, the deterministic lexical sparse vector implemented in
`src/lib/sparse.js` is **not** called BM25 anywhere in code, comments, docs, or the eval report.
It is a hashed, IDF-free (until Milestone 3's optional idf pass, see that file's header comment),
raw/log term-frequency sparse vector with a fixed tokenizer, stopword list, and FNV-1a-based
feature hashing into a fixed-size sparse index space to keep it collision-documented and
deterministic across runs/versions. It is described precisely (not as "BM25-lite" or similar) in
`README.md`, `eval/PROTOCOL.md`, and code comments.

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
