import React, { startTransition, useEffect, useOptimistic, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronRight, CircleCheck, Globe, Layers, LibraryBig, Plus, X } from "lucide-react";
import { cn } from "../ui/cn.js";
import { Button } from "../ui/button.jsx";
import { Checkbox, Segmented } from "../ui/form.jsx";
import { Badge, EmptyState, Notice, SiteAvatar } from "../ui/primitives.jsx";
import { Progress, Stepper } from "../ui/progress.jsx";
import { Tip } from "../ui/overlay.jsx";
import { toast } from "../ui/toaster.jsx";
import { formatMs, send, useTabs } from "../ui/hooks.js";
import { JOB_STAGES, jobDetail, jobPercent, stageIndex } from "../ui/job.js";
import { Library } from "./Library.jsx";

const domainOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

// ─── Indexing job ───────────────────────────────────────────────────────────
function JobCard({ job, dismissed, onDismiss }) {
  if (!job) return null;
  if (job.running) {
    const pct = jobPercent(job);
    return (
      <div role="status" aria-live="polite" className="flex flex-col gap-3 rounded-xl border border-primary/30 bg-card p-3 shadow-soft">
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate text-[13px] font-medium">
            Page {Math.min(job.done + 1, job.total)} of {job.total}
            {job.current?.title ? <span className="font-normal text-muted-foreground"> · {job.current.title}</span> : null}
          </p>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{pct}%</span>
        </div>
        <Progress value={pct} aria-label="Indexing progress" />
        <Stepper steps={JOB_STAGES} current={stageIndex(job)} />
        <p className="text-xs text-muted-foreground">{jobDetail(job)}. You can close this popup, indexing continues.</p>
      </div>
    );
  }
  if (!job.finishedAt || dismissed === job.finishedAt) return null;
  const parts = [];
  if (job.added) parts.push(`${job.added} added`);
  if (job.unchanged) parts.push(`${job.unchanged} unchanged`);
  if (job.failures.length) parts.push(`${job.failures.length} failed`);
  const allFailed = job.failures.length > 0 && !job.added && !job.unchanged;
  return (
    <Notice
      tone={allFailed ? "danger" : job.failures.length ? "warning" : "success"}
      action={
        <Button variant="ghost" size="icon-sm" className="-my-1 -mr-1.5" onClick={() => onDismiss(job.finishedAt)} aria-label="Dismiss">
          <X />
        </Button>
      }
    >
      <p className="font-medium">
        {parts.join(" · ") || "Nothing to add"} in {formatMs(job.finishedAt - job.startedAt)}
      </p>
      {job.failures.slice(0, 3).map((f, i) => (
        <p key={i} className="mt-0.5 opacity-90">{f.title}: {f.error}</p>
      ))}
    </Notice>
  );
}

// ─── Working set ────────────────────────────────────────────────────────────
function TabRow({ tab, added, selected, onToggle, disabled, tag }) {
  const domain = domainOf(tab.url);
  return (
    <li>
      <label className={cn("flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted", (added || disabled) && "cursor-default opacity-70 hover:bg-transparent")}>
        <Checkbox checked={added || selected} disabled={added || disabled} onCheckedChange={onToggle} aria-label={`Select ${tab.title}`} />
        <SiteAvatar domain={domain} className="size-6 text-[11px]" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">{tab.title || tab.url}</span>
          <span className="block truncate text-[11px] text-muted-foreground">{domain}</span>
        </span>
        {tag}
        {added && <Badge tone="success"><Check /> Added</Badge>}
      </label>
    </li>
  );
}

