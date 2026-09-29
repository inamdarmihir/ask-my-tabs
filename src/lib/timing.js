// Tiny stage timer used to report where time goes when indexing a page or answering a question.
// `time(name, fn)` accumulates wall-clock time per stage (safe to call for stages that overlap or
// repeat, e.g. one "retrieve" stage covering several parallel searches); `summary()` returns
// rounded milliseconds. The clock is injectable so tests are deterministic.

export function startTimer(now = () => performance.now()) {
  const start = now();
  const stages = {};
  return {
    async time(name, fn) {
      const t = now();
      try {
        return await fn();
      } finally {
        stages[name] = (stages[name] || 0) + (now() - t);
      }
    },
    summary() {
      const rounded = {};
      for (const [k, v] of Object.entries(stages)) rounded[k] = Math.round(v);
      return { totalMs: Math.round(now() - start), stages: rounded };
    },
  };
}

// "1.3 s" for >= 1 s, otherwise "420 ms".
export function formatMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}
