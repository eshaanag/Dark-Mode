import { initRetriever } from "./retriever.js";

const notes = document.getElementById("notes");
const save = document.getElementById("save");
const grokKey = document.getElementById("grokKey");
const geminiKey = document.getElementById("geminiKey");
const ollamaUrl = document.getElementById("ollamaUrl");
const primaryAI = document.getElementById("primaryAI");
const status = document.getElementById("status");

hydratePopup();

save.addEventListener("click", async () => {
  save.disabled = true;
  status.textContent = "Indexing...";

  try {
    const ragData = notes.value.trim();
    const ragIndex = initRetriever(ragData);
    const apiKeys = {
      grok: grokKey.value.trim(),
      gemini: geminiKey.value.trim(),
      ollamaUrl: ollamaUrl.value.trim() || "http://localhost:11434"
    };

    await chrome.storage.session.set({
      ragData,
      ragIndex,
      apiKeys,
      primaryAI: primaryAI.value
    });

    await chrome.runtime.sendMessage({ action: "dataUpdated" }).catch(() => null);
    notifyActiveTab();
    status.textContent = `${ragIndex.chunks.length} chunks indexed | Ready`;
  } catch (error) {
    status.textContent = `Could not load notes: ${error.message || "Unknown error"}`;
  } finally {
    save.disabled = false;
  }
});

async function hydratePopup() {
  const stored = await chrome.storage.session.get(["ragData", "ragIndex", "apiKeys", "primaryAI"]);
  notes.value = stored.ragData || "";
  grokKey.value = stored.apiKeys?.grok || "";
  geminiKey.value = stored.apiKeys?.gemini || "";
  ollamaUrl.value = stored.apiKeys?.ollamaUrl || "http://localhost:11434";
  primaryAI.value = stored.primaryAI || "grok";

  const chunkCount = stored.ragIndex?.chunks?.length || 0;
  status.textContent = `${chunkCount} chunks indexed | Ready`;
}

async function notifyActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { action: "dataUpdated" }).catch(() => {});
  }
}
