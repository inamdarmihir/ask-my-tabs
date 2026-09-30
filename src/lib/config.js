// User configuration store. All runtime settings live here; nothing else constructs a Qdrant
// URL or LLM provider string by hand. The schema is intentionally flat -- no nested objects --
// so a partial `saveConfig({ llmProvider: "groq" })` patch works without a full read-modify-write
// cycle, and `chrome.storage.onChanged` listeners see individual key diffs.
//
// Defaults are chosen for the local-first experience the original codebase was built around:
// a user who just cloned the repo and ran `docker compose up -d` should not need to touch
// settings at all. Cloud and API-key paths are opt-in via the settings page.

export const CONFIG_KEY = "ask-my-tabs-config";

// LLM providers that speak the OpenAI Chat Completions wire format (same request/response
// shape, different base URL and auth header). Adding a provider here is sufficient -- no other
// switch statement needs updating.
export const OPENAI_COMPATIBLE_PROVIDERS = {
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-6-luna",
    keyHint: "sk-...",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  groq: {
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    keyHint: "gsk_...",
    keyUrl: "https://console.groq.com/keys",
  },
};

// Gemini uses a different wire format (different request body, different auth mechanism) and is
// handled separately in llm-api.js. It is listed here only so the settings UI can enumerate it.
export const GEMINI_PROVIDER = {
  gemini: {
    label: "Google Gemini",
    defaultModel: "gemini-1.5-flash",
    keyHint: "AIza...",
    keyUrl: "https://aistudio.google.com/app/apikey",
  },
};

export const ALL_API_PROVIDERS = { ...OPENAI_COMPATIBLE_PROVIDERS, ...GEMINI_PROVIDER };

export const DEFAULT_CONFIG = {
  // Qdrant connection. An empty apiKey means no Authorization header (local Docker default).
  qdrantUrl: "http://127.0.0.1:6333",
  qdrantApiKey: "",

  // LLM. "webllm" requires WebGPU + a ~0.5 GB one-time model download. API providers need a key.
  llmProvider: "webllm", // "openai" | "groq" | "gemini" | "webllm"
  llmApiKey: "",
  llmModel: "", // empty = use the provider's defaultModel from OPENAI_COMPATIBLE_PROVIDERS
  // Optional OpenAI-compatible endpoint (Azure, Ollama, LM Studio, a proxy). Empty = the provider's own URL.
  llmBaseUrl: "",

  // Retrieval mode. Users rarely need to change this; it is exposed in settings for power
  // users who want to compare modes. See src/lib/agent.js and DECISIONS.md for what each means.
  retrievalMode: "hybrid", // "hybrid" | "dense" | "sparse"

  // How answers are produced. "deep" = a tool-using research agent (deepagents/LangGraph) that plans,
  // searches and reads your pages as needed; used only with OpenAI-compatible providers. "pipeline" =
  // the fixed fast path (plan, read or search, write). Anything the deep agent can't run falls back to it.
  agentMode: "deep", // "deep" | "pipeline"
};

// Returns the merged config (stored values on top of defaults). Works in both Chrome extension
// context and Node.js (tests, eval harness) -- in Node, chrome.storage is absent so defaults
// are returned directly, which is the right behaviour for a test environment that doesn't
// touch real storage.
export async function getConfig() {
  if (typeof chrome === "undefined" || !chrome?.storage?.local) {
    return { ...DEFAULT_CONFIG };
  }
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  return { ...DEFAULT_CONFIG, ...(stored[CONFIG_KEY] || {}) };
}

// Persists a partial patch over the current config. Only the keys present in `patch` are
// updated; all others are left unchanged. Callers must not pass keys outside DEFAULT_CONFIG --
// this keeps the schema authoritative and prevents accidental key proliferation.
export async function saveConfig(patch) {
  if (typeof chrome === "undefined" || !chrome?.storage?.local) return;
  const current = await getConfig();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [CONFIG_KEY]: next });
  return next;
}
