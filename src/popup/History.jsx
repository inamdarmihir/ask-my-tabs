import React, { useMemo, useState } from "react";
import { MessageSquare, Plus, Search, Trash2 } from "lucide-react";
import { cn } from "../ui/cn.js";
import { Button } from "../ui/button.jsx";
import { EmptyState, Input } from "../ui/primitives.jsx";
import { Sheet, Tip } from "../ui/overlay.jsx";
import { timeAgo } from "../ui/hooks.js";

const DAY = 24 * 60 * 60 * 1000;

function groupByAge(threads, now) {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const groups = [
    { label: "Today", items: [] },
    { label: "Yesterday", items: [] },
    { label: "Previous 7 days", items: [] },
    { label: "Older", items: [] },
  ];
  for (const t of threads) {
    if (t.updatedAt >= startOfToday) groups[0].items.push(t);
    else if (t.updatedAt >= startOfToday - DAY) groups[1].items.push(t);
    else if (t.updatedAt >= startOfToday - 7 * DAY) groups[2].items.push(t);
    else groups[3].items.push(t);
  }
  return groups.filter((g) => g.items.length);
}

export function History({ open, onOpenChange, container, threads, activeId, onOpen, onNew, onDelete }) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? threads.filter((t) => t.title.toLowerCase().includes(q)) : threads;
  }, [threads, query]);
  const groups = useMemo(() => groupByAge(shown, Date.now()), [shown]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange} container={container} title="History" description="Your saved conversations">
      <Button onClick={onNew}>
        <Plus /> New chat
      </Button>
      {threads.length > 5 && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search chats" aria-label="Search chats" className="h-8 pl-8" />
        </div>
      )}
      <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-1">
        {threads.length === 0 ? (
          <EmptyState icon={MessageSquare} title="No conversations yet">They're saved here automatically.</EmptyState>
        ) : groups.length === 0 ? (
          <p className="px-1 text-xs text-muted-foreground">No chats match "{query}".</p>
        ) : (
          groups.map((g) => (
            <section key={g.label}>
              <h3 className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{g.label}</h3>
              <ul className="flex flex-col gap-0.5">
                {g.items.map((t) => {
                  const questions = t.messages.filter((m) => m.role === "user").length;
                  const pending = t.messages.some((m) => m.status === "pending");
                  return (
                    <li key={t.id} className={cn("group flex items-center rounded-lg transition-colors hover:bg-muted", t.id === activeId && "bg-accent hover:bg-accent")}>
                      <button type="button" onClick={() => onOpen(t.id)} className="flex min-w-0 flex-1 flex-col items-start px-2.5 py-1.5 text-left" aria-current={t.id === activeId ? "true" : undefined}>
                        <span className={cn("w-full truncate text-[13px] font-medium", t.id === activeId && "text-accent-foreground")}>{t.title}</span>
                        <span className="text-[11px] text-muted-foreground">
                          {pending ? <span className="text-primary">answering...</span> : `${questions} question${questions === 1 ? "" : "s"}`} · {timeAgo(t.updatedAt)}
                        </span>
                      </button>
                      <Tip label="Delete chat">
                        <Button variant="ghost" size="icon-sm" className="mr-1 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100" onClick={() => onDelete(t.id)} aria-label={`Delete chat ${t.title}`}>
                          <Trash2 />
                        </Button>
                      </Tip>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>
    </Sheet>
  );
}
