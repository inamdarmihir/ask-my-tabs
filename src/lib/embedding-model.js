// The one place that names the embedding model the extension ships. Changing the model, its
// precision, or its query prompt means changing this file only: the library collection name is
// derived from `key`, so vectors from a different model are never mixed into an existing
// collection (their vector spaces are incompatible even when the dimensions match).
//
// Chosen by `npm run eval` under the rule in DECISIONS.md; results in eval/RESULTS.md. The files
// are bundled in models/<id>/ (see scripts/fetch-models.js) at revision `revision`.
export const EMBEDDING_MODEL = {
  key: "leaf-ir-q8",
  id: "MongoDB/mdbr-leaf-ir",
  dtype: "q8",
  revision: "4262131b32c3182bd06e67e92ae69d7bd66e0c5c",
  dims: 384,
  // Instruction prepended to QUERIES only (never documents); see embedQuery in embeddings.js.
  queryPrefix: "Represent this sentence for searching relevant passages: ",
};
