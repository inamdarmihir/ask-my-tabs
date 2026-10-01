import React, { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, LibraryBig, Search, Trash2, X } from "lucide-react";
import { Button } from "../ui/button.jsx";
import { Select } from "../ui/form.jsx";
import { EmptyState, Input, Notice, SiteAvatar, Skeleton } from "../ui/primitives.jsx";
import { ConfirmDialog, Tip } from "../ui/overlay.jsx";
import { toast } from "../ui/toaster.jsx";
import { send, timeAgo } from "../ui/hooks.js";

const ALL = "__all__";

export function Library({ qdrantUp, refreshKey, filter, setFilter, onDeleted }) {
  const [sources, setSources] = useState(null);
  const [domains, setDomains] = useState([]);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
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
      setSources([]);
      return;
    }
    setError(null);
    setSources(res.sources);
    setDomains((prev) => Array.from(new Set([...prev, ...res.sources.map((s) => s.domain)])).sort());
  }, [qdrantUp, filter.domain, filter.date]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !sources) return sources;
    return sources.filter((s) => `${s.title || ""} ${s.domain} ${s.canonicalUrl}`.toLowerCase().includes(q));
  }, [sources, query]);

  const del = async (s) => {
    const res = await send({ type: "DELETE_FROM_LIBRARY", url: s.canonicalUrl }).catch(() => null);
    if (!res?.ok) {
      toast.error(`Couldn't delete: ${res?.qdrant?.message || res?.error || "unknown error"}`);
      return;
    }
    toast.success("Removed from your library");
    onDeleted(s);
    load();
  };

  const filtered = !!(filter.domain || filter.date);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-pretty text-xs text-muted-foreground">Everything you've indexed, kept in Qdrant across restarts. Filters here also narrow "Library" questions.</p>

      <div className="flex flex-col gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your library" aria-label="Search your library" className="h-8 pl-8" />
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={filter.domain || ALL}
            onValueChange={(v) => setFilter({ ...filter, domain: v === ALL ? "" : v })}
            options={[{ value: ALL, label: "All sites" }, ...domains.map((d) => ({ value: d, label: d }))]}
            aria-label="Filter by site"
            className="h-8 flex-1"
          />
          <div className="relative flex-1">
            <CalendarDays className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input type="date" value={filter.date} onChange={(e) => setFilter({ ...filter, date: e.target.value })} title="Only sources indexed on or after this date" aria-label="Indexed on or after" className="h-8 pl-8 text-xs" />
          </div>
          {filtered && (
            <Tip label="Clear filters">
              <Button variant="ghost" size="icon-sm" onClick={() => setFilter({ domain: "", date: "" })} aria-label="Clear filters"><X /></Button>
            </Tip>
          )}
        </div>
      </div>

      {error && <Notice tone="danger">{error}</Notice>}

      {!qdrantUp && !error ? (
        <Notice tone="warning">Connect your database to see your library.</Notice>
      ) : visible === null ? (
        <div className="flex flex-col gap-1.5" aria-busy="true">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full rounded-xl" />)}
        </div>
      ) : visible.length === 0 && !error ? (
        <EmptyState icon={LibraryBig} title={query || filtered ? "Nothing matches" : "Your library is empty"}>
          {query || filtered ? "Try a different search or clear the filters." : "Pages you add are saved here, so you can ask about them in any later session."}
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {visible.map((s) => (
            <li key={s.sourceKey} className="group flex items-center gap-2.5 rounded-xl border border-border bg-card p-2">
              <SiteAvatar domain={s.domain} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium" title={s.canonicalUrl}>{s.title || s.canonicalUrl}</p>
                <p className="truncate text-[11px] text-muted-foreground">{s.domain} · {timeAgo(s.indexedAt)} · {s.chunkCount} chunks</p>
              </div>
              <Tip label="Delete from library (permanent)">
                <Button variant="ghost" size="icon-sm" className="hover:text-destructive" onClick={() => setConfirming(s)} aria-label={`Delete ${s.title} from library`}>
                  <Trash2 />
                </Button>
              </Tip>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={!!confirming}
        onOpenChange={(o) => !o && setConfirming(null)}
        title="Delete from your library?"
        description={confirming ? `"${confirming.title || confirming.canonicalUrl}" will be removed from Qdrant for good. You can add the page again later.` : ""}
        confirmLabel="Delete for good"
        onConfirm={() => del(confirming)}
      />
    </div>
  );
}