function WorkingSet({ workingSet, running, onStart, onRemove }) {
  const { current, open } = useTabs();
  const [picked, setPicked] = useState(() => new Set());
  const [showTabs, setShowTabs] = useState(false);
  const [items, removeOptimistic] = useOptimistic(workingSet, (list, tabId) => list.filter((t) => t.tabId !== tabId));
  const addedTabIds = new Set(workingSet.map((w) => w.tabId));
  const others = open.filter((t) => t.id !== current?.id);
  const addable = others.filter((t) => !addedTabIds.has(t.id));
  const currentAdded = current && addedTabIds.has(current.id);
  const selected = [...picked].filter((id) => addable.some((t) => t.id === id));

  // Open the tab list by default while the working set is empty, so the next step is visible.
  const opened = useRef(false);
  useEffect(() => {
    if (!opened.current && others.length && workingSet.length === 0) {
      opened.current = true;
      setShowTabs(true);
    }
  }, [others.length, workingSet.length]);

  const toggle = (id, on) => setPicked((s) => {
    const next = new Set(s);
    on ? next.add(id) : next.delete(id);
    return next;
  });

  return (
    <div className="flex flex-col gap-4">
      {current ? (
        <div className="flex items-center gap-2.5 rounded-xl border border-border bg-card p-2.5 shadow-soft">
          <SiteAvatar domain={domainOf(current.url)} className="size-8" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium">{current.title || current.url}</p>
            <p className="truncate text-[11px] text-muted-foreground">This tab · {domainOf(current.url)}</p>
          </div>
          {currentAdded ? (
            <Badge tone="success"><CircleCheck /> Added</Badge>
          ) : (
            <Button size="sm" disabled={running} onClick={() => onStart([current.id])}>
              <Plus /> Add
            </Button>
          )}
        </div>
      ) : (
        <p className="rounded-xl border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">Switch to a web page to add it, or pick from your open tabs below.</p>
      )}

      <section>
        <h3 className="mb-1.5 flex items-center gap-2 text-xs font-medium text-muted-foreground">
          Working set
          {items.length > 0 && <Badge tone="accent">{items.length}</Badge>}
        </h3>
        {items.length === 0 ? (
          <EmptyState icon={Layers} title="No pages yet">Add the tab you're on, then ask a question about it.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-1.5">
            <AnimatePresence initial={false}>
              {items.map((t) => (
                <motion.li key={t.sourceKey} layout initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97, height: 0 }} transition={{ duration: 0.18 }} className="flex items-center gap-2.5 rounded-xl border border-border bg-card p-2">
                  <SiteAvatar domain={t.domain} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium" title={t.canonicalUrl}>{t.title || t.canonicalUrl}</p>
                    <p className="truncate text-[11px] text-muted-foreground">{t.domain}</p>
                  </div>
                  <Tip label="Remove from working set (keeps the library copy)">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${t.title}`}
                      onClick={() => startTransition(async () => {
                        removeOptimistic(t.tabId);
                        await onRemove(t.tabId);
                      })}
                    >
                      <X />
                    </Button>
                  </Tip>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </section>

      {others.length > 0 && (
        <section>
          <button type="button" onClick={() => setShowTabs((v) => !v)} aria-expanded={showTabs} className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
            <ChevronRight className={cn("size-3.5 transition-transform", showTabs && "rotate-90")} />
            Other open tabs ({others.length})
          </button>
          <AnimatePresence initial={false}>
            {showTabs && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                <ul className="mt-1.5 flex flex-col">
                  {others.map((t) => (
                    <TabRow key={t.id} tab={t} added={addedTabIds.has(t.id)} selected={picked.has(t.id)} disabled={running} onToggle={(on) => toggle(t.id, !!on)} />
                  ))}
                </ul>
                <div className="mt-2 flex gap-2">
                  <Button size="sm" disabled={running || selected.length === 0} onClick={() => { onStart(selected); setPicked(new Set()); }}>
                    <Plus /> Add {selected.length ? `${selected.length} selected` : "selected"}
                  </Button>
                  <Button variant="outline" size="sm" disabled={running || addable.length === 0} onClick={() => onStart(open.map((t) => t.id))} title="Index every web page open in this window">
                    Add all {open.length} tabs
                  </Button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </section>
      )}
    </div>
  );
}

export function Pages({ workingSet, job, qdrantUp, filter, setFilter, onRemove, onLibraryDeleted }) {
  const [section, setSection] = useState("set");
  const [refreshKey, setRefreshKey] = useState(0);
  const [dismissed, setDismissed] = useState(null);
  const wasRunning = useRef(false);
  const running = !!job?.running;

  // Refresh the library when a job finishes, including one that finished while the popup was closed.
  useEffect(() => {
    if (wasRunning.current && !job?.running) setRefreshKey((k) => k + 1);
    wasRunning.current = !!job?.running;
  }, [job?.running]);

  const start = async (tabIds) => {
    await send({ type: "ENSURE_OFFSCREEN" }).catch(() => {});
    send({ type: "WARM_EMBEDDER" }).catch(() => {});
    const res = await send({ type: "START_INDEX_JOB", tabIds }).catch((e) => ({ ok: false, error: String(e) }));
    if (!res?.ok) toast.error(res?.error || "Couldn't start indexing.");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3 pt-3">
        <Segmented
          value={section}
          onValueChange={setSection}
          label="Pages section"
          className="w-full [&>button]:flex-1"
          options={[
            { value: "set", label: (<><Layers className="size-3.5" />Working set</>) },
            { value: "library", label: (<><LibraryBig className="size-3.5" />Library</>) },
          ]}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 [scrollbar-gutter:stable]">
        <JobCard job={job} dismissed={dismissed} onDismiss={setDismissed} />
        {section === "set" ? (
          <WorkingSet workingSet={workingSet} running={running} onStart={start} onRemove={onRemove} />
        ) : (
          <Library qdrantUp={qdrantUp} refreshKey={refreshKey} filter={filter} setFilter={setFilter} onDeleted={onLibraryDeleted} />
        )}
      </div>
    </div>
  );
}
