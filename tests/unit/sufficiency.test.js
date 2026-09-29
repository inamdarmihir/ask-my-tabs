// Tests for the method-agnostic sufficiency signal that replaced the old
// SUFFICIENCY_SCORE_FLOOR = 0.45 cosine-only constant (see DECISIONS.md). The point of these
// tests is specifically that the SAME function behaves sensibly across score distributions that
// look nothing alike in absolute magnitude: cosine-like ([-1, 1]), lexical-TF-like (unbounded,
// small positive floats), and RRF fusion-rank-like (unbounded, can exceed 1).
import test from "node:test";
import assert from "node:assert/strict";
import { hasDiscriminativeSignal, validateCitations, hitsPerSource } from "../../src/lib/agent.js";

test("no hits at all is never sufficient", () => {
  assert.equal(hasDiscriminativeSignal([]), false);
  assert.equal(hasDiscriminativeSignal(null), false);
});

test("cosine-like scores (0..1 range): a real top hit is sufficient", () => {
  assert.equal(hasDiscriminativeSignal([{ score: 0.6 }, { score: 0.3 }, { score: 0.1 }]), true);
});

test("cosine-like scores: a weak but non-degenerate top hit still counts (LLM judges topical fit)", () => {
  // Under the OLD code, a top score of 0.2 would have failed the 0.45 floor unconditionally.
  // The new function intentionally does not hard-fail on magnitude -- that judgment is left to
  // the LLM sufficiency check, which runs after this. This function only screens out "nothing
  // useful came back at all".
  assert.equal(hasDiscriminativeSignal([{ score: 0.2 }, { score: 0.05 }]), true);
});

test("RRF-like fusion scores (unbounded, can exceed 1): a real top hit is sufficient", () => {
  assert.equal(hasDiscriminativeSignal([{ score: 1.9 }, { score: 1.2 }, { score: 0.5 }]), true);
});

test("lexical-TF-like scores (small positive floats): a real top hit is sufficient", () => {
  assert.equal(hasDiscriminativeSignal([{ score: 3.4 }, { score: 2.1 }]), true);
});

test("degenerate signal: every hit scored identically is NOT sufficient, regardless of scale", () => {
  assert.equal(hasDiscriminativeSignal([{ score: 0.5 }, { score: 0.5 }, { score: 0.5 }]), false);
  assert.equal(hasDiscriminativeSignal([{ score: 7 }, { score: 7 }]), false);
});

test("all-zero or non-positive scores are NOT sufficient", () => {
  assert.equal(hasDiscriminativeSignal([{ score: 0 }, { score: 0 }]), false);
  assert.equal(hasDiscriminativeSignal([{ score: -0.1 }, { score: -0.2 }]), false);
});

test("a single hit with positive score is sufficient (no min/max spread needed for n=1)", () => {
  assert.equal(hasDiscriminativeSignal([{ score: 0.01 }]), true);
});

test("validateCitations accepts in-range [n] references", () => {
  const result = validateCitations("Claim one [1]. Claim two [2][3].", 3);
  assert.deepEqual(result.valid, [1, 2, 3]);
  assert.deepEqual(result.invalid, []);
  assert.equal(result.citedCount, 3);
});

test("validateCitations flags out-of-range [n] references", () => {
  const result = validateCitations("Claim [1]. Fabricated support [7].", 3);
  assert.deepEqual(result.valid, [1]);
  assert.deepEqual(result.invalid, [7]);
});

test("validateCitations handles answers with no citations at all", () => {
  const result = validateCitations("No citations here.", 5);
  assert.deepEqual(result.valid, []);
  assert.deepEqual(result.invalid, []);
  assert.equal(result.citedCount, 0);
});

test("validateCitations de-duplicates repeated references to the same index", () => {
  const result = validateCitations("[1] and again [1] and once more [1]", 2);
  assert.deepEqual(result.valid, [1]);
  assert.equal(result.citedCount, 1);
});

test("hitsPerSource lets a single source fill topK and caps many sources at 2", () => {
  assert.equal(hitsPerSource(5, 1), 5);
  assert.equal(hitsPerSource(5, 2), 3);
  assert.equal(hitsPerSource(5, 3), 2);
  assert.equal(hitsPerSource(5, 20), 2);
});

test("hitsPerSource falls back to the minimum when the source count is unknown", () => {
  assert.equal(hitsPerSource(5, null), 2);
  assert.equal(hitsPerSource(5, 0), 2);
});
