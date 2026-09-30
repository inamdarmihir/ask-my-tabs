// BM25 sparse representation for hybrid retrieval.
//
// Okapi BM25 scores a document d for a query q as
//     sum over query terms t of  IDF(t) * tf(t,d)*(k1+1) / ( tf(t,d) + k1*(1 - b + b*|d|/avgdl) )
// and is split here the way Qdrant's documented BM25 recipe splits it:
//   * DOCUMENT side (this file, at index time): each term's weight is the saturating,
//     length-normalized TF part above, with k1 = 1.2 and b = 0.75. `|d|` is the chunk's own
//     token count; `avgdl` is a fixed estimate (BM25.avgdl) of the mean chunk length, because a
//     stored vector cannot know the corpus average as documents come and go.
//   * QUERY side (this file): each distinct query term has weight 1.
//   * IDF (Qdrant, at query time): the collection's sparse vector is configured with
//     `modifier: "idf"` (src/lib/qdrant.js), so Qdrant multiplies each matched term by
//     ln(1 + (N - n + 0.5) / (n + 0.5)) computed from LIVE collection statistics. Inserts,
//     replacements and deletes therefore keep IDF correct with no corpus state kept here.
// The one approximation versus textbook BM25 is the fixed avgdl; everything else is exact.
//
// Text pipeline (frozen, versioned as SPARSE_ALGORITHM_VERSION so results record which revision
// produced them):
//   1. Lowercase; tokens are runs of [a-z0-9]+(?:[._:-][a-z0-9]+)* so identifiers such as
//      "v1.11.0", "ECONNRESET" or "gpt-5.6" survive as single tokens.
//   2. Drop a small English stopword list and tokens shorter than 2 characters.
//   3. Porter-stem purely alphabetic tokens ("running", "runs" -> "run"); identifiers containing
//      digits or separators are left intact.
//   4. Hash each token to a 2^18 index space with 32-bit FNV-1a. Colliding tokens have their
//      weights summed (documented, accepted lossy tradeoff of feature hashing).
// Deterministic: same text + same algorithm version always yields the same vector.

import { stemmer } from "stemmer";

export const SPARSE_ALGORITHM_VERSION = "bm25-stem-hash-v1";
export const BM25 = { k1: 1.2, b: 0.75, avgdl: 100 };
export const SPARSE_DIM = 262144; // 2^18

const TOKEN_PATTERN = /[a-z0-9]+(?:[._:-][a-z0-9]+)*/g;
const MIN_TOKEN_LEN = 2;

// Small, fixed, English-only stopword list. Deliberately short: this is a retrieval signal for
// technical documentation/changelog text, not a general-purpose NLP stopword list, so it leaves
// in words that can matter (e.g. "not", "no") and only strips the highest-frequency function
// words.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "was", "were",
  "be", "been", "being", "with", "as", "at", "by", "from", "that", "this", "it", "its", "into",
  "than", "then", "so", "such", "these", "those", "there", "their", "your", "you", "we", "our",
  "but", "if", "do", "does", "did", "have", "has", "had", "will", "would", "can", "could",
  "should", "may", "might", "must", "not", "no",
]);

export function tokenize(text) {
  const lower = String(text).toLowerCase();
  const matches = lower.match(TOKEN_PATTERN) || [];
  return matches
    .filter((t) => t.length >= MIN_TOKEN_LEN && !STOPWORDS.has(t))
    .map((t) => (/^[a-z]+$/.test(t) ? stemmer(t) : t));
}

// 32-bit FNV-1a. Fast, dependency-free, and stable across JS engines (pure integer ops).
function fnv1a32(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function tokenIndex(token) {
  return fnv1a32(token) % SPARSE_DIM;
}

function countTokens(tokens) {
  const counts = new Map();
  for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
  return counts;
}

// Merges per-token weights into { indices, values }: indices strictly ascending and unique
// (colliding tokens summed) -- the shape Qdrant's REST API expects for a sparse vector.
function toSparse(weightsByToken) {
  const merged = new Map();
  for (const [token, w] of weightsByToken) {
    const idx = tokenIndex(token);
    merged.set(idx, (merged.get(idx) || 0) + w);
  }
  const indices = Array.from(merged.keys()).sort((a, b) => a - b);
  return { indices, values: indices.map((i) => merged.get(i)) };
}

// Document-side BM25 vector for one chunk (see the header for the formula).
export function sparseDocVector(text, { k1 = BM25.k1, b = BM25.b, avgdl = BM25.avgdl } = {}) {
  const tokens = tokenize(text);
  const dl = tokens.length;
  const weights = new Map();
  for (const [token, tf] of countTokens(tokens)) {
    weights.set(token, (tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * dl) / avgdl)));
  }
  return toSparse(weights);
}

// Query-side vector: every distinct term weighs 1; Qdrant's IDF modifier supplies the rest.
export function sparseQueryVector(text) {
  const weights = new Map();
  for (const token of new Set(tokenize(text))) weights.set(token, 1);
  return toSparse(weights);
}
