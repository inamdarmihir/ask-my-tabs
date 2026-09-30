import React, { useEffect, useRef, useState } from "react";
import { citationStatus } from "../lib/freshness.js";
import { STALE_PENDING_MS, INTERRUPTED_MESSAGE } from "../lib/threads.js";
import { RichText } from "./RichText.jsx";
import { CheckIcon, ChevronIcon, CopyIcon, RetryIcon, SendIcon, SparkIcon } from "./icons.jsx";
import { formatMs, send, useNow } from "./hooks.js";

const SUGGESTIONS = ["Summarize these pages in a few bullets", "What are the most important takeaways?", "What should I look at first, and why?"];

function StatusChip({ status }) {
  return <span className={`badge badge-${status}`}>{status === "confirmed-current" ? "current" : status}</span>;
}

function Pending({ message, now }) {
  const started = message.startedAt ?? message.createdAt;
  const secs = Math.max(0, Math.round((now - started) / 1000));
  const done = (message.steps || []).slice(0, -1);
  return (
    <div className="pending" role="status">
      {done.length > 0 && (
        <ul className="steps">
          {done.map((st, i) => <li key={i}><CheckIcon /> {st}</li>)}
        </ul>
      )}
      <div className="pending-now">
        <span className="spinner" />
        <span>{message.statusText || "Working..."}</span>
        <span className="elapsed">{secs}s</span>
      </div>
    </div>
  );
}

const STAGE_LABELS = { plan: "Understanding", read: "Reading pages", retrieve: "Searching", generate: "Writing" };

