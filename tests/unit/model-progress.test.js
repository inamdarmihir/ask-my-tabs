import test from "node:test";
import assert from "node:assert/strict";
import { normalizeProgress } from "../../src/lib/model-progress.js";

test("WebLLM download text becomes a download phase with percent and MB", () => {
  const r = normalizeProgress("language", {
    progress: 0.16,
    text: "Fetching param cache[5/30]: 240MB fetched. 16% completed, 12 secs elapsed. It can take a while.",
  });
  assert.deepEqual(r, { pct: 16, phase: "download", mb: 240, detail: "Downloading language model... 16%" });
});

test("WebLLM cache-to-GPU load is a separate phase", () => {
  const r = normalizeProgress("language", { progress: 0.5, text: "Loading model from cache[15/30]: 120MB loaded. 50% completed, 3 secs elapsed." });
  assert.equal(r.phase, "load");
  assert.equal(r.pct, 50);
  assert.equal(r.detail, "Loading language model... 50%");
});

test("WebLLM events with no usable percentage keep their text and report no percent", () => {
  assert.deepEqual(normalizeProgress("language", { progress: 0, text: "Start to fetch params" }), { pct: null, phase: "download", mb: null, detail: "Start to fetch params" });
  assert.equal(normalizeProgress("language", { progress: 1, text: "Finish loading on WebGPU - webgpu" }).pct, null);
});

test("transformers.js file progress reports percent and megabytes from bytes", () => {
  const r = normalizeProgress("embedding", { status: "progress", file: "model.onnx", progress: 41.6, loaded: 12_500_000, total: 30_000_000 });
  assert.deepEqual(r, { pct: 42, phase: "download", mb: 12.5, detail: "Downloading embedding model... 42%" });
});

test("transformers.js lifecycle events and empty input are ignored; strings pass through", () => {
  assert.equal(normalizeProgress("embedding", { status: "initiate", file: "x" }), null);
  assert.equal(normalizeProgress("embedding", { status: "done", file: "x" }), null);
  assert.equal(normalizeProgress("embedding", null), null);
  assert.deepEqual(normalizeProgress("x", "Loading..."), { pct: null, phase: "init", mb: null, detail: "Loading..." });
});

test("transformers.js percent is clamped to 0-100", () => {
  assert.equal(normalizeProgress("e", { status: "progress", progress: 140 }).pct, 100);
  assert.equal(normalizeProgress("e", { status: "progress", progress: -5 }).pct, 0);
});
