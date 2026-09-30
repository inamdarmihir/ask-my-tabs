import test from "node:test";
import assert from "node:assert/strict";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { createCitationRegistry, finalizeCitations, makeTools, createResearchAgent, runDeepAgent, describeToolCall } from "../../src/lib/deep-agent.js";

function pt(sourceKey, chunkIndex, text, extra = {}) {
  return { id: `${sourceKey}-${chunkIndex}`, payload: { sourceKey, chunkIndex, text, indexedAt: 1, contentHash: "h", title: `Title ${sourceKey}`, canonicalUrl: `https://${sourceKey}.com`, domain: `${sourceKey}.com`, pageKind: "feed", ...extra } };
}

function fakeClient(points) {
  return {
    async scrollAll(_c, { filter }) {
      const keys = filter?.must?.find((m) => m.key === "sourceKey")?.match;
      const only = keys?.value ? [keys.value] : keys?.any;
      return points.filter((p) => !only || only.includes(p.payload.sourceKey));
    },
    async query(_c, { filter }) {
      return points.slice(0, 2).map((p, i) => ({ id: p.id, score: 1 - i * 0.1, payload: p.payload }));
    },
  };
}

// A model that follows a script of tool calls, then answers.
class ScriptedModel extends BaseChatModel {
  constructor(script) {
    super({});
    this.script = script;
    this.i = 0;
  }
  _llmType() { return "scripted"; }
  bindTools() { return this; }
  async _generate() {
    const step = this.script[Math.min(this.i++, this.script.length - 1)];
    const msg = new AIMessage(typeof step === "string" ? step : { content: "", tool_calls: [{ ...step, id: `c${this.i}` }] });
    return { generations: [{ text: typeof step === "string" ? step : "", message: msg }] };
  }
}

test("registry numbers each chunk once and reuses the number", () => {
  const r = createCitationRegistry();
  const h = (id) => ({ id, text: "t", tabTitle: "T", domain: "d" });
  assert.equal(r.add(h("a")), 1);
  assert.equal(r.add(h("b")), 2);
  assert.equal(r.add(h("a")), 1);
  assert.equal(r.size, 2);
});

test("finalizeCitations renumbers by first appearance, keeps only cited, strips unknown numbers", () => {
  const r = createCitationRegistry();
  for (const id of ["a", "b", "c"]) r.add({ id, text: `text ${id}`, tabTitle: `T${id}`, tabUrl: "u", domain: "d", sourceKey: id });
  const out = finalizeCitations("Claim one [3]. Claim two [1] and [3]. Bogus [9].", r);
  assert.equal(out.answer, "Claim one [1]. Claim two [2] and [1]. Bogus.");
  assert.deepEqual(out.citations.map((c) => [c.index, c.tabTitle]), [[1, "Tc"], [2, "Ta"]]);
  assert.deepEqual(out.validation.stripped, [9]);
  assert.deepEqual(out.validation.invalid, []);
});

test("tools: list_sources, read_page windows and citations, search_pages", async () => {
  const points = [pt("hn", 0, "1. Alpha (a.com)"), pt("hn", 1, "2. Beta (b.com)"), pt("blog", 0, "Blog text", { pageKind: "article" })];
  const registry = createCitationRegistry();
  const { listSources, readPage, searchPages } = makeTools({ client: fakeClient(points), collection: "c", filter: undefined, embed: async (t) => t.map(() => new Float32Array(2)), registry });

  const list = await listSources.invoke({});
  assert.match(list, /S1 \| Title hn \| hn\.com \| list\/feed page \| 2 sections/);
  assert.match(list, /S2 \| Title blog/);

  const page = await readPage.invoke({ source: "S1" });
  assert.match(page, /\[1\] .*1\. Alpha/);
  assert.match(page, /\[2\] .*2\. Beta/);
  assert.match(page, /end of the page/);
  const second = await readPage.invoke({ source: "hn", start: 2, count: 1 });
  assert.match(second, /\[2\]/, "same chunk keeps its number");
  assert.equal(registry.size, 2);

  assert.match(await readPage.invoke({ source: "nope" }), /Unknown source/);
  const found = await searchPages.invoke({ query: "alpha" });
  assert.match(found, /\[1\]/);
});

test("the deep agent runs a real tool loop: list, read, then answer with citations", async () => {
  const points = [pt("hn", 0, "1. Dots: Always-on agents (openai.com)"), pt("hn", 1, "2. Postal thing")];
  const registry = createCitationRegistry();
  const { tools } = makeTools({ client: fakeClient(points), collection: "c", filter: undefined, embed: async (t) => t.map(() => new Float32Array(2)), registry });
  const model = new ScriptedModel([
    { name: "list_sources", args: {} },
    { name: "read_page", args: { source: "S1" } },
    "The standout is always-on agents [1]. Also bogus [7].",
  ]);
  const agent = createResearchAgent({ model, tools });
  const statuses = [];
  const run = await runDeepAgent({ agent, question: "best AI news?", onStatus: (s) => statuses.push(s), onToken: () => {}, registry });
  assert.equal(run.toolCalls, 2);
  assert.deepEqual(statuses, ["Looking at your saved pages...", "Reading S1..."]);
  const done = finalizeCitations(run.text, registry);
  assert.equal(done.answer, "The standout is always-on agents [1]. Also bogus.");
  assert.equal(done.citations.length, 1);
  assert.match(done.citations[0].text, /Dots/);
});

test("describeToolCall gives readable statuses", () => {
  assert.equal(describeToolCall("search_pages", { query: "opus nerf" }), 'Searching for "opus nerf"...');
  assert.equal(describeToolCall("write_todos"), "Planning the research...");
});
