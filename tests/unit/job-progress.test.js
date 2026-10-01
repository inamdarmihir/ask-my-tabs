import test from "node:test";
import assert from "node:assert/strict";
import { jobPercent, stageIndex, jobDetail } from "../../src/ui/job.js";

const job = (over) => ({ running: true, total: 4, done: 0, current: null, ...over });

test("overall percent advances through pages and within a page", () => {
  assert.equal(jobPercent(job({ done: 0, current: { stage: "reading" } })), 1);
  assert.equal(jobPercent(job({ done: 1, current: { stage: "reading" } })), 26);
  // half the chunks of page 3 embedded: (2 + 0.1 + 0.85*0.5) / 4
  assert.equal(jobPercent(job({ done: 2, current: { stage: "embedding", done: 5, total: 10 } })), 63);
  assert.equal(jobPercent(job({ done: 3, current: { stage: "saving" } })), 99);
});

test("percent never passes 100 and handles an empty or missing job", () => {
  assert.equal(jobPercent(job({ done: 4, current: null })), 100);
  assert.equal(jobPercent(job({ done: 4, current: { stage: "saving" } })), 100);
  assert.equal(jobPercent(null), 0);
  assert.equal(jobPercent(job({ total: 0 })), 0);
});

test("embedding with an unknown chunk count does not divide by zero", () => {
  assert.equal(jobPercent(job({ done: 0, current: { stage: "embedding", done: 0, total: 0 } })), 1);
});

test("stage index and detail text follow the current stage", () => {
  assert.equal(stageIndex(job({ current: { stage: "embedding" } })), 1);
  assert.equal(stageIndex(job({ current: { stage: "saving" } })), 2);
  assert.equal(stageIndex(job({ current: null })), 0);
  assert.equal(jobDetail(job({ current: { stage: "embedding", done: 3, total: 9 } })), "Embedding chunk 3 of 9");
  assert.equal(jobDetail(job({ current: null })), "Starting...");
});
