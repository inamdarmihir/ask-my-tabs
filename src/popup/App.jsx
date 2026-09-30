import React, { useCallback, useEffect, useMemo, useState } from "react";
import { buildScopeFilter } from "../lib/filters.js";
import { THREADS_KEY, ACTIVE_THREAD_KEY } from "../lib/threads.js";
import { Chat } from "./Chat.jsx";
import { History } from "./History.jsx";
import { Pages } from "./Pages.jsx";
import { ExpandIcon, HistoryIcon, PlusIcon, SettingsIcon } from "./icons.jsx";
import { send, useModel, useQdrant, useStorage } from "./hooks.js";

const NO_THREADS = [];
const NO_PAGES = [];
const NO_ID = null;

function Banners({ qdrant, checkQdrant, model, downloadModel }) {
  return (
    <>
      {qdrant.status === "down" && (
        <div className="banner banner-bad">
          <span>
            {qdrant.location === "local"
              ? "Can't reach Qdrant on this computer. Run \"docker compose up -d\" in the project folder, then retry."
              : "Can't reach your Qdrant Cloud cluster. Check the URL and API key in Settings, then retry."}
          </span>
          <button className="btn btn-danger btn-sm" onClick={checkQdrant}>Retry</button>
        </div>
      )}
      {!model.label && !model.ready && (
        <div className="banner">
          <span>{model.error ? `Model load failed: ${model.error}` : model.progress || "The on-device answer model isn't downloaded yet (about 0.5 GB, one time)."}</span>
          <button className="btn btn-primary btn-sm" disabled={model.loading && !model.error} onClick={downloadModel}>
            {model.error ? "Retry" : model.loading ? "Loading..." : "Download"}
          </button>
        </div>
      )}
    </>
  );
}

