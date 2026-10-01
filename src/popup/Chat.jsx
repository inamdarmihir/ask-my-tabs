import React, { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Compass, Library, ListChecks, Sparkles, Lightbulb, Layers } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "../ui/cn.js";
import { Button } from "../ui/button.jsx";
import { Segmented } from "../ui/form.jsx";
import { Kbd } from "../ui/primitives.jsx";
import { Tip } from "../ui/overlay.jsx";
import { useNow } from "../ui/hooks.js";
import { AssistantMessage } from "./Message.jsx";

const SUGGESTIONS = [
  { text: "Summarize these pages in a few bullets", icon: ListChecks },
  { text: "What are the most important takeaways?", icon: Lightbulb },
  { text: "What should I look at first, and why?", icon: Compass },
];

function Hero({ workingSet, scope, onPick }) {
  return (
    <div className="m-auto flex w-full max-w-sm flex-col items-center gap-3 px-2 py-6 text-center">
      <span className="grid size-12 place-items-center rounded-2xl bg-gradient-to-br from-primary to-[color-mix(in_oklab,var(--primary),white_35%)] text-primary-foreground shadow-soft">
        <Sparkles className="size-6" />
      </span>
      <div>
        <h2 className="text-balance text-lg font-semibold tracking-tight">Ask across your pages</h2>
        <p className="mt-1 text-pretty text-xs text-muted-foreground">Answers are written from pages you've added and cite exactly where each claim came from.</p>
      </div>
      {scope === "working-set" && workingSet.length > 0 && (
        <div className="flex flex-wrap justify-center gap-1">
          {workingSet.slice(0, 4).map((w) => (
            <span key={w.sourceKey} title={w.canonicalUrl} className="max-w-[150px] truncate rounded-full border border-border bg-card px-2.5 py-0.5 text-[11px] text-muted-foreground">
              {w.title || w.domain}
            </span>
          ))}
          {workingSet.length > 4 && <span className="rounded-full border border-border bg-card px-2.5 py-0.5 text-[11px] text-muted-foreground">+{workingSet.length - 4} more</span>}
        </div>
      )}
      <div className="flex w-full flex-col gap-1.5">
        {SUGGESTIONS.map(({ text, icon: Icon }) => (
          <button key={text} type="button" onClick={() => onPick(text)} className="group flex items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2 text-left text-[13px] transition-[border-color,background-color,box-shadow] hover:border-primary/50 hover:bg-accent/50 hover:shadow-soft">
            <Icon className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
            <span className="flex-1">{text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Composer({ draft, setDraft, onSubmit, canSubmit, pending, placeholder, scope, setScope, workingSetCount, textareaRef }) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="mx-3 mb-3 mt-1 rounded-2xl border border-input bg-card shadow-soft transition-[border-color,box-shadow] focus-within:border-primary focus-within:ring-[3px] focus-within:ring-ring"
    >
      <textarea
        ref={textareaRef}
        rows={1}
        autoFocus
        value={draft}
        placeholder={placeholder}
        aria-label="Your question"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSubmit();
          }
        }}
        className="field-sizing-content block max-h-32 min-h-[44px] w-full resize-none bg-transparent px-3.5 pb-1 pt-3 text-[13.5px] leading-relaxed outline-none placeholder:text-muted-foreground/70"
      />
      <div className="flex items-center justify-between gap-2 px-2 pb-2">
        <Segmented
          value={scope}
          onValueChange={setScope}
          label="Where to search"
          options={[
            { value: "working-set", title: "Only the pages in your working set", label: (<><Layers className="size-3.5" />Working set{workingSetCount ? ` · ${workingSetCount}` : ""}</>) },
            { value: "library", title: "Everything you have ever indexed", label: (<><Library className="size-3.5" />Library</>) },
          ]}
        />
        <Tip label={pending ? "Wait for the current answer" : <span className="flex items-center gap-1.5">Send <Kbd className="border-background/30 bg-transparent text-background">Enter</Kbd></span>} side="top">
          <span>
            <Button type="submit" size="icon" className="rounded-full" disabled={!canSubmit} aria-label="Send">
              <ArrowUp className="size-4" strokeWidth={2.5} />
            </Button>
          </span>
        </Tip>
      </div>
    </form>
  );
}

export function Chat({ thread, workingSet, busy, scope, setScope, canAsk, blockedHint, onSend, setup }) {
  const [draft, setDraft] = useState("");
  const scroller = useRef(null);
  const textareaRef = useRef(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const messages = thread?.messages || [];
  const pending = messages.some((m) => m.status === "pending");
  const now = useNow(pending);
  const last = messages[messages.length - 1];

  // Follow the answer as it streams, unless the user scrolled up to read.
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight });
  }, [thread?.id, messages.length, last?.content, last?.status, last?.statusText]);

  useEffect(() => {
    stick.current = true;
    setAway(false);
    textareaRef.current?.focus();
  }, [thread?.id]);

  const onScroll = () => {
    const el = scroller.current;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    stick.current = nearBottom;
    setAway(!nearBottom);
  };

  const canSubmit = !!draft.trim() && !busy && !pending && canAsk;
  const submit = (text = draft) => {
    const q = text.trim();
    if (!q || busy || pending || !canAsk) return;
    stick.current = true;
    onSend(q);
    setDraft("");
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scroller} onScroll={onScroll} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-2 pt-4 [scrollbar-gutter:stable]">
        {messages.length === 0 ? (
          setup || <Hero workingSet={workingSet} scope={scope} onPick={submit} />
        ) : (
          messages.map((m, idx) =>
            m.role === "user" ? (
              <motion.div key={m.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }} className="flex justify-end">
                <div className="max-w-[85%] whitespace-pre-wrap text-pretty rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-[13.5px] text-primary-foreground [overflow-wrap:anywhere]">{m.content}</div>
              </motion.div>
            ) : (
              <AssistantMessage
                key={m.id}
                message={m}
                workingSet={workingSet}
                now={now}
                onRegenerate={idx === messages.length - 1 && !pending && canAsk ? () => onSend(messages[idx - 1].content) : null}
              />
            ),
          )
        )}
      </div>

      <AnimatePresence>
        {away && (
          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }} className="pointer-events-none absolute inset-x-0 bottom-[118px] flex justify-center">
            <Button
              variant="outline"
              size="sm"
              className="pointer-events-auto rounded-full shadow-soft"
              onClick={() => {
                stick.current = true;
                scroller.current.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
              }}
            >
              <ArrowDown /> Latest
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      <Composer
        draft={draft}
        setDraft={setDraft}
        onSubmit={() => submit()}
        canSubmit={canSubmit}
        pending={pending}
        placeholder={canAsk ? "Ask a question about your pages..." : blockedHint}
        scope={scope}
        setScope={setScope}
        workingSetCount={workingSet.length}
        textareaRef={textareaRef}
      />
    </div>
  );
}
