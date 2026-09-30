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

import { chunkStructured } from "../../src/lib/chunk.js";

test("chunkStructured never cuts a line and keeps items whole", () => {
  const items = Array.from({ length: 40 }, (_, i) => `${i + 1}. Headline number ${i + 1} about something (site${i}.com)\n${i * 3} points by user${i} ${i} hours ago | ${i} comments`).join("\n");
  const chunks = chunkStructured(items, { maxChars: 400 });
  assert.ok(chunks.length > 3);
  for (const c of chunks) {
    assert.ok(c.length <= 400 + 120, "chunk within budget (overlap allowed)");
    for (const line of c.split("\n")) assert.ok(items.includes(line), "no line is cut");
  }
  assert.ok(chunks.join("\n").includes("40. Headline number 40"));
});

test("chunkStructured starts a new chunk at a heading and splits an overlong line by words", () => {
  const text = `## One\n${"a ".repeat(150).trim()}\n## Two\nbody`;
  const chunks = chunkStructured(text, { maxChars: 1200, minBeforeHeading: 100 });
  assert.ok(chunks.some((c) => c.startsWith("## Two")));
  const long = chunkStructured("x ".repeat(2000).trim(), { maxChars: 500 });
  assert.ok(long.length > 1);
});

test("chunkStructured with overlapLines 0 never repeats lines across chunks", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `${i + 1}. Item ${i + 1} title (site.com)\n${i} points by u ${i} hours ago | ${i} comments`);
  const chunks = chunkStructured(lines.join("\n"), { maxChars: 320, overlapLines: 0 });
  const all = chunks.join("\n").split("\n");
  assert.equal(new Set(all).size, all.length, "no duplicated lines");
  assert.equal(all.length, 60);
});

test("chunkStructured groupItems keeps each numbered item's detail lines with its title", () => {
  const text = ["Site header", ...Array.from({ length: 12 }, (_, i) => `${i + 1}. Title ${i + 1} (x.com)\n${i} points | ${i} comments`)].join("\n");
  const chunks = chunkStructured(text, { maxChars: 120, overlapLines: 0, groupItems: true });
  let checked = 0;
  for (const c of chunks) {
    for (const m of c.matchAll(/^\d+\. Title (\d+)[^\n]*\n(\d+) points/gm)) {
      assert.equal(Number(m[2]), Number(m[1]) - 1);
      checked += 1;
    }
  }
  assert.equal(checked, 12, "every item still has its own stats line right after its title");
});
