const STORAGE_KEY = "workingSet";

const el = {
  banner: document.getElementById("model-banner"),
  modelStatusText: document.getElementById("model-status-text"),
  loadModelsBtn: document.getElementById("load-models-btn"),
  addTabBtn: document.getElementById("add-tab-btn"),
  tabList: document.getElementById("tab-list"),
  emptyState: document.getElementById("empty-state"),
  questionInput: document.getElementById("question-input"),
  askBtn: document.getElementById("ask-btn"),
  statusLine: document.getElementById("status-line"),
  answerSection: document.getElementById("answer-section"),
  answerText: document.getElementById("answer-text"),
  citations: document.getElementById("citations"),
};

function sendToBackground(message) {
  return chrome.runtime.sendMessage(message);
}

async function getWorkingSet() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return stored[STORAGE_KEY] || [];
}

async function setWorkingSet(list) {
  await chrome.storage.local.set({ [STORAGE_KEY]: list });
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
    span.title = tab.url;
    const removeBtn = document.createElement("button");
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", () => removeTab(tab.tabId));
    li.append(span, removeBtn);
    el.tabList.appendChild(li);
  }
  el.askBtn.disabled = list.length === 0;
}

async function removeTab(tabId) {
  const list = (await getWorkingSet()).filter((t) => t.tabId !== tabId);
  await setWorkingSet(list);
  chrome.runtime.sendMessage({ type: "REMOVE_TAB", tabId }).catch(() => {});
}

async function addCurrentTab() {
  el.addTabBtn.disabled = true;
  el.addTabBtn.textContent = "Reading page...";
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) throw new Error("No active tab found.");

    const extraction = await sendToBackground({ type: "EXTRACT_TAB_TEXT", tabId: activeTab.id });
    if (!extraction.ok) throw new Error(extraction.error);
    if (!extraction.text || extraction.text.length < 50) {
      throw new Error("Not enough readable text on this page.");
    }

    await sendToBackground({ type: "ENSURE_OFFSCREEN" });

    el.addTabBtn.textContent = "Indexing...";
    const indexResult = await chrome.runtime.sendMessage({
      type: "INDEX_TAB",
      tabId: activeTab.id,
      title: extraction.title,
      url: activeTab.url,
      text: extraction.text,
    });
    if (!indexResult.ok) throw new Error(indexResult.error);

    const list = await getWorkingSet();
    if (!list.some((t) => t.tabId === activeTab.id)) {
      list.push({ tabId: activeTab.id, title: extraction.title, url: activeTab.url });
      await setWorkingSet(list);
    }
  } catch (err) {
    alert(`Couldn't add this tab: ${err.message}`);
  } finally {
    el.addTabBtn.disabled = false;
    el.addTabBtn.textContent = "+ Add current tab";
  }
}

async function refreshModelStatus() {
  try {
    const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
    setModelsReady(!!state?.modelsReady);
  } catch {
    setModelsReady(false);
  }
}

function setModelsReady(ready) {
  el.banner.classList.toggle("ready", ready);
  el.loadModelsBtn.hidden = ready;
  el.modelStatusText.textContent = ready
    ? "Models loaded and running locally."
    : "Models not loaded yet.";
}

async function loadModels() {
  el.loadModelsBtn.disabled = true;
  el.loadModelsBtn.textContent = "Loading...";
  await sendToBackground({ type: "ENSURE_OFFSCREEN" });
  chrome.runtime.sendMessage({ type: "LOAD_MODELS" }).catch(() => {});
}

async function askQuestion() {
  const question = el.questionInput.value.trim();
  if (!question) return;

  const list = await getWorkingSet();
  el.askBtn.disabled = true;
  el.statusLine.hidden = false;
  el.statusLine.textContent = "Starting...";
  el.answerSection.hidden = true;
  el.answerText.textContent = "";
  el.citations.innerHTML = "";

  await sendToBackground({ type: "ENSURE_OFFSCREEN" });
  chrome.runtime
    .sendMessage({
      type: "ASK",
      question,
      tabIds: list.map((t) => t.tabId),
      tabTitles: list.map((t) => t.title),
    })
    .catch(() => {});
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "MODEL_PROGRESS") {
    el.modelStatusText.textContent =
      typeof message.detail === "string" ? message.detail : `Loading ${message.stage}...`;
  } else if (message.type === "MODELS_READY") {
    setModelsReady(true);
  } else if (message.type === "MODEL_ERROR") {
    el.modelStatusText.textContent = `Model load failed: ${message.error}`;
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
    el.citations.innerHTML = "";
    for (const c of message.citations || []) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = c.tabUrl;
      a.textContent = `[${c.index}] ${c.tabTitle}`;
      a.target = "_blank";
      li.appendChild(a);
      el.citations.appendChild(li);
    }
  } else if (message.type === "ANSWER_ERROR") {
    el.askBtn.disabled = false;
    el.statusLine.hidden = true;
    el.answerSection.hidden = false;
    el.answerText.textContent = `Something went wrong: ${message.error}`;
  }
});

el.addTabBtn.addEventListener("click", addCurrentTab);
el.loadModelsBtn.addEventListener("click", loadModels);
el.askBtn.addEventListener("click", askQuestion);

(async () => {
  renderWorkingSet(await getWorkingSet());
  await refreshModelStatus();
})();
