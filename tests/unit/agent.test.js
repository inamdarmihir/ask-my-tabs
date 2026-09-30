import test from "node:test";
import assert from "node:assert/strict";
import { answerQuestion, stripThinking, isOverviewQuestion } from "../../src/lib/agent.js";
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

test("stripThinking removes empty and unfinished think blocks", () => {
  assert.equal(stripThinking("<think>\n\n</think>\n\nHello [1]"), "Hello [1]");
  assert.equal(stripThinking("<think>\nstill going"), "");
  assert.equal(stripThinking("plain"), "plain");
});

test("overview questions also search by source titles", async () => {
  assert.equal(isOverviewQuestion("Tell me about the page, what do you see?"), true);
  assert.equal(isOverviewQuestion("how does caching work"), false);
  const { calls, args } = harness();
  await answerQuestion("what do you see?", { ...args, sourceCount: 1, tabTitles: ["Hacker News"] }, noop, noop);
  assert.equal(calls.queries, 2);
});

function pt(sourceKey, chunkIndex, text, indexedAt = 1, contentHash = "h") {
  return { id: `${sourceKey}${chunkIndex}`, payload: { sourceKey, chunkIndex, text, indexedAt, contentHash, title: sourceKey, canonicalUrl: `https://x/${sourceKey}`, domain: "x" } };
}

test("summaries read the page in order instead of searching", async () => {
  const { calls, args } = harness();
  const points = [pt("a", 2, "third"), pt("a", 0, "first"), pt("a", 1, "second")];
  args.client.scrollAll = async () => points;
  let seenUser = "";
  args.chatStream = async (m, onToken) => { seenUser = m[m.length - 1].content; onToken("ok [1]", "ok [1]"); return "ok [1]"; };
  const res = await answerQuestion("summarize the best news", { ...args, sourceCount: 1, tabTitles: ["A"] }, noop, noop);
  assert.equal(calls.queries, 0, "no similarity search in read mode");
  assert.equal(res.timings.mode, "read");
  assert.ok(seenUser.indexOf("first") < seenUser.indexOf("second") && seenUser.indexOf("second") < seenUser.indexOf("third"));
});

test("read mode keeps only the latest snapshot and respects the budget", async () => {
  const { selectReadingChunks } = await import("../../src/lib/reading.js");
  const points = [pt("a", 0, "old", 1, "h1"), pt("a", 0, "new0", 2, "h2"), pt("a", 1, "x".repeat(50), 2, "h2"), pt("a", 2, "y".repeat(50), 2, "h2")];
  const hits = selectReadingChunks(points, 60);
  assert.deepEqual(hits.map((h) => h.text.slice(0, 4)), ["new0", "xxxx"]);
});

test("capable models plan once, rewrite follow-ups, and receive history", async () => {
  const { calls, args } = harness();
  let messages;
  args.chatJSON = async (m) => { calls.chatJSON.push("plan"); return JSON.stringify({ intent: "lookup", question: "What is beta's price?", queries: ["beta price"] }); };
  args.chatStream = async (m, onToken) => { messages = m; onToken("A [1]", "A [1]"); return "A [1]"; };
  await answerQuestion("and its price?", { ...args, sourceCount: 2, capable: true, history: [{ q: "what is beta", a: "Beta is a thing." }] }, noop, noop);
  assert.equal(calls.chatJSON.length, 1);
  assert.ok(messages.some((m) => m.role === "assistant" && m.content.includes("Beta is a thing")));
  assert.ok(messages[messages.length - 1].content.includes("What is beta's price?"));
});

test("capable model reads the whole page for a lookup question when it fits, no similarity search", async () => {
  const { calls, args } = harness();
  args.client.scrollAll = async () => [pt("a", 0, "alpha costs 5"), pt("a", 1, "beta costs 9")];
  args.chatJSON = async () => JSON.stringify({ intent: "lookup", question: "what does beta cost", queries: ["beta cost"] });
  args.chatStream = async (m, onToken) => { onToken("Beta costs 9 [2].", "Beta costs 9 [2]."); return "Beta costs 9 [2]."; };
  const res = await answerQuestion("what does beta cost", { ...args, sourceCount: 1, capable: true, tabTitles: ["A"] }, noop, noop);
  assert.equal(calls.queries, 0);
  assert.equal(res.timings.mode, "read");
  assert.equal(res.citations.length, 2);
});

test("capable model rewrites once when the answer cites nonexistent snippets", async () => {
  const { args } = harness();
  args.client.scrollAll = async () => [pt("a", 0, "alpha"), pt("a", 1, "beta")];
  args.chatJSON = async () => JSON.stringify({ intent: "summarize", question: "sum", queries: ["sum"] });
  let calls = 0;
  args.chatStream = async (m, onToken) => {
    calls += 1;
    const t = calls === 1 ? "Things [7] [8]." : "Things [1] [2].";
    onToken(t, t);
    return t;
  };
  const statuses = [];
  const res = await answerQuestion("summarize", { ...args, sourceCount: 1, capable: true, tabTitles: ["A"] }, (s) => statuses.push(s), noop);
  assert.equal(calls, 2);
  assert.equal(res.answer, "Things [1] [2].");
  assert.deepEqual(res.citationValidation.invalid, []);
  assert.ok(statuses.includes("Checking citations..."));
});

test("on-device model never gets the verify pass", async () => {
  const { args } = harness();
  let calls = 0;
  args.chatStream = async (m, onToken) => { calls += 1; onToken("no cites", "no cites"); return "no cites"; };
  await answerQuestion("how does caching work", { ...args, sourceCount: null }, noop, noop);
  assert.equal(calls, 1);
});
