import React from "react";

// Small, dependency-free renderer for the subset of Markdown a small model actually emits:
// paragraphs, "-"/"1." lists, **bold**, `code`. [n] becomes a clickable citation chip when n
// refers to a real snippet; out-of-range numbers are flagged instead of rendered as dead links.
const TOKEN = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[\d+\])/g;

function inline(text, citationCount, onCite, keyPrefix) {
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
      out.push(
        n >= 1 && n <= citationCount ? (
          <button key={key} className="cite" onClick={() => onCite(n)} title={`Show source ${n}`}>{n}</button>
        ) : (
          <span key={key} className="cite cite-invalid" title="This number doesn't match any supplied snippet">{n}</span>
        ),
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function RichText({ text, citationCount = 0, onCite = () => {} }) {
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
    <div className="rich">
      {blocks.map((b) =>
        b.h !== undefined ? (
          <h3 key={b.key}>{inline(b.h, citationCount, onCite, b.key)}</h3>
        ) : b.p !== undefined ? (
          <p key={b.key}>{inline(b.p, citationCount, onCite, b.key)}</p>
        ) : b.ordered ? (
          <ol key={b.key}>{b.items.map((t, i) => <li key={i}>{inline(t, citationCount, onCite, `${b.key}-${i}`)}</li>)}</ol>
        ) : (
          <ul key={b.key}>{b.items.map((t, i) => <li key={i}>{inline(t, citationCount, onCite, `${b.key}-${i}`)}</li>)}</ul>
        ),
      )}
    </div>
  );
}
