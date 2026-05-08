import { initRetriever, loadRetriever, query } from "./retriever.js";
import { explainWithAI, generatePracticeQuestion } from "./ai.js";

let indexReady = false;
let panelOpen = false;

initializeServiceWorker();

chrome.runtime.onInstalled.addListener(initializeServiceWorker);
chrome.runtime.onStartup.addListener(initializeServiceWorker);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "studyrag-keepalive") {
    // Keeps the MV3 service worker alive.
  }
});

// Commands ARE user gestures - sidePanel.open() works here
chrome.commands.onCommand.addListener((command) => {
  handleCommand(command).catch((error) => {
    console.warn("StudyRAG command failed:", error);
  });
});

// Extension icon click - also a user gesture, panel opens here
chrome.action.onClicked && chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.id) {
    try {
      await chrome.sidePanel.open({ tabId: tab.id });
      panelOpen = true;
    } catch (e) {
      console.warn("StudyRAG: could not open panel on icon click", e);
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => {
      console.error("StudyRAG background error:", error);
      sendResponse({ ok: false, error: error.message || "Unknown error" });
    });

  return true; // Keep channel open for async response
});

async function handleCommand(command) {
  const tab = await getActiveTab();

  if (command === "search-notes") {
    if (tab?.id) {
      // Commands are user gestures - sidePanel.open() works
      try {
        await chrome.sidePanel.open({ tabId: tab.id });
        panelOpen = true;
      } catch (e) {
        console.warn("StudyRAG: panel open failed in command", e);
      }
      sendTabMessage(tab.id, { action: "collectSelectionAndSearch" });
    }
    return;
  }

  if (command === "toggle-panel") {
    if (tab?.id) {
      if (panelOpen) {
        sendRuntimeMessage({ action: "closePanel" });
        panelOpen = false;
      } else {
        try {
          await chrome.sidePanel.open({ tabId: tab.id });
          panelOpen = true;
        } catch (e) {
          console.warn("StudyRAG: panel toggle failed", e);
        }
      }
    }
  }
}

async function handleMessage(message, sender) {
  if (!message || !message.action) {
    return { ok: false, error: "Missing action" };
  }

  // Search: run retrieval + AI, publish result to panel
  // Note: we do NOT try to open the panel here — that must happen
  // via a command or icon click (user gesture). We just run the search
  // and store the result; panel will show it when it next polls or receives the broadcast.
  if (message.action === "search" || message.action === "searchNotes") {
    return handleSearch(message.query || "");
  }

  if (message.action === "manualSearch") {
    return handleSearch(message.query || "");
  }

  if (message.action === "dataUpdated") {
    return rebuildIndexFromStorage();
  }

  // openPanel from content script — store a flag so panel knows to open
  // Actual panel.open() must be done via user gesture (command/icon click)
  // We can try it here but it will silently fail on most Chrome versions
  if (message.action === "openPanel") {
    const tabId = sender?.tab?.id || (await getActiveTab())?.id;
    if (tabId) {
      try {
        // This may work in some Chrome versions when triggered close to a click
        await chrome.sidePanel.open({ tabId });
        panelOpen = true;
      } catch (e) {
        // Silently fails if not a user gesture context - that's expected
        // User should use Alt+Q or Alt+S to open the panel
      }
    }
    return { ok: true };
  }

  if (message.action === "togglePanel") {
    const tabId = sender?.tab?.id || (await getActiveTab())?.id;
    if (panelOpen) {
      sendRuntimeMessage({ action: "closePanel" });
      panelOpen = false;
    } else if (tabId) {
      try {
        await chrome.sidePanel.open({ tabId });
        panelOpen = true;
      } catch (e) {
        console.warn("StudyRAG: togglePanel open failed - use Alt+S shortcut instead", e);
      }
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
      message: "No matching chunks found. Try rephrasing or check your notes."
    };
    await publishResult(result);
    return result;
  }

  // If we have a direct answer (high confidence match), return immediately
  if (retrieval.directAnswer) {
    await publishResult(baseResult);
    return baseResult;
  }

  // If we have chunks but no direct answer, still show them immediately
  // then try AI if keys are available
  await publishResult({ ...baseResult, status: "retrieved" });

  const { apiKeys, primaryAI } = await chrome.storage.session.get(["apiKeys", "primaryAI"]);
  const hasAnyKey = apiKeys?.grok || apiKeys?.gemini || apiKeys?.ollamaUrl;

  if (!hasAnyKey) {
    // No AI keys - just return the chunks, that's still useful
    return baseResult;
  }

  // Publish "thinking" state
  await publishResult({
    ...baseResult,
    status: "thinking",
    aiAnswer: "Generating explanation..."
  });

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
  indexReady = snapshot.chunks.length > 0;
  return { ok: true, chunkCount: snapshot.chunks.length };
}

async function ensureRetriever() {
  if (indexReady) return true;

  const { ragIndex, ragData } = await chrome.storage.session.get(["ragIndex", "ragData"]);

  if (ragIndex && loadRetriever(ragIndex)) {
    indexReady = ragIndex.chunks.length > 0;
    return indexReady;
  }

  if (!ragData) return false;

  const snapshot = initRetriever(ragData);
  await chrome.storage.session.set({ ragIndex: snapshot });
  indexReady = snapshot.chunks.length > 0;
  return indexReady;
}

async function publishResult(result) {
  const latestResult = { ...result, createdAt: result.createdAt || Date.now() };
  const { history = [] } = await chrome.storage.session.get("history");
  const nextHistory = latestResult.query
    ? [
        { query: latestResult.query, score: latestResult.score || 0, createdAt: latestResult.createdAt },
        ...history.filter((item) => item.query !== latestResult.query)
      ].slice(0, 5)
    : history;

  await chrome.storage.session.set({ latestResult, history: nextHistory });
  sendRuntimeMessage({ action: "showResult", result: latestResult, history: nextHistory });
}

async function publishQuiz(result) {
  await chrome.storage.session.set({ latestQuiz: result });
  sendRuntimeMessage({ action: "quizResult", result });
}

function initializeServiceWorker() {
  // Allow panel to read session storage
  if (chrome.storage?.session?.setAccessLevel) {
    chrome.storage.session
      .setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })
      .catch(() => {});
  }

  // FIX: Set openPanelOnActionClick to TRUE so clicking the extension icon opens the panel
  // We handle icon clicks via action.onClicked above only if this is false,
  // but actually setting it true is simpler and more reliable
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }

  // Keepalive alarm
  if (chrome.alarms?.create) {
    chrome.alarms.create("studyrag-keepalive", { periodInMinutes: 0.4 });
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
        // Panel may be closed; result is persisted in storage for when it reopens.
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
        // Tab may not have content script yet.
      }
    });
  } catch {
    // Ignore.
  }
}
