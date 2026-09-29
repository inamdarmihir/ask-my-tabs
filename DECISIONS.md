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

(Further entries appended per milestone below.)
