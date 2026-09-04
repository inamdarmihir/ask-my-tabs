// Splits page text into overlapping chunks small enough to embed well and to hand to the
// LLM as retrieved context. Word-based, not character-based, so chunk sizes stay meaningful
// across languages that don't tokenize the way English does.

export function chunkText(text, { chunkWords = 180, overlapWords = 30 } = {}) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const chunks = [];
  let start = 0;
  while (start < words.length) {
    const end = Math.min(start + chunkWords, words.length);
    chunks.push(words.slice(start, end).join(" "));
    if (end === words.length) break;
    start = end - overlapWords;
  }
  return chunks;
}

// Cheap, dependency-free hash used to detect whether a tab's content changed since it was
// last indexed, so re-adding an unchanged tab is a no-op instead of a re-embed.
export async function hashText(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
