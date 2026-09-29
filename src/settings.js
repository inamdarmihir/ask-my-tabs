import { getConfig, saveConfig, DEFAULT_CONFIG, OPENAI_COMPATIBLE_PROVIDERS, GEMINI_PROVIDER } from "./lib/config.js";
import { makeClient } from "./lib/qdrant.js";
import { testApiKey } from "./lib/llm-api.js";

const ALL_PROVIDERS = { ...OPENAI_COMPATIBLE_PROVIDERS, ...GEMINI_PROVIDER };

const el = {
  qdrantModeRadios: document.querySelectorAll('input[name="qdrantMode"]'),
  qdrantCloudFields: document.getElementById("qdrant-cloud-fields"),
  qdrantUrl: document.getElementById("qdrant-url"),
  qdrantApiKey: document.getElementById("qdrant-apikey"),
  testQdrantBtn: document.getElementById("test-qdrant-btn"),
  qdrantStatus: document.getElementById("qdrant-status"),

  llmTypeRadios: document.querySelectorAll('input[name="llmType"]'),
  llmApiFields: document.getElementById("llm-api-fields"),
  llmLocalFields: document.getElementById("llm-local-fields"),
  llmProvider: document.getElementById("llm-provider"),
  llmApiKey: document.getElementById("llm-apikey"),
  llmModel: document.getElementById("llm-model"),
  llmModelHint: document.getElementById("llm-model-hint"),
  llmKeyUrl: document.getElementById("llm-key-url"),
  testLlmBtn: document.getElementById("test-llm-btn"),
  llmStatus: document.getElementById("llm-status"),

  saveBtn: document.getElementById("save-btn"),
  saveStatus: document.getElementById("save-status"),
  resetBtn: document.getElementById("reset-btn"),
};

function updateQdrantVisibility() {
  const mode = document.querySelector('input[name="qdrantMode"]:checked').value;
  el.qdrantCloudFields.hidden = mode === "local";
}

function updateLLMVisibility() {
  const type = document.querySelector('input[name="llmType"]:checked').value;
  el.llmApiFields.hidden = type === "local";
  el.llmLocalFields.hidden = type === "api";
}

function updateLLMProviderHints() {
  const provider = el.llmProvider.value;
  const config = ALL_PROVIDERS[provider];
  if (!config) return;
  el.llmModelHint.textContent = `Default: ${config.defaultModel}`;
  el.llmApiKey.placeholder = config.keyHint;
  el.llmKeyUrl.href = config.keyUrl;
  el.llmStatus.textContent = "";
}

async function handleTestLLM() {
  el.testLlmBtn.disabled = true;
  el.llmStatus.className = "status-badge";
  el.llmStatus.textContent = "Testing...";
  const r = await testApiKey({
    provider: el.llmProvider.value,
    apiKey: el.llmApiKey.value.trim(),
    model: el.llmModel.value.trim(),
  });
  el.llmStatus.className = `status-badge ${r.ok ? "success" : "error"}`;
  el.llmStatus.textContent = `${r.ok ? "✓" : "✗"} ${r.message}`;
  el.testLlmBtn.disabled = false;
}

async function loadSettings() {
  const cfg = await getConfig();
  
  // Qdrant
  const isLocalQdrant = cfg.qdrantUrl === "http://127.0.0.1:6333" && !cfg.qdrantApiKey;
  document.querySelector(`input[name="qdrantMode"][value="${isLocalQdrant ? 'local' : 'cloud'}"]`).checked = true;
  el.qdrantUrl.value = cfg.qdrantUrl === "http://127.0.0.1:6333" ? "" : cfg.qdrantUrl;
  el.qdrantApiKey.value = cfg.qdrantApiKey || "";
  updateQdrantVisibility();

  // LLM
  const isLocalLLM = cfg.llmProvider === "webllm";
  document.querySelector(`input[name="llmType"][value="${isLocalLLM ? 'local' : 'api'}"]`).checked = true;
  if (!isLocalLLM) {
    el.llmProvider.value = cfg.llmProvider;
  }
  el.llmApiKey.value = cfg.llmApiKey || "";
  el.llmModel.value = cfg.llmModel || "";
  updateLLMVisibility();
  updateLLMProviderHints();
}

async function handleSave() {
  el.saveBtn.disabled = true;
  el.saveBtn.textContent = "Saving...";

  const qdrantMode = document.querySelector('input[name="qdrantMode"]:checked').value;
  const llmType = document.querySelector('input[name="llmType"]:checked').value;

  const patch = {
    qdrantUrl: qdrantMode === "local" ? "http://127.0.0.1:6333" : el.qdrantUrl.value.trim() || "http://127.0.0.1:6333",
    qdrantApiKey: qdrantMode === "local" ? "" : el.qdrantApiKey.value.trim(),
    llmProvider: llmType === "local" ? "webllm" : el.llmProvider.value,
    llmApiKey: llmType === "local" ? "" : el.llmApiKey.value.trim(),
    llmModel: llmType === "local" ? "" : el.llmModel.value.trim(),
  };

  await saveConfig(patch);
  await chrome.runtime.sendMessage({ type: "SET_CONFIG", patch });

  el.saveBtn.disabled = false;
  el.saveBtn.textContent = "Save Settings";
  
  el.saveStatus.classList.add("show");
  setTimeout(() => el.saveStatus.classList.remove("show"), 2500);
}

async function handleTestQdrant() {
  el.testQdrantBtn.disabled = true;
  el.qdrantStatus.className = "status-badge";
  el.qdrantStatus.textContent = "Testing...";

  const mode = document.querySelector('input[name="qdrantMode"]:checked').value;
  const url = mode === "local" ? "http://127.0.0.1:6333" : el.qdrantUrl.value.trim();
  const apiKey = mode === "local" ? "" : el.qdrantApiKey.value.trim();

  if (mode === "cloud" && !url) {
    el.qdrantStatus.className = "status-badge error";
    el.qdrantStatus.textContent = "🔴 URL required";
    el.testQdrantBtn.disabled = false;
    return;
  }

  try {
    const client = makeClient({ url, apiKey });
    const res = await client.health();
    if (res.reachable && res.ready) {
      el.qdrantStatus.className = "status-badge success";
      el.qdrantStatus.textContent = "🟢 Connected";
    } else if (res.reachable && !res.ready) {
      el.qdrantStatus.className = "status-badge error";
      el.qdrantStatus.textContent = "🔴 Reached, but not ready";
    } else {
      el.qdrantStatus.className = "status-badge error";
      el.qdrantStatus.textContent = "🔴 Unreachable";
    }
  } catch (err) {
    el.qdrantStatus.className = "status-badge error";
    el.qdrantStatus.textContent = "🔴 Error";
  }

  el.testQdrantBtn.disabled = false;
}

// Event Listeners
el.qdrantModeRadios.forEach(r => r.addEventListener("change", updateQdrantVisibility));
el.llmTypeRadios.forEach(r => r.addEventListener("change", updateLLMVisibility));
el.llmProvider.addEventListener("change", updateLLMProviderHints);
el.testQdrantBtn.addEventListener("click", handleTestQdrant);
el.testLlmBtn.addEventListener("click", handleTestLLM);
el.saveBtn.addEventListener("click", handleSave);

el.resetBtn.addEventListener("click", async (e) => {
  e.preventDefault();
  if (confirm("Reset all settings to default?")) {
    await saveConfig(DEFAULT_CONFIG);
    await chrome.runtime.sendMessage({ type: "SET_CONFIG", patch: DEFAULT_CONFIG });
    loadSettings();
  }
});

// Init
document.addEventListener("DOMContentLoaded", loadSettings);
