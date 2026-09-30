// Small on-device models sometimes fall into a loop, emitting the same line (often copied from a
// snippet, with only a counter changing) until the token limit. This finds that state so the
// stream can be stopped and the repeats dropped.

const normalize = (line) => line.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();

// Returns { text, looped }. A line (digits ignored) seen `maxRepeats` times marks a loop; the text
// is cut before the repeat that crossed the limit. Also catches one long line ending in a phrase
// repeated back to back.
export function trimRepetition(text, maxRepeats = 3) {
  const lines = (text || "").split("\n");
  const seen = new Map();
  for (let i = 0; i < lines.length; i++) {
    const key = normalize(lines[i]);
    if (key.length < 12) continue; // short lines ("- yes", blanks) legitimately repeat
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    if (n >= maxRepeats) {
      // Keep everything before the first repeat of this line's second occurrence.
      const kept = lines.slice(0, i);
      while (kept.length && normalize(kept[kept.length - 1]) === key) kept.pop();
      return { text: kept.join("\n").trimEnd(), looped: true };
    }
  }
  const m = (text || "").match(/(.{12,}?)\1{2,}$/s);
  if (m) return { text: text.slice(0, text.length - m[0].length + m[1].length).trimEnd(), looped: true };
  return { text, looped: false };
}
