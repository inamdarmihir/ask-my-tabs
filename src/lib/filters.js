// Builds a Qdrant filter object for a retrieval/library-scoping request. Used identically by
// the extension's ASK path and by the eval harness, so "same filter shape for every variant" is
// enforced by sharing this function rather than by convention.

export function buildScopeFilter({ sourceKeys, domain, indexedAfter, indexedBefore, corpusMode } = {}) {
  const must = [];
  if (sourceKeys && sourceKeys.length > 0) {
    must.push({ key: "sourceKey", match: { any: sourceKeys } });
  }
  if (domain) {
    must.push({ key: "domain", match: { value: domain } });
  }
  if (indexedAfter || indexedBefore) {
    const range = {};
    if (indexedAfter) range.gte = indexedAfter;
    if (indexedBefore) range.lte = indexedBefore;
    must.push({ key: "indexedAt", range });
  }
  if (corpusMode) {
    must.push({ key: "corpusMode", match: { value: corpusMode } });
  }
  return must.length > 0 ? { must } : undefined;
}
