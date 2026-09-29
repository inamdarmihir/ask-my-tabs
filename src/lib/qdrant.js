// Thin REST adapter for the local Qdrant instance. No bundled Qdrant JS client is used: the
// official `@qdrant/js-client-rest` package pulls in Node-oriented dependencies (it assumes
// Node's `http`/`https` in places) that do not bundle cleanly for an MV3 offscreen document
// without extra shimming, and the REST surface this project needs (collections, points, the
// Query API) is small and stable. Explicit `fetch` calls are what's actually used, kept in one
// place so the rest of the codebase never constructs a Qdrant request by hand. This module has
// no `chrome.*` dependency, so it also runs unmodified under Node for the eval harness.

export const DENSE_VECTOR_NAME = "dense";
export const SPARSE_VECTOR_NAME = "sparse";
export const DENSE_SIZE = 384; // must match src/lib/embeddings.js's bge-small-en-v1.5 output

export class QdrantConnectionError extends Error {
  constructor(url, cause) {
    super(
      `Can't reach Qdrant at ${url}. ` +
        `If using local Docker, run "docker compose up -d" in the project root. ` +
        `If using Qdrant Cloud, check your URL and API key in Settings.`,
    );
    this.name = "QdrantConnectionError";
    this.cause = cause;
  }
}

export class QdrantSchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = "QdrantSchemaError";
  }
}

