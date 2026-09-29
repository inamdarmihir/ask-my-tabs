import test from "node:test";
import assert from "node:assert/strict";
import { chunkText, hashText } from "../../src/lib/chunk.js";

test("chunkText splits into overlapping word windows", () => {
  const words = Array.from({ length: 400 }, (_, i) => `w${i}`).join(" ");
  const chunks = chunkText(words, { chunkWords: 180, overlapWords: 30 });
  assert.ok(chunks.length >= 2);
  const firstWords = chunks[0].split(" ");
  assert.equal(firstWords.length, 180);
  // overlap: last 30 words of chunk 0 should reappear at the start of chunk 1
  const overlapFromFirst = firstWords.slice(-30).join(" ");
  assert.ok(chunks[1].startsWith(overlapFromFirst));
});

test("chunkText returns empty array for empty/whitespace text", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("   \n  "), []);
});

test("chunkText never drops the final short chunk", () => {
  const words = Array.from({ length: 190 }, (_, i) => `w${i}`).join(" ");
  const chunks = chunkText(words, { chunkWords: 180, overlapWords: 30 });
  const allWordsCovered = chunks.join(" ").includes("w189");
  assert.ok(allWordsCovered);
});

test("hashText is deterministic and content-sensitive", async () => {
  const h1 = await hashText("hello world");
  const h2 = await hashText("hello world");
  const h3 = await hashText("hello world!");
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.match(h1, /^[0-9a-f]{64}$/);
});
