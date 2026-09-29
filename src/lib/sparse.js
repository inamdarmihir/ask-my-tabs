// Deterministic lexical sparse representation for hybrid retrieval.
//
// IMPORTANT NAMING NOTE (read before renaming anything in here): this is NOT BM25. BM25 requires
// corpus-wide document-frequency statistics, average document length, and specific k1/b
// weighting that update correctly as documents are added/changed/removed. None of that is
// implemented here -- there is no corpus-level state at all, which is exactly what makes this
// representation trivial to keep correct under this project's insert/replace/delete lifecycle.
// This is a per-chunk, hashed, log-dampened TERM-FREQUENCY sparse vector. Call it that
// ("lexical TF sparse vector") everywhere -- in code, in the eval report, in the README.
//
// Algorithm, frozen and versioned as SPARSE_ALGORITHM_VERSION so eval runs can record exactly
// which revision produced a given result:
//   1. Tokenize: lowercase the text, then extract runs matching
//        [a-z0-9]+(?:[._-:][a-z0-9]+)*
//      This keeps things like "v1.11.0", "ECONNRESET" -> "econnreset", "gpt-5.6", "3.11.2"
//      intact as single tokens instead of shattering them into digits -- which matters directly
//      for the eval's "exact identifier/error/version" question category. Plain words tokenize
//      the same way a naive \w+ split would.
//   2. Drop tokens in a small fixed English stopword list (see STOPWORDS) AND drop any token
//      shorter than MIN_TOKEN_LEN (2), to keep single letters/punctuation noise out.
//   3. Count raw term frequency per surviving token within the chunk.
//   4. Weight with sublinear log dampening: weight = 1 + log(count). This avoids one repeated
//      common word dominating a chunk's vector, without claiming any corpus-level IDF signal.
//   5. Hash each token to a fixed-size index space with 32-bit FNV-1a mod SPARSE_DIM
//      (SPARSE_DIM = 2^18 = 262144). This is the standard "hashing trick": if two different
//      tokens collide on the same index (expected to be rare at this project's corpus size --
//      a few thousand distinct tokens into a 262144-slot space), their weights are summed at
//      that index rather than one silently overwriting the other. Collisions are not detected
//      or reported per-query; this is a known, accepted, documented lossy tradeoff of feature
//      hashing, not a claim of collision-free indexing.
//   6. Return { indices, values } with indices sorted ascending and de-duplicated (post-collision
//      merge) -- the shape Qdrant's REST API expects for a sparse vector.
//
// Deterministic: same text + same algorithm version always produces the same vector. No corpus
// state, no randomness, no dependency on insertion order.

export const SPARSE_ALGORITHM_VERSION = "lexical-tf-hash-v1";
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
  return matches.filter((t) => t.length >= MIN_TOKEN_LEN && !STOPWORDS.has(t));
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

// Builds the sparse vector for one chunk of text. Returns { indices, values }, both arrays,
// indices strictly ascending and unique -- ready to hand to Qdrant as a sparse vector.
export function sparseVector(text) {
  const tokens = tokenize(text);
  const counts = new Map(); // token -> raw count
  for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);

  const weighted = new Map(); // index -> summed weight (collision-merged)
  for (const [token, count] of counts) {
    const idx = tokenIndex(token);
    const weight = 1 + Math.log(count);
    weighted.set(idx, (weighted.get(idx) || 0) + weight);
  }

  const indices = Array.from(weighted.keys()).sort((a, b) => a - b);
  const values = indices.map((i) => weighted.get(i));
  return { indices, values };
}
