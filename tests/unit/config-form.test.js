import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../../src/lib/config.js";
import { storageFromConfig, storagePatch, modelFromConfig, modelPatch, patchesDiffer, LOCAL_QDRANT_URL } from "../../src/ui/config-form.js";

test("default config loads as local Docker with the on-device model, and saves back unchanged", () => {
  const storage = storageFromConfig(DEFAULT_CONFIG);
  const model = modelFromConfig(DEFAULT_CONFIG);
  assert.deepEqual(storage, { mode: "local", url: "", apiKey: "" });
  assert.equal(model.type, "local");
  assert.deepEqual(storagePatch(storage), { qdrantUrl: LOCAL_QDRANT_URL, qdrantApiKey: "" });
  assert.deepEqual(modelPatch(model), { llmProvider: "webllm", llmApiKey: "", llmModel: "", llmBaseUrl: "" });
});

test("a cloud Qdrant with a key round-trips, and trims what the user typed", () => {
  const cfg = { ...DEFAULT_CONFIG, qdrantUrl: "https://abc.qdrant.io:6333", qdrantApiKey: "k" };
  const form = storageFromConfig(cfg);
  assert.equal(form.mode, "cloud");
  assert.deepEqual(storagePatch({ ...form, url: "  https://x.qdrant.io  ", apiKey: " secret " }), { qdrantUrl: "https://x.qdrant.io", qdrantApiKey: "secret" });
});

test("local Qdrant with an API key stored is treated as cloud (so the key isn't silently dropped)", () => {
  assert.equal(storageFromConfig({ ...DEFAULT_CONFIG, qdrantApiKey: "k" }).mode, "cloud");
});

test("cloud mode with an empty URL falls back to local rather than saving an empty URL", () => {
  assert.equal(storagePatch({ mode: "cloud", url: "  ", apiKey: "" }).qdrantUrl, LOCAL_QDRANT_URL);
});

test("switching to on-device clears API settings; an API provider keeps them", () => {
  const api = modelFromConfig({ ...DEFAULT_CONFIG, llmProvider: "groq", llmApiKey: "gsk", llmModel: "m", llmBaseUrl: "http://x/v1" });
  assert.deepEqual(api, { type: "api", provider: "groq", apiKey: "gsk", model: "m", baseUrl: "http://x/v1" });
  assert.deepEqual(modelPatch({ ...api, type: "local" }), { llmProvider: "webllm", llmApiKey: "", llmModel: "", llmBaseUrl: "" });
  assert.equal(modelPatch(api).llmProvider, "groq");
});

test("patchesDiffer detects edits", () => {
  const a = storagePatch({ mode: "local", url: "", apiKey: "" });
  assert.equal(patchesDiffer(a, { ...a }), false);
  assert.equal(patchesDiffer(a, { ...a, qdrantApiKey: "x" }), true);
});
