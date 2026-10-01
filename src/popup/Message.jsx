import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronRight, Copy, ExternalLink, LoaderCircle, RotateCcw, ShieldCheck, Sparkles } from "lucide-react";
import { citationStatus } from "../lib/freshness.js";
import { STALE_PENDING_MS, INTERRUPTED_MESSAGE } from "../lib/threads.js";
import { cn } from "../ui/cn.js";
import { Button } from "../ui/button.jsx";
import { Badge, Notice, SiteAvatar, Skeleton } from "../ui/primitives.jsx";
import { Progress } from "../ui/progress.jsx";
import { Tip } from "../ui/overlay.jsx";
import { toast } from "../ui/toaster.jsx";
import { formatMs, send } from "../ui/hooks.js";
import { RichText } from "./RichText.jsx";

const STATUS_BADGE = {
  "confirmed-current": { tone: "success", label: "Up to date" },
  superseded: { tone: "danger", label: "Changed since" },
  archived: { tone: "neutral", label: "Saved copy" },
};

const STAGE_LABELS = { plan: "Understanding", read: "Reading pages", retrieve: "Searching", generate: "Writing" };

// ─── In-progress answer ─────────────────────────────────────────────────────
function Pending({ message, now, hasContent }) {
  const started = message.startedAt ?? message.createdAt;
  const secs = Math.max(0, Math.round((now - started) / 1000));
  const done = (message.steps || []).slice(0, -1);
  return (
    <div role="status" aria-live="polite" className="overflow-hidden rounded-xl border border-border bg-card">
      <Progress value={null} className="h-0.5 rounded-none" />
      <div className="flex flex-col gap-1.5 p-2.5">
        <AnimatePresence initial={false}>
          {done.map((st, i) => (
            <motion.div key={`${i}-${st}`} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-2 text-xs text-muted-foreground">
              <Check className="size-3.5 shrink-0 text-success" strokeWidth={3} />
              <span className="truncate">{st}</span>
            </motion.div>
          ))}
        </AnimatePresence>
        <div className="flex items-center gap-2 text-xs">
          <LoaderCircle className="size-3.5 shrink-0 animate-spin text-primary" />
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">{message.statusText || "Working..."}</span>
          <span className="shrink-0 tabular-nums text-muted-foreground">{secs}s</span>
        </div>
        {!hasContent && (
          <div className="mt-1 flex flex-col gap-1.5" aria-hidden="true">
            <Skeleton className="h-3 w-11/12" />
            <Skeleton className="h-3 w-8/12" />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── How it was answered ────────────────────────────────────────────────────
function Trace({ message }) {
  const [open, setOpen] = useState(false);
  const t = message.timings;
  const steps = (message.steps || []).filter((x) => x !== "Writing an answer...");
  if (!steps.length && !t) return null;
  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} /> How this was answered
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="mt-2 flex flex-col gap-2 rounded-xl bg-muted/60 p-2.5 text-xs">
              <ul className="flex flex-col gap-1 text-muted-foreground">
                {steps.map((st, i) => (
                  <li key={i} className="flex items-center gap-2"><Check className="size-3.5 shrink-0 text-success" strokeWidth={3} />{st}</li>
                ))}
                <li className="flex items-center gap-2"><Check className="size-3.5 shrink-0 text-success" strokeWidth={3} />Wrote the answer</li>
              </ul>
              {t?.mode && (
                <p className="text-muted-foreground">
                  {t.mode === "deep"
                    ? `Research agent · ${t.toolCalls} tool call${t.toolCalls === 1 ? "" : "s"}`
                    : `${t.mode === "read" ? "Read the page directly" : "Searched for the best matches"} · ${t.intent} question`}
                  {t.repaired ? " · citations corrected" : ""}
                </p>
              )}
              {t?.stages && (
                <div className="flex flex-wrap gap-1">
                  {Object.entries(t.stages).map(([k, v]) => (
                    <Badge key={k}>{STAGE_LABELS[k] || k} {formatMs(v)}</Badge>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Sources ────────────────────────────────────────────────────────────────
function groupBySource(citations) {
  const map = new Map();
  for (const c of citations) {
    if (!map.has(c.sourceKey)) map.set(c.sourceKey, { sourceKey: c.sourceKey, domain: c.domain, items: [] });
    map.get(c.sourceKey).items.push(c);
  }
  return [...map.values()];
}

// One card per page (not per snippet), listing which [n] came from it.
function SourceCard({ group, highlight, openTab }) {
  const [expanded, setExpanded] = useState(false);
  const [freshness, setFreshness] = useState(null);
  const ref = useRef(null);
  const hl = group.items.some((c) => c.index === highlight);
  const first = group.items[0];

  useEffect(() => {
    if (hl) {
      setExpanded(true);
      // Wait for the list's open animation, or the card has no position to scroll to yet.
      const t = setTimeout(() => ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 260);
      return () => clearTimeout(t);
    }
  }, [hl, highlight]);

  const jump = async (e) => {
    if (!openTab) return;
    e.preventDefault();
    try {
      const tab = await chrome.tabs.update(openTab.tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch {
      chrome.tabs.create({ url: first.tabUrl });
    }
  };
  const check = async () => {
    setFreshness("checking");
    const res = await send({ type: "CHECK_FRESHNESS", tabId: openTab.tabId, canonicalUrl: first.tabUrl, storedContentHash: first.contentHash }).catch(() => null);
    if (res?.ok && res.checked) setFreshness(res.matches ? "confirmed-current" : "superseded");
    else setFreshness({ error: res?.reason || res?.error || "Could not check." });
  };
  const status = typeof freshness === "string" && freshness !== "checking" ? freshness : citationStatus({ hasNewerSnapshot: false, liveCheck: null });
  const badge = STATUS_BADGE[status] || STATUS_BADGE.archived;

  return (
    <li ref={ref} className={cn("rounded-xl border bg-card p-2.5 transition-[border-color,box-shadow]", hl ? "border-primary shadow-[0_0_0_3px_var(--ring)]" : "border-border")}>
      <div className="flex items-start gap-2.5">
        <SiteAvatar domain={group.domain} />
        <div className="min-w-0 flex-1">
          <a href={first.tabUrl} target="_blank" rel="noreferrer" onClick={jump} className="group flex items-center gap-1 text-[13px] font-medium hover:text-primary">
            <span className="truncate">{first.tabTitle}</span>
            <ExternalLink className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
          </a>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            <span>{group.domain}</span>
            <span className="inline-flex gap-0.5">
              {group.items.map((c) => (
                <span key={c.index} className="grid h-4 min-w-4 place-items-center rounded bg-accent px-1 text-[10px] font-semibold text-accent-foreground">{c.index}</span>
              ))}
            </span>
            <Badge tone={badge.tone}>{badge.label}</Badge>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {openTab && freshness === null && (
              <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={check}>
                <ShieldCheck className="size-3.5" /> Check if changed
              </Button>
            )}
            {freshness === "checking" && <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><LoaderCircle className="size-3 animate-spin" /> Checking...</span>}
            {freshness?.error && <span className="text-[11px] text-muted-foreground" title={freshness.error}>Couldn't check</span>}
            <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
              <ChevronRight className={cn("size-3.5 transition-transform", expanded && "rotate-90")} />
              {expanded ? "Hide excerpts" : `Excerpts (${group.items.length})`}
            </Button>
          </div>
        </div>
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="mt-2 flex flex-col gap-1.5">
              {group.items.map((c) => (
                <blockquote key={c.index} className={cn("border-l-2 pl-2 text-pretty text-xs text-muted-foreground", c.index === highlight ? "border-primary" : "border-border")}>
                  <b className="text-foreground">[{c.index}]</b> {c.text}
                </blockquote>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

function Sources({ citations, open, onToggle, highlight, workingSet }) {
  const groups = groupBySource(citations);
  return (
    <div>
      <button type="button" onClick={onToggle} aria-expanded={open} className="group flex items-center gap-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
        <span className="flex -space-x-1">
          {groups.slice(0, 4).map((g) => (
            <SiteAvatar key={g.sourceKey} domain={g.domain} className="size-5 rounded-full text-[10px] ring-2 ring-background" />
          ))}
        </span>
        {groups.length} page{groups.length === 1 ? "" : "s"} used
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <ul className="mt-2 flex flex-col gap-2">
              {groups.map((g) => (
                <SourceCard key={g.sourceKey} group={g} highlight={highlight} openTab={workingSet.find((w) => w.sourceKey === g.sourceKey)} />
              ))}
            </ul>
            <p className="mt-2 text-[11px] text-muted-foreground">Sources point to saved copies, which may differ from the live page.</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── The message ────────────────────────────────────────────────────────────
export function AssistantMessage({ message, workingSet, now, onRegenerate }) {
  const [showSources, setShowSources] = useState(false);
  const [highlight, setHighlight] = useState(null);
  const [copied, setCopied] = useState(false);
  const citations = message.citations || [];
  const stale = message.status === "pending" && now - (message.startedAt ?? message.createdAt) > STALE_PENDING_MS;
  const status = stale ? "error" : message.status;
  const t = message.timings;

  const onCite = (n) => {
    setShowSources(true);
    setHighlight(n);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      toast.success("Answer copied");
      setTimeout(() => setCopied(false), 1400);
    } catch {
      toast.error("Couldn't copy to the clipboard");
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="flex gap-2.5">
      <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground">
        <Sparkles className="size-3.5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        {message.content && <RichText text={message.content} citations={citations} onCite={onCite} />}
        {status === "pending" && <Pending message={message} now={now} hasContent={!!message.content} />}
        {status === "error" && <Notice tone="danger">{stale ? INTERRUPTED_MESSAGE : message.error}</Notice>}
        {message.strippedCitations?.length > 0 && (
          <Notice tone="warning">
            Removed {message.strippedCitations.length} citation{message.strippedCitations.length === 1 ? "" : "s"} that didn't match any source (the model cited [{message.strippedCitations.join(", ")}]). Check the claims nearby.
          </Notice>
        )}
        {message.invalidCitations?.length > 0 && (
          <Notice tone="warning">
            {message.invalidCitations.length > 4
              ? `${message.invalidCitations.length} citations in this answer (up to [${Math.max(...message.invalidCitations)}]) don't match any supplied snippet.`
              : `The answer cites [${message.invalidCitations.join(", ")}], which ${message.invalidCitations.length === 1 ? "doesn't" : "don't"} match any supplied snippet.`}{" "}
            Treat those claims as unsupported.
          </Notice>
        )}
        {status === "done" && (
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-[11px] text-muted-foreground">
              {message.model ? `${message.model} · ` : ""}
              {t ? `${formatMs(t.totalMs)}${t.snippets ? ` · ${t.snippets} snippets` : ""}` : ""}
            </span>
            <span className="flex shrink-0 gap-0.5">
              {onRegenerate && (
                <Tip label="Ask again">
                  <Button variant="ghost" size="icon-sm" onClick={onRegenerate} aria-label="Ask again"><RotateCcw /></Button>
                </Tip>
              )}
              <Tip label="Copy answer">
                <Button variant="ghost" size="icon-sm" onClick={copy} aria-label="Copy answer">{copied ? <Check className="text-success" /> : <Copy />}</Button>
              </Tip>
            </span>
          </div>
        )}
        {citations.length > 0 && <Sources citations={citations} open={showSources} onToggle={() => setShowSources((v) => !v)} highlight={highlight} workingSet={workingSet} />}
        {status === "done" && <Trace message={message} />}
      </div>
    </motion.div>
  );
}
