import test from "node:test";
import assert from "node:assert/strict";
import { citationStatus, recencyDecayFactor, applyFreshnessBoost, checkLiveFreshness } from "../../src/lib/freshness.js";

test("citationStatus defaults to archived when no live check has run", () => {
  assert.equal(citationStatus({ hasNewerSnapshot: false, liveCheck: null }), "archived");
});

test("citationStatus is superseded when a newer snapshot is known to exist", () => {
  assert.equal(citationStatus({ hasNewerSnapshot: true, liveCheck: null }), "superseded");
});

test("citationStatus reflects a live check's match/mismatch", () => {
  assert.equal(
    citationStatus({ hasNewerSnapshot: false, liveCheck: { checked: true, matches: true } }),
    "confirmed-current",
  );
  assert.equal(
    citationStatus({ hasNewerSnapshot: false, liveCheck: { checked: true, matches: false } }),
    "superseded",
  );
});

test("recencyDecayFactor is 1.0 at age zero and 0.5 at exactly one half-life", () => {
  const now = 1_000_000;
  const halfLife = 1000;
  assert.equal(recencyDecayFactor(now, now, halfLife), 1);
  assert.ok(Math.abs(recencyDecayFactor(now - halfLife, now, halfLife) - 0.5) < 1e-9);
});

test("recencyDecayFactor never exceeds 1 even for a future/clock-skewed indexedAt", () => {
  const now = 1000;
  assert.equal(recencyDecayFactor(5000, now, 100), 1);
});

test("applyFreshnessBoost re-sorts by boosted score and exposes the raw score/decay used", () => {
  const now = 1_000_000;
  const halfLifeMs = 1000;
  const hits = [
    { id: "old-but-relevant", score: 10, payload: { indexedAt: now - 10 * halfLifeMs } }, // decays hard
    { id: "new-but-weak", score: 1, payload: { indexedAt: now } }, // no decay
  ];
  const boosted = applyFreshnessBoost(hits, { now, halfLifeMs });
  assert.equal(boosted[0].id, "new-but-weak", "freshness boost can flip ranking -- that's the documented tradeoff");
  assert.equal(boosted[0].score, 1, "original score must remain visible, not overwritten");
  assert.ok(boosted[1].freshnessDecay < 0.01, "decay factor for the old hit must be reported, not hidden");
});

test("checkLiveFreshness reports a match when hashes agree", async () => {
  const fakeHash = async (t) => `hash(${t})`;
  const res = await checkLiveFreshness({ storedContentHash: "hash(same text)", currentText: "same text", hashText: fakeHash });
  assert.equal(res.checked, true);
  assert.equal(res.matches, true);
});

test("checkLiveFreshness reports a mismatch when content changed", async () => {
  const fakeHash = async (t) => `hash(${t})`;
  const res = await checkLiveFreshness({ storedContentHash: "hash(old text)", currentText: "new text", hashText: fakeHash });
  assert.equal(res.matches, false);
});
