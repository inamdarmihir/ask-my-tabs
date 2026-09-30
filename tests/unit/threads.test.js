import test from "node:test";
import assert from "node:assert/strict";
import {
  startTurn, patchMessage, deleteThread, eventToPatch, sweepInterrupted, trimCitations, titleFrom, hasPending, MAX_THREADS, INTERRUPTED_MESSAGE,
} from "../../src/lib/threads.js";

let n = 0;
const newId = () => `id${++n}`;

test("startTurn creates a thread with a user message and a pending assistant message", () => {
  const { list, threadId, messageId } = startTurn([], { threadId: null, question: "What is X?", scope: "library", now: 100, newId });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, threadId);
  assert.equal(list[0].title, "What is X?");
  assert.deepEqual(list[0].messages.map((m) => m.role), ["user", "assistant"]);
  assert.equal(list[0].messages[1].id, messageId);
  assert.equal(list[0].messages[1].status, "pending");
  assert.ok(hasPending(list));
});

test("startTurn appends to an existing thread and moves it to the top", () => {
  const a = startTurn([], { question: "first", now: 1, newId });
  const b = startTurn(a.list, { question: "second", now: 2, newId });
  const c = startTurn(b.list, { threadId: a.threadId, question: "follow up", now: 3, newId });
  assert.equal(c.list[0].id, a.threadId);
  assert.equal(c.list[0].messages.length, 4);
  assert.equal(c.list[0].title, "first");
  assert.equal(c.list.length, 2);
});

test("an unknown threadId starts a new thread instead of dropping the question", () => {
  const { list } = startTurn([], { threadId: "gone", question: "q", now: 1, newId });
  assert.equal(list.length, 1);
});

test("threads are capped at MAX_THREADS, dropping the least recently updated", () => {
  let list = [];
  for (let i = 0; i < MAX_THREADS + 5; i++) list = startTurn(list, { question: `q${i}`, now: i, newId }).list;
  assert.equal(list.length, MAX_THREADS);
  assert.equal(list.some((t) => t.title === "q0"), false);
  assert.equal(list[0].title, `q${MAX_THREADS + 4}`);
});

test("patchMessage touches only the target message", () => {
  const { list, threadId, messageId } = startTurn([], { question: "q", now: 1, newId });
  const next = patchMessage(list, threadId, messageId, { content: "hi" }, 5);
  assert.equal(next[0].messages[1].content, "hi");
  assert.equal(next[0].messages[0].content, "q");
  assert.equal(next[0].updatedAt, 5);
});

test("deleteThread removes only that thread", () => {
  const a = startTurn([], { question: "a", now: 1, newId });
  const b = startTurn(a.list, { question: "b", now: 2, newId });
  assert.deepEqual(deleteThread(b.list, a.threadId).map((t) => t.id), [b.threadId]);
});

test("eventToPatch maps streaming, done, and error events", () => {
  assert.equal(eventToPatch({ type: "AGENT_STATUS", status: "Searching..." }).statusText, "Searching...");
  assert.equal(eventToPatch({ type: "ANSWER_TOKEN", delta: "b", full: "ab" }).content, "ab");
  assert.equal(eventToPatch({ type: "ANSWER_TOKEN", delta: "b", full: null }, { content: "a" }).content, "ab");
  const done = eventToPatch({ type: "ANSWER_DONE", answer: "A [1]", citations: [{ index: 1, text: "x".repeat(1000) }], timings: { totalMs: 5 }, citationValidation: { invalid: [3] } });
  assert.equal(done.status, "done");
  assert.deepEqual(done.invalidCitations, [3]);
  assert.ok(done.citations[0].text.length < 500);
  const err = eventToPatch({ type: "ANSWER_ERROR", error: "boom", qdrant: { kind: "down", message: "Qdrant is down" } });
  assert.equal(err.status, "error");
  assert.equal(err.error, "Qdrant is down");
  assert.equal(eventToPatch({ type: "NOPE" }), null);
});

test("sweepInterrupted marks pending answers, optionally only stale ones, and is a no-op otherwise", () => {
  const { list } = startTurn([], { question: "q", now: 1000, newId });
  assert.equal(sweepInterrupted(list, 1500, 10_000), list, "fresh pending untouched, same reference");
  const swept = sweepInterrupted(list, 20_000, 10_000);
  assert.equal(swept[0].messages[1].status, "error");
  assert.equal(swept[0].messages[1].error, INTERRUPTED_MESSAGE);
  assert.equal(sweepInterrupted(list, 1500)[0].messages[1].status, "error");
});

test("titleFrom collapses whitespace and truncates", () => {
  assert.equal(titleFrom("  a\n b  "), "a b");
  assert.equal(titleFrom("x".repeat(100)).length, 60);
  assert.equal(titleFrom(""), "New chat");
  assert.equal(trimCitations(undefined).length, 0);
});
