import React from "react";
import { AlertCircle, Download, RefreshCw } from "lucide-react";
import { Button } from "./button.jsx";
import { Progress } from "./progress.jsx";

const PHASE_TITLE = {
  download: "Downloading the answer model",
  load: "Loading it into memory",
  init: "Getting ready",
};

// Download control for the on-device answer model: a button, then a live progress bar, or the failure.
// `model` and `onDownload` come from useModel().
export function ModelDownload({ model, onDownload }) {
  const { loading, progress, error } = model;

  if (loading) {
    const pct = progress?.pct ?? null;
    const phase = progress?.phase || "init";
    return (
      <div className="flex flex-col gap-2" role="status" aria-live="polite">
        <div className="flex items-baseline justify-between gap-3 text-xs">
          <span className="font-medium text-foreground">{PHASE_TITLE[phase]}</span>
          <span className="tabular-nums text-muted-foreground">
            {pct !== null ? `${pct}%` : "Starting..."}
            {progress?.mb ? ` · ${Math.round(progress.mb)} MB` : ""}
          </span>
        </div>
        <Progress value={pct} aria-label="Model download progress" />
        <p className="text-xs text-muted-foreground">One-time download. You can close this, it keeps going in the background.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <div role="alert" className="flex gap-2 rounded-lg bg-destructive-soft p-2.5 text-xs text-destructive">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          <span className="text-pretty">{error}</span>
        </div>
      )}
      <div className="flex items-center gap-3">
        <Button onClick={onDownload} size="md">
          {error ? <RefreshCw /> : <Download />}
          {error ? "Try again" : "Download model"}
        </Button>
        {!error && <span className="whitespace-nowrap text-xs text-muted-foreground">About 0.5 GB, once</span>}
      </div>
    </div>
  );
}
