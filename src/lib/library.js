// Library lifecycle: turns extracted page text into Qdrant points, and back out again.
// Depends only on the Qdrant adapter, ids/chunk/sparse helpers, and an injected `embed`
// function -- no chrome.* APIs -- so it runs identically in the extension's offscreen document
// and in the Node eval harness.

import { chunkText, hashText } from "./chunk.js";
import { canonicalizeUrl, domainOf, sourceKeyFor, chunkPointId } from "./ids.js";
import { sparseVector, SPARSE_ALGORITHM_VERSION } from "./sparse.js";
import { startTimer } from "./timing.js";

// Chunks embedded per model call. Small enough to report progress and keep peak memory low, large
// enough that per-call overhead doesn't dominate (benchmarked: batches of 8 were 10-30% faster
// than one call for a whole page in Node).
export const EMBED_BATCH_SIZE = 16;

export class IndexingError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "IndexingError";
    this.cause = cause;
  }
}

// Indexes (or no-ops, or replaces) one source's current text. `embed(texts) -> Float32Array[]`
// is injected so this module never imports the model loader directly.
//
// Ordering is the whole point of "atomic-enough": the NEW snapshot's points are embedded and
// upserted successfully BEFORE the OLD snapshot's points (if any, and if the content actually
// changed) are deleted. If embedding or upsert throws, execution stops before any delete runs,
// so a failed re-index leaves the previous snapshot fully intact and queryable -- never a
// partially-deleted corpus. If the delete step itself fails (network blip after a successful
// upsert), the function surfaces that distinctly (`staleSnapshotCleanupFailed: true`) rather
// than silently swallowing it; the leftover old chunks are still tagged with their own
// (superseded) contentHash, and a repair pass is just calling indexSource again, which is
// idempotent and will retry the delete with the same deterministic point IDs.
export async function indexSource(client, collection, { canonicalUrl: rawUrl, title, text, embed, observedTabId, observedSessionId, corpusMode = "library", onProgress }) {
  const timer = startTimer();
  const canonicalUrl = canonicalizeUrl(rawUrl);
  const domain = domainOf(canonicalUrl);
  const sourceKey = await sourceKeyFor(canonicalUrl);
  const contentHash = await hashText(text);

  // Deliberately checks "does a chunk with THIS EXACT content hash already exist for this
  // source" via set membership, not "what is the single most-recent hash" via a timestamp
  // comparison. A timestamp-based "latest wins" comparison is racy: an earlier version of this
  // function picked the point with the max `indexedAt`, which ties (and therefore picks the
  // wrong snapshot) whenever two writes land in the same millisecond -- caught by a unit test
  // for the failed-cleanup-then-retry sequence that runs fast enough to hit that tie in practice
  // (i.e. this isn't just a theoretical worry -- it reproduced immediately in fast, real test
  // runs, though rarely against a live Qdrant where network latency spreads writes apart). Set
  // membership has no timing dependency at all.
  const existingPoints = await timer.time("check", () =>
    client.scrollAll(collection, {
      filter: { must: [{ key: "sourceKey", match: { value: sourceKey } }] },
      withPayload: true,
    }),
  );
  const existingHashes = new Set(existingPoints.map((p) => p.payload.contentHash));
  const hadAnySnapshotBefore = existingPoints.length > 0;

  if (existingHashes.has(contentHash)) {
    // Already fully indexed under this exact content. If a PRIOR re-index's cleanup delete
    // failed, there may still be leftover chunks from an older, different hash sitting
    // alongside the current one -- self-heal that now rather than requiring a distinct repair
    // path. Best-effort: if this also fails, the source is still correctly answering queries
    // with the fresh chunks, just with old chunks still contributing noise until a future
    // successful cleanup.
    if (existingHashes.size > 1) {
      try {
        await client.deletePointsByFilter(collection, {
          must: [{ key: "sourceKey", match: { value: sourceKey } }],
          must_not: [{ key: "contentHash", match: { value: contentHash } }],
        });
      } catch {
        // best-effort repair; next successful write will retry the same cleanup
      }
    }
    return { skipped: true, reason: "unchanged since last indexed", sourceKey, contentHash, timings: timer.summary() };
  }

  const pieces = chunkText(text);
  if (pieces.length === 0) {
    return { skipped: true, reason: "no extractable text", sourceKey, contentHash };
  }

  const denseVectors = [];
  try {
    await timer.time("embed", async () => {
      for (let i = 0; i < pieces.length; i += EMBED_BATCH_SIZE) {
        denseVectors.push(...(await embed(pieces.slice(i, i + EMBED_BATCH_SIZE))));
        onProgress?.({ stage: "embedding", done: Math.min(i + EMBED_BATCH_SIZE, pieces.length), total: pieces.length });
      }
    });
  } catch (err) {
    throw new IndexingError(
      `Embedding failed for ${canonicalUrl}; previous snapshot (if any) was left untouched.`,
      err,
    );
  }

  const indexedAt = Date.now();
  const ids = await Promise.all(pieces.map((_, i) => chunkPointId(sourceKey, contentHash, i)));
  const points = pieces.map((chunk, i) => ({
    id: ids[i],
    dense: Array.from(denseVectors[i]),
    sparse: sparseVector(chunk),
    payload: {
      sourceKey,
      canonicalUrl,
      domain,
      title,
      indexedAt,
      contentHash,
      chunkIndex: i,
      chunkCount: pieces.length,
      text: chunk,
      observedTabId: observedTabId ?? null,
      observedSessionId: observedSessionId ?? null,
      corpusMode,
      sparseAlgorithmVersion: SPARSE_ALGORITHM_VERSION,
    },
  }));

  onProgress?.({ stage: "saving", done: pieces.length, total: pieces.length });
  try {
    await timer.time("upsert", () => client.upsertPoints(collection, points));
  } catch (err) {
    throw new IndexingError(
      `Upsert failed for ${canonicalUrl}; previous snapshot (if any) was left untouched.`,
      err,
    );
  }

  // Only now, after the new snapshot is confirmed written, remove any old chunks for this
  // source that belong to a different (superseded) content hash.
  let staleSnapshotCleanupFailed = false;
  if (hadAnySnapshotBefore) {
    try {
      await client.deletePointsByFilter(collection, {
        must: [{ key: "sourceKey", match: { value: sourceKey } }],
        must_not: [{ key: "contentHash", match: { value: contentHash } }],
      });
    } catch (err) {
      staleSnapshotCleanupFailed = true;
    }
  }

  return {
    skipped: false,
    sourceKey,
    canonicalUrl,
    domain,
    contentHash,
    indexedAt,
    chunkCount: points.length,
    replaced: hadAnySnapshotBefore,
    staleSnapshotCleanupFailed,
    timings: timer.summary(),
  };
}

