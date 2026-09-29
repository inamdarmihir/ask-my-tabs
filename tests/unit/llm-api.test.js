import test from "node:test";
import assert from "node:assert/strict";
import { testApiKey, chatJSONApi } from "../../src/lib/llm-api.js";

function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = original;
  });
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("testApiKey: empty key is rejected without a network call", async () => {
  await withFetch(() => assert.fail("no request expected"), async () => {
    const r = await testApiKey({ provider: "openai", apiKey: "" });
    assert.equal(r.ok, false);
  });
});

test("testApiKey: valid OpenAI key with a listed model", async () => {
  let seen;
  await withFetch(async (url, opts) => {
    seen = { url, auth: opts.headers.Authorization };
    return json({ data: [{ id: "gpt-6-luna" }, { id: "gpt-6-sol" }] });
  }, async () => {
    const r = await testApiKey({ provider: "openai", apiKey: "sk-test", model: "gpt-6-luna" });
    assert.deepEqual([r.ok, r.message], [true, "Key works. Using gpt-6-luna."]);
  });
  assert.equal(seen.url, "https://api.openai.com/v1/models");
  assert.equal(seen.auth, "Bearer sk-test");
});

test("testApiKey: key works but model is not listed -> ok with a warning", async () => {
  await withFetch(async () => json({ data: [{ id: "gpt-6-sol" }] }), async () => {
    const r = await testApiKey({ provider: "openai", apiKey: "sk-test", model: "nope" });
    assert.equal(r.ok, true);
    assert.match(r.message, /isn't in this account's model list/);
  });
});

test("testApiKey: rejected key and network failure", async () => {
  await withFetch(async () => json({}, 401), async () => {
    assert.match((await testApiKey({ provider: "groq", apiKey: "x" })).message, /rejected/);
  });
  await withFetch(async () => { throw new TypeError("offline"); }, async () => {
    const r = await testApiKey({ provider: "groq", apiKey: "x" });
    assert.equal(r.ok, false);
    assert.match(r.message, /reach/);
  });
});

test("testApiKey: Gemini strips the models/ prefix and treats 400 as a bad key", async () => {
  await withFetch(async () => json({ models: [{ name: "models/gemini-1.5-flash" }] }), async () => {
    assert.equal((await testApiKey({ provider: "gemini", apiKey: "k", model: "gemini-1.5-flash" })).message, "Key works. Using gemini-1.5-flash.");
  });
  await withFetch(async () => json({}, 400), async () => {
    assert.equal((await testApiKey({ provider: "gemini", apiKey: "bad" })).ok, false);
  });
});

test("chat request retries once without temperature when the model rejects it", async () => {
  const bodies = [];
  await withFetch(async (_url, opts) => {
    const body = JSON.parse(opts.body);
    bodies.push(body);
    if ("temperature" in body) return new Response("Unsupported value: 'temperature' does not support 0.2", { status: 400 });
    return json({ choices: [{ message: { content: "{}" } }] });
  }, async () => {
    const out = await chatJSONApi([{ role: "user", content: "hi" }], { provider: "openai", apiKey: "k", model: "m" });
    assert.equal(out, "{}");
  });
  assert.equal(bodies.length, 2);
  assert.ok("temperature" in bodies[0]);
  assert.ok(!("temperature" in bodies[1]));
});

test("other 400 errors are not retried", async () => {
  let calls = 0;
  await withFetch(async () => { calls++; return new Response("bad model", { status: 400 }); }, async () => {
    await assert.rejects(() => chatJSONApi([{ role: "user", content: "hi" }], { provider: "openai", apiKey: "k", model: "m" }), /400/);
  });
  assert.equal(calls, 1);
});
