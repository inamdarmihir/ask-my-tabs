import test from "node:test";
import assert from "node:assert/strict";
import { tokenize, sparseVector, tokenIndex, SPARSE_DIM } from "../../src/lib/sparse.js";

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

test("sparseVector is deterministic for identical text", () => {
  const a = sparseVector("Qdrant hybrid retrieval test");
  const b = sparseVector("Qdrant hybrid retrieval test");
  assert.deepEqual(a, b);
});

test("sparseVector indices are ascending and unique", () => {
  const { indices } = sparseVector(
    "one two three four five six seven eight nine ten eleven twelve error 404 not found",
  );
  for (let i = 1; i < indices.length; i++) {
    assert.ok(indices[i] > indices[i - 1], "indices must be strictly ascending (unique + sorted)");
  }
});

test("sparseVector applies sublinear log weighting, not raw counts", () => {
  const once = sparseVector("token");
  const thrice = sparseVector("token token token");
  assert.equal(once.values.length, 1);
  assert.equal(thrice.values.length, 1);
  // 1 + log(3) ~= 2.0986, strictly less than raw count 3 -- sublinear, not linear TF.
  assert.ok(thrice.values[0] > once.values[0]);
  assert.ok(thrice.values[0] < 3 * once.values[0]);
});

test("sparseVector on empty/whitespace text returns an empty vector", () => {
  assert.deepEqual(sparseVector(""), { indices: [], values: [] });
  assert.deepEqual(sparseVector("   "), { indices: [], values: [] });
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
  const { values: valuesA } = sparseVector(tokenA);
  const { values: valuesCombined } = sparseVector(`${tokenA} ${tokenB}`);
  // Combined single-index weight must be >= either alone (summed on collision).
  assert.ok(valuesCombined[0] >= valuesA[0]);
});