// Explicit "Delete from library" action -- removes every chunk for a source. Distinct from
// removing a tab from the working set, which never calls this.
export async function removeSourceFromLibrary(client, collection, canonicalUrl) {
  const canon = canonicalizeUrl(canonicalUrl);
  const sourceKey = await sourceKeyFor(canon);
  await client.deleteBySourceKey(collection, sourceKey);
  return { sourceKey, canonicalUrl: canon };
}

// One row per distinct source (not per chunk) for the library UI: title, domain, indexedAt,
// chunk count. `filter` supports the domain/date scoping described in the product spec.
export async function listLibrarySources(client, collection, { domain, indexedAfter, indexedBefore, corpusMode } = {}) {
  const must = [];
  if (domain) must.push({ key: "domain", match: { value: domain } });
  if (corpusMode) must.push({ key: "corpusMode", match: { value: corpusMode } });
  if (indexedAfter || indexedBefore) {
    const range = {};
    if (indexedAfter) range.gte = indexedAfter;
    if (indexedBefore) range.lte = indexedBefore;
    must.push({ key: "indexedAt", range });
  }
  const filter = must.length ? { must } : undefined;

  const points = await client.scrollAll(collection, { filter, withPayload: true });
  const bySource = new Map();
  for (const p of points) {
    const s = p.payload.sourceKey;
    const existing = bySource.get(s);
    if (!existing || p.payload.chunkIndex === 0) {
      bySource.set(s, {
        sourceKey: s,
        canonicalUrl: p.payload.canonicalUrl,
        domain: p.payload.domain,
        title: p.payload.title,
        indexedAt: p.payload.indexedAt,
        contentHash: p.payload.contentHash,
        chunkCount: p.payload.chunkCount,
      });
    }
  }
  return Array.from(bySource.values()).sort((a, b) => b.indexedAt - a.indexedAt);
}
