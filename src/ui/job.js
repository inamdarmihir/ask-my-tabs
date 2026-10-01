// Pure helpers over the indexing job stored in chrome.storage.session by background.js:
// {running, total, done, added, unchanged, failures, current: {title, stage, done, total}, startedAt, finishedAt}

export const JOB_STAGES = ["Read page", "Embed text", "Save"];

const STAGE_INDEX = { reading: 0, embedding: 1, saving: 2 };

export function stageIndex(job) {
  return STAGE_INDEX[job?.current?.stage] ?? 0;
}

// Overall 0-100 across every page in the job. Within a page, reading is ~5%, embedding fills the
// bulk (by chunk), and saving is ~95%, so the bar moves steadily instead of jumping per page.
export function jobPercent(job) {
  if (!job?.total) return 0;
  const cur = job.current;
  let within = 0;
  if (cur?.stage === "embedding" && cur.total) within = 0.1 + 0.85 * (cur.done / cur.total);
  else if (cur?.stage === "saving") within = 0.95;
  else if (cur) within = 0.05;
  return Math.min(100, Math.round(((job.done + within) / job.total) * 100));
}

export function jobDetail(job) {
  const cur = job?.current;
  if (!cur) return "Starting...";
  if (cur.stage === "embedding") return cur.total ? `Embedding chunk ${cur.done} of ${cur.total}` : "Embedding";
  if (cur.stage === "saving") return "Saving to your library";
  return "Reading the page";
}
