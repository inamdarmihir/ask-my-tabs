// Shared constants between the extension runtime and the eval harness. Kept in one file so the
// eval harness can never accidentally point at (and mutate) the real library collection --
// the eval harness always builds its own isolated, versioned collection name.
//
// The Qdrant URL is intentionally NOT here -- it is user-configurable and lives in
// src/lib/config.js. Only values that are never user-settable belong in this file.
export const LIBRARY_COLLECTION_PREFIX = "ask_my_tabs_library";

// One collection per embedding model, so switching models never mixes incompatible vectors.
export function libraryCollectionName(modelKey) {
  return `${LIBRARY_COLLECTION_PREFIX}__${modelKey}`;
}
export const DEFAULT_RETRIEVAL_MODE = "hybrid";
export const DEFAULT_FRESHNESS_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, frozen in eval/PROTOCOL.md
