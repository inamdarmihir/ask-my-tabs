import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { EMBEDDING_MODEL } from "../../src/lib/embedding-model.js";
import { libraryCollectionName } from "../../src/lib/constants.js";
import { DENSE_SIZE } from "../../src/lib/qdrant.js";

test("collection name is keyed by the embedding model so incompatible vectors never mix", () => {
  assert.equal(libraryCollectionName("leaf-ir-q8"), "ask_my_tabs_library__leaf-ir-q8");
  assert.notEqual(libraryCollectionName("a"), libraryCollectionName("b"));
  assert.equal(libraryCollectionName("leaf-ir-q8", "bm25-stem-hash-v1"), "ask_my_tabs_library__leaf-ir-q8__bm25-stem-hash-v1");
});

test("the configured model's output size matches the Qdrant collection schema", () => {
  assert.equal(EMBEDDING_MODEL.dims, DENSE_SIZE);
});

test("the bundled model files the extension loads are present in the repo", () => {
  const dir = new URL(`../../models/${EMBEDDING_MODEL.id}/`, import.meta.url);
  const suffix = { fp32: "", fp16: "_fp16", q8: "_quantized" }[EMBEDDING_MODEL.dtype];
  for (const f of ["config.json", "tokenizer.json", `onnx/model${suffix}.onnx`]) {
    assert.ok(existsSync(new URL(f, dir)), `missing bundled file ${f}`);
  }
  // External-data weights (the bulk of the model) must be there when the config declares them.
  const data = new URL(`onnx/model${suffix}.onnx_data`, dir);
  if (existsSync(data)) assert.ok(statSync(data).size > 1e6);
});
