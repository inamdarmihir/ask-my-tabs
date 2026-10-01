// Turns the two progress shapes the model loaders emit into one structure the UI can draw as a bar.
//
//   transformers.js: {status: "progress", file, progress: 0-100, loaded, total}  (bytes)
//   WebLLM:          {progress: 0-1, text}; text is a log line such as
//                    "Fetching param cache[5/30]: 240MB fetched. 16% completed, 12 secs elapsed. ..."
//
// Returns {pct, phase, mb, detail} or null for events not worth showing.
//   pct    0-100, or null when the loader gave no percentage
//   phase  "download" (network), "load" (cache to GPU memory, shader compile) or "init"
//   mb     megabytes transferred so far, when the loader says
//   detail short human sentence, also used as the plain-text fallback status

const PHASE_NAMES = { download: "Downloading", load: "Loading", init: "Preparing" };

function phaseFromText(text) {
  if (/fetching|fetch/i.test(text)) return "download";
  if (/loading|finish/i.test(text)) return "load";
  return "init";
}

export function normalizeProgress(label, p) {
  if (typeof p === "string") return { pct: null, phase: "init", mb: null, detail: p };
  if (!p) return null;

  if (typeof p.text === "string") {
    const phase = phaseFromText(p.text);
    const pct = typeof p.progress === "number" && p.progress > 0 && p.progress < 1 ? Math.round(p.progress * 100) : null;
    const mbMatch = p.text.match(/(\d+(?:\.\d+)?)\s*MB/i);
    const mb = mbMatch ? Number(mbMatch[1]) : null;
    return { pct, phase, mb, detail: pct === null ? p.text : `${PHASE_NAMES[phase]} ${label} model... ${pct}%` };
  }

  if (p.status === "progress" && typeof p.progress === "number") {
    const pct = Math.max(0, Math.min(100, Math.round(p.progress)));
    const mb = typeof p.loaded === "number" ? Math.round((p.loaded / 1e6) * 10) / 10 : null;
    return { pct, phase: "download", mb, detail: `Downloading ${label} model... ${pct}%` };
  }
  return null;
}
