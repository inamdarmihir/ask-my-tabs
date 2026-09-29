// Freshness handling, kept deliberately separate from retrieval relevance (see DECISIONS.md and
// eval/PROTOCOL.md for why they're evaluated as two different hypotheses, not one).
//
// Three distinct things live here, and they are NOT the same thing:
//   1. `citationStatus` -- what a citation should say about the snapshot it points to, using
//      only information we actually have (never inferring "still accurate" without a live check).
//   2. `recencyDecayFactor` / `applyFreshnessBoost` -- an explicit, off-by-default *experimental*
//      ranking variant that biases toward recently-indexed chunks. This changes RANKING, so any
//      report using it must show what it pushed down, per the product spec's "never let a
//      recency boost hide an otherwise relevant source without reporting the tradeoff."
//   3. `checkLiveFreshness` -- a bounded, explicit, user-triggered re-check against a tab that is
//      STILL OPEN with a MATCHING URL right now. It never runs on a schedule, never claims to
//      check a closed tab or a tab Chrome doesn't have permission to read, and only ever compares
//      a fresh content hash against the stored one -- it does not re-index automatically.

// A citation always carries a status describing what we actually know, not what's likely true:
//   - "archived": indexed snapshot exists; no live check has been attempted (the default -- a
//     closed tab, or an open tab nobody asked to re-check, is "archived", not "stale". The
//     product spec is explicit that a closed tab must not be presented as known-stale).
//   - "confirmed-current": a live check was run and the current page's content hash matches the
//     stored snapshot's hash.
//   - "superseded": a live check (or a later re-index of the same source) found a DIFFERENT
//     content hash for this canonical URL -- the cited snapshot is known to no longer match the
//     live page.
export function citationStatus({ hasNewerSnapshot, liveCheck }) {
  if (hasNewerSnapshot) return "superseded";
  if (liveCheck && liveCheck.checked) {
    return liveCheck.matches ? "confirmed-current" : "superseded";
  }
  return "archived";
}

// Exponential half-life decay on indexedAt. Pure function, no clock reads inside, so it's
// testable and reproducible: given the same (indexedAt, now, halfLifeMs) triple it always
// returns the same factor. Default half-life (30 days) is a parameter frozen in
// eval/PROTOCOL.md before results are looked at, not tuned after seeing outcomes.
export function recencyDecayFactor(indexedAt, now, halfLifeMs) {
  const ageMs = Math.max(0, now - indexedAt);
  return Math.pow(0.5, ageMs / halfLifeMs);
}

// Applies the decay factor as a multiplier on top of whatever retrieval score the hit already
// has (cosine, sparse TF score, or RRF fusion score -- decay is scale-relative, not
// scale-absolute, so it composes with any of them without reintroducing a magic-number floor).
// Returns hits re-sorted by the boosted score, but every hit keeps `score` (original) and
// `freshnessDecay` (the factor actually applied) visible, so a report can show exactly what
// freshness boosting changed rather than hiding it.
export function applyFreshnessBoost(hits, { now = Date.now(), halfLifeMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
  return hits
    .map((h) => {
      const freshnessDecay = recencyDecayFactor(h.payload?.indexedAt ?? now, now, halfLifeMs);
      return { ...h, freshnessDecay, boostedScore: h.score * freshnessDecay };
    })
    .sort((a, b) => b.boostedScore - a.boostedScore);
}

// Bounded live freshness check. Only usable for a source that is currently open in a tab whose
// URL still canonicalizes to the same source -- never claims to reach a closed tab, a
// navigated-away tab, or a page outside host permissions. Caller (background.js) is responsible
// for verifying the tab is still open and its URL still matches before invoking this; this
// function itself just does the hash comparison so it's testable without chrome.* mocks.
export async function checkLiveFreshness({ storedContentHash, currentText, hashText }) {
  const currentHash = await hashText(currentText);
  return { checked: true, matches: currentHash === storedContentHash, currentHash };
}
