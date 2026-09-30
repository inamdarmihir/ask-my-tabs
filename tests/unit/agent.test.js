import test from "node:test";
import assert from "node:assert/strict";
import { answerQuestion } from "../../src/lib/agent.js";
import { startTimer } from "../../src/lib/timing.js";

// Minimal fakes: a Qdrant client returning canned hits, an LLM that records what it was asked, and
// an embedder. The point is agent orchestration (when planning runs, whether searches overlap),
// not retrieval quality -- that is covered by the integration tests and the eval harness.
function hit(id, sourceKey, score, title = sourceKey) {
  return {
    id,
    score,
    payload: { title, canonicalUrl: `https://x/${sourceKey}`, text: `text ${id}`, sourceKey, domain: "x", indexedAt: 1, contentHash: "h", chunkIndex: 0 },
  };
}

function harness({ queryDelayMs = 0, planned = ["alpha", "beta"] } = {}) {
  const calls = { chatJSON: [], queries: 0, concurrent: 0, maxConcurrent: 0 };
  const client = {
    async query() {
      calls.queries += 1;
      calls.concurrent += 1;
      calls.maxConcurrent = Math.max(calls.maxConcurrent, calls.concurrent);
      await new Promise((r) => setTimeout(r, queryDelayMs));
      calls.concurrent -= 1;
      return [hit(`p${calls.queries}`, `s${calls.queries}`, 1 / calls.queries), hit(`q${calls.queries}`, `s${calls.queries}`, 0.5 / calls.queries)];
    },
  };
  const chatJSON = async (messages) => {
    calls.chatJSON.push(messages[0].content.slice(0, 30));
    return messages[0].content.startsWith("You plan")
      ? JSON.stringify({ queries: planned })
      : JSON.stringify({ sufficient: true });
  };
  const chatStream = async (_m, onToken) => {
    onToken("Answer [1].", "Answer [1].");
    return "Answer [1].";
  };
  const embed = async (texts) => texts.map(() => new Float32Array(4));
  return { calls, args: { client, collection: "c", tabTitles: ["A", "B"], embed, chatJSON, chatStream } };
}

const noop = () => {};

test("single-source scope skips the planning LLM call and searches the question directly", async () => {
  const { calls, args } = harness();
  const res = await answerQuestion("what is alpha?", { ...args, sourceCount: 1 }, noop, noop);
  assert.equal(calls.chatJSON.some((c) => c.startsWith("You plan")), false);
  assert.equal(calls.queries, 1);
  assert.equal(res.timings.queries, 1);
  assert.ok(!("plan" in res.timings.stages));
});

test("multi-source scope plans queries and searches them concurrently", async () => {
  const { calls, args } = harness({ queryDelayMs: 20 });
  const res = await answerQuestion("compare alpha and beta", { ...args, sourceCount: 2 }, noop, noop);
  assert.equal(calls.chatJSON.filter((c) => c.startsWith("You plan")).length, 1);
  assert.equal(calls.queries, 2);
  assert.equal(calls.maxConcurrent, 2, "planned queries should overlap");
  assert.ok("plan" in res.timings.stages && "retrieve" in res.timings.stages && "generate" in res.timings.stages);
  assert.equal(res.timings.queries, 2);
  assert.ok(res.citations.length > 0);
});

test("a simple question skips planning and never makes a sufficiency call", async () => {
  const { calls, args } = harness();
  await answerQuestion("how does caching work", { ...args, sourceCount: null }, noop, noop);
  assert.equal(calls.chatJSON.length, 0);
  assert.equal(calls.queries, 1);
});

test("library scope still plans a comparative question", async () => {
  const { calls, args } = harness();
  await answerQuestion("alpha vs beta", { ...args, sourceCount: null }, noop, noop);
  assert.equal(calls.chatJSON.filter((c) => c.startsWith("You plan")).length, 1);
});

test("startTimer accumulates repeated stages and reports rounded ms", async () => {
  let t = 0;
  const timer = startTimer(() => t);
  await timer.time("a", async () => { t += 10.4; });
  await timer.time("a", async () => { t += 5; });
  await timer.time("b", async () => { t += 1; });
  assert.deepEqual(timer.summary(), { totalMs: 16, stages: { a: 15, b: 1 } });
});
