// "Read mode": for summaries and overviews, similarity search is the wrong tool. Nothing in
// "summarize the best AI news" resembles any one chunk, so top-k returns a few arbitrary pieces.
// Instead the agent reads the page(s) in order, within a character budget, like a person would.

// Keeps only each source's most recent snapshot (a failed cleanup can leave old chunks behind).
export function latestSnapshot(points) {
  const newest = new Map(); // sourceKey -> { indexedAt, contentHash }
  for (const p of points) {
    const cur = newest.get(p.payload.sourceKey);
    if (!cur || p.payload.indexedAt > cur.indexedAt) newest.set(p.payload.sourceKey, { indexedAt: p.payload.indexedAt, contentHash: p.payload.contentHash });
  }
  return points.filter((p) => newest.get(p.payload.sourceKey).contentHash === p.payload.contentHash);
}

// Returns hits (same shape retrieve() produces) in reading order. The budget is split evenly
// across sources so one long page can't crowd out the others; each source contributes its chunks
// from the top of the page until its share runs out.
export function selectReadingChunks(points, budgetChars) {
  const bySource = new Map();
  for (const p of latestSnapshot(points)) {
    if (!bySource.has(p.payload.sourceKey)) bySource.set(p.payload.sourceKey, []);
    bySource.get(p.payload.sourceKey).push(p);
  }
  if (bySource.size === 0) return [];
  const share = Math.floor(budgetChars / bySource.size);
  const hits = [];
  for (const chunks of bySource.values()) {
    chunks.sort((a, b) => a.payload.chunkIndex - b.payload.chunkIndex);
    let used = 0;
    for (const c of chunks) {
      const len = c.payload.text.length;
      if (used > 0 && used + len > share) break; // always take at least the first chunk
      used += len;
      hits.push({
        id: c.id,
        score: 1,
        tabTitle: c.payload.title,
        tabUrl: c.payload.canonicalUrl,
        text: c.payload.text,
        sourceKey: c.payload.sourceKey,
        domain: c.payload.domain,
        indexedAt: c.payload.indexedAt,
        contentHash: c.payload.contentHash,
        chunkIndex: c.payload.chunkIndex,
        payload: c.payload,
      });
    }
  }
  return hits;
}

const COMMON =
  "Ground every claim in the numbered snippets and cite them inline like [1] or [2]. Cite only " +
  "with the snippet's own label; numbers INSIDE snippet text (rankings, item numbers, points, " +
  "comment counts) are page content, not citations. Write in your own words: never paste or list " +
  "snippet text line by line, never list bare URLs, never repeat yourself. If the snippets don't " +
  "contain what was asked, say exactly what is missing instead of guessing. ";

const BY_INTENT = {
  summarize:
    "You are a sharp research assistant. The snippets are what the user is looking at (\"the page\", " +
    '"this page" mean them). Synthesize, do not enumerate. Format: one plain sentence saying what ' +
    "the page is, then 3-6 bullets grouped by theme. Each bullet: a bold 2-5 word label, then what " +
    "it says and why it matters, with citations. If the page is a feed or list of links (headlines, " +
    "points, comments), decide which items best fit the user's request, rank them, and explain each " +
    "in a sentence; skip the rest. Finish with a one-line takeaway. ",
  compare:
    "You are a careful analyst comparing sources. Give a one-sentence verdict first, then one short " +
    "bullet group per thing compared, then a line on the key difference. ",
  lookup:
    "You are a precise research assistant. Answer directly in the first sentence, then add only the " +
    "supporting detail that matters, as short paragraphs or bullets. ",
};

export function answerSystemPrompt(intent, count, untrustedNotice) {
  return `${BY_INTENT[intent] || BY_INTENT.lookup}${COMMON}Valid citations are [1] to [${count}]. ${untrustedNotice}`;
}

export function historyMessages(history, maxTurns = 3, maxAnswerChars = 600) {
  return (history || []).slice(-maxTurns).flatMap((h) => [
    { role: "user", content: h.q },
    { role: "assistant", content: h.a.length > maxAnswerChars ? `${h.a.slice(0, maxAnswerChars)}...` : h.a },
  ]);
}
