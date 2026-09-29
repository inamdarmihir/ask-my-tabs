import test from "node:test";
import assert from "node:assert/strict";
import { indexSource, removeSourceFromLibrary, listLibrarySources, IndexingError, EMBED_BATCH_SIZE } from "../../src/lib/library.js";

// A tiny in-memory fake of the qdrant.js adapter surface library.js actually calls, so these
// tests exercise real lifecycle logic (no-op detection, replace ordering, failure handling)
// without needing a live Qdrant container. Live-Qdrant coverage of the same scenarios lives in
// tests/integration/qdrant.integration.test.js.
function fakeClient() {
  const points = new Map(); // id -> point
  return {
    _points: points,
    async upsertPoints(_collection, newPoints) {
      if (this._failUpsert) throw new Error("simulated upsert failure");
      for (const p of newPoints) points.set(p.id, p);
    },
    async deletePointsByFilter(_collection, filter) {
      if (this._failDelete) throw new Error("simulated delete failure");
      const sourceKeyClause = filter.must.find((c) => c.key === "sourceKey");
      const notHashClause = filter.must_not?.find((c) => c.key === "contentHash");
      for (const [id, p] of Array.from(points.entries())) {
        const matchesSource = p.payload.sourceKey === sourceKeyClause.match.value;
        const matchesExclusion = notHashClause ? p.payload.contentHash !== notHashClause.match.value : true;
        if (matchesSource && matchesExclusion) points.delete(id);
      }
    },
    async deleteBySourceKey(collection, sourceKey) {
      return this.deletePointsByFilter(collection, { must: [{ key: "sourceKey", match: { value: sourceKey } }] });
    },
    async scrollAll(_collection, { filter } = {}) {
      let out = Array.from(points.values());
      const domainClause = filter?.must?.find((c) => c.key === "domain");
      if (domainClause) out = out.filter((p) => p.payload.domain === domainClause.match.value);
      return out.map((p) => ({ id: p.id, payload: p.payload }));
    },
  };
}

const fakeEmbed = async (texts) => texts.map(() => new Float32Array(384).fill(0.01));

test("indexing a new source writes chunks and returns skipped:false", async () => {
  const client = fakeClient();
  const res = await indexSource(client, "col", {
    canonicalUrl: "https://example.com/docs",
    title: "Docs",
    text: Array.from({ length: 50 }, (_, i) => `word${i}`).join(" "),
    embed: fakeEmbed,
  });
  assert.equal(res.skipped, false);
  assert.ok(res.chunkCount >= 1);
  assert.equal(client._points.size, res.chunkCount);
});

test("re-indexing unchanged content is a true no-op (content-hash short circuit)", async () => {
  const client = fakeClient();
  const text = "stable content that never changes across re-indexing attempts here";
  const args = { canonicalUrl: "https://example.com/a", title: "A", text, embed: fakeEmbed };
  const first = await indexSource(client, "col", args);
  const sizeAfterFirst = client._points.size;
  const second = await indexSource(client, "col", args);
  assert.equal(second.skipped, true);
  assert.equal(second.reason, "unchanged since last indexed");
  assert.equal(client._points.size, sizeAfterFirst, "no new vectors should have been added");
  assert.equal(first.contentHash, second.contentHash);
});

test("changed content replaces old chunks -- old chunks are not left behind as current", async () => {
  const client = fakeClient();
  const canonicalUrl = "https://example.com/changelog";
  await indexSource(client, "col", { canonicalUrl, title: "Changelog v1", text: "version one release notes", embed: fakeEmbed });
  const idsAfterFirst = new Set(client._points.keys());

  const result = await indexSource(client, "col", { canonicalUrl, title: "Changelog v2", text: "version two release notes changed", embed: fakeEmbed });
  assert.equal(result.replaced, true);

  for (const p of client._points.values()) {
    assert.equal(p.payload.contentHash, result.contentHash, "no stale-hash chunk should remain after replacement");
  }
  const idsAfterSecond = new Set(client._points.keys());
  const anyOldSurvived = Array.from(idsAfterFirst).some((id) => idsAfterSecond.has(id));
  assert.equal(anyOldSurvived, false, "old point IDs (different content hash) must be gone");
});

