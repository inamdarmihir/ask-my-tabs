import test from "node:test";
import assert from "node:assert/strict";
import { trimRepetition } from "../../src/lib/repetition.js";

test("cuts a loop where only a counter changes", () => {
  const text = ["Intro sentence here.", ...[45, 46, 47, 48, 49].map((n) => `${n} Language models for text classification (site.com)`)].join("\n\n");
  const r = trimRepetition(text);
  assert.equal(r.looped, true);
  assert.ok(r.text.startsWith("Intro sentence here."));
  assert.ok(r.text.split("Language models").length - 1 <= 2);
});

test("cuts a phrase repeated back to back on one line", () => {
  const r = trimRepetition("Summary. " + "the same phrase again ".repeat(6));
  assert.equal(r.looped, true);
  assert.ok(r.text.length < 60);
});

test("leaves normal text and short repeated lines alone", () => {
  const ok = "First point [1].\n\n- yes\n- yes\n- yes\n\nSecond point [2].";
  assert.deepEqual(trimRepetition(ok), { text: ok, looped: false });
});
