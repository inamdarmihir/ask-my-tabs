// src/lib/filters.js
function buildScopeFilter({ sourceKeys, domain, indexedAfter, indexedBefore, corpusMode } = {}) {
  const must = [];
  if (sourceKeys && sourceKeys.length > 0) {
    must.push({ key: "sourceKey", match: { any: sourceKeys } });
  }
  if (domain) {
    must.push({ key: "domain", match: { value: domain } });
  }
  if (indexedAfter || indexedBefore) {
    const range = {};
    if (indexedAfter) range.gte = indexedAfter;
    if (indexedBefore) range.lte = indexedBefore;
    must.push({ key: "indexedAt", range });
  }
  if (corpusMode) {
    must.push({ key: "corpusMode", match: { value: corpusMode } });
  }
  return must.length > 0 ? { must } : void 0;
}

// src/lib/freshness.js
function citationStatus({ hasNewerSnapshot, liveCheck }) {
  if (hasNewerSnapshot) return "superseded";
  if (liveCheck && liveCheck.checked) {
    return liveCheck.matches ? "confirmed-current" : "superseded";
  }
  return "archived";
}

// src/lib/config.js
var CONFIG_KEY = "ask-my-tabs-config";
var OPENAI_COMPATIBLE_PROVIDERS = {
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-6-luna",
    keyHint: "sk-...",
    keyUrl: "https://platform.openai.com/api-keys"
  },
  groq: {
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    keyHint: "gsk_...",
    keyUrl: "https://console.groq.com/keys"
  }
};
var GEMINI_PROVIDER = {
  gemini: {
    label: "Google Gemini",
    defaultModel: "gemini-1.5-flash",
    keyHint: "AIza...",
    keyUrl: "https://aistudio.google.com/app/apikey"
  }
};
var ALL_API_PROVIDERS = { ...OPENAI_COMPATIBLE_PROVIDERS, ...GEMINI_PROVIDER };
var DEFAULT_CONFIG = {
  // Qdrant connection. An empty apiKey means no Authorization header (local Docker default).
  qdrantUrl: "http://127.0.0.1:6333",
  qdrantApiKey: "",
  // LLM. "webllm" requires WebGPU + a ~0.5 GB one-time model download. API providers need a key.
  llmProvider: "webllm",
  // "openai" | "groq" | "gemini" | "webllm"
  llmApiKey: "",
  llmModel: "",
  // empty = use the provider's defaultModel from OPENAI_COMPATIBLE_PROVIDERS
  // Retrieval mode. Users rarely need to change this; it is exposed in settings for power
  // users who want to compare modes. See src/lib/agent.js and DECISIONS.md for what each means.
  retrievalMode: "hybrid"
  // "hybrid" | "dense" | "sparse"
};
async function getConfig() {
  if (typeof chrome === "undefined" || !chrome?.storage?.local) {
    return { ...DEFAULT_CONFIG };
  }
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  return { ...DEFAULT_CONFIG, ...stored[CONFIG_KEY] || {} };
}

