import { buildScopeFilter } from "./lib/filters.js";
import { citationStatus } from "./lib/freshness.js";
import { getConfig, ALL_API_PROVIDERS } from "./lib/config.js";
import { formatMs } from "./lib/timing.js";

const WORKING_SET_KEY = "workingSet";

const el = {
  modelBanner: document.getElementById("model-banner"),
  modelStatusText: document.getElementById("model-status-text"),
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
  settingsBtn: document.getElementById("settings-btn"),
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
    removeBtn.textContent = "✕";
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

// The tab currently being indexed, so INDEX_PROGRESS events for other tabs are ignored.
let indexingTabId = null;

// Indexing runs in the service worker (INDEX_TAB), so it completes even if this popup closes.
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
    el.timingNote.textContent = res.skipped
      ? "Already indexed and unchanged."
      : `Indexed ${res.chunkCount} chunks in ${formatMs(res.timings?.totalMs ?? 0)}.`;
  } catch (err) {
    alert(`Couldn't add this tab: ${err.message}`);
  } finally {
    indexingTabId = null;
    el.addTabBtn.disabled = false;
    el.addTabBtn.textContent = "+ Add current tab";
  }
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

let allDomainsSeen = new Set();

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
    sub.textContent = `${s.domain} · indexed ${formatDate(s.indexedAt)} · ${s.chunkCount} chunk(s)`;
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
    `Delete "${source.title || source.canonicalUrl}" from the library?\n\n` +
      `This permanently removes its indexed chunks from Qdrant. This is different from ` +
      `"Remove from working set", which only stops searching it and keeps the library copy.`,
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

// Which answer model is active, so the banner can say so. A hosted provider only needs the
// small local embedding model; only WebLLM needs the large download. Showing this also makes a
// misconfiguration (API key entered but "Local" still selected) visible at a glance.
let answerModelLabel = null; // null = WebLLM (local)

async function refreshModelStatus() {
  try {
    const cfg = await getConfig();
    const provider = ALL_API_PROVIDERS[cfg.llmProvider];
    answerModelLabel = provider ? `${provider.label} (${cfg.llmModel || provider.defaultModel})` : null;
  } catch {
    answerModelLabel = null;
  }
  try {
    const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
    setModelsReady(!!state?.modelsReady);
  } catch {
    setModelsReady(false);
  }
}

function setModelsReady(ready) {
  el.modelBanner.classList.toggle("ready", ready);
  el.loadModelsBtn.hidden = ready;
  if (answerModelLabel) {
    el.loadModelsBtn.textContent = "Load embedding model (~70 MB)";
    el.modelStatusText.textContent = ready
      ? `Ready. Answers by ${answerModelLabel}; embeddings run locally.`
      : `Answers by ${answerModelLabel}. Embedding model loads on first use.`;
  } else {
    el.loadModelsBtn.textContent = "Load local models (~0.6 GB, one-time)";
    el.modelStatusText.textContent = ready
      ? "Models loaded and running locally."
      : "Local answer model not loaded yet.";
  }
}

// The offscreen bundle is large (~8 MB), so right after ENSURE_OFFSCREEN creates the document its
// message listener may not be registered yet and sendMessage rejects with "Receiving end does
// not exist". Retry briefly before reporting Qdrant as down, so a slow startup isn't mistaken
// for an unreachable server.
async function checkQdrantHealth() {
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
  el.qdrantBanner.hidden = !!healthy;
  if (!healthy) {
    el.qdrantStatusText.textContent =
      "Can't reach Qdrant at http://127.0.0.1:6333. Run \"docker compose up -d\" in the " +
      "project folder, then click Retry.";
  }
}

