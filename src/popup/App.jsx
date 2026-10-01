import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Layers, MessageSquare } from "lucide-react";
import { buildScopeFilter } from "../lib/filters.js";
import { THREADS_KEY, ACTIVE_THREAD_KEY } from "../lib/threads.js";
import { cn } from "../ui/cn.js";
import { NavTabs } from "../ui/form.jsx";
import { Toaster, toast } from "../ui/toaster.jsx";
import { send, useModel, useQdrant, useStorage } from "../ui/hooks.js";
import { ActivityStrip } from "./ActivityStrip.jsx";
import { Chat } from "./Chat.jsx";
import { Header, overallStatus } from "./Header.jsx";
import { History } from "./History.jsx";
import { Pages } from "./Pages.jsx";
import { SetupChecklist, setupSteps } from "./SetupChecklist.jsx";

const NO_THREADS = [];
const NO_PAGES = [];
const NO_ID = null;

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
  const [root, setRoot] = useState(null);
  const [qdrant, checkQdrant] = useQdrant();
  const [model, downloadModel] = useModel();

  const thread = useMemo(() => threads.find((t) => t.id === activeId) || null, [threads, activeId]);

  // Start loading the small embedding model now so the first "Add tab" doesn't wait for it.
  useEffect(() => {
    send({ type: "ENSURE_OFFSCREEN" }).then(() => send({ type: "WARM_EMBEDDER" })).catch(() => {});
  }, []);

  const setActive = useCallback((id) => chrome.storage.local.set({ [ACTIVE_THREAD_KEY]: id }), []);

  const steps = setupSteps({ qdrant, model, workingSet, scope });
  const setupIncomplete = steps.some((s) => !s.done);
  const dbDown = qdrant.status === "down";
  const needsPages = scope === "working-set" && workingSet.length === 0;
  const canAsk = !needsPages && !dbDown;
  const blockedHint = dbDown ? "Connect your database to start asking" : "Add a page to start asking";

  const onSend = async (question) => {
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
    if (!res?.ok) toast.error(res?.error || "Couldn't send the question.");
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

  const newChat = () => {
    setView("chat");
    setActive(null);
  };

  const setup = setupIncomplete ? (
    <SetupChecklist qdrant={qdrant} checkQdrant={checkQdrant} model={model} downloadModel={downloadModel} steps={steps} onGoPages={() => setView("pages")} />
  ) : null;

  // The checklist and the Pages tab draw their own progress bars, so the strip skips the duplicate.
  const checklistShown = view === "chat" && setupIncomplete && !thread?.messages.length;

  return (
    <div ref={setRoot} className={cn("relative flex flex-col overflow-hidden bg-background text-foreground", full ? "mx-auto h-screen w-full max-w-3xl border-x border-border" : "h-[580px] w-[440px]")}>
      <Header full={full} status={overallStatus({ qdrant, model })} qdrant={qdrant} checkQdrant={checkQdrant} model={model} onNewChat={newChat} onOpenHistory={() => setShowHistory(true)} />
      <ActivityStrip model={model} job={job} onOpenPages={() => setView("pages")} hideModel={checklistShown} hideJob={view === "pages"} />
      <NavTabs
        value={view}
        onValueChange={setView}
        items={[
          { value: "chat", label: (<><MessageSquare />Chat</>) },
          { value: "pages", label: (<><Layers />Pages{workingSet.length ? <span className="rounded-full bg-muted px-1.5 text-[11px] leading-4 text-muted-foreground">{workingSet.length}</span> : null}</>) },
        ]}
      />
      <main className="flex min-h-0 flex-1 flex-col">
        {/* Chat stays mounted behind the Pages tab so a half-typed question and the scroll position survive. */}
        <div hidden={view !== "chat"} className="flex min-h-0 flex-1 flex-col">
          <Chat thread={thread} workingSet={workingSet} busy={!threadsLoaded} scope={scope} setScope={setScope} canAsk={canAsk} blockedHint={blockedHint} onSend={onSend} setup={setup} />
        </div>
        {view === "pages" && (
          <Pages workingSet={workingSet} job={job} qdrantUp={qdrant.status === "up"} filter={filter} setFilter={setFilter} onRemove={removeFromWorkingSet} onLibraryDeleted={onLibraryDeleted} />
        )}
      </main>

      <History
        open={showHistory}
        onOpenChange={setShowHistory}
        container={root}
        threads={threads}
        activeId={activeId}
        onOpen={(id) => { setActive(id); setView("chat"); setShowHistory(false); }}
        onNew={() => { newChat(); setShowHistory(false); }}
        onDelete={deleteThread}
      />
      <Toaster offset={full ? 16 : 8} />
    </div>
  );
}