export class QdrantApiError extends Error {
  constructor(status, body) {
    super(`Qdrant API error ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
    this.name = "QdrantApiError";
    this.status = status;
    this.body = body;
  }
}

// `url` is the full Qdrant base URL (e.g. "http://127.0.0.1:6333" for local Docker or
// "https://xyz.qdrant.io:6333" for Qdrant Cloud). `apiKey` is optional: when non-empty,
// every request carries an `Authorization: Bearer {apiKey}` header, which is the auth
// mechanism Qdrant Cloud uses. Local instances ignore the header harmlessly.
export function makeClient({ url = "http://127.0.0.1:6333", apiKey = "" } = {}) {
  const baseUrl = url;
  const authHeaders = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

  async function request(path, { method = "GET", body } = {}) {
    let res;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...authHeaders,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      // fetch() throws TypeError on network-level failure (connection refused, DNS, CORS
      // rejection) -- this is the "Qdrant is down" case the UI needs to show actionable
      // guidance for instead of a raw stack trace.
      throw new QdrantConnectionError(baseUrl, err);
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      throw new QdrantApiError(res.status, json?.status?.error ?? json ?? text);
    }
    return json;
  }

  return {
    baseUrl,

    // Bounded, fast liveness check for the UI's "Qdrant down" banner. Distinguishes
    // "unreachable" from "reachable but not ready yet" so the guidance can differ.
    // Auth headers are included because Qdrant Cloud requires them on all endpoints.
    async health() {
      try {
        const res = await fetch(`${baseUrl}/readyz`, { method: "GET", headers: authHeaders });
        return { reachable: true, ready: res.ok };
      } catch (err) {
        return { reachable: false, ready: false, error: String(err) };
      }
    },

    async listCollections() {
      const res = await request("/collections");
      return res.result.collections.map((c) => c.name);
    },

    async getCollection(name) {
      try {
        const res = await request(`/collections/${encodeURIComponent(name)}`);
        return res.result;
      } catch (err) {
        if (err instanceof QdrantApiError && err.status === 404) return null;
        throw err;
      }
    },

    // Idempotent: creates the collection with the schema this project needs if it doesn't
    // exist; if it already exists, verifies the dense vector's dimension/distance and the
    // sparse vector's presence match what's expected, and THROWS instead of silently deleting
    // or recreating on mismatch -- per explicit instruction, incompatible schema is detected,
    // never silently wiped.
    async ensureCollection(name, { denseSize = DENSE_SIZE } = {}) {
      const existing = await this.getCollection(name);
      if (!existing) {
        await request(`/collections/${encodeURIComponent(name)}`, {
          method: "PUT",
          body: {
            vectors: {
              [DENSE_VECTOR_NAME]: { size: denseSize, distance: "Cosine" },
            },
            sparse_vectors: {
              [SPARSE_VECTOR_NAME]: { index: { on_disk: false } },
            },
          },
        });
      } else {
        const denseCfg = existing.config?.params?.vectors?.[DENSE_VECTOR_NAME];
        const sparseCfg = existing.config?.params?.sparse_vectors?.[SPARSE_VECTOR_NAME];
        if (!denseCfg) {
          throw new QdrantSchemaError(
            `Collection "${name}" exists but has no "${DENSE_VECTOR_NAME}" named vector. ` +
              `Refusing to touch it automatically -- inspect it manually or use a different ` +
              `collection name.`,
          );
        }
        if (denseCfg.size !== denseSize) {
          throw new QdrantSchemaError(
            `Collection "${name}" has dense vector size ${denseCfg.size}, expected ${denseSize}. ` +
              `This usually means it was created with a different embedding model. Refusing to ` +
              `delete or recreate it automatically -- back it up, drop it manually with ` +
              `"docker compose down -v" (destroys ALL collections) or the Qdrant API, then retry.`,
          );
        }
        if ((denseCfg.distance || "").toLowerCase() !== "cosine") {
          throw new QdrantSchemaError(
            `Collection "${name}" has dense distance metric "${denseCfg.distance}", expected ` +
              `"Cosine". Refusing to modify it automatically.`,
          );
        }
        if (!sparseCfg) {
          throw new QdrantSchemaError(
            `Collection "${name}" exists but has no "${SPARSE_VECTOR_NAME}" sparse vector ` +
              `configured -- it predates hybrid retrieval support. Refusing to modify it ` +
              `automatically; create a fresh collection instead.`,
          );
        }
      }

      // Payload indexes are idempotent to (re-)create: Qdrant returns 200 for an index that
      // already exists with the same schema. These are what make domain/date/source filters
      // fast; they are NOT evidence of better search *quality* on their own -- see DECISIONS.md.
      const indexes = [
        ["sourceKey", "keyword"],
        ["domain", "keyword"],
        ["indexedAt", "integer"],
        ["contentHash", "keyword"],
        ["chunkIndex", "integer"],
        ["corpusMode", "keyword"],
      ];
      for (const [field, schema] of indexes) {
        await request(`/collections/${encodeURIComponent(name)}/index`, {
          method: "PUT",
          body: { field_name: field, field_schema: schema },
        });
      }

      return { created: !existing };
    },

    async deleteCollection(name) {
      await request(`/collections/${encodeURIComponent(name)}`, { method: "DELETE" });
    },

    // Upsert is the only write path for chunk points. Point IDs are deterministic (see
    // src/lib/ids.js), so re-upserting the same (source, snapshot, chunk index) overwrites in
    // place rather than duplicating.
    // `wait=true` on both write paths below: without it Qdrant acknowledges the write and
    // returns before the change is guaranteed visible to a subsequent query, which was caught
    // live in this project's own integration tests (a query issued immediately after an upsert
    // intermittently missed the just-written point). Correctness > raw write throughput at this
    // project's scale.
    async upsertPoints(collection, points) {
      if (points.length === 0) return;
      await request(`/collections/${encodeURIComponent(collection)}/points?wait=true`, {
        method: "PUT",
        body: {
          points: points.map((p) => ({
            id: p.id,
            vector: { [DENSE_VECTOR_NAME]: p.dense, [SPARSE_VECTOR_NAME]: p.sparse },
            payload: p.payload,
          })),
        },
      });
    },

    async deletePointsByFilter(collection, filter) {
      await request(`/collections/${encodeURIComponent(collection)}/points/delete?wait=true`, {
        method: "POST",
        body: { filter },
      });
    },

    async deleteBySourceKey(collection, sourceKey) {
      await this.deletePointsByFilter(collection, {
        must: [{ key: "sourceKey", match: { value: sourceKey } }],
      });
    },

    // Scrolls every point matching an (optional) filter, returning only the requested payload
    // fields. Used for library listing (distinct sources/domains/dates) and for the eval
    // harness's ground-truth lookups. Fine at this project's corpus size (hundreds of chunks,
    // not millions); would need real pagination-aware batching at a scale this project
    // explicitly isn't targeting.
    async scrollAll(collection, { filter, withPayload = true, withVector = false, batchSize = 256 } = {}) {
      const out = [];
      let offset;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const res = await request(`/collections/${encodeURIComponent(collection)}/points/scroll`, {
          method: "POST",
          body: { filter, limit: batchSize, offset, with_payload: withPayload, with_vector: withVector },
        });
        out.push(...res.result.points);
        offset = res.result.next_page_offset;
        if (!offset || res.result.points.length === 0) break;
      }
      return out;
    },

    // Core retrieval entry point. `mode` is one of "dense", "sparse", "hybrid" -- see
    // src/lib/agent.js and eval/PROTOCOL.md for what each means and how they're compared.
    // `filter` is a Qdrant filter object (already built by the caller, e.g. scoping to a
    // working set's source keys and/or a domain/date range) applied identically regardless of
    // mode, so variants are compared at the same eligible corpus.
    async query(collection, { mode, dense, sparse, filter, limit = 8, prefetchLimit = 40 }) {
      const body = { filter, limit, with_payload: true, with_vector: false };
      if (mode === "dense") {
        body.query = dense;
        body.using = DENSE_VECTOR_NAME;
      } else if (mode === "sparse") {
        body.query = sparse;
        body.using = SPARSE_VECTOR_NAME;
      } else if (mode === "hybrid") {
        body.prefetch = [
          { query: dense, using: DENSE_VECTOR_NAME, limit: prefetchLimit, filter },
          { query: sparse, using: SPARSE_VECTOR_NAME, limit: prefetchLimit, filter },
        ];
        body.query = { fusion: "rrf" };
        delete body.filter; // filter already applied per-prefetch; a top-level filter here would double-filter harmlessly but is redundant
      } else {
        throw new Error(`Unknown retrieval mode: ${mode}`);
      }
      const res = await request(`/collections/${encodeURIComponent(collection)}/points/query`, {
        method: "POST",
        body,
      });
      return res.result.points.map((p) => ({ id: p.id, score: p.score, payload: p.payload }));
    },
  };
}