function Trace({ message }) {
  const [open, setOpen] = useState(false);
  const t = message.timings;
  const steps = (message.steps || []).filter((x) => x !== "Writing an answer...");
  if (!steps.length && !t) return null;
  return (
    <div className="trace">
      <button className={`sources-toggle ${open ? "open" : ""}`} onClick={() => setOpen((v) => !v)}><ChevronIcon /> How this was answered</button>
      {open && (
        <div className="trace-body">
          <ul className="steps">{steps.map((st, i) => <li key={i}><CheckIcon /> {st}</li>)}<li><CheckIcon /> Wrote the answer</li></ul>
          {t?.mode && (
            <p className="trace-line">
              {t.mode === "read" ? "Read the page directly" : "Searched for the best matches"} · {t.intent} question{t.repaired ? " · citations corrected" : ""}
            </p>
          )}
          {t?.stages && (
            <div className="stages">
              {Object.entries(t.stages).map(([k, v]) => <span key={k} className="stage">{STAGE_LABELS[k] || k} {formatMs(v)}</span>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// One card per page (not per snippet), listing which [n] came from it.
function SourceGroup({ group, highlight, openTab }) {
  const [expanded, setExpanded] = useState(false);
  const [freshness, setFreshness] = useState(null);
  const ref = useRef(null);
  const hl = group.items.some((c) => c.index === highlight);
  useEffect(() => {
    if (hl) {
      setExpanded(true);
      ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [hl, highlight]);
  const first = group.items[0];

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

  return (
    <li ref={ref} className={`source ${hl ? "source-hl" : ""}`}>
      <div className="source-body">
        <div className="source-top">
          <a href={first.tabUrl} target="_blank" rel="noreferrer" onClick={jump} className="source-title">{first.tabTitle}</a>
        </div>
        <div className="source-meta">
          <span>{group.domain}</span>
          <span className="nums">{group.items.map((c) => <span key={c.index} className="cite static">{c.index}</span>)}</span>
          <StatusChip status={status} />
          {openTab && freshness === null && <button className="link" onClick={check}>Check freshness</button>}
          {freshness === "checking" && <span>checking...</span>}
          {freshness?.error && <span title={freshness.error}>couldn't check</span>}
          <button className="link" onClick={() => setExpanded((v) => !v)}>{expanded ? "Hide excerpts" : `Excerpts (${group.items.length})`}</button>
        </div>
        {expanded && group.items.map((c) => (
          <blockquote key={c.index} className={c.index === highlight ? "hl" : ""}><b>[{c.index}]</b> {c.text}</blockquote>
        ))}
      </div>
    </li>
  );
}

function groupBySource(citations) {
  const map = new Map();
  for (const c of citations) {
    if (!map.has(c.sourceKey)) map.set(c.sourceKey, { sourceKey: c.sourceKey, domain: c.domain, items: [] });
    map.get(c.sourceKey).items.push(c);
  }
  return [...map.values()];
}

function AssistantMessage({ message, workingSet, now, onRegenerate }) {
  const [showSources, setShowSources] = useState(false);
  const [highlight, setHighlight] = useState(null);
  const [copied, setCopied] = useState(false);
  const citations = message.citations || [];
  const stale = message.status === "pending" && now - (message.startedAt ?? message.createdAt) > STALE_PENDING_MS;
  const status = stale ? "error" : message.status;
  const cited = new Set([...(message.content || "").matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));

  const onCite = (n) => {
    setShowSources(true);
    setHighlight(n);
  };
  const copy = async () => {
    await navigator.clipboard.writeText(message.content).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  const t = message.timings;
  return (
    <div className="msg msg-assistant">
      {message.content && <RichText text={message.content} citationCount={citations.length} onCite={onCite} />}
      {status === "pending" && <Pending message={message} now={now} />}
      {status === "error" && <div className="error-box">{stale ? INTERRUPTED_MESSAGE : message.error}</div>}
      {message.strippedCitations?.length > 0 && (
        <div className="warn-box">Removed {message.strippedCitations.length} citation{message.strippedCitations.length === 1 ? "" : "s"} that didn't match any source (the model cited [{message.strippedCitations.join(", ")}]). Check the claims nearby.</div>
      )}
      {message.invalidCitations?.length > 0 && (
        <div className="warn-box">
          {message.invalidCitations.length > 4
            ? `${message.invalidCitations.length} citations in this answer (up to [${Math.max(...message.invalidCitations)}]) don't match any supplied snippet.`
            : `The answer cites [${message.invalidCitations.join(", ")}], which ${message.invalidCitations.length === 1 ? "doesn't" : "don't"} match any supplied snippet.`}{" "}
          Treat those claims as unsupported.
        </div>
      )}
      {status === "done" && (
        <div className="msg-footer">
          <span className="timing">
            {message.model ? `${message.model} · ` : ""}
            {t ? `${formatMs(t.totalMs)}${t.snippets ? ` · ${t.snippets} snippets · ${t.sources} source${t.sources === 1 ? "" : "s"}` : ""}` : ""}
          </span>
          <span className="actions">
            {onRegenerate && <button className="icon-btn small" onClick={onRegenerate} title="Ask again" aria-label="Regenerate"><RetryIcon /></button>}
            <button className="icon-btn small" onClick={copy} title="Copy answer" aria-label="Copy answer">{copied ? <CheckIcon /> : <CopyIcon />}</button>
          </span>
        </div>
      )}
      {status === "done" && <Trace message={message} />}
      {citations.length > 0 && (
        <div className="sources">
          <button className={`sources-toggle ${showSources ? "open" : ""}`} onClick={() => setShowSources((v) => !v)}>
            <ChevronIcon /> {groupBySource(citations).length} page{groupBySource(citations).length === 1 ? "" : "s"} used
          </button>
          {showSources && (
            <>
              <ul className="source-list">
                {groupBySource(citations).map((g) => (
                  <SourceGroup key={g.sourceKey} group={g} highlight={highlight} openTab={workingSet.find((w) => w.sourceKey === g.sourceKey)} />
                ))}
              </ul>
              <p className="snapshot-note">Sources point to stored snapshots, which may differ from the live page.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function Chat({ thread, workingSet, busy, scope, setScope, canAsk, blockedReason, onSend, onGoPages }) {
  const [draft, setDraft] = useState("");
  const scroller = useRef(null);
  const taRef = useRef(null);
  const messages = thread?.messages || [];
  const pending = messages.some((m) => m.status === "pending");
  const now = useNow(pending);

  // Stick to the bottom while an answer streams in.
  const last = messages[messages.length - 1];
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread?.id, messages.length, last?.content, last?.status]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, [draft]);

  const submit = (text = draft) => {
    const q = text.trim();
    if (!q || busy || pending || !canAsk) return;
    onSend(q);
    setDraft("");
  };

  return (
    <div className="chat">
      <div className="chat-scroll" ref={scroller}>
        {messages.length === 0 ? (
          <div className="empty-chat">
            <div className="empty-mark"><SparkIcon /></div>
            <h2>Ask across your pages</h2>
            <p>
              {canAsk
                ? "Answers are written from your indexed pages and cite where each claim came from."
                : blockedReason}
            </p>
            {!canAsk && <button className="btn btn-primary" onClick={onGoPages}>Add pages</button>}
            {canAsk && scope === "working-set" && workingSet.length > 0 && (
              <div className="page-chips">
                {workingSet.slice(0, 4).map((w) => <span key={w.sourceKey} className="page-chip" title={w.canonicalUrl}>{w.title || w.domain}</span>)}
                {workingSet.length > 4 && <span className="page-chip">+{workingSet.length - 4} more</span>}
              </div>
            )}
            {canAsk && (
              <div className="suggestions">
                {SUGGESTIONS.map((s) => <button key={s} className="suggestion" onClick={() => submit(s)}>{s}</button>)}
              </div>
            )}
          </div>
        ) : (
          messages.map((m, idx) =>
            m.role === "user" ? (
              <div key={m.id} className="msg msg-user"><div className="bubble">{m.content}</div></div>
            ) : (
              <AssistantMessage key={m.id} message={m} workingSet={workingSet} now={now} onRegenerate={idx === messages.length - 1 && !pending && canAsk ? () => onSend(messages[idx - 1].content) : null} />
            ),
          )
        )}
      </div>

      <div className="composer">
        <textarea
          ref={taRef}
          rows={1}
          value={draft}
          placeholder={canAsk ? "Ask a question..." : "Add a page to start asking"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-row">
          <div className="segmented" role="radiogroup" aria-label="Where to search">
            <button role="radio" aria-checked={scope === "working-set"} className={scope === "working-set" ? "on" : ""} onClick={() => setScope("working-set")} title="Only the pages in your working set">
              Working set{workingSet.length ? ` · ${workingSet.length}` : ""}
            </button>
            <button role="radio" aria-checked={scope === "library"} className={scope === "library" ? "on" : ""} onClick={() => setScope("library")} title="Everything you have ever indexed">
              Library
            </button>
          </div>
          <button className="send" onClick={() => submit()} disabled={!draft.trim() || busy || pending || !canAsk} aria-label="Send" title={pending ? "Wait for the current answer" : "Send (Enter)"}>
            <SendIcon />
          </button>
        </div>
      </div>
    </div>
  );
}