// src/lib/timing.js
function formatMs(ms) {
  return ms >= 1e3 ? `${(ms / 1e3).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

// src/popup.js
var WORKING_SET_KEY = "workingSet";
var el = {
  modelBanner: document.getElementById("model-banner"),
  modelStatusText: document.getElementById("model-status-text"),
  modelChip: document.getElementById("model-chip"),
  modelProgress: document.getElementById("model-progress"),
  qdrantChip: document.getElementById("qdrant-chip"),
  qdrantChipText: document.getElementById("qdrant-chip-text"),
  addAllBtn: document.getElementById("add-all-btn"),
  loadModelsBtn: document.getElementById("load-models-btn"),
  qdrantBanner: document.getElementById("qdrant-banner"),
  qdrantStatusText: document.getElementById("qdrant-status-text"),
  qdrantRetryBtn: document.getElementById("qdrant-retry-btn"),
  addTabBtn: document.getElementById("add-tab-btn"),
  tabList: document.getElementById("tab-list"),
  emptyState: document.getElementById("empty-state"),
  domainFilter: document.getElementById("domain-filter"),
  dateFilter: document.getElementById("date-filter"),
  clearFiltersBtn: document.getElementById("clear-filters-btn"),
  refreshLibraryBtn: document.getElementById("refresh-library-btn"),
  libraryList: document.getElementById("library-list"),
  libraryEmptyState: document.getElementById("library-empty-state"),
  questionInput: document.getElementById("question-input"),
  askBtn: document.getElementById("ask-btn"),
  statusLine: document.getElementById("status-line"),
  timingNote: document.getElementById("timing-note"),
  answerSection: document.getElementById("answer-section"),
  answerText: document.getElementById("answer-text"),
  citationWarning: document.getElementById("citation-warning"),
  citations: document.getElementById("citations"),
  settingsBtn: document.getElementById("settings-btn")
};
function sendToBackground(message) {
  return chrome.runtime.sendMessage(message);
}
async function getWorkingSet() {
  const stored = await chrome.storage.local.get(WORKING_SET_KEY);
  return stored[WORKING_SET_KEY] || [];
}
async function setWorkingSet(list) {
  await chrome.storage.local.set({ [WORKING_SET_KEY]: list });
  renderWorkingSet(list);
}
function renderWorkingSet(list) {
  el.tabList.innerHTML = "";
  el.emptyState.hidden = list.length > 0;
  for (const tab of list) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.className = "title";
    span.textContent = tab.title;
    span.title = tab.canonicalUrl;
    const removeBtn = document.createElement("button");
    removeBtn.textContent = "\u2715";
    removeBtn.title = "Remove from working set (keeps the library copy)";
    removeBtn.addEventListener("click", () => removeFromWorkingSet(tab.tabId));
    li.append(span, removeBtn);
    el.tabList.appendChild(li);
  }
  el.askBtn.disabled = list.length === 0 && scopeValue() === "working-set";
}
async function removeFromWorkingSet(tabId) {
  const res = await sendToBackground({ type: "REMOVE_FROM_WORKING_SET", tabId }).catch(() => null);
  if (res?.ok) renderWorkingSet(res.workingSet);
  else renderWorkingSet(await getWorkingSet());
}
var indexingTabId = null;
async function addCurrentTab() {
  el.addTabBtn.disabled = true;
  el.addTabBtn.textContent = "Reading page...";
  el.timingNote.hidden = true;
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) throw new Error("No active tab found.");
    indexingTabId = activeTab.id;
    const res = await sendToBackground({ type: "INDEX_TAB", tabId: activeTab.id });
    if (!res?.ok) throw new Error(res?.error || "Indexing failed.");
    renderWorkingSet(await getWorkingSet());
    refreshLibrary();
    el.timingNote.hidden = false;
    el.timingNote.textContent = res.skipped ? "Already indexed and unchanged." : `Indexed ${res.chunkCount} chunks in ${formatMs(res.timings?.totalMs ?? 0)}.`;
  } catch (err) {
    alert(`Couldn't add this tab: ${err.message}`);
  } finally {
    indexingTabId = null;
    el.addTabBtn.disabled = false;
    el.addTabBtn.textContent = "+ Add current tab";
  }
}
async function addAllTabs() {
  const tabs = (await chrome.tabs.query({ currentWindow: true })).filter((t) => /^https?:\/\//.test(t.url || ""));
  if (tabs.length === 0) return;
  el.addTabBtn.disabled = true;
  el.addAllBtn.disabled = true;
  el.timingNote.hidden = true;
  const started = performance.now();
  let added = 0;
  const failures = [];
  for (let i = 0; i < tabs.length; i++) {
    el.addAllBtn.textContent = `Adding ${i + 1}/${tabs.length}...`;
    const res = await sendToBackground({ type: "INDEX_TAB", tabId: tabs[i].id }).catch((e) => ({ ok: false, error: String(e) }));
    if (res?.ok) added += 1;
    else failures.push(res?.error || "unknown error");
  }
  renderWorkingSet(await getWorkingSet());
  refreshLibrary();
  el.timingNote.hidden = false;
  el.timingNote.textContent = `Added ${added} of ${tabs.length} pages in ${formatMs(performance.now() - started)}` + (failures.length ? `. First problem: ${failures[0]}` : ".");
  el.addTabBtn.disabled = false;
  el.addAllBtn.disabled = false;
  el.addAllBtn.textContent = "Add all";
}
function formatDate(ms) {
  if (!ms) return "unknown date";
  return new Date(ms).toLocaleString();
}
async function refreshLibrary() {
  await sendToBackground({ type: "ENSURE_OFFSCREEN" });
  const filter = {};
  if (el.domainFilter.value) filter.domain = el.domainFilter.value;
  if (el.dateFilter.value) filter.indexedAfter = new Date(el.dateFilter.value).getTime();
  const res = await chrome.runtime.sendMessage({ type: "LIST_LIBRARY", filter }).catch(() => null);
  if (!res?.ok) {
    el.libraryList.innerHTML = "";
    el.libraryEmptyState.hidden = false;
    el.libraryEmptyState.textContent = res?.qdrant?.message || "Couldn't load the library.";
    return;
  }
  renderLibrary(res.sources);
}
var allDomainsSeen = /* @__PURE__ */ new Set();
function renderLibrary(sources) {
  el.libraryList.innerHTML = "";
  el.libraryEmptyState.hidden = sources.length > 0;
  el.libraryEmptyState.textContent = "Nothing in the library yet.";
  for (const s of sources) allDomainsSeen.add(s.domain);
  const currentSelection = el.domainFilter.value;
  el.domainFilter.innerHTML = '<option value="">All domains</option>';
  for (const d of Array.from(allDomainsSeen).sort()) {
    const opt = document.createElement("option");
    opt.value = d;
    opt.textContent = d;
    el.domainFilter.appendChild(opt);
  }
  el.domainFilter.value = currentSelection;
  for (const s of sources) {
    const li = document.createElement("li");
    const meta = document.createElement("div");
    meta.className = "meta";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = s.title || s.canonicalUrl;
    title.title = s.canonicalUrl;
    const sub = document.createElement("span");
    sub.className = "sub";
    sub.textContent = `${s.domain} \xB7 indexed ${formatDate(s.indexedAt)} \xB7 ${s.chunkCount} chunk(s)`;
    meta.append(title, sub);
    const delBtn = document.createElement("button");
    delBtn.className = "danger";
    delBtn.textContent = "Delete from library";
    delBtn.title = "Permanently removes this source's indexed chunks from Qdrant. Different from removing it from the working set.";
    delBtn.addEventListener("click", () => deleteFromLibrary(s));
    li.append(meta, delBtn);
    el.libraryList.appendChild(li);
  }
}
async function deleteFromLibrary(source) {
  const confirmed = confirm(
    `Delete "${source.title || source.canonicalUrl}" from the library?

This permanently removes its indexed chunks from Qdrant. This is different from "Remove from working set", which only stops searching it and keeps the library copy.`
  );
  if (!confirmed) return;
  const res = await chrome.runtime.sendMessage({ type: "DELETE_FROM_LIBRARY", url: source.canonicalUrl }).catch(() => null);
  if (!res?.ok) {
    alert(`Couldn't delete: ${res?.qdrant?.message || res?.error || "unknown error"}`);
    return;
  }
  const list = (await getWorkingSet()).filter((t) => t.sourceKey !== source.sourceKey);
  await setWorkingSet(list);
  refreshLibrary();
}
var answerModelLabel = null;
var qdrantLocation = "local";
async function refreshModelStatus() {
  try {
    const cfg = await getConfig();
    const provider = ALL_API_PROVIDERS[cfg.llmProvider];
    answerModelLabel = provider ? `${provider.label} ${cfg.llmModel || provider.defaultModel}` : null;
    qdrantLocation = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(cfg.qdrantUrl) ? "local" : "cloud";
  } catch {
    answerModelLabel = null;
  }
  setQdrantChip(null);
  try {
    const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
    setModelsReady(!!state?.modelsReady);
  } catch {
    setModelsReady(false);
  }
}
function setModelsReady(ready) {
  el.modelStatusText.textContent = answerModelLabel ? `Answers: ${answerModelLabel}` : "Answers: on this device";
  el.modelBanner.hidden = !!answerModelLabel || ready;
  if (ready) el.modelProgress.hidden = true;
}
function setQdrantChip(healthy) {
  const dot = el.qdrantChip.querySelector(".dot");
  dot.className = `dot ${healthy === true ? "ok" : healthy === false ? "bad" : ""}`;
  el.qdrantChipText.textContent = healthy === null ? "Qdrant: checking..." : `Qdrant: ${qdrantLocation}${healthy ? "" : " (unreachable)"}`;
}
async function checkQdrantHealth() {
  setQdrantChip(null);
  const attempts = 6;
  for (let i = 0; i < attempts; i++) {
    try {
      await sendToBackground({ type: "ENSURE_OFFSCREEN" });
      const res = await chrome.runtime.sendMessage({ type: "QDRANT_HEALTH" });
      if (res) {
        const healthy = !!(res.ok && res.health?.reachable && res.health?.ready);
        setQdrantHealthy(healthy, res);
        return healthy;
      }
    } catch (err) {
      console.warn(`[popup] Qdrant health attempt ${i + 1}/${attempts} failed:`, err);
    }
    await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
  setQdrantHealthy(false);
  return false;
}
function setQdrantHealthy(healthy, res) {
  setQdrantChip(!!healthy);
  el.qdrantBanner.hidden = !!healthy;
  if (!healthy) {
    el.qdrantStatusText.textContent = qdrantLocation === "local" ? `Can't reach Qdrant on this computer. Run "docker compose up -d" in the project folder, then click Retry.` : "Can't reach your Qdrant Cloud cluster. Check the URL and API key in Settings, then click Retry.";
  }
}
async function loadModels() {
  el.loadModelsBtn.disabled = true;
  el.loadModelsBtn.textContent = "Loading...";
  await sendToBackground({ type: "ENSURE_OFFSCREEN" });
  chrome.runtime.sendMessage({ type: "LOAD_MODELS" }).catch(() => {
  });
}
function scopeValue() {
  return document.querySelector('input[name="scope"]:checked')?.value || "working-set";
}
function renderCitationStatusChip(status) {
  const span = document.createElement("span");
  span.className = `citation-status ${status}`;
  span.textContent = status === "confirmed-current" ? "current" : status;
  return span;
}
function renderCitations(citations, workingSet) {
  el.citations.innerHTML = "";
  for (const c of citations || []) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = c.tabUrl;
    a.textContent = `[${c.index}] ${c.tabTitle}`;
    a.target = "_blank";
    li.appendChild(a);
    li.appendChild(renderCitationStatusChip(citationStatus({ hasNewerSnapshot: false, liveCheck: null })));
    const indexedAt = document.createElement("span");
    indexedAt.className = "citation-indexed-at";
    indexedAt.textContent = `snapshot indexed ${formatDate(c.indexedAt)} \xB7 chunk ${c.chunkIndex}`;
    li.appendChild(indexedAt);
    const openTab = workingSet.find((t) => t.sourceKey === c.sourceKey);
    if (openTab) {
      a.addEventListener("click", async (e) => {
        e.preventDefault();
        try {
          const tab = await chrome.tabs.update(openTab.tabId, { active: true });
          await chrome.windows.update(tab.windowId, { focused: true });
        } catch {
          chrome.tabs.create({ url: c.tabUrl });
        }
      });
      const checkBtn = document.createElement("button");
      checkBtn.className = "secondary";
      checkBtn.textContent = "Check freshness";
      checkBtn.addEventListener("click", async () => {
        checkBtn.disabled = true;
        checkBtn.textContent = "Checking...";
        const res = await chrome.runtime.sendMessage({
          type: "CHECK_FRESHNESS",
          tabId: openTab.tabId,
          canonicalUrl: c.tabUrl,
          storedContentHash: c.contentHash
        }).catch(() => null);
        checkBtn.remove();
        const chip = li.querySelector(".citation-status");
        if (res?.ok && res.checked) {
          chip.replaceWith(renderCitationStatusChip(res.matches ? "confirmed-current" : "superseded"));
        } else {
          chip.title = res?.reason || res?.error || "Could not check.";
        }
      });
      li.appendChild(checkBtn);
    }
    el.citations.appendChild(li);
  }
}
async function askQuestion() {
  const question = el.questionInput.value.trim();
  if (!question) return;
  const workingSet = await getWorkingSet();
  const scope = scopeValue();
  if (scope === "working-set" && workingSet.length === 0) {
    alert('Add at least one tab to the working set, or switch scope to "Entire library".');
    return;
  }
  const healthy = await checkQdrantHealth();
  if (!healthy) return;
  const filter = scope === "working-set" ? buildScopeFilter({ sourceKeys: workingSet.map((t) => t.sourceKey) }) : buildScopeFilter({
    domain: el.domainFilter.value || void 0,
    indexedAfter: el.dateFilter.value ? new Date(el.dateFilter.value).getTime() : void 0
  });
  el.askBtn.disabled = true;
  el.statusLine.hidden = false;
  el.statusLine.textContent = "Starting...";
  el.answerSection.hidden = true;
  el.answerText.textContent = "";
  el.citationWarning.hidden = true;
  el.citations.innerHTML = "";
  await sendToBackground({ type: "ENSURE_OFFSCREEN" });
  chrome.runtime.sendMessage({
    type: "ASK",
    question,
    filter,
    tabTitles: workingSet.map((t) => t.title),
    // Lets retrieval size its per-source cap; unknown (null) for library scope.
    sourceCount: scope === "working-set" ? new Set(workingSet.map((t) => t.sourceKey)).size : null
  }).catch(() => {
  });
  chrome.runtime.onMessage.addListener(function onDone(message) {
    if (message.type === "ANSWER_DONE" || message.type === "ANSWER_ERROR") {
      chrome.runtime.onMessage.removeListener(onDone);
    }
    if (message.type === "ANSWER_DONE") {
      renderCitations(message.citations, workingSet);
    }
  });
}
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "MODEL_PROGRESS") {
    const text = typeof message.detail === "string" ? message.detail : `Loading ${message.stage}...`;
    el.modelProgress.hidden = false;
    el.modelProgress.textContent = text;
    if (indexingTabId !== null) el.addTabBtn.textContent = text;
  } else if (message.type === "INDEX_PROGRESS") {
    if (message.tabId === indexingTabId) {
      el.addTabBtn.textContent = message.stage === "saving" ? "Saving..." : `Indexing ${message.done}/${message.total}...`;
    }
  } else if (message.type === "MODELS_READY") {
    setModelsReady(true);
  } else if (message.type === "MODEL_ERROR") {
    el.modelProgress.hidden = false;
    el.modelProgress.textContent = `Model load failed: ${message.error}`;
    el.loadModelsBtn.hidden = false;
    el.loadModelsBtn.disabled = false;
    el.loadModelsBtn.textContent = "Retry load";
  } else if (message.type === "AGENT_STATUS") {
    el.statusLine.textContent = message.status;
  } else if (message.type === "ANSWER_TOKEN") {
    el.statusLine.hidden = true;
    el.answerSection.hidden = false;
    if (message.full !== null) el.answerText.textContent = message.full;
    else el.answerText.textContent = message.delta;
  } else if (message.type === "ANSWER_DONE") {
    el.askBtn.disabled = false;
    el.statusLine.hidden = true;
    el.answerSection.hidden = false;
    if (message.answer) el.answerText.textContent = message.answer;
    if (message.timings) {
      const t = message.timings;
      const parts = [`Answered in ${formatMs(t.totalMs)}`];
      if (t.snippets) parts.push(`${t.snippets} snippets`, `${t.sources} source${t.sources === 1 ? "" : "s"}`);
      el.timingNote.hidden = false;
      el.timingNote.textContent = parts.join(" \xB7 ");
    }
    if (message.citationValidation?.invalid?.length) {
      el.citationWarning.hidden = false;
      el.citationWarning.textContent = `The answer cites [${message.citationValidation.invalid.join(", ")}], which ${message.citationValidation.invalid.length === 1 ? "doesn't" : "don't"} match any supplied snippet. Treat that claim as unsupported.`;
    }
  } else if (message.type === "ANSWER_ERROR") {
    el.askBtn.disabled = false;
    el.statusLine.hidden = true;
    el.answerSection.hidden = false;
    if (message.qdrant?.kind === "down") {
      el.answerText.textContent = message.qdrant.message;
      checkQdrantHealth();
    } else {
      el.answerText.textContent = `Something went wrong: ${message.error}`;
    }
  }
});
el.addTabBtn.addEventListener("click", addCurrentTab);
el.addAllBtn.addEventListener("click", addAllTabs);
el.qdrantChip.addEventListener("click", checkQdrantHealth);
el.modelChip.addEventListener("click", () => chrome.runtime.openOptionsPage());
el.loadModelsBtn.addEventListener("click", loadModels);
el.askBtn.addEventListener("click", askQuestion);
el.qdrantRetryBtn.addEventListener("click", checkQdrantHealth);
el.refreshLibraryBtn.addEventListener("click", refreshLibrary);
el.clearFiltersBtn.addEventListener("click", () => {
  el.domainFilter.value = "";
  el.dateFilter.value = "";
  refreshLibrary();
});
el.domainFilter.addEventListener("change", refreshLibrary);
el.dateFilter.addEventListener("change", refreshLibrary);
document.querySelectorAll('input[name="scope"]').forEach((r) => r.addEventListener("change", async () => {
  renderWorkingSet(await getWorkingSet());
}));
el.settingsBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
(async () => {
  renderWorkingSet(await getWorkingSet());
  sendToBackground({ type: "ENSURE_OFFSCREEN" }).then(() => chrome.runtime.sendMessage({ type: "WARM_EMBEDDER" })).catch(() => {
  });
  await refreshModelStatus();
  const healthy = await checkQdrantHealth();
  if (healthy) refreshLibrary();
})();