test("a failed embed/upsert leaves the previous snapshot fully intact (no partial deletion)", async () => {
  const client = fakeClient();
  const canonicalUrl = "https://example.com/flaky";
  await indexSource(client, "col", { canonicalUrl, title: "v1", text: "first stable version of the page", embed: fakeEmbed });
  const beforeAttempt = new Map(client._points);

  client._failUpsert = true;
  await assert.rejects(
    () => indexSource(client, "col", { canonicalUrl, title: "v2", text: "second version totally different text", embed: fakeEmbed }),
    IndexingError,
  );
  client._failUpsert = false;

  assert.deepEqual(client._points, beforeAttempt, "old snapshot must be untouched after a failed re-index");
});

test("a failed cleanup-delete after a successful upsert is surfaced, not swallowed silently", async () => {
  const client = fakeClient();
  const canonicalUrl = "https://example.com/partial";
  await indexSource(client, "col", { canonicalUrl, title: "v1", text: "original content before any change happens", embed: fakeEmbed });

  client._failDelete = true;
  const result = await indexSource(client, "col", { canonicalUrl, title: "v2", text: "updated content after the change happens", embed: fakeEmbed });
  assert.equal(result.staleSnapshotCleanupFailed, true);
  client._failDelete = false;

  // Retrying (idempotent point IDs) should succeed and clean up the leftover old chunk.
  const retry = await indexSource(client, "col", { canonicalUrl, title: "v2", text: "updated content after the change happens", embed: fakeEmbed });
  assert.equal(retry.skipped, true); // same content hash as the previous attempt now
});

test("removeSourceFromLibrary deletes every chunk for that source", async () => {
  const client = fakeClient();
  await indexSource(client, "col", { canonicalUrl: "https://example.com/gone", title: "Gone", text: "content to be deleted from the library entirely", embed: fakeEmbed });
  assert.ok(client._points.size > 0);
  await removeSourceFromLibrary(client, "col", "https://example.com/gone");
  assert.equal(client._points.size, 0);
});

test("listLibrarySources returns one row per source, not one per chunk", async () => {
  const client = fakeClient();
  const longText = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
  await indexSource(client, "col", { canonicalUrl: "https://example.com/long", title: "Long doc", text: longText, embed: fakeEmbed });
  const sources = await listLibrarySources(client, "col");
  assert.equal(sources.length, 1);
  assert.ok(sources[0].chunkCount > 1);
});

test("embedding runs in batches of EMBED_BATCH_SIZE and reports progress", async () => {
  const client = fakeClient();
  const batchSizes = [];
  const progress = [];
  const embed = async (texts) => {
    batchSizes.push(texts.length);
    return texts.map(() => new Float32Array(384).fill(0.01));
  };
  // ~180-word chunks with 30-word overlap: 5,000 words gives well over two batches of chunks.
  const text = Array.from({ length: 5000 }, (_, i) => `word${i}`).join(" ");
  const res = await indexSource(client, "col", {
    canonicalUrl: "https://example.com/long",
    title: "Long",
    text,
    embed,
    onProgress: (p) => progress.push(p),
  });

  assert.ok(res.chunkCount > EMBED_BATCH_SIZE, "fixture must span more than one batch");
  assert.ok(batchSizes.every((n) => n <= EMBED_BATCH_SIZE));
  assert.equal(batchSizes.reduce((a, b) => a + b, 0), res.chunkCount);
  const embedding = progress.filter((p) => p.stage === "embedding");
  assert.equal(embedding.length, batchSizes.length);
  assert.equal(embedding.at(-1).done, res.chunkCount);
  assert.equal(progress.at(-1).stage, "saving");
  assert.equal(client._points.size, res.chunkCount);
});

test("indexSource reports per-stage timings, including for the unchanged no-op", async () => {
  const client = fakeClient();
  const args = { canonicalUrl: "https://example.com/t", title: "T", text: Array.from({ length: 60 }, (_, i) => `w${i}`).join(" "), embed: fakeEmbed };
  const first = await indexSource(client, "col", args);
  assert.ok("embed" in first.timings.stages && "upsert" in first.timings.stages);
  const second = await indexSource(client, "col", args);
  assert.equal(second.skipped, true);
  assert.ok(!("embed" in second.timings.stages));
});
