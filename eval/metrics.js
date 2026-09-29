// Ranking metrics for the retrieval eval. Pure functions, unit-tested in
// tests/unit/eval-metrics.test.js. `ranked` is an ordered array of doc ids (best first, unique);
// `relevant` is a Map/Object of docId -> graded relevance (> 0 means relevant).

const relOf = (relevant, id) => (relevant instanceof Map ? relevant.get(id) : relevant[id]) || 0;
const relCount = (relevant) =>
  (relevant instanceof Map ? Array.from(relevant.values()) : Object.values(relevant)).filter((r) => r > 0).length;

export function ndcgAtK(ranked, relevant, k = 10) {
  let dcg = 0;
  ranked.slice(0, k).forEach((id, i) => {
    dcg += (2 ** relOf(relevant, id) - 1) / Math.log2(i + 2);
  });
  const ideal = (relevant instanceof Map ? Array.from(relevant.values()) : Object.values(relevant))
    .filter((r) => r > 0)
    .sort((a, b) => b - a)
    .slice(0, k);
  const idcg = ideal.reduce((sum, r, i) => sum + (2 ** r - 1) / Math.log2(i + 2), 0);
  return idcg === 0 ? 0 : dcg / idcg;
}

export function recallAtK(ranked, relevant, k = 10) {
  const total = relCount(relevant);
  if (total === 0) return 0;
  const hits = ranked.slice(0, k).filter((id) => relOf(relevant, id) > 0).length;
  return hits / total;
}

export function mrrAtK(ranked, relevant, k = 10) {
  const i = ranked.slice(0, k).findIndex((id) => relOf(relevant, id) > 0);
  return i === -1 ? 0 : 1 / (i + 1);
}

export function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

// Collapses chunk-level hits (already score-sorted, best first) into a unique doc ranking: a
// document is ranked by its best chunk.
export function docRanking(hits, docIdOf) {
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    const id = docIdOf(h);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// Applies the pre-registered selection rule from DECISIONS.md. `results` is an array of
// { key, sizeMB, hybrid: { ndcg }, dense: { ndcg } }. Returns { chosen, eligible, excluded, best }.
export function selectConfig(results, { tolerance = 0.01, brokenDenseRatio = 0.5 } = {}) {
  const bestDense = Math.max(...results.map((r) => r.dense.ndcg));
  const excluded = results.filter((r) => r.dense.ndcg < brokenDenseRatio * bestDense);
  const valid = results.filter((r) => !excluded.includes(r));
  const best = valid.reduce((a, b) => (b.hybrid.ndcg > a.hybrid.ndcg ? b : a));
  const eligible = valid.filter((r) => r.hybrid.ndcg >= best.hybrid.ndcg - tolerance);
  eligible.sort((a, b) => a.sizeMB - b.sizeMB || b.hybrid.ndcg - a.hybrid.ndcg);
  return { chosen: eligible[0], eligible, excluded, best };
}
