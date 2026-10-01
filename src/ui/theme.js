// "light" | "dark" | "system". Kept in localStorage (same origin for every extension page) so
// theme-init.js can read it synchronously before first paint, which avoids a flash of light mode.
// No React here on purpose: theme-init.js bundles this file alone.
const KEY = "amt-theme";
export const THEME_EVENT = "amt-theme-change";
const dark = () => window.matchMedia("(prefers-color-scheme: dark)");

export function getThemePref() {
  try {
    return localStorage.getItem(KEY) || "system";
  } catch {
    return "system";
  }
}

export function applyTheme(pref = getThemePref()) {
  const isDark = pref === "dark" || (pref === "system" && dark().matches);
  document.documentElement.classList.toggle("dark", isDark);
}

export function setThemePref(pref) {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* storage blocked: the choice just won't persist */
  }
  applyTheme(pref);
  window.dispatchEvent(new Event(THEME_EVENT));
}

// Subscribe for useSyncExternalStore; also re-applies "system" when the OS theme flips.
export function subscribeTheme(cb) {
  const mq = dark();
  const onSystem = () => {
    if (getThemePref() === "system") applyTheme("system");
  };
  window.addEventListener(THEME_EVENT, cb);
  mq.addEventListener("change", onSystem);
  return () => {
    window.removeEventListener(THEME_EVENT, cb);
    mq.removeEventListener("change", onSystem);
  };
}
