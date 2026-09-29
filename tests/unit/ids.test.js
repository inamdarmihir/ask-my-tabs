import test from "node:test";
import assert from "node:assert/strict";
import { canonicalizeUrl, domainOf, sourceKeyFor, chunkPointId } from "../../src/lib/ids.js";

test("canonicalizeUrl lowercases scheme/host, strips default port and fragment", () => {
  const c = canonicalizeUrl("HTTPS://Example.COM:443/Path/?b=2&a=1#section");
  // Trailing slash is also stripped per the documented policy (#6) -- covered separately below.
  assert.equal(c, "https://example.com/Path?b=2&a=1");
});

test("canonicalizeUrl strips known tracking params but keeps other query params", () => {
  const c = canonicalizeUrl("https://example.com/page?utm_source=x&id=42&fbclid=abc");
  assert.equal(c, "https://example.com/page?id=42");
});

test("canonicalizeUrl strips a single trailing slash, but not the root path", () => {
  assert.equal(canonicalizeUrl("https://example.com/docs/"), "https://example.com/docs");
  assert.equal(canonicalizeUrl("https://example.com/"), "https://example.com/");
});

test("canonicalizeUrl rejects non-http(s) schemes", () => {
  assert.throws(() => canonicalizeUrl("chrome://extensions"));
  assert.throws(() => canonicalizeUrl("file:///etc/passwd"));
  assert.throws(() => canonicalizeUrl("not a url"));
});

test("domainOf extracts a lowercased hostname", () => {
  assert.equal(domainOf("https://Example.com/x"), "example.com");
});

test("sourceKeyFor is deterministic and does not embed the raw URL", async () => {
  const url = "https://example.com/docs/api";
  const key1 = await sourceKeyFor(url);
  const key2 = await sourceKeyFor(url);
  assert.equal(key1, key2);
  assert.match(key1, /^[0-9a-f]{64}$/);
  assert.ok(!key1.includes("example"));
});

test("sourceKeyFor differs for different canonical URLs", async () => {
  const keyA = await sourceKeyFor("https://example.com/a");
  const keyB = await sourceKeyFor("https://example.com/b");
  assert.notEqual(keyA, keyB);
});

test("chunkPointId is a deterministic, valid-shaped UUID with no raw URL/title inside", async () => {
  const sourceKey = await sourceKeyFor("https://example.com/very-secret-title-string");
  const id1 = await chunkPointId(sourceKey, "hash123", 0);
  const id2 = await chunkPointId(sourceKey, "hash123", 0);
  const idOtherChunk = await chunkPointId(sourceKey, "hash123", 1);
  const idOtherHash = await chunkPointId(sourceKey, "hash456", 0);

  assert.equal(id1, id2);
  assert.notEqual(id1, idOtherChunk);
  assert.notEqual(id1, idOtherHash);
  assert.match(
    id1,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "must be a UUID-shaped string Qdrant accepts as a point id",
  );
  assert.ok(!id1.includes("secret"));
});
