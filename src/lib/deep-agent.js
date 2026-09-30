// Agentic RAG with deepagents (LangChain's agent harness on LangGraph). Instead of a fixed
// retrieve-then-write pipeline, a tool-using agent decides how to research the user's saved pages:
// it can plan with todos, list what is available, run hybrid (dense + BM25) searches with different
// wordings, read whole pages in order, delegate independent sub-questions to a researcher subagent,
// and only then write the answer. Every snippet a tool returns is numbered in a shared registry, so
// the final answer's [n] citations always resolve to a real stored snippet.
//
// Everything here is provider-agnostic except createModel(); the tools take injected `client`/`embed`
// so the module runs in Node tests with fakes.

import { createDeepAgent } from "deepagents";
import { ChatOpenAI } from "@langchain/openai";
import { tool } from "langchain";
import { z } from "zod";
import { retrieve, stripThinking, validateCitations, UNTRUSTED_CONTENT_NOTICE } from "./agent.js";
import { latestSnapshot } from "./reading.js";
import { OPENAI_COMPATIBLE_PROVIDERS } from "./config.js";

const SEARCH_TOP_K = 6;
const SNIPPET_CHARS = 700;
const READ_CHARS_PER_CALL = 9000;
const RECURSION_LIMIT = 40;
const TIMEOUT_MS = 150_000;

// ─── Citation registry ────────────────────────────────────────────────────────

// Numbers every distinct chunk the agent sees. The same chunk always gets the same number, so
// citing it from a search result and again after reading the page still resolves.
export function createCitationRegistry() {
  const byId = new Map();
  const entries = [];
  return {
    add(hit) {
      let e = byId.get(hit.id);
      if (!e) {
        e = { index: entries.length + 1, hit };
        byId.set(hit.id, e);
        entries.push(e);
      }
      return e.index;
    },
    entries,
    get size() {
      return entries.length;
    },
  };
}

export function formatSnippet(n, hit, maxChars = SNIPPET_CHARS) {
  const text = hit.text.length > maxChars ? `${hit.text.slice(0, maxChars)}...` : hit.text;
  return `[${n}] (${hit.tabTitle}, ${hit.domain}) ${text}`;
}

// Turns the model's raw answer into what the UI stores: cited numbers are renumbered 1..k in order of
// first appearance and only the snippets actually cited are returned; numbers that were never
// returned by a tool are removed. Returns { answer, citations, validation }.
export function finalizeCitations(rawAnswer, registry) {
  const byIndex = new Map(registry.entries.map((e) => [e.index, e]));
  const order = new Map(); // registry index -> new index
  const stripped = [];
  const answer = rawAnswer.replace(/\s?\[(\d+)\]/g, (m, n) => {
    const idx = Number(n);
    if (!byIndex.has(idx)) {
      stripped.push(idx);
      return "";
    }
    if (!order.has(idx)) order.set(idx, order.size + 1);
    return m.replace(`[${n}]`, `[${order.get(idx)}]`);
  });
  const citations = [...order.entries()].map(([idx, newIdx]) => {
    const h = byIndex.get(idx).hit;
    return {
      index: newIdx,
      tabTitle: h.tabTitle,
      tabUrl: h.tabUrl,
      text: h.text,
      score: h.score,
      sourceKey: h.sourceKey,
      domain: h.domain,
      indexedAt: h.indexedAt,
      contentHash: h.contentHash,
      chunkIndex: h.chunkIndex,
    };
  });
  return { answer, citations, validation: { ...validateCitations(answer, citations.length), stripped } };
}

// ─── Tools ────────────────────────────────────────────────────────────────────

function withSource(filter, sourceKey) {
  return { must: [...(filter?.must || []), { key: "sourceKey", match: { value: sourceKey } }] };
}

// One lazily-built listing of the pages in scope (latest snapshot each), shared by all tools so
// "S1", "S2"... mean the same page everywhere in a run.
function createSourceIndex({ client, collection, filter }) {
  let cached = null;
  return async function sources() {
    if (cached) return cached;
    const points = await client.scrollAll(collection, {
      filter,
      withPayload: ["sourceKey", "title", "domain", "canonicalUrl", "pageKind", "indexedAt", "contentHash"],
    });
    const perSource = new Map();
    for (const p of latestSnapshot(points)) {
      const cur = perSource.get(p.payload.sourceKey) || { ...p.payload, sections: 0 };
      cur.sections += 1;
      perSource.set(p.payload.sourceKey, cur);
    }
    cached = [...perSource.values()].map((s, i) => ({ ...s, ref: `S${i + 1}` }));
    return cached;
  };
}

function resolveSource(sources, ref) {
  const r = String(ref || "").trim();
  const byRef = sources.find((s) => s.ref.toLowerCase() === r.toLowerCase() || s.ref.toLowerCase() === `s${r}`.toLowerCase());
  if (byRef) return byRef;
  const q = r.toLowerCase();
  return q ? sources.find((s) => (s.title || "").toLowerCase().includes(q) || s.domain.toLowerCase().includes(q)) : null;
}

