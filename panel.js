const queryInput = document.getElementById("query");
const searchButton = document.getElementById("search");
const closePanelButton = document.getElementById("closePanel");
const notesResult = document.getElementById("notesResult");
const aiResult = document.getElementById("aiResult");
const confidenceBadge = document.getElementById("confidence");
const providerLabel = document.getElementById("provider");
const historyEl = document.getElementById("history");
const quizButton = document.getElementById("quizMe");
const quizCard = document.getElementById("quizCard");
const quizResult = document.getElementById("quizResult");
const quizProvider = document.getElementById("quizProvider");

let currentResult = null;

document.addEventListener("DOMContentLoaded", initPanel);
searchButton.addEventListener("click", () => runManualSearch(queryInput.value));
queryInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") runManualSearch(queryInput.value);
});

closePanelButton.addEventListener("click", () => {
  sendMessage({ action: "panelClosed" });
  window.close();
});

quizButton.addEventListener("click", runQuiz);

chrome.runtime.onMessage.addListener((message) => {
  if (!message || !message.action) return;

  if (message.action === "showResult" || message.action === "studyRagResult") {
    renderResult(message.result);
    renderHistory(message.history || []);
  }

  if (message.action === "quizResult") {
    renderQuiz(message.result);
  }

  if (message.action === "closePanel") {
    sendMessage({ action: "panelClosed" });
    window.close();
  }
});

window.addEventListener("pagehide", () => {
  sendMessage({ action: "panelClosed" });
});

async function initPanel() {
  const response = await sendMessage({ action: "panelReady" });
  if (response?.latestResult) renderResult(response.latestResult);
  if (response?.latestQuiz) renderQuiz(response.latestQuiz);
  renderHistory(response?.history || []);
}

async function runManualSearch(query) {
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) return;

  renderLoading(cleanQuery);
  const response = await sendMessage({ action: "manualSearch", query: cleanQuery });
  renderResult(response || { ok: false, message: "Search failed." });
}

async function runQuiz() {
  const chunk = currentResult?.chunks?.[0];
  if (!chunk) {
    renderQuiz({ ok: false, error: "Search your notes first, then generate a practice question." });
    return;
  }

  quizCard.hidden = false;
  quizResult.textContent = "Generating practice question...";
  quizProvider.textContent = "";

  const response = await sendMessage({ action: "quizMe", chunk });
  renderQuiz(response || { ok: false, error: "Quiz generation failed." });
}

function renderLoading(query) {
  queryInput.value = query;
  currentResult = null;
  confidenceBadge.textContent = "0%";
  confidenceBadge.classList.remove("good");
  notesResult.classList.add("muted");
  notesResult.textContent = "Searching your notes...";
  aiResult.classList.add("muted");
  aiResult.textContent = "Checking for note matches first.";
  providerLabel.textContent = "";
}

function renderResult(result) {
  if (!result) return;
  currentResult = result;

  if (result.query) queryInput.value = result.query;

  const score = Number(result.score || 0);
  const percent = Math.max(0, Math.min(99, Math.round(score * 100)));
  confidenceBadge.textContent = `${percent}%`;
  confidenceBadge.classList.toggle("good", score > 0.7);

  renderChunks(result.chunks || [], result.query || "", result.message || "");
  renderAi(result);
}

function renderChunks(chunks, query, message) {
  notesResult.innerHTML = "";

  if (!chunks.length) {
    notesResult.classList.add("muted");
    notesResult.textContent = message || "No matching chunks found.";
    return;
  }

  notesResult.classList.remove("muted");

  chunks.slice(0, 3).forEach((chunk, index) => {
    const item = document.createElement("div");
    item.style.marginBottom = index === chunks.length - 1 ? "0" : "10px";

    const meta = document.createElement("div");
    meta.className = "muted";
    meta.style.fontSize = "11px";
    meta.style.marginBottom = "4px";
    meta.textContent = `${chunk.source || "notes"} | ${Math.round((chunk.score || 0) * 100)}%`;

    const body = document.createElement("div");
    body.innerHTML = highlightTerms(chunk.text || chunk.answer || "", query);

    item.appendChild(meta);
    item.appendChild(body);
    notesResult.appendChild(item);
  });
}

function renderAi(result) {
  const hasDirect = Boolean(result.directAnswer);
  const text = hasDirect
    ? result.directAnswer
    : result.aiAnswer || result.message || "AI explanation will appear here.";

  aiResult.classList.toggle("muted", !text || result.status === "thinking");
  aiResult.textContent = text;
  providerLabel.textContent = result.aiProvider ? result.aiProvider.toUpperCase() : hasDirect ? "NOTES" : "";
}

function renderHistory(history) {
  historyEl.innerHTML = "";

  if (!history.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "No searches yet.";
    historyEl.appendChild(empty);
    return;
  }

  history.slice(0, 5).forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.query;
    button.addEventListener("click", () => runManualSearch(item.query));
    historyEl.appendChild(button);
  });
}

function renderQuiz(result) {
  quizCard.hidden = false;

  if (!result?.ok && result?.error) {
    quizResult.textContent = result.error;
    quizProvider.textContent = "";
    return;
  }

  quizResult.textContent = result?.quiz || result?.answer || "No practice question generated.";
  quizProvider.textContent = result?.aiProvider ? result.aiProvider.toUpperCase() : "";
}

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        console.warn("StudyRAG panel:", chrome.runtime.lastError.message);
        resolve(null);
        return;
      }
      resolve(response);
    });
  });
}

function highlightTerms(text, query) {
  const escaped = escapeHtml(text || "");
  const terms = Array.from(
    new Set(
      String(query || "")
        .toLowerCase()
        .match(/[a-z0-9']{3,}/g) || []
    )
  ).slice(0, 10);

  if (!terms.length) return escaped;

  const pattern = new RegExp(`\\b(${terms.map(escapeRegExp).join("|")})\\b`, "gi");
  return escaped.replace(pattern, "<mark>$1</mark>");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
