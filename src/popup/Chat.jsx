import React, { useEffect, useRef, useState } from "react";
import { citationStatus } from "../lib/freshness.js";
import { STALE_PENDING_MS, INTERRUPTED_MESSAGE } from "../lib/threads.js";
import { RichText } from "./RichText.jsx";
import { CheckIcon, ChevronIcon, CopyIcon, SendIcon, SparkIcon } from "./icons.jsx";
import { formatMs, send, useNow } from "./hooks.js";

const SUGGESTIONS = ["Summarize these pages", "What are the key takeaways?", "Where do these pages disagree?"];

function StatusChip({ status }) {
  return <span className={`badge badge-${status}`}>{status === "confirmed-current" ? "current" : status}</span>;
}

function Citation({ c, highlighted, openTab }) {
  const [expanded, setExpanded] = useState(false);
  const [freshness, setFreshness] = useState(null); // null | "checking" | "confirmed-current" | "superseded" | {error}
  const ref = useRef(null);
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [highlighted]);

  const jump = async (e) => {
    if (!openTab) return; // no open tab: let the link open the stored URL
    e.preventDefault();
    try {
      const tab = await chrome.tabs.update(openTab.tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch {
      chrome.tabs.create({ url: c.tabUrl });
    }
  };

  const check = async () => {
    setFreshness("checking");
    const res = await send({ type: "CHECK_FRESHNESS", tabId: openTab.tabId, canonicalUrl: c.tabUrl, storedContentHash: c.contentHash }).catch(() => null);
    if (res?.ok && res.checked) setFreshness(res.matches ? "confirmed-current" : "superseded");
    else setFreshness({ error: res?.reason || res?.error || "Could not check." });
  };

  return (
    <li ref={ref} className={`source ${highlighted ? "source-hl" : ""}`}>
      <span className="source-n">{c.index}</span>
      <div className="source-body">
        <a href={c.tabUrl} target="_blank" rel="noreferrer" onClick={jump} className="source-title">{c.tabTitle}</a>
        <div className="source-meta">
          {c.domain} · indexed {c.indexedAt ? new Date(c.indexedAt).toLocaleDateString() : "unknown"}
          {typeof freshness === "string" && freshness !== "checking" ? <StatusChip status={freshness} /> : <StatusChip status={citationStatus({ hasNewerSnapshot: false, liveCheck: null })} />}
          {openTab && freshness === null && <button className="link" onClick={check}>Check freshness</button>}
          {freshness === "checking" && <span> checking...</span>}
          {freshness?.error && <span title={freshness.error}> couldn't check</span>}
        </div>
        {c.text && (
          <button className="link excerpt-toggle" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Hide excerpt" : "Show excerpt"}
          </button>
        )}
        {expanded && <blockquote>{c.text}</blockquote>}
      </div>
    </li>
  );
}

function Pending({ message, now }) {
  const started = message.startedAt ?? message.createdAt;
  const secs = Math.max(0, Math.round((now - started) / 1000));
  return (
    <div className="pending" role="status">
      <span className="spinner" />
      <span>{message.statusText || "Working..."}</span>
      <span className="elapsed">{secs}s</span>
    </div>
  );
}

function AssistantMessage({ message, workingSet, now }) {
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
          <button className="icon-btn small" onClick={copy} title="Copy answer">{copied ? <CheckIcon /> : <CopyIcon />}</button>
        </div>
      )}
      {citations.length > 0 && (
        <div className="sources">
          <button className={`sources-toggle ${showSources ? "open" : ""}`} onClick={() => setShowSources((v) => !v)}>
            <ChevronIcon /> Sources ({citations.length})
          </button>
          {showSources && (
            <>
              <ol className="source-list">
                {[...citations].sort((a, b) => Number(cited.has(b.index)) - Number(cited.has(a.index)) || a.index - b.index).map((c) => (
                  <Citation key={c.index} c={c} highlighted={highlight === c.index} openTab={workingSet.find((w) => w.sourceKey === c.sourceKey)} />
                ))}
              </ol>
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
            {canAsk && (
              <div className="suggestions">
                {SUGGESTIONS.map((s) => <button key={s} className="suggestion" onClick={() => submit(s)}>{s}</button>)}
              </div>
            )}
          </div>
        ) : (
          messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="msg msg-user"><div className="bubble">{m.content}</div></div>
            ) : (
              <AssistantMessage key={m.id} message={m} workingSet={workingSet} now={now} />
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
