import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getConfig, ALL_API_PROVIDERS } from "../lib/config.js";
import { getThemePref, setThemePref, subscribeTheme } from "./theme.js";

export function send(message) {
  return chrome.runtime.sendMessage(message);
}

export function useThemePref() {
  return [useSyncExternalStore(subscribeTheme, getThemePref), setThemePref];
}

// Live view of one chrome.storage key. `initial` must be a stable reference (module constant).
export function useStorage(area, key, initial) {
  const [value, setValue] = useState(initial);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    chrome.storage[area].get(key).then((r) => {
      if (!alive) return;
      if (r[key] !== undefined) setValue(r[key]);
      setLoaded(true);
    });
    const onChanged = (changes, name) => {
      if (name === area && changes[key]) setValue(changes[key].newValue ?? initial);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, [area, key, initial]);
  return [value, loaded];
}

export function useRuntimeMessages(handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const l = (m) => ref.current(m);
    chrome.runtime.onMessage.addListener(l);
    return () => chrome.runtime.onMessage.removeListener(l);
  }, []);
}

// Re-renders every second while `on`, so elapsed timers tick.
export function useNow(on) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

// Qdrant reachability. The offscreen bundle is large, so its listener may not be registered right
// after ENSURE_OFFSCREEN; retry briefly before calling the database down.
export function useQdrant() {
  const [state, setState] = useState({ status: "checking", location: "local" });
  const check = useCallback(async () => {
    setState((s) => ({ ...s, status: "checking" }));
    let location = "local";
    try {
      const cfg = await getConfig();
      location = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(cfg.qdrantUrl) ? "local" : "cloud";
    } catch {
      /* default */
    }
    for (let i = 0; i < 6; i++) {
      try {
        await send({ type: "ENSURE_OFFSCREEN" });
        const res = await send({ type: "QDRANT_HEALTH" });
        if (res) {
          const up = !!(res.ok && res.health?.reachable && res.health?.ready);
          setState({ status: up ? "up" : "down", location });
          return up;
        }
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
    setState({ status: "down", location });
    return false;
  }, []);
  useEffect(() => {
    check();
  }, [check]);
  return [state, check];
}

// Which answer model is active, and whether the on-device one is downloaded.
// `progress` is {pct: 0-100|null, phase: "download"|"load"|"init", mb, detail} while the on-device
// model loads. The offscreen document remembers the latest value, so reopening the popup mid-download
// still shows a live bar.
export function useModel() {
  const [state, setState] = useState({ label: null, onDevice: true, ready: false, progress: null, error: null, loading: false });
  const refresh = useCallback(async () => {
    let label = null;
    try {
      const cfg = await getConfig();
      const p = ALL_API_PROVIDERS[cfg.llmProvider];
      label = p ? `${p.label} ${cfg.llmModel || p.defaultModel}` : null;
    } catch {
      /* on-device */
    }
    let info = null;
    try {
      info = await send({ type: "GET_STATE" });
    } catch {
      /* offscreen not up yet */
    }
    setState((s) => ({
      ...s,
      label,
      onDevice: !label,
      ready: !!info?.modelsReady,
      loading: s.loading || !!info?.llmLoading,
      progress: info?.llmLoading ? info.llmProgress || s.progress : s.progress,
    }));
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useRuntimeMessages((m) => {
    // Only the on-device answer model is a big download; the embedder ships in the package.
    if (m.type === "MODEL_PROGRESS" && m.stage === "llm") {
      setState((s) => ({ ...s, loading: true, progress: { pct: m.pct ?? null, phase: m.phase ?? "download", mb: m.mb ?? null, detail: m.detail ?? null } }));
    } else if (m.type === "MODELS_READY") {
      setState((s) => ({ ...s, ready: true, progress: null, error: null, loading: false }));
    } else if (m.type === "MODEL_ERROR") {
      setState((s) => ({ ...s, error: m.error, loading: false, progress: null }));
    }
  });
  const download = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null, progress: { pct: null, phase: "init", mb: null, detail: "Starting..." } }));
    await send({ type: "ENSURE_OFFSCREEN" });
    send({ type: "LOAD_MODELS" }).catch(() => {});
  }, []);
  return [state, download, refresh];
}

// The page under the popup, plus how many regular web pages are open in this window.
export function useTabs() {
  const [state, setState] = useState({ current: null, open: [] });
  const refresh = useCallback(async () => {
    try {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const open = tabs.filter((t) => /^https?:\/\//.test(t.url || ""));
      const current = open.find((t) => t.active) || null;
      setState({ current, open });
    } catch {
      /* no tabs permission in this context */
    }
  }, []);
  useEffect(() => {
    refresh();
    const events = ["onCreated", "onRemoved", "onUpdated", "onActivated"];
    events.forEach((e) => chrome.tabs[e]?.addListener(refresh));
    return () => events.forEach((e) => chrome.tabs[e]?.removeListener(refresh));
  }, [refresh]);
  return state;
}

export function formatMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

export function timeAgo(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
