import React from "react";
import { AnimatePresence, motion } from "motion/react";
import { Cpu, Layers, LoaderCircle } from "lucide-react";
import { Progress } from "../ui/progress.jsx";
import { jobDetail, jobPercent } from "../ui/job.js";

const MODEL_TITLE = { download: "Downloading answer model", load: "Loading answer model", init: "Preparing answer model" };

function Row({ icon: Icon, title, detail, pct, onClick }) {
  const Comp = onClick ? "button" : "div";
  return (
    <motion.div
      layout
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.2 }}
      className="overflow-hidden"
    >
      <Comp onClick={onClick} className="flex w-full flex-col gap-1.5 px-3 py-2 text-left" {...(onClick ? { type: "button", "aria-label": `${title}. Open details` } : {})}>
        <span className="flex items-center gap-2 text-xs">
          <Icon className="size-3.5 shrink-0 text-primary" />
          <span className="truncate font-medium text-foreground">{title}</span>
          <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{pct !== null ? `${pct}%` : <LoaderCircle className="size-3.5 animate-spin" />}</span>
        </span>
        <Progress value={pct} aria-label={title} />
        {detail && <span className="truncate text-[11px] text-muted-foreground">{detail}</span>}
      </Comp>
    </motion.div>
  );
}

// One slim bar under the header for anything running in the background: the model download and
// page indexing. Visible on every tab except where the same progress is already drawn in full.
export function ActivityStrip({ model, job, onOpenPages, hideModel = false, hideJob = false }) {
  const modelPct = model.progress?.pct ?? null;
  const modelOn = model.loading && model.onDevice && !hideModel;
  return (
    <div className="border-y border-border bg-accent/40 empty:hidden">
      <AnimatePresence initial={false}>
        {modelOn && (
          <Row
            key="model"
            icon={Cpu}
            title={MODEL_TITLE[model.progress?.phase || "init"]}
            pct={modelPct}
            detail={model.progress?.mb ? `${Math.round(model.progress.mb)} MB so far. One-time, runs in the background.` : "One-time, runs in the background."}
          />
        )}
        {job?.running && !hideJob && (
          <Row
            key="job"
            icon={Layers}
            title={`Indexing page ${Math.min(job.done + 1, job.total)} of ${job.total}`}
            pct={jobPercent(job)}
            detail={`${jobDetail(job)}${job.current?.title ? ` · ${job.current.title}` : ""}`}
            onClick={onOpenPages}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