async function loadModels() {
  el.loadModelsBtn.disabled = true;
  el.loadModelsBtn.textContent = "Loading...";
  await sendToBackground({ type: "ENSURE_OFFSCREEN" });
  chrome.runtime.sendMessage({ type: "LOAD_MODELS" }).catch(() => {});
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
    indexedAt.textContent = `snapshot indexed ${formatDate(c.indexedAt)} · chunk ${c.chunkIndex}`;
    li.appendChild(indexedAt);

    const openTab = workingSet.find((t) => t.sourceKey === c.sourceKey);
    if (openTab) {
      const checkBtn = document.createElement("button");
      checkBtn.className = "secondary";
      checkBtn.textContent = "Check freshness";
      checkBtn.addEventListener("click", async () => {
        checkBtn.disabled = true;
        checkBtn.textContent = "Checking...";
        const res = await chrome.runtime
          .sendMessage({
            type: "CHECK_FRESHNESS",
            tabId: openTab.tabId,
            canonicalUrl: c.tabUrl,
            storedContentHash: c.contentHash,
          })
          .catch(() => null);
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
    alert("Add at least one tab to the working set, or switch scope to \"Entire library\".");
    return;
  }

  const healthy = await checkQdrantHealth();
  if (!healthy) return;

  const filter =
    scope === "working-set"
      ? buildScopeFilter({ sourceKeys: workingSet.map((t) => t.sourceKey) })
      : buildScopeFilter({
          domain: el.domainFilter.value || undefined,
          indexedAfter: el.dateFilter.value ? new Date(el.dateFilter.value).getTime() : undefined,
        });

  el.askBtn.disabled = true;
  el.statusLine.hidden = false;
  el.statusLine.textContent = "Starting...";
  el.answerSection.hidden = true;
  el.answerText.textContent = "";
  el.citationWarning.hidden = true;
  el.citations.innerHTML = "";

  await sendToBackground({ type: "ENSURE_OFFSCREEN" });
  chrome.runtime
    .sendMessage({
      type: "ASK",
      question,
      filter,
      tabTitles: workingSet.map((t) => t.title),
      // Lets retrieval size its per-source cap; unknown (null) for library scope.
      sourceCount: scope === "working-set" ? new Set(workingSet.map((t) => t.sourceKey)).size : null,
    })
    .catch(() => {});

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
    el.modelStatusText.textContent =
      typeof message.detail === "string" ? message.detail : `Loading ${message.stage}...`;
    // Mirror download progress onto the button that is waiting for it.
    if (indexingTabId !== null) el.addTabBtn.textContent = el.modelStatusText.textContent;
  } else if (message.type === "INDEX_PROGRESS") {
    if (message.tabId === indexingTabId) {
      el.addTabBtn.textContent =
        message.stage === "saving" ? "Saving..." : `Indexing ${message.done}/${message.total}...`;
    }
  } else if (message.type === "MODELS_READY") {
    setModelsReady(true);
  } else if (message.type === "MODEL_ERROR") {
    el.modelStatusText.textContent = `Model load failed: ${message.error}`;
    // Re-enable the button so a fixable, transient cause (GPU driver update, closing another
    // GPU-heavy tab, retrying after enabling WebGPU in chrome://flags) can actually be retried
    // without closing and reopening the popup.
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
      el.timingNote.textContent = parts.join(" · ");
    }
    if (message.citationValidation?.invalid?.length) {
      el.citationWarning.hidden = false;
      el.citationWarning.textContent =
        `The answer cites [${message.citationValidation.invalid.join(", ")}], which ` +
        `${message.citationValidation.invalid.length === 1 ? "doesn't" : "don't"} match any ` +
        `supplied snippet. Treat that claim as unsupported.`;
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
  // Start loading the embedding model now so the first "Add tab" doesn't wait for it.
  sendToBackground({ type: "ENSURE_OFFSCREEN" })
    .then(() => chrome.runtime.sendMessage({ type: "WARM_EMBEDDER" }))
    .catch(() => {});
  await refreshModelStatus();
  const healthy = await checkQdrantHealth();
  if (healthy) refreshLibrary();
})();
