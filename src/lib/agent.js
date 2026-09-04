// The agentic part. A plain RAG pipeline would embed the question once, retrieve once, and
// stuff the top-k chunks into a prompt. This instead lets the model decide how to search:
// break a comparative question into per-tab queries, notice when the first pass didn't turn up
// enough, and issue one refined follow-up search before it commits to an answer. Two hops, not
// an open-ended loop -- enough to matter for "compare X and Y", not enough to wander.

import { embed } from "./embeddings.js";
import { search } from "./vectorstore.js";
import { chatJSON, chatStream } from "./llm.js";

const MAX_HOPS = 2;
const TOP_K_PER_QUERY = 5;
const SUFFICIENCY_SCORE_FLOOR = 0.45; // below this, the best hit probably isn't a real answer

function safeParseJSON(text, fallback) {
  try {
    const parsed = JSON.parse(text);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

async function planQueries(question, tabTitles) {
  const raw = await chatJSON([
    {
      role: "system",
      content:
        "You plan search queries for a retrieval system. Given a user question and the titles " +
        "of the tabs available to search, output JSON: {\"queries\": [\"...\"]} with 1 to 3 " +
        "short, specific search queries. For a question comparing multiple things, issue one " +
        "query per thing being compared. Respond with JSON only.",
    },
    {
      role: "user",
      content: `Available tabs:\n${tabTitles.map((t) => `- ${t}`).join("\n")}\n\nQuestion: ${question}`,
    },
  ]);
  const parsed = safeParseJSON(raw, { queries: [question] });
  const queries = Array.isArray(parsed.queries) && parsed.queries.length ? parsed.queries : [question];
  return queries.slice(0, 3);
}

async function checkSufficiency(question, hits) {
  if (hits.length === 0) return { sufficient: false, refinedQuery: question };
  const bestScore = Math.max(...hits.map((h) => h.score));
  if (bestScore < SUFFICIENCY_SCORE_FLOOR) {
    return { sufficient: false, refinedQuery: question };
  }
  const raw = await chatJSON([
    {
      role: "system",
      content:
        'Given a question and retrieved snippets, decide if there is enough information to ' +
        'answer well. Output JSON: {"sufficient": true|false, "refined_query": "..."}. Only set ' +
        "refined_query when sufficient is false -- make it a more specific search than the " +
        "original question.",
    },
    {
      role: "user",
      content: `Question: ${question}\n\nSnippets:\n${hits
        .map((h, i) => `[${i + 1}] (${h.tabTitle}) ${h.text.slice(0, 300)}`)
        .join("\n")}`,
    },
  ]);
  const parsed = safeParseJSON(raw, { sufficient: true });
  return {
    sufficient: parsed.sufficient !== false,
    refinedQuery: parsed.refined_query || question,
  };
}

function dedupeHits(hits) {
  const seen = new Set();
  const out = [];
  for (const h of hits.sort((a, b) => b.score - a.score)) {
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    out.push(h);
  }
  return out;
}

export async function answerQuestion(question, { tabIds, tabTitles }, onStatus, onToken) {
  onStatus("Planning search queries...");
  const queries = await planQueries(question, tabTitles);

  let allHits = [];
  for (const q of queries) {
    onStatus(`Searching for "${q}"...`);
    const [qEmbedding] = await embed([q]);
    const hits = await search(qEmbedding, { tabIds, topK: TOP_K_PER_QUERY });
    allHits.push(...hits);
  }
  allHits = dedupeHits(allHits);

  onStatus("Checking whether that's enough to answer...");
  const { sufficient, refinedQuery } = await checkSufficiency(question, allHits);

  if (!sufficient) {
    onStatus(`Not quite enough -- searching again for "${refinedQuery}"...`);
    const [qEmbedding] = await embed([refinedQuery]);
    const moreHits = await search(qEmbedding, { tabIds, topK: TOP_K_PER_QUERY });
    allHits = dedupeHits([...allHits, ...moreHits]);
  }

  const topHits = allHits.slice(0, 8);

  if (topHits.length === 0) {
    onToken(
      "I couldn't find anything in your working set that relates to this question. Try adding " +
        "a relevant tab first.",
      null,
    );
    return { answer: null, citations: [] };
  }

  onStatus("Writing an answer...");
  const contextBlock = topHits
    .map((h, i) => `[${i + 1}] (from "${h.tabTitle}") ${h.text}`)
    .join("\n\n");

  const answer = await chatStream(
    [
      {
        role: "system",
        content:
          "Answer the user's question using ONLY the numbered snippets provided. Cite snippets " +
          'inline like [1] or [2] next to the claims they support. If the snippets don\'t fully ' +
          "answer the question, say what's missing instead of guessing.",
      },
      { role: "user", content: `Snippets:\n${contextBlock}\n\nQuestion: ${question}` },
    ],
    onToken,
  );

  return {
    answer,
    citations: topHits.map((h, i) => ({
      index: i + 1,
      tabTitle: h.tabTitle,
      tabUrl: h.tabUrl,
      text: h.text,
      score: h.score,
    })),
  };
}
