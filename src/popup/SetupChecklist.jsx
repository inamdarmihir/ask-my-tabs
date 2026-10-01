import React from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Check, LoaderCircle, RefreshCw, Settings } from "lucide-react";
import { cn } from "../ui/cn.js";
import { Button } from "../ui/button.jsx";
import { ModelDownload } from "../ui/model-download.jsx";

// What the user still has to do before the first question, in order. Shown in place of the chat's
// empty state until every step is done, so the next action is always one obvious button.
export function setupSteps({ qdrant, model, workingSet, scope }) {
  return [
    { id: "db", done: qdrant.status === "up", busy: qdrant.status === "checking" },
    { id: "model", done: !model.onDevice || model.ready },
    // Library questions don't need a working set.
    { id: "pages", done: workingSet.length > 0 || scope === "library" },
  ];
}

function StepBadge({ n, done, active }) {
  return (
    <span
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold transition-colors",
        done ? "bg-success text-white" : active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
      )}
    >
      <AnimatePresence mode="wait" initial={false}>
        {done ? (
          <motion.span key="c" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
            <Check className="size-3.5" strokeWidth={3} />
          </motion.span>
        ) : (
          <motion.span key="n" exit={{ scale: 0.4, opacity: 0 }}>{n}</motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

export function SetupChecklist({ qdrant, checkQdrant, model, downloadModel, steps, onGoPages }) {
  const activeIdx = steps.findIndex((s) => !s.done);
  const doneCount = steps.filter((s) => s.done).length;

  const items = [
    {
      title: "Connect your database",
      doneText: `Connected (${qdrant.location === "local" ? "on this computer" : "cloud"})`,
      body: qdrant.status === "checking" ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" /> Checking the connection...</p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-pretty text-xs text-muted-foreground">
            {qdrant.location === "local"
              ? "Can't reach Qdrant on this computer. Run \"docker compose up -d\" in the project folder, or switch to Qdrant Cloud in Settings."
              : "Can't reach your Qdrant Cloud cluster. Check the URL and API key in Settings."}
          </p>
          <div className="flex gap-2">
            <Button size="sm" onClick={checkQdrant}><RefreshCw /> Try again</Button>
            <Button size="sm" variant="outline" onClick={() => chrome.runtime.openOptionsPage()}><Settings /> Settings</Button>
          </div>
        </div>
      ),
    },
    {
      title: "Get the answer model ready",
      doneText: model.label ? `Using ${model.label}` : "On-device model ready",
      body: <ModelDownload model={model} onDownload={downloadModel} />,
    },
    {
      title: "Pick pages to ask about",
      doneText: "Pages added",
      body: (
        <div className="flex flex-col gap-2">
          <p className="text-pretty text-xs text-muted-foreground">Add the tabs you want answers from. Everything stays in your own database.</p>
          <Button size="sm" className="self-start" onClick={onGoPages}>Choose pages <ArrowRight /></Button>
        </div>
      ),
    },
  ];

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-3">
      <div className="text-center">
        <h2 className="text-balance text-base font-semibold">Let's get you set up</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{doneCount} of {steps.length} done</p>
      </div>
      <ol className="flex flex-col gap-2">
        {items.map((it, i) => {
          const s = steps[i];
          const active = i === activeIdx;
          return (
            <li key={it.title} className={cn("rounded-xl border bg-card p-3 transition-[border-color,opacity,box-shadow]", active ? "border-primary/40 shadow-soft" : "border-border", !active && !s.done && "opacity-60")}>
              <div className="flex items-center gap-2.5">
                <StepBadge n={i + 1} done={s.done} active={active} />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium">{it.title}</p>
                  {s.done && <p className="truncate text-xs text-muted-foreground">{it.doneText}</p>}
                </div>
              </div>
              <AnimatePresence initial={false}>
                {active && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                    <div className="pt-3 pl-[34px]">{it.body}</div>
                  </motion.div>
                )}
              </AnimatePresence>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
