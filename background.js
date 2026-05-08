import { initRetriever, loadRetriever, query } from "./retriever.js";
import { explainWithAI, generatePracticeQuestion } from "./ai.js";

let indexReady = false;
let panelOpen = false;

initializeServiceWorker();

chrome.runtime.onInstalled.addListener(initializeServiceWorker);
chrome.runtime.onStartup.addListener(initializeServiceWorker);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "studyrag-keepalive") {
    // Touching this listener is enough to wake the MV3 service worker.
  }
});

chrome.commands.onCommand.addListener((command) => {
  handleCommand(command).catch((error) => {
    console.warn("StudyRAG command failed:", error);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => {
      console.error("StudyRAG background error:", error);
      sendResponse({ ok: false, error: error.message || "Unknown error" });
    });

  return true;
});

async function handleCommand(command) {
  const tab = await getActiveTab();

  if (command === "search-notes") {
    if (tab?.id) {
      await openPanel(tab.id);
      sendTabMessage(tab.id, { action: "collectSelectionAndSearch" });
    }
    return;
  }

  if (command === "toggle-panel") {
    if (panelOpen) {
      sendRuntimeMessage({ action: "closePanel" });
      panelOpen = false;
    } else if (tab?.id) {
      await openPanel(tab.id);
    }
  }
}

async function handleMessage(message, sender) {
  if (!message || !message.action) {
    return { ok: false, error: "Missing action" };
  }

  if (message.action === "search" || message.action === "searchNotes") {
    if (sender?.tab?.id) await openPanel(sender.tab.id);
    return handleSearch(message.query || "");
  }

  if (message.action === "manualSearch") {
    return handleSearch(message.query || "");
  }

  if (message.action === "dataUpdated") {
    return rebuildIndexFromStorage();
  }

  if (message.action === "openPanel") {
    const tabId = sender?.tab?.id || (await getActiveTab())?.id;
    if (tabId) await openPanel(tabId);
    return { ok: true };
  }

  if (message.action === "togglePanel") {
    const tabId = sender?.tab?.id || (await getActiveTab())?.id;
    if (panelOpen) {
      sendRuntimeMessage({ action: "closePanel" });
      panelOpen = false;
    } else if (tabId) {
      await openPanel(tabId);
    }
    return { ok: true, panelOpen };
  }

  if (message.action === "panelReady") {
    panelOpen = true;
    const stored = await chrome.storage.session.get(["latestResult", "history", "latestQuiz"]);
    return {
      ok: true,
      latestResult: stored.latestResult || null,
      history: stored.history || [],
      latestQuiz: stored.latestQuiz || null
    };
  }

  if (message.action === "panelClosed") {
    panelOpen = false;
    return { ok: true };
  }

  if (message.action === "quizMe") {
    return handleQuiz(message.chunk || null);
  }

  return { ok: false, error: `Unknown action: ${message.action}` };
}

async function handleSearch(queryText) {
  const cleanQuery = String(queryText || "").trim();
  if (!cleanQuery) {
    const result = {
      ok: false,
      status: "empty",
      query: "",
      directAnswer: null,
      chunks: [],
      score: 0,
      aiAnswer: "",
      aiProvider: null,
      message: "Highlight text or type a question to search your notes.",
      createdAt: Date.now()
    };
    await publishResult(result);
    return result;
  }

  const ready = await ensureRetriever();
  if (!ready) {
    const result = {
      ok: false,
      status: "no-notes",
      query: cleanQuery,
      directAnswer: null,
      chunks: [],
      score: 0,
      aiAnswer: "",
      aiProvider: null,
      message: "No notes loaded. Paste notes in the StudyRAG popup and click Load Notes.",
      createdAt: Date.now()
    };
    await publishResult(result);
    return result;
  }

  const retrieval = query(cleanQuery);
  const baseResult = {
    ok: true,
    status: retrieval.directAnswer ? "direct" : "retrieved",
    query: cleanQuery,
    directAnswer: retrieval.directAnswer,
    chunks: retrieval.chunks,
    score: retrieval.score,
    aiAnswer: retrieval.directAnswer || "",
    aiProvider: null,
    createdAt: Date.now()
  };

  if (!retrieval.chunks.length) {
    const result = {
      ...baseResult,
      status: "no-match",
      message: "No matching chunks found in your notes."
    };
    await publishResult(result);
    return result;
  }

  if (retrieval.directAnswer) {
    await publishResult(baseResult);
    return baseResult;
  }

  await publishResult({
    ...baseResult,
    status: "thinking",
    aiAnswer: "Generating study explanation..."
  });

  const { apiKeys, primaryAI } = await chrome.storage.session.get(["apiKeys", "primaryAI"]);
  const ai = await explainWithAI({
    question: cleanQuery,
    chunks: retrieval.chunks,
    apiKeys: apiKeys || {},
    primaryAI: primaryAI || "grok"
  });

  const result = {
    ...baseResult,
    status: ai.ok ? "ai" : "ai-error",
    aiAnswer: ai.answer,
    aiProvider: ai.provider,
    aiErrors: ai.errors || [],
    createdAt: Date.now()
  };

  await publishResult(result);
  return result;
}

async function handleQuiz(chunk) {
  const stored = await chrome.storage.session.get(["latestResult", "apiKeys", "primaryAI"]);
  const sourceChunk = chunk || stored.latestResult?.chunks?.[0];

  if (!sourceChunk) {
    const result = {
      ok: false,
      status: "quiz-error",
      quiz: "",
      error: "Search your notes first, then generate a practice question.",
      createdAt: Date.now()
    };
    await publishQuiz(result);
    return result;
  }

  const ai = await generatePracticeQuestion({
    chunk: sourceChunk,
    apiKeys: stored.apiKeys || {},
    primaryAI: stored.primaryAI || "grok"
  });

  const result = {
    ok: ai.ok,
    status: ai.ok ? "quiz" : "ai-error",
    quiz: ai.answer,
    aiProvider: ai.provider,
    aiErrors: ai.errors || [],
    createdAt: Date.now()
  };

  await publishQuiz(result);
  return result;
}

async function rebuildIndexFromStorage() {
  const { ragData } = await chrome.storage.session.get("ragData");
  const snapshot = initRetriever(ragData || "");
  await chrome.storage.session.set({ ragIndex: snapshot });
  indexReady = true;
  return { ok: true, chunkCount: snapshot.chunks.length };
}

async function ensureRetriever() {
  if (indexReady) return true;

  const { ragIndex, ragData } = await chrome.storage.session.get(["ragIndex", "ragData"]);
  if (ragIndex && loadRetriever(ragIndex)) {
    indexReady = true;
    return ragIndex.chunks.length > 0;
  }

  if (!ragData) return false;

  const snapshot = initRetriever(ragData);
  await chrome.storage.session.set({ ragIndex: snapshot });
  indexReady = true;
  return snapshot.chunks.length > 0;
}

async function publishResult(result) {
  const latestResult = { ...result, createdAt: result.createdAt || Date.now() };
  const { history = [] } = await chrome.storage.session.get("history");
  const nextHistory = latestResult.query
    ? [
        {
          query: latestResult.query,
          score: latestResult.score || 0,
          createdAt: latestResult.createdAt
        },
        ...history.filter((item) => item.query !== latestResult.query)
      ].slice(0, 5)
    : history;

  await chrome.storage.session.set({ latestResult, history: nextHistory });
  sendRuntimeMessage({ action: "showResult", result: latestResult, history: nextHistory });
  sendRuntimeMessage({ action: "studyRagResult", result: latestResult, history: nextHistory });
}

async function publishQuiz(result) {
  await chrome.storage.session.set({ latestQuiz: result });
  sendRuntimeMessage({ action: "quizResult", result });
}

function initializeServiceWorker() {
  configureSessionStorage();
  configureSidePanel();
  configureKeepalive();
}

function configureSessionStorage() {
  if (chrome.storage?.session?.setAccessLevel) {
    chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" }).catch(() => {});
  }
}

function configureSidePanel() {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
}

function configureKeepalive() {
  if (chrome.alarms?.create) {
    chrome.alarms.create("studyrag-keepalive", { periodInMinutes: 0.5 });
  }
}

async function openPanel(tabId) {
  if (!chrome.sidePanel?.open || !tabId) return false;

  try {
    await chrome.sidePanel.open({ tabId });
    panelOpen = true;
    return true;
  } catch (error) {
    console.warn("StudyRAG side panel could not be opened:", error);
    return false;
  }
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

function sendRuntimeMessage(message) {
  try {
    chrome.runtime.sendMessage(message, () => {
      if (chrome.runtime.lastError) {
        // Side panel may be closed; latest results are already persisted.
      }
    });
  } catch {
    // Ignore missing receivers.
  }
}

function sendTabMessage(tabId, message) {
  try {
    chrome.tabs.sendMessage(tabId, message, () => {
      if (chrome.runtime.lastError) {
        // Existing tabs may not have the content script until the tab is reloaded.
      }
    });
  } catch {
    // Ignore tabs where content scripts cannot run.
  }
}
