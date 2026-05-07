import { initRetriever, loadRetriever, query } from "./retriever.js";
import { explainWithAI, generatePracticeQuestion } from "./ai.js";

let indexReady = false;
let panelOpen = false;

chrome.runtime.onInstalled.addListener(() => {
  configureSessionStorage();
  configureSidePanel();
});

chrome.runtime.onStartup.addListener(() => {
  configureSessionStorage();
  configureSidePanel();
});

chrome.commands.onCommand.addListener(async (command) => {
  const tab = await getActiveTab();
  if (!tab?.id) return;

  if (command === "search-notes") {
    await openPanel(tab.id);
    chrome.tabs.sendMessage(tab.id, { action: "collectSelectionAndSearch" }).catch(() => {});
  }

  if (command === "toggle-panel") {
    if (panelOpen) {
      chrome.runtime.sendMessage({ action: "closePanel" }).catch(() => {});
      panelOpen = false;
    } else {
      await openPanel(tab.id);
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      console.error("StudyRAG background error:", error);
      sendResponse({ ok: false, error: error.message || "Unknown error" });
    });
  return true;
});

async function handleMessage(message, sender) {
  if (!message || !message.action) return { ok: false, error: "Missing action" };

  if (message.action === "dataUpdated") {
    const { ragData, ragIndex } = await chrome.storage.session.get(["ragData", "ragIndex"]);
    if (ragIndex && loadRetriever(ragIndex)) {
      indexReady = true;
      return { ok: true, chunkCount: ragIndex.chunks.length };
    }
    const snapshot = initRetriever(ragData || "");
    await chrome.storage.session.set({ ragIndex: snapshot });
    indexReady = true;
    return { ok: true, chunkCount: snapshot.chunks.length };
  }

  if (message.action === "searchNotes") {
    if (sender?.tab?.id) await openPanel(sender.tab.id);
    return runSearch(message.query || "");
  }

  if (message.action === "manualSearch") {
    return runSearch(message.query || "");
  }

  if (message.action === "quizMe") {
    return runQuiz(message.chunk || null);
  }

  if (message.action === "openPanel") {
    const tabId = sender?.tab?.id || (await getActiveTab())?.id;
    if (tabId) await openPanel(tabId);
    return { ok: true };
  }

  if (message.action === "panelReady") {
    panelOpen = true;
    const { latestResult, history } = await chrome.storage.session.get(["latestResult", "history"]);
    return { ok: true, latestResult: latestResult || null, history: history || [] };
  }

  if (message.action === "panelClosed") {
    panelOpen = false;
    return { ok: true };
  }

  return { ok: false, error: "Unknown action" };
}

async function runSearch(queryText) {
  const cleanQuery = String(queryText || "").trim();
  if (!cleanQuery) {
    const result = {
      ok: false,
      status: "empty",
      query: "",
      message: "Highlight text or type a question to search your notes."
    };
    await publishResult(result);
    return result;
  }

  await ensureRetriever();
  const retrieval = query(cleanQuery);

  if (!retrieval.chunks.length) {
    const result = {
      ok: true,
      status: "no-notes-match",
      query: cleanQuery,
      directAnswer: null,
      chunks: [],
      score: 0,
      aiAnswer: "No matching notes found. Load notes in the StudyRAG popup, then try again.",
      aiProvider: null
    };
    await publishResult(result);
    return result;
  }

  const thinking = {
    ok: true,
    status: retrieval.directAnswer ? "direct" : "thinking",
    query: cleanQuery,
    directAnswer: retrieval.directAnswer,
    chunks: retrieval.chunks,
    score: retrieval.score,
    aiAnswer: retrieval.directAnswer ? "Direct match found in your notes. AI was not needed." : "Thinking...",
    aiProvider: null,
    createdAt: Date.now()
  };
  await publishResult(thinking);

  if (retrieval.directAnswer) {
    return thinking;
  }

  const { apiKeys, primaryAI } = await chrome.storage.session.get(["apiKeys", "primaryAI"]);
  const ai = await explainWithAI({
    question: cleanQuery,
    chunks: retrieval.chunks,
    apiKeys: apiKeys || {},
    primaryAI: primaryAI || "grok"
  });

  const result = {
    ...thinking,
    status: ai.ok ? "ai" : "ai-error",
    aiAnswer: ai.answer,
    aiProvider: ai.provider,
    aiErrors: ai.errors || [],
    createdAt: Date.now()
  };
  await publishResult(result);
  return result;
}

async function runQuiz(chunk) {
  const sourceChunk = chunk || (await chrome.storage.session.get("latestResult")).latestResult?.chunks?.[0];
  if (!sourceChunk) {
    return { ok: false, error: "Search your notes first, then quiz from a matched chunk." };
  }

  const { apiKeys, primaryAI } = await chrome.storage.session.get(["apiKeys", "primaryAI"]);
  const ai = await generatePracticeQuestion({
    chunk: sourceChunk,
    apiKeys: apiKeys || {},
    primaryAI: primaryAI || "grok"
  });

  const quiz = {
    ok: ai.ok,
    status: ai.ok ? "quiz" : "ai-error",
    quiz: ai.answer,
    aiProvider: ai.provider,
    aiErrors: ai.errors || [],
    createdAt: Date.now()
  };
  chrome.runtime.sendMessage({ action: "quizResult", result: quiz }).catch(() => {});
  return quiz;
}

async function ensureRetriever() {
  if (indexReady) return;

  const { ragIndex, ragData } = await chrome.storage.session.get(["ragIndex", "ragData"]);
  if (ragIndex && loadRetriever(ragIndex)) {
    indexReady = true;
    return;
  }

  const snapshot = initRetriever(ragData || "");
  await chrome.storage.session.set({ ragIndex: snapshot });
  indexReady = true;
}

async function publishResult(result) {
  const createdAt = result.createdAt || Date.now();
  const latestResult = { ...result, createdAt };
  const { history = [] } = await chrome.storage.session.get("history");
  const nextHistory = latestResult.query
    ? [
        { query: latestResult.query, score: latestResult.score || 0, createdAt },
        ...history.filter((item) => item.query !== latestResult.query)
      ].slice(0, 5)
    : history;

  await chrome.storage.session.set({ latestResult, history: nextHistory });
  chrome.runtime.sendMessage({ action: "studyRagResult", result: latestResult, history: nextHistory }).catch(() => {});
}

function configureSessionStorage() {
  if (chrome.storage?.session?.setAccessLevel) {
    chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});
  }
}

function configureSidePanel() {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  }
}

async function openPanel(tabId) {
  if (!chrome.sidePanel?.open || !tabId) return;
  try {
    await chrome.sidePanel.open({ tabId });
    panelOpen = true;
  } catch (error) {
    console.warn("StudyRAG side panel could not be opened:", error);
  }
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}
