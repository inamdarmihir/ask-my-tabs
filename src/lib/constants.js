// Shared constants between the extension runtime and the eval harness. Kept in one file so the
// eval harness can never accidentally point at (and mutate) the real library collection --
// eval/run-eval.js always builds its own isolated, versioned collection name and never imports
// LIBRARY_COLLECTION for writes.

export const QDRANT_URL = "http://127.0.0.1:6333";
export const LIBRARY_COLLECTION = "ask_my_tabs_library";
export const DEFAULT_RETRIEVAL_MODE = "hybrid";
export const DEFAULT_FRESHNESS_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, frozen in eval/PROTOCOL.md