export function makeTools({ client, collection, mode = "hybrid", filter, embed, registry, sourceCount = null, onProgress = () => {} }) {
  const sources = createSourceIndex({ client, collection, filter });

  const listSources = tool(
    async () => {
      const list = await sources();
      if (list.length === 0) return "No pages are in scope.";
      return list
        .map((s) => `${s.ref} | ${s.title || s.canonicalUrl} | ${s.domain} | ${s.pageKind === "feed" ? "list/feed page" : "page"} | ${s.sections} sections`)
        .join("\n");
    },
    {
      name: "list_sources",
      description: "List the saved pages you can research (reference like S1, title, domain, size). Call this first when you are unsure what is available.",
      schema: z.object({}),
    },
  );

  const searchPages = tool(
    async ({ query, source }) => {
      let f = filter;
      let scoped = sourceCount;
      if (source) {
        const s = resolveSource(await sources(), source);
        if (!s) return `Unknown source "${source}". Call list_sources to see valid references.`;
        f = withSource(filter, s.sourceKey);
        scoped = 1;
      }
      const hits = await retrieve({ client, collection, mode, filter: f, query, embed, topK: SEARCH_TOP_K, sourceCount: scoped });
      if (hits.length === 0) return "No matching snippets. Try different wording, or read a page directly with read_page.";
      return hits.map((h) => formatSnippet(registry.add(h), h)).join("\n\n");
    },
    {
      name: "search_pages",
      description:
        "Hybrid search (semantic + BM25 keyword) over the saved pages. Returns numbered snippets [n] you can cite. " +
        "Use specific keywords or names; retry with different wording if results are weak. Optionally restrict to one page with `source` (e.g. S2).",
      schema: z.object({ query: z.string().describe("What to look for"), source: z.string().optional().describe("Optional page reference such as S1") }),
    },
  );

  const readPage = tool(
    async ({ source, start = 1, count = 12 }) => {
      const s = resolveSource(await sources(), source);
      if (!s) return `Unknown source "${source}". Call list_sources to see valid references.`;
      const points = await client.scrollAll(collection, { filter: withSource(filter, s.sourceKey), withPayload: true });
      const chunks = latestSnapshot(points).sort((a, b) => a.payload.chunkIndex - b.payload.chunkIndex);
      const total = chunks.length;
      const from = Math.max(1, start) - 1;
      const out = [];
      let used = 0;
      let i = from;
      for (; i < total && out.length < Math.max(1, count); i++) {
        const c = chunks[i];
        const hit = {
          id: c.id, score: 1, tabTitle: c.payload.title, tabUrl: c.payload.canonicalUrl, text: c.payload.text, sourceKey: c.payload.sourceKey,
          domain: c.payload.domain, indexedAt: c.payload.indexedAt, contentHash: c.payload.contentHash, chunkIndex: c.payload.chunkIndex,
        };
        const line = formatSnippet(registry.add(hit), hit, 1500);
        if (used > 0 && used + line.length > READ_CHARS_PER_CALL) break;
        used += line.length;
        out.push(line);
      }
      const more = i < total ? ` Call read_page again with start=${i + 1} for more.` : " That is the end of the page.";
      return `${s.title} (${s.domain}), sections ${from + 1}-${i} of ${total}.${more}\n\n${out.join("\n\n")}`;
    },
    {
      name: "read_page",
      description:
        "Read a saved page in order, as numbered snippets [n] you can cite. Best for summaries, feeds/lists of items, and questions about a whole page. " +
        "Pages are read in windows: use `start` to continue.",
      schema: z.object({
        source: z.string().describe("Page reference such as S1 (from list_sources), or part of its title"),
        start: z.number().int().optional().describe("First section number (default 1)"),
        count: z.number().int().optional().describe("How many sections (default 12)"),
      }),
    },
  );

  return { tools: [listSources, searchPages, readPage], listSources, searchPages, readPage, sources };
}

// ─── Agent ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are a research agent that answers questions about web pages the user has saved. You have tools " +
  "to list those pages, search them (semantic + BM25 keywords) and read them in order. Work like a careful " +
  "analyst:\n" +
  "- Decide what evidence you need, then get it. For a summary, overview, 'best/top items', or a feed/list " +
  "page, read the page with read_page (continue with `start` if it has more). For a specific fact, use " +
  "search_pages and retry with different wording if results are weak. For a comparison or several sub-questions, " +
  "plan with write_todos and delegate independent sub-questions to the `researcher` subagent.\n" +
  "- Be efficient: usually 1 to 4 tool calls. Stop as soon as you have enough. Do not use the file tools " +
  "unless you genuinely need scratch space.\n" +
  "- Never claim what the pages don't say. If evidence is missing, say exactly what is missing.\n" +
  "FINAL ANSWER RULES: write in your own words and synthesize; do not paste snippet text or list bare URLs. " +
  "Lead with the answer in one or two sentences, then short bullets with a bold label each when there are " +
  "several points, ranked by importance. On a feed/list page, pick the items that best match the request and " +
  "say why they matter; skip the rest. Cite claims inline as [n] using ONLY numbers that tool results gave " +
  "you (numbers inside the page text, such as rankings or point counts, are content, not citations). " +
  UNTRUSTED_CONTENT_NOTICE;

