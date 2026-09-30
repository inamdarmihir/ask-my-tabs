// Chat threads: pure helpers over a plain array so they run in Node tests and in the service
// worker alike. Threads live in chrome.storage.local (written only by background.js, which owns
// every in-flight answer), so they survive the popup closing, the browser restarting, and the
// offscreen document being recycled. The popup only ever reads them.

export const THREADS_KEY = "threads";
export const ACTIVE_THREAD_KEY = "activeThreadId";
export const MAX_THREADS = 60;
// A pending answer older than this has almost certainly lost its worker (browser killed mid-run).
export const STALE_PENDING_MS = 5 * 60 * 1000;
const CITATION_TEXT_CHARS = 400;
export const INTERRUPTED_MESSAGE = "This answer was interrupted before it finished. Ask again to retry.";

export function titleFrom(question) {
  const t = (question || "").replace(/\s+/g, " ").trim();
  return t.length > 60 ? `${t.slice(0, 57)}...` : t || "New chat";
}

function sortAndPrune(list) {
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_THREADS);
}

// Appends a user message plus a pending assistant message. Creates the thread when `threadId`
// is missing or unknown. Returns the new list and the ids the caller needs to route events.
export function startTurn(list, { threadId, question, scope, now, newId, model = null }) {
  const messageId = newId();
  const user = { id: newId(), role: "user", content: question, createdAt: now, scope };
  const assistant = { id: messageId, role: "assistant", content: "", createdAt: now, status: "pending", statusText: "Starting...", startedAt: now, model };
  const existing = list.find((t) => t.id === threadId);
  const thread = existing
    ? { ...existing, updatedAt: now, messages: [...existing.messages, user, assistant] }
    : { id: newId(), title: titleFrom(question), createdAt: now, updatedAt: now, messages: [user, assistant] };
  const rest = list.filter((t) => t.id !== thread.id);
  return { list: sortAndPrune([thread, ...rest]), threadId: thread.id, messageId };
}

export function patchMessage(list, threadId, messageId, patch, now) {
  return list.map((t) =>
    t.id !== threadId
      ? t
      : { ...t, updatedAt: now, messages: t.messages.map((m) => (m.id === messageId ? { ...m, ...patch } : m)) },
  );
}

export function deleteThread(list, threadId) {
  return list.filter((t) => t.id !== threadId);
}

export function trimCitations(citations) {
  return (citations || []).map((c) => ({
    ...c,
    text: typeof c.text === "string" && c.text.length > CITATION_TEXT_CHARS ? `${c.text.slice(0, CITATION_TEXT_CHARS)}...` : c.text,
  }));
}

// Turns one offscreen event into a message patch (or null when the event isn't part of an answer).
// `message` is the message's current state, needed to append streamed deltas.
export function eventToPatch(event, message) {
  switch (event.type) {
    case "MODEL_PROGRESS":
      return { statusText: typeof event.detail === "string" ? event.detail : `Loading ${event.stage}...` };
    case "AGENT_STATUS":
      return { statusText: event.status };
    case "ANSWER_TOKEN":
      return { content: event.full ?? `${message?.content || ""}${event.delta}`, statusText: "Writing an answer..." };
    case "ANSWER_DONE": {
      const invalid = event.citationValidation?.invalid || [];
      return {
        content: event.answer ?? message?.content ?? "",
        status: "done",
        statusText: "",
        citations: trimCitations(event.citations),
        timings: event.timings || null,
        abstained: !!event.abstained,
        invalidCitations: invalid,
      };
    }
    case "ANSWER_ERROR":
      return {
        status: "error",
        statusText: "",
        error: event.qdrant?.kind === "down" ? event.qdrant.message : String(event.error || "Something went wrong."),
        qdrantDown: event.qdrant?.kind === "down",
      };
    default:
      return null;
  }
}

// Marks pending answers as interrupted. With `olderThanMs` set, only ones that have been pending
// longer than that (used by the popup for display); without it, all of them (used at browser start,
// when no answer can still be running).
export function sweepInterrupted(list, now, olderThanMs = 0) {
  let changed = false;
  const next = list.map((t) => {
    if (!t.messages.some((m) => m.status === "pending" && now - (m.startedAt ?? m.createdAt) >= olderThanMs)) return t;
    changed = true;
    return {
      ...t,
      messages: t.messages.map((m) =>
        m.status === "pending" && now - (m.startedAt ?? m.createdAt) >= olderThanMs
          ? { ...m, status: "error", statusText: "", error: INTERRUPTED_MESSAGE }
          : m,
      ),
    };
  });
  return changed ? next : list;
}

export function hasPending(list) {
  return list.some((t) => t.messages.some((m) => m.status === "pending"));
}
