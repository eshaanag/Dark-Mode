const queryInput = document.getElementById("query");
const searchButton = document.getElementById("search");
const closePanel = document.getElementById("closePanel");
const notesResult = document.getElementById("notesResult");
const aiResult = document.getElementById("aiResult");
const confidence = document.getElementById("confidence");
const provider = document.getElementById("provider");
const historyEl = document.getElementById("history");
const quizMe = document.getElementById("quizMe");
const quizCard = document.getElementById("quizCard");
const quizResult = document.getElementById("quizResult");
const quizProvider = document.getElementById("quizProvider");

let currentResult = null;

initPanel();

searchButton.addEventListener("click", () => runManualSearch(queryInput.value));
queryInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") runManualSearch(queryInput.value);
});

closePanel.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "panelClosed" }).catch(() => {});
  window.close();
});

quizMe.addEventListener("click", async () => {
  const chunk = currentResult?.chunks?.[0];
  if (!chunk) {
    renderQuiz({ ok: false, error: "Search your notes first, then generate a practice question." });
    return;
  }

  quizCard.hidden = false;
  quizResult.textContent = "Generating...";
  quizProvider.textContent = "";
  const response = await chrome.runtime.sendMessage({ action: "quizMe", chunk }).catch((error) => ({
    ok: false,
    error: error.message
  }));
  renderQuiz(response);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.action === "studyRagResult") {
    renderResult(message.result);
    renderHistory(message.history || []);
  }

  if (message?.action === "quizResult") {
    renderQuiz(message.result);
  }

  if (message?.action === "closePanel") {
    chrome.runtime.sendMessage({ action: "panelClosed" }).catch(() => {});
    window.close();
  }
});

window.addEventListener("pagehide", () => {
  chrome.runtime.sendMessage({ action: "panelClosed" }).catch(() => {});
});

async function initPanel() {
  const response = await chrome.runtime.sendMessage({ action: "panelReady" }).catch(() => null);
  if (response?.latestResult) renderResult(response.latestResult);
  renderHistory(response?.history || []);
}

async function runManualSearch(query) {
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) return;

  notesResult.textContent = "Searching your notes...";
  notesResult.classList.add("muted");
  aiResult.textContent = "Checking for a direct match first.";
  aiResult.classList.add("muted");
  provider.textContent = "";

  const response = await chrome.runtime.sendMessage({
    action: "manualSearch",
    query: cleanQuery
  }).catch((error) => ({
    ok: false,
    message: error.message || "Search failed."
  }));

  renderResult(response);
}

function renderResult(result) {
  if (!result) return;
  currentResult = result;

  if (result.query) queryInput.value = result.query;

  const topChunk = result.chunks?.[0] || null;
  const percent = Math.min(99, Math.round((result.score || 0) * 100));
  confidence.textContent = `${percent}%`;
  confidence.classList.toggle("good", (result.score || 0) > 0.7);

  if (topChunk) {
    notesResult.classList.remove("muted");
    notesResult.innerHTML = highlightTerms(topChunk.text, result.query || "");
  } else {
    notesResult.classList.add("muted");
    notesResult.textContent = result.message || "No matching note chunk found.";
  }

  aiResult.classList.toggle("muted", !result.aiAnswer || result.status === "thinking");
  aiResult.textContent = result.directAnswer
    ? "Direct match found in your notes. AI was not needed."
    : result.aiAnswer || "AI explanation will appear here.";
  provider.textContent = result.aiProvider ? result.aiProvider.toUpperCase() : "";
}

function renderHistory(history) {
  historyEl.innerHTML = "";
  if (!history.length) {
    historyEl.innerHTML = '<div class="muted">No searches yet.</div>';
    return;
  }

  for (const item of history.slice(0, 5)) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.query;
    button.addEventListener("click", () => runManualSearch(item.query));
    historyEl.appendChild(button);
  }
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