const RESEARCHER_PROMPT =
  "You research one focused sub-question over the user's saved pages using list_sources, search_pages and " +
  "read_page. Return concise findings as bullets, each with its [n] citation numbers exactly as the tools " +
  "returned them, and state clearly what you could not find. No preamble. " + UNTRUSTED_CONTENT_NOTICE;

export function createModel({ provider, apiKey, model, baseUrl }) {
  const p = OPENAI_COMPATIBLE_PROVIDERS[provider];
  if (!p) throw new Error(`The deep agent supports OpenAI-compatible providers only (got "${provider}").`);
  return new ChatOpenAI({
    model: model || p.defaultModel,
    apiKey,
    streaming: true,
    maxRetries: 1,
    configuration: { baseURL: (baseUrl || "").replace(/\/+$/, "") || p.baseUrl, dangerouslyAllowBrowser: true },
  });
}

export function createResearchAgent({ model, tools }) {
  return createDeepAgent({
    model,
    tools,
    systemPrompt: SYSTEM_PROMPT,
    subagents: [
      {
        name: "researcher",
        description: "Investigates one focused sub-question over the saved pages and returns cited findings. Use for independent parts of a comparison or multi-part question.",
        systemPrompt: RESEARCHER_PROMPT,
        tools,
      },
    ],
  });
}

const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (typeof p === "string" ? p : p?.text || "")).join("") : "");

export function describeToolCall(name, input = {}) {
  switch (name) {
    case "list_sources": return "Looking at your saved pages...";
    case "search_pages": return `Searching for "${String(input.query || "").slice(0, 60)}"${input.source ? ` in ${input.source}` : ""}...`;
    case "read_page": return `Reading ${input.source || "a page"}${input.start > 1 ? ` (from section ${input.start})` : ""}...`;
    case "write_todos": return "Planning the research...";
    case "task": return `Delegating: ${String(input.description || input.subagent_type || "sub-question").slice(0, 70)}...`;
    default: return `Working (${name})...`;
  }
}

// Runs the agent and adapts LangGraph's event stream to this project's callbacks. Only the main
// agent's tokens are streamed to the user (not a subagent's); a model turn that starts a new tool
// call resets the buffer, so what remains at the end is the final answer.
export async function runDeepAgent({ agent, question, history = [], onStatus, onToken, registry, signal }) {
  const messages = [
    ...history.flatMap((h) => [{ role: "user", content: h.q }, { role: "assistant", content: h.a }]),
    { role: "user", content: question },
  ];
  let buf = "";
  let final = "";
  let depth = 0;
  let toolCalls = 0;
  const stream = agent.streamEvents({ messages }, { version: "v2", recursionLimit: RECURSION_LIMIT, signal });
  for await (const ev of stream) {
    if (ev.event === "on_tool_start") {
      toolCalls += 1;
      if (ev.name === "task") depth += 1;
      onStatus(describeToolCall(ev.name, ev.data?.input));
    } else if (ev.event === "on_tool_end" && ev.name === "task") {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && ev.event === "on_chat_model_start") {
      buf = "";
    } else if (depth === 0 && ev.event === "on_chat_model_stream") {
      const t = textOf(ev.data?.chunk?.content);
      if (t) {
        buf += t;
        onToken(t, stripThinking(buf));
      }
    } else if (depth === 0 && ev.event === "on_chat_model_end") {
      const out = ev.data?.output;
      if (!out?.tool_calls?.length) final = textOf(out?.content) || buf;
    }
  }
  return { text: stripThinking(final || buf), toolCalls };
}

export async function answerWithDeepAgent({ cfg, client, collection, mode, filter, embed, sourceCount, history, question }, onStatus, onToken) {
  const started = performance.now();
  const registry = createCitationRegistry();
  const { tools } = makeTools({ client, collection, mode, filter, embed, registry, sourceCount });
  const agent = createResearchAgent({ model: createModel({ provider: cfg.llmProvider, apiKey: cfg.llmApiKey, model: cfg.llmModel, baseUrl: cfg.llmBaseUrl }), tools });
  onStatus("Starting the research agent...");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let run;
  try {
    run = await runDeepAgent({ agent, question, history, onStatus, onToken, registry, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!run.text) throw new Error("The research agent returned no answer.");
  const { answer, citations, validation } = finalizeCitations(run.text, registry);
  return {
    answer,
    citations,
    abstained: false,
    citationValidation: validation,
    timings: {
      totalMs: Math.round(performance.now() - started),
      stages: {},
      intent: "deep",
      mode: "deep",
      toolCalls: run.toolCalls,
      snippets: registry.size,
      sources: new Set(registry.entries.map((e) => e.hit.sourceKey)).size,
      repaired: validation.stripped.length > 0,
    },
  };
}
