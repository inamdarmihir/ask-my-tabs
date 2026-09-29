import { saveConfig, OPENAI_COMPATIBLE_PROVIDERS, GEMINI_PROVIDER } from "./lib/config.js";
import { makeClient } from "./lib/qdrant.js";
import { testApiKey } from "./lib/llm-api.js";

const LOCAL_QDRANT_URL = "http://127.0.0.1:6333";

const ALL_PROVIDERS = { ...OPENAI_COMPATIBLE_PROVIDERS, ...GEMINI_PROVIDER };

const el = {
  qdrantModeRadios: document.querySelectorAll('input[name="obQdrantMode"]'),
  qdrantCloudFields: document.getElementById("ob-qdrant-cloud-fields"),
  qdrantUrl: document.getElementById("ob-qdrant-url"),
  qdrantApiKey: document.getElementById("ob-qdrant-apikey"),
  step1Btn: document.getElementById("ob-step1-btn"),
  qdrantStatus: document.getElementById("ob-qdrant-status"),
  step1Card: document.getElementById("step-1"),

  llmTypeRadios: document.querySelectorAll('input[name="obLlmType"]'),
  llmApiFields: document.getElementById("ob-llm-api-fields"),
  llmProvider: document.getElementById("ob-llm-provider"),
  llmApiKey: document.getElementById("ob-llm-apikey"),
  llmKeyUrl: document.getElementById("ob-llm-key-url"),
  llmModel: document.getElementById("ob-llm-model"),
  llmModelHint: document.getElementById("ob-llm-model-hint"),
  testLlmBtn: document.getElementById("ob-test-llm-btn"),
  llmStatus: document.getElementById("ob-llm-status"),
  qdrantDetected: document.getElementById("ob-qdrant-detected"),
  step2Btn: document.getElementById("ob-step2-btn"),
  step2Card: document.getElementById("step-2"),

  step3Card: document.getElementById("step-3"),
  doneBtn: document.getElementById("ob-done-btn"),
};

function updateQdrantVisibility() {
  const mode = document.querySelector('input[name="obQdrantMode"]:checked').value;
  el.qdrantCloudFields.hidden = mode === "local";
}

function updateLLMVisibility() {
  const type = document.querySelector('input[name="obLlmType"]:checked').value;
  el.llmApiFields.hidden = type === "local";
}

function updateLLMProviderHints() {
  const provider = el.llmProvider.value;
  const config = ALL_PROVIDERS[provider];
  if (!config) return;
  el.llmApiKey.placeholder = config.keyHint;
  el.llmKeyUrl.href = config.keyUrl;
  el.llmModelHint.textContent = `Default: ${config.defaultModel}`;
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

// If Qdrant is already running locally, preselect it so most local users just click Continue.
async function detectLocalQdrant() {
  try {
    const res = await makeClient({ url: LOCAL_QDRANT_URL }).health();
    if (res.reachable && res.ready) {
      document.querySelector('input[name="obQdrantMode"][value="local"]').checked = true;
      el.qdrantDetected.hidden = false;
      updateQdrantVisibility();
    }
  } catch {
    // not running locally: leave the default (cloud) selected
  }
}

async function handleStep1() {
  const mode = document.querySelector('input[name="obQdrantMode"]:checked').value;
  const url = mode === "local" ? LOCAL_QDRANT_URL : el.qdrantUrl.value.trim();
  const apiKey = mode === "local" ? "" : el.qdrantApiKey.value.trim();

  if (mode === "cloud" && !url) {
    el.qdrantStatus.className = "status-badge error";
    el.qdrantStatus.textContent = "URL required";
    return;
  }

  el.step1Btn.disabled = true;
  el.step1Btn.textContent = "Testing...";
  el.qdrantStatus.className = "status-badge";
  el.qdrantStatus.textContent = "";

  try {
    const client = makeClient({ url, apiKey });
    const res = await client.health();
    if (res.reachable && res.ready) {
      el.qdrantStatus.className = "status-badge success";
      el.qdrantStatus.textContent = "Connected ✓";
      
      // Save partial config
      const patch = { qdrantUrl: url, qdrantApiKey: apiKey };
      await saveConfig(patch);
      await chrome.runtime.sendMessage({ type: "SET_CONFIG", patch });

      // Unlock Step 2
      el.step2Card.classList.remove("locked");
      el.step1Btn.hidden = true;
    } else {
      el.qdrantStatus.className = "status-badge error";
      el.qdrantStatus.textContent = "Connection failed";
      el.step1Btn.disabled = false;
      el.step1Btn.textContent = "Test & Continue →";
    }
  } catch (err) {
    el.qdrantStatus.className = "status-badge error";
    el.qdrantStatus.textContent = "Connection failed";
    el.step1Btn.disabled = false;
    el.step1Btn.textContent = "Test & Continue →";
  }
}

async function handleStep2() {
  const type = document.querySelector('input[name="obLlmType"]:checked').value;
  
  const patch = {
    llmProvider: type === "local" ? "webllm" : el.llmProvider.value,
    llmApiKey: type === "local" ? "" : el.llmApiKey.value.trim(),
    llmModel: type === "local" ? "" : el.llmModel.value.trim(),
  };

  el.step2Btn.disabled = true;
  el.step2Btn.textContent = "Saving...";

  await saveConfig(patch);
  await chrome.runtime.sendMessage({ type: "SET_CONFIG", patch });

  el.step1Card.hidden = true;
  el.step2Card.hidden = true;
  el.step3Card.hidden = false;
}

// Event Listeners
el.qdrantModeRadios.forEach(r => r.addEventListener("change", updateQdrantVisibility));
el.llmTypeRadios.forEach(r => r.addEventListener("change", updateLLMVisibility));
el.llmProvider.addEventListener("change", updateLLMProviderHints);
el.step1Btn.addEventListener("click", handleStep1);
el.step2Btn.addEventListener("click", handleStep2);
el.testLlmBtn.addEventListener("click", handleTestLLM);

el.doneBtn.addEventListener("click", () => {
  window.close();
});

// Init
document.addEventListener("DOMContentLoaded", () => {
  updateQdrantVisibility();
  updateLLMVisibility();
  updateLLMProviderHints();
  detectLocalQdrant();
});
