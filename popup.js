const notesEl = document.getElementById("notes");
const saveBtn = document.getElementById("save");
const grokKeyEl = document.getElementById("grokKey");
const geminiKeyEl = document.getElementById("geminiKey");
const ollamaUrlEl = document.getElementById("ollamaUrl");
const primaryAIEl = document.getElementById("primaryAI");
const statusEl = document.getElementById("status");

document.addEventListener("DOMContentLoaded", hydrate);
saveBtn.addEventListener("click", save);

async function save() {
  saveBtn.disabled = true;
  statusEl.textContent = "Saving...";
  try {
    const ragData = notesEl.value.trim();
    await chrome.storage.session.set({
      ragData,
      ragIndex: null,
      apiKeys: {
        grok: grokKeyEl.value.trim(),
        gemini: geminiKeyEl.value.trim(),
        ollamaUrl: ollamaUrlEl.value.trim() || "http://localhost:11434"
      },
      primaryAI: primaryAIEl.value
    });
    const res = await msg({ action: "dataUpdated" });
    const n = res?.chunkCount ?? 0;
    statusEl.textContent = n + " chunks indexed" + (n === 0 && ragData ? " — try Q:/A: format" : " — ready");
  } catch(e) {
    statusEl.textContent = "Error: " + e.message;
  } finally {
    saveBtn.disabled = false;
  }
}

async function hydrate() {
  try {
    const s = await chrome.storage.session.get(["ragData","ragIndex","apiKeys","primaryAI"]);
    notesEl.value = s.ragData || "";
    grokKeyEl.value = s.apiKeys?.grok || "";
    geminiKeyEl.value = s.apiKeys?.gemini || "";
    ollamaUrlEl.value = s.apiKeys?.ollamaUrl || "http://localhost:11434";
    primaryAIEl.value = s.primaryAI || "grok";
    statusEl.textContent = (s.ragIndex?.chunks?.length || 0) + " chunks indexed";
  } catch(e) {}
}

function msg(m) {
  return new Promise(r => {
    chrome.runtime.sendMessage(m, res => {
      if (chrome.runtime.lastError) { r(null); return; }
      r(res);
    });
  });
}