export function App() {
  const full = new URLSearchParams(location.search).has("full");
  const [threads, threadsLoaded] = useStorage("local", THREADS_KEY, NO_THREADS);
  const [activeId] = useStorage("local", ACTIVE_THREAD_KEY, NO_ID);
  const [workingSet] = useStorage("local", "workingSet", NO_PAGES);
  const [job] = useStorage("session", "indexJob", NO_ID);
  const [view, setView] = useState("chat");
  const [showHistory, setShowHistory] = useState(false);
  const [scope, setScope] = useState("working-set");
  const [filter, setFilter] = useState({ domain: "", date: "" });
  const [sendError, setSendError] = useState(null);
  const [qdrant, checkQdrant] = useQdrant();
  const [model, downloadModel] = useModel();

  const thread = useMemo(() => threads.find((t) => t.id === activeId) || null, [threads, activeId]);

  // Start loading the small embedding model now so the first "Add tab" doesn't wait for it.
  useEffect(() => {
    send({ type: "ENSURE_OFFSCREEN" }).then(() => send({ type: "WARM_EMBEDDER" })).catch(() => {});
  }, []);

  const setActive = useCallback((id) => chrome.storage.local.set({ [ACTIVE_THREAD_KEY]: id }), []);

  const canAsk = scope === "library" || workingSet.length > 0;
  const blockedReason = "Your working set is empty. Add the pages you want to ask about, or switch to Library to search everything you've indexed.";

  const onSend = async (question) => {
    setSendError(null);
    const filterForScope =
      scope === "working-set"
        ? buildScopeFilter({ sourceKeys: workingSet.map((t) => t.sourceKey) })
        : buildScopeFilter({ domain: filter.domain || undefined, indexedAfter: filter.date ? new Date(filter.date).getTime() : undefined });
    const res = await send({
      type: "SEND_QUESTION",
      threadId: thread?.id ?? null,
      question,
      scope,
      filter: filterForScope,
      tabTitles: workingSet.map((t) => t.title),
      sourceCount: scope === "working-set" ? new Set(workingSet.map((t) => t.sourceKey)).size : null,
    }).catch((e) => ({ ok: false, error: String(e) }));
    if (!res?.ok) setSendError(res?.error || "Couldn't send the question.");
  };

  const removeFromWorkingSet = async (tabId) => {
    await send({ type: "REMOVE_FROM_WORKING_SET", tabId }).catch(() => {});
  };

  const onLibraryDeleted = async (source) => {
    const next = workingSet.filter((t) => t.sourceKey !== source.sourceKey);
    await chrome.storage.local.set({ workingSet: next });
  };

  const deleteThread = async (id) => {
    await send({ type: "DELETE_THREAD", threadId: id }).catch(() => {});
    if (id === activeId) await setActive(null);
  };

  const modelLabel = model.label ? model.label : "on this device";
  const qdrantDot = qdrant.status === "up" ? "ok" : qdrant.status === "down" ? "bad" : "";

  return (
    <div className={`app ${full ? "app-full" : ""}`}>
      <header className="header">
        <div className="brand">
          <img src="icons/icon48.png" alt="" width="22" height="22" />
          <h1>Ask My Tabs</h1>
        </div>
        <div className="header-actions">
          <button className="icon-btn" onClick={() => { setView("chat"); setActive(null); }} title="New chat" aria-label="New chat"><PlusIcon /></button>
          <button className="icon-btn" onClick={() => setShowHistory(true)} title="History" aria-label="History"><HistoryIcon /></button>
          {!full && (
            <button className="icon-btn" onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?full=1") })} title="Open in a tab" aria-label="Open in a tab"><ExpandIcon /></button>
          )}
          <button className="icon-btn" onClick={() => chrome.runtime.openOptionsPage()} title="Settings" aria-label="Settings"><SettingsIcon /></button>
        </div>
      </header>

      <div className="chips">
        <button className="chip" onClick={checkQdrant} title="Vector database. Click to re-check.">
          <span className={`dot ${qdrantDot}`} />
          Qdrant: {qdrant.status === "checking" ? "checking..." : `${qdrant.location}${qdrant.status === "down" ? " (unreachable)" : ""}`}
        </button>
        <button className="chip" onClick={() => chrome.runtime.openOptionsPage()} title="Answer model. Click to change in Settings.">
          <span className="dot ok" />
          Answers: {modelLabel}
        </button>
      </div>

      <nav className="tabs" role="tablist">
        <button role="tab" aria-selected={view === "chat"} className={view === "chat" ? "on" : ""} onClick={() => setView("chat")}>Chat</button>
        <button role="tab" aria-selected={view === "pages"} className={view === "pages" ? "on" : ""} onClick={() => setView("pages")}>
          Pages{workingSet.length ? <span className="count">{workingSet.length}</span> : null}
          {job?.running && <span className="live-dot" />}
        </button>
      </nav>

      <Banners qdrant={qdrant} checkQdrant={checkQdrant} model={model} downloadModel={downloadModel} />

      <main className="main">
        {view === "chat" ? (
          <Chat
            thread={thread}
            workingSet={workingSet}
            busy={!threadsLoaded}
            scope={scope}
            setScope={setScope}
            canAsk={canAsk}
            blockedReason={blockedReason}
            onSend={onSend}
            onGoPages={() => setView("pages")}
          />
        ) : (
          <Pages
            workingSet={workingSet}
            job={job}
            qdrantUp={qdrant.status === "up"}
            filter={filter}
            setFilter={setFilter}
            onRemove={removeFromWorkingSet}
            onLibraryDeleted={onLibraryDeleted}
          />
        )}
        {sendError && <div className="toast error-box" onClick={() => setSendError(null)}>{sendError}</div>}
      </main>

      {showHistory && (
        <History
          threads={threads}
          activeId={activeId}
          onOpen={(id) => { setActive(id); setView("chat"); setShowHistory(false); }}
          onNew={() => { setActive(null); setView("chat"); setShowHistory(false); }}
          onDelete={deleteThread}
          onClose={() => setShowHistory(false)}
        />
      )}
    </div>
  );
}
