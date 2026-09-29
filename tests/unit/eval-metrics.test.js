import test from "node:test";
import assert from "node:assert/strict";
import { ndcgAtK, recallAtK, mrrAtK, docRanking, selectConfig } from "../../eval/metrics.js";

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !~ ${b}`);

test("nDCG is 1 for a perfect ranking and 0 when nothing relevant is retrieved", () => {
  const rel = { a: 1, b: 1 };
  close(ndcgAtK(["a", "b", "x"], rel), 1);
  close(ndcgAtK(["x", "y", "z"], rel), 0);
});

test("nDCG discounts a relevant doc that appears lower", () => {
  const rel = { a: 1 };
  close(ndcgAtK(["a"], rel), 1);
  close(ndcgAtK(["x", "a"], rel), 1 / Math.log2(3));
});

test("nDCG only looks at the top k", () => {
  const rel = { a: 1 };
  close(ndcgAtK(["x", "x2", "a"], rel, 2), 0);
});

test("recall@k counts relevant docs found over all relevant docs", () => {
  const rel = { a: 1, b: 1, c: 1, d: 1 };
  close(recallAtK(["a", "x", "b"], rel, 10), 0.5);
  close(recallAtK(["a", "x", "b"], rel, 1), 0.25);
  close(recallAtK(["a"], {}, 10), 0);
});

test("MRR uses the rank of the first relevant doc", () => {
  close(mrrAtK(["x", "y", "a"], { a: 1 }), 1 / 3);
  close(mrrAtK(["x"], { a: 1 }), 0);
});

test("docRanking keeps each document once, at its best chunk's position", () => {
  const hits = [{ d: "a" }, { d: "b" }, { d: "a" }, { d: "c" }];
  assert.deepEqual(docRanking(hits, (h) => h.d), ["a", "b", "c"]);
});

test("selectConfig picks the smallest config within tolerance of the best hybrid nDCG", () => {
  const r = (key, sizeMB, hybrid, dense) => ({ key, sizeMB, hybrid: { ndcg: hybrid }, dense: { ndcg: dense } });
  const results = [r("big-best", 67, 0.70, 0.66), r("small-close", 23, 0.695, 0.65), r("smaller-too-low", 20, 0.60, 0.55)];
  assert.equal(selectConfig(results).chosen.key, "small-close");
});

test("selectConfig excludes an implausibly weak dense score as a broken export", () => {
  const r = (key, sizeMB, hybrid, dense) => ({ key, sizeMB, hybrid: { ndcg: hybrid }, dense: { ndcg: dense } });
  const results = [r("good", 67, 0.70, 0.66), r("broken-but-hybrid-ok", 10, 0.69, 0.10)];
  const sel = selectConfig(results);
  assert.equal(sel.chosen.key, "good");
  assert.deepEqual(sel.excluded.map((x) => x.key), ["broken-but-hybrid-ok"]);
});
