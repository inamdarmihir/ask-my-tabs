import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Offscreen documents have no chrome.storage, so lib/config.js's getConfig() silently returns the
// built-in defaults there. That once made the user's API key, provider and Qdrant URL be ignored
// for answering. The offscreen entry must get settings from the background worker instead.
test("offscreen.js reads settings from the background, never via lib/config getConfig", () => {
  const src = readFileSync(new URL("../../src/offscreen.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /import\s*\{[^}]*\bgetConfig\b[^}]*\}\s*from\s*"\.\/lib\/config\.js"/);
  assert.match(src, /type:\s*"GET_CONFIG"/);
  const bg = readFileSync(new URL("../../src/background.js", import.meta.url), "utf8");
  assert.match(bg, /message\.type === "GET_CONFIG"/);
});
