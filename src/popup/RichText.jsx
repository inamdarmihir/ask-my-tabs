import React from "react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../ui/overlay.jsx";
import { SiteAvatar } from "../ui/primitives.jsx";
import { cn } from "../ui/cn.js";

// Small, dependency-free renderer for the subset of Markdown a small model actually emits:
// paragraphs, "-"/"1." lists, **bold**, `code`. [n] becomes a citation chip when n refers to a real
// snippet (hover for a preview, click to jump to the source); out-of-range numbers are flagged
// instead of rendered as dead links.
const TOKEN = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[\d+\])/g;

const chipClass = "mx-px inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-md px-1 align-[1px] text-[10.5px] font-semibold leading-none";

function Cite({ n, citation, onCite }) {
  if (!citation) {
    return (
      <span className={cn(chipClass, "bg-destructive-soft text-destructive")} title="This number doesn't match any supplied snippet">
        {n}
      </span>
    );
  }
  return (
    <HoverCard openDelay={120} closeDelay={80}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          onClick={() => onCite(n)}
          aria-label={`Source ${n}: ${citation.tabTitle || citation.domain}`}
          className={cn(chipClass, "bg-accent text-accent-foreground transition-colors hover:bg-primary hover:text-primary-foreground")}
        >
          {n}
        </button>
      </HoverCardTrigger>
      <HoverCardContent>
        <div className="flex items-center gap-2">
          <SiteAvatar domain={citation.domain} className="size-6 text-[11px]" />
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium">{citation.tabTitle || citation.domain}</p>
            <p className="truncate text-[11px] text-muted-foreground">{citation.domain}</p>
          </div>
        </div>
        <p className="mt-2 line-clamp-5 border-l-2 border-primary/40 pl-2 text-pretty text-xs text-muted-foreground">{citation.text}</p>
        <p className="mt-2 text-[11px] text-muted-foreground">Click to see this source below</p>
      </HoverCardContent>
    </HoverCard>
  );
}

function inline(text, citations, onCite, keyPrefix) {
  const out = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyPrefix}-${i++}`;
    if (tok.startsWith("**")) out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    else if (tok[0] === "`") out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    else {
      const n = Number(tok.slice(1, -1));
      out.push(<Cite key={key} n={n} citation={citations.find((c) => c.index === n) || null} onCite={onCite} />);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function RichText({ text, citations = [], onCite = () => {} }) {
  const blocks = [];
  let list = null;
  const flush = () => {
    if (list) blocks.push(list);
    list = null;
  };
  (text || "").split("\n").forEach((raw, idx) => {
    const line = raw.trimEnd();
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    if (heading) {
      flush();
      blocks.push({ h: heading[1], key: `h${idx}` });
      return;
    }
    const bullet = line.match(/^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/);
    if (bullet) {
      const ordered = !!bullet[1];
      if (!list || list.ordered !== ordered) {
        flush();
        list = { ordered, items: [], key: `l${idx}` };
      }
      list.items.push(bullet[2]);
    } else if (line.trim() === "") {
      flush();
    } else {
      flush();
      blocks.push({ p: line, key: `p${idx}` });
    }
  });
  flush();

  return (
    <div className="prose-answer">
      {blocks.map((b) =>
        b.h !== undefined ? (
          <h3 key={b.key}>{inline(b.h, citations, onCite, b.key)}</h3>
        ) : b.p !== undefined ? (
          <p key={b.key}>{inline(b.p, citations, onCite, b.key)}</p>
        ) : b.ordered ? (
          <ol key={b.key}>{b.items.map((t, i) => <li key={i}>{inline(t, citations, onCite, `${b.key}-${i}`)}</li>)}</ol>
        ) : (
          <ul key={b.key}>{b.items.map((t, i) => <li key={i}>{inline(t, citations, onCite, `${b.key}-${i}`)}</li>)}</ul>
        ),
      )}
    </div>
  );
}
