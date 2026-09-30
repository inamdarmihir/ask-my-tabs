import React, { useCallback, useEffect, useState } from "react";
import { CloseIcon, TrashIcon } from "./icons.jsx";
import { formatMs, send, timeAgo } from "./hooks.js";

function JobBar({ job }) {
  if (!job) return null;
  if (job.running) {
    const cur = job.current;
    const pct = cur?.total ? Math.round((cur.done / cur.total) * 100) : 0;
    const detail = !cur ? "Starting..." : cur.stage === "embedding" ? `Embedding chunk ${cur.done}/${cur.total}` : cur.stage === "saving" ? "Saving" : "Reading page";
    return (
      <div className="job" role="status">
        <div className="job-top">
          <span className="spinner" />
          <span className="job-title">Page {Math.min(job.done + 1, job.total)} of {job.total}{cur?.title ? ` · ${cur.title}` : ""}</span>
        </div>
        <div className="progress"><div style={{ width: `${cur?.stage === "embedding" ? pct : cur?.stage === "saving" ? 100 : 6}%` }} /></div>
        <div className="job-detail">{detail}. You can close this popup, indexing continues.</div>
      </div>
    );
  }
  if (!job.finishedAt) return null;
  const parts = [];
  if (job.added) parts.push(`${job.added} added`);
  if (job.unchanged) parts.push(`${job.unchanged} unchanged`);
  if (job.failures.length) parts.push(`${job.failures.length} failed`);
  return (
    <div className={`job job-done ${job.failures.length && !job.added && !job.unchanged ? "job-bad" : ""}`}>
      {parts.join(" · ") || "Nothing to add"} in {formatMs(job.finishedAt - job.startedAt)}
      {job.failures[0] && <div className="job-detail">{job.failures[0].title}: {job.failures[0].error}</div>}
    </div>
  );
}

function Library({ qdrantUp, refreshKey, filter, setFilter, onDeleted }) {
  const [sources, setSources] = useState([]);
  const [domains, setDomains] = useState([]);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(null);

  const load = useCallback(async () => {
    if (!qdrantUp) return;
    await send({ type: "ENSURE_OFFSCREEN" });
    const f = {};
    if (filter.domain) f.domain = filter.domain;
    if (filter.date) f.indexedAfter = new Date(filter.date).getTime();
    const res = await send({ type: "LIST_LIBRARY", filter: f }).catch(() => null);
    if (!res?.ok) {
      setError(res?.qdrant?.message || "Couldn't load the library.");
      return;
    }
    setError(null);
    setSources(res.sources);
    setDomains((prev) => Array.from(new Set([...prev, ...res.sources.map((s) => s.domain)])).sort());
  }, [qdrantUp, filter.domain, filter.date]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const del = async (s) => {
    const res = await send({ type: "DELETE_FROM_LIBRARY", url: s.canonicalUrl }).catch(() => null);
    setConfirming(null);
    if (!res?.ok) {
      setError(`Couldn't delete: ${res?.qdrant?.message || res?.error || "unknown error"}`);
      return;
    }
    onDeleted(s);
    load();
  };

  return (
    <div className="library">
      <div className="filters">
        <select value={filter.domain} onChange={(e) => setFilter({ ...filter, domain: e.target.value })} aria-label="Filter by domain">
          <option value="">All domains</option>
          {domains.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <input type="date" value={filter.date} onChange={(e) => setFilter({ ...filter, date: e.target.value })} title="Only sources indexed on or after this date" />
        {(filter.domain || filter.date) && <button className="icon-btn small" onClick={() => setFilter({ domain: "", date: "" })} title="Clear filters"><CloseIcon /></button>}
      </div>
      <p className="hint">The Library is everything you've indexed, kept in Qdrant across restarts. Filters here also narrow "Library" questions.</p>
      {error && <div className="error-box">{error}</div>}
      {!error && sources.length === 0 && <p className="empty">Nothing in the library yet.</p>}
      <ul className="rows">
        {sources.map((s) => (
          <li key={s.sourceKey} className="row">
            <div className="row-main">
              <span className="row-title" title={s.canonicalUrl}>{s.title || s.canonicalUrl}</span>
              <span className="row-sub">{s.domain} · {timeAgo(s.indexedAt)} · {s.chunkCount} chunks</span>
            </div>
            {confirming === s.sourceKey ? (
              <div className="confirm">
                <button className="btn btn-danger btn-sm" onClick={() => del(s)}>Delete for good</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setConfirming(null)}>Cancel</button>
              </div>
            ) : (
              <button className="icon-btn small" onClick={() => setConfirming(s.sourceKey)} title="Delete from library (permanent)" aria-label={`Delete ${s.title} from library`}><TrashIcon /></button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Pages({ workingSet, job, qdrantUp, filter, setFilter, onRemove, onLibraryDeleted }) {
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showLibrary, setShowLibrary] = useState(false);
  const wasRunning = React.useRef(false);

  // Refresh the library when a job finishes, including one that finished while the popup was closed.
  useEffect(() => {
    if (wasRunning.current && !job?.running) setRefreshKey((k) => k + 1);
    wasRunning.current = !!job?.running;
  }, [job?.running]);

  const start = async (all) => {
    setError(null);
    await send({ type: "ENSURE_OFFSCREEN" }).catch(() => {});
    send({ type: "WARM_EMBEDDER" }).catch(() => {});
    const res = await send({ type: "START_INDEX_JOB", all }).catch((e) => ({ ok: false, error: String(e) }));
    if (!res?.ok) setError(res.error);
  };
  const running = !!job?.running;

  return (
    <div className="pages">
      <section>
        <div className="section-head">
          <h2>Working set</h2>
          <div className="btn-row">
            <button className="btn btn-primary btn-sm" disabled={running} onClick={() => start(false)}>+ Add this tab</button>
            <button className="btn btn-ghost btn-sm" disabled={running} onClick={() => start(true)} title="Index every web page open in this window">Add all tabs</button>
          </div>
        </div>
        <JobBar job={job} />
        {error && <div className="error-box">{error}</div>}
        {workingSet.length === 0 ? (
          <p className="empty">No pages yet. Add the tab you're on, then ask a question.</p>
        ) : (
          <ul className="rows">
            {workingSet.map((t) => (
              <li key={t.sourceKey} className="row">
                <div className="row-main">
                  <span className="row-title" title={t.canonicalUrl}>{t.title || t.canonicalUrl}</span>
                  <span className="row-sub">{t.domain}</span>
                </div>
                <button className="icon-btn small" onClick={() => onRemove(t.tabId)} title="Remove from working set (keeps the library copy)" aria-label={`Remove ${t.title}`}><CloseIcon /></button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <button className={`section-toggle ${showLibrary ? "open" : ""}`} onClick={() => setShowLibrary((v) => !v)} aria-expanded={showLibrary}>
          <span className="chev"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg></span>
          <h2>Library</h2>
        </button>
        {showLibrary && <Library qdrantUp={qdrantUp} refreshKey={refreshKey} filter={filter} setFilter={setFilter} onDeleted={onLibraryDeleted} />}
      </section>
    </div>
  );
}
