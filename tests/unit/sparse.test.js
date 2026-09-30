import test from "node:test";
import assert from "node:assert/strict";
import { tokenize, sparseDocVector, sparseQueryVector, tokenIndex, SPARSE_DIM, BM25 } from "../../src/lib/sparse.js";

test("tokenize lowercases and drops stopwords/short tokens", () => {
  const tokens = tokenize("The Quick Brown Fox is a fox");
  assert.deepEqual(tokens, ["quick", "brown", "fox", "fox"]);
});

test("tokenize keeps dotted/hyphenated identifiers intact", () => {
  const tokens = tokenize("Upgrade to v1.11.0 and check ECONNRESET on gpt-5.6");
  assert.ok(tokens.includes("v1.11.0"));
  assert.ok(tokens.includes("econnreset"));
  assert.ok(tokens.includes("gpt-5.6"));
});

test("sparseDocVector is deterministic for identical text", () => {
  const a = sparseDocVector("Qdrant hybrid retrieval test");
  const b = sparseDocVector("Qdrant hybrid retrieval test");
  assert.deepEqual(a, b);
});

test("sparseDocVector indices are ascending and unique", () => {
  const { indices } = sparseDocVector(
    "one two three four five six seven eight nine ten eleven twelve error 404 not found",
  );
  for (let i = 1; i < indices.length; i++) {
    assert.ok(indices[i] > indices[i - 1], "indices must be strictly ascending (unique + sorted)");
  }
});

test("BM25 term weight saturates: more occurrences help, with diminishing returns, capped at k1+1", () => {
  // dl == avgdl in every case so only tf varies.
  const w = (n) => sparseDocVector(Array(n).fill("token").join(" "), { avgdl: n }).values[0];
  assert.ok(w(2) > w(1) && w(3) > w(2));
  assert.ok(w(3) - w(2) < w(2) - w(1), "diminishing returns");
  assert.ok(w(500) < BM25.k1 + 1, "weight never exceeds k1+1");
});

test("BM25 length normalization: the same term counts for less in a longer chunk", () => {
  const short = sparseDocVector("zebra stripes").values[0];
  const long = sparseDocVector("zebra " + Array.from({ length: 300 }, (_, i) => `word${i}x`).join(" ")).values[0];
  assert.ok(short > long);
});

test("BM25 with dl = avgdl reduces to tf*(k1+1)/(tf+k1)", () => {
  const { k1 } = BM25;
  const text = Array(BM25.avgdl - 1).fill("filler").concat(["needle"]).join(" ");
  // filler is a stopword-free token; needle has tf=1 and dl = avgdl.
  const idx = sparseDocVector(text).indices;
  const needleIdx = sparseQueryVector("needle").indices[0];
  const v = sparseDocVector(text).values[idx.indexOf(needleIdx)];
  assert.ok(Math.abs(v - (1 * (k1 + 1)) / (1 + k1)) < 1e-9);
});

test("query vector weights each distinct term 1, ignoring repeats", () => {
  const q = sparseQueryVector("zebra zebra zebra stripes");
  assert.equal(q.values.length, 2);
  assert.ok(q.values.every((v) => v === 1));
});

test("stemming conflates inflections but leaves identifiers intact", () => {
  assert.deepEqual(tokenize("running runs"), ["run", "run"]);
  assert.equal(new Set(tokenize("connection connections connected")).size, 1);
  assert.ok(tokenize("v1.11.0 gpt-5.6").includes("v1.11.0"));
  assert.deepEqual(sparseQueryVector("runs").indices, sparseQueryVector("running").indices);
});

test("sparseDocVector on empty/whitespace text returns an empty vector", () => {
  assert.deepEqual(sparseDocVector(""), { indices: [], values: [] });
  assert.deepEqual(sparseDocVector("   "), { indices: [], values: [] });
});

test("tokenIndex is within the fixed hashing space and deterministic", () => {
  const idx1 = tokenIndex("hello");
  const idx2 = tokenIndex("hello");
  assert.equal(idx1, idx2);
  assert.ok(idx1 >= 0 && idx1 < SPARSE_DIM);
});

test("hash collisions (documented tradeoff) sum weights instead of overwriting", () => {
  // Find two distinct short tokens that collide in a deliberately tiny simulated space by
  // checking the real hash space for an actual collision among a bounded token set, so this
  // test exercises the real collision-merge branch rather than asserting it structurally only.
  const seen = new Map();
  let collided = null;
  for (let i = 0; i < 5000 && !collided; i++) {
    const token = `tok${i}`;
    const idx = tokenIndex(token);
    if (seen.has(idx)) {
      collided = [seen.get(idx), token];
    } else {
      seen.set(idx, token);
    }
  }
  assert.ok(collided, "expected at least one collision within 5000 probe tokens at SPARSE_DIM=2^18");
  const [tokenA, tokenB] = collided;
  const { values: valuesA } = sparseDocVector(tokenA);
  const { values: valuesCombined } = sparseDocVector(`${tokenA} ${tokenB}`);
  // Combined single-index weight must be >= either alone (summed on collision).
  assert.ok(valuesCombined[0] >= valuesA[0]);
});
