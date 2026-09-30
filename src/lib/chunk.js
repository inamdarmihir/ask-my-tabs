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

// Structure-aware chunking for text that keeps its line breaks (see extractPageText): whole lines
// are packed into chunks of about `maxChars`, never cutting a line (a headline and its points stay
// together), a "## " heading starts a fresh chunk once the current one has some substance, and the
// last `overlapLines` lines repeat at the start of the next chunk for continuity. A single line
// longer than maxChars is split by words.
export function chunkStructured(text, { maxChars = 1200, overlapLines = 2, minBeforeHeading = 400, groupItems = false } = {}) {
  // groupItems: numbered list entries ("12. Title", then its detail lines) become one indivisible
  // unit, so a headline is never separated from its points and comment count.
  let source = text.split("\n");
  if (groupItems) {
    const grouped = [];
    for (const raw of source) {
      const line = raw.trim();
      if (!line) continue;
      if (/^\d{1,3}\.\s/.test(line) || grouped.length === 0) grouped.push(line);
      else grouped[grouped.length - 1] += `\n${line}`;
    }
    source = grouped;
  }
  const lines = [];
  for (const raw of source) {
    const line = raw.trim();
    if (!line) continue;
    if (line.length <= maxChars) lines.push(line);
    else lines.push(...chunkText(line, { chunkWords: 150, overlapWords: 0 }));
  }
  const chunks = [];
  let cur = [];
  let size = 0;
  const flush = () => {
    if (cur.length) chunks.push(cur.join("\n"));
  };
  for (const line of lines) {
    const isHeading = line.startsWith("## ");
    if (cur.length && (size + line.length + 1 > maxChars || (isHeading && size >= minBeforeHeading))) {
      flush();
      const carry = isHeading || overlapLines <= 0 ? [] : cur.slice(-overlapLines); // slice(-0) would copy everything
      cur = carry;
      size = carry.reduce((n, l) => n + l.length + 1, 0);
    }
    cur.push(line);
    size += line.length + 1;
  }
  // Skip a trailing chunk that is nothing but the overlap already emitted.
  if (cur.length && (chunks.length === 0 || cur.some((l) => !chunks[chunks.length - 1].includes(l)))) flush();
  return chunks;
}

// Cheap, dependency-free hash used to detect whether a tab's content changed since it was
// last indexed, so re-adding an unchanged tab is a no-op instead of a re-embed.
export async function hashText(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
