// Pure conversions between the flat stored config (see lib/config.js) and the shapes the settings
// and onboarding forms edit. No DOM or chrome.* here, so they run in Node tests.

export const LOCAL_QDRANT_URL = "http://127.0.0.1:6333";

// Storage form: {mode: "local" | "cloud", url, apiKey}
export function storageFromConfig(cfg) {
  const local = cfg.qdrantUrl === LOCAL_QDRANT_URL && !cfg.qdrantApiKey;
  return { mode: local ? "local" : "cloud", url: cfg.qdrantUrl === LOCAL_QDRANT_URL ? "" : cfg.qdrantUrl || "", apiKey: cfg.qdrantApiKey || "" };
}

export function storagePatch(s) {
  const local = s.mode === "local";
  return { qdrantUrl: local ? LOCAL_QDRANT_URL : s.url.trim() || LOCAL_QDRANT_URL, qdrantApiKey: local ? "" : s.apiKey.trim() };
}

// Model form: {type: "api" | "local", provider, apiKey, model, baseUrl}
export function modelFromConfig(cfg) {
  const local = cfg.llmProvider === "webllm";
  return { type: local ? "local" : "api", provider: local ? "openai" : cfg.llmProvider, apiKey: cfg.llmApiKey || "", model: cfg.llmModel || "", baseUrl: cfg.llmBaseUrl || "" };
}

export function modelPatch(m) {
  const local = m.type === "local";
  return {
    llmProvider: local ? "webllm" : m.provider,
    llmApiKey: local ? "" : m.apiKey.trim(),
    llmModel: local ? "" : m.model.trim(),
    llmBaseUrl: local ? "" : m.baseUrl.trim(),
  };
}

// True when the two patches would store different values, for the "unsaved changes" indicator.
export function patchesDiffer(a, b) {
  return JSON.stringify(a) !== JSON.stringify(b);
}
