'use strict';

// ── Tab switching ──────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab).classList.add('active');
  });
});

// ── Elements ───────────────────────────────────────────────────
const queryInput    = document.getElementById('query');
const searchBtn     = document.getElementById('searchBtn');
const notesResult   = document.getElementById('notesResult');
const aiResult      = document.getElementById('aiResult');
const confidence    = document.getElementById('confidence');
const provider      = document.getElementById('provider');
const quizBtn       = document.getElementById('quizBtn');
const quizCard      = document.getElementById('quizCard');
const quizResult    = document.getElementById('quizResult');
const quizProvider  = document.getElementById('quizProvider');
const historyList   = document.getElementById('historyList');

const notesInput    = document.getElementById('notesInput');
const loadBtn       = document.getElementById('loadBtn');
const statusBar     = document.getElementById('statusBar');

const grokKey       = document.getElementById('grokKey');
const geminiKey     = document.getElementById('geminiKey');
const ollamaUrl     = document.getElementById('ollamaUrl');
const primaryAI     = document.getElementById('primaryAI');
const saveSettings  = document.getElementById('saveSettings');
const savedMsg      = document.getElementById('savedMsg');

let currentResult = null;

// ── Init ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);

async function init() {
  // Load saved notes text + settings
  try {
    const s = await chrome.storage.session.get(['ragData', 'ragIndex', 'apiKeys', 'primaryAI', 'latestResult', 'history']);
    if (s.ragData) notesInput.value = s.ragData;
    if (s.apiKeys) {
      grokKey.value    = s.apiKeys.grok || '';
      geminiKey.value  = s.apiKeys.gemini || '';
      ollamaUrl.value  = s.apiKeys.ollamaUrl || 'http://localhost:11434';
    }
    if (s.primaryAI) primaryAI.value = s.primaryAI;

    const n = s.ragIndex?.chunks?.length || 0;
    setStatus(n > 0 ? `✓ ${n} chunks indexed — ready to search` : 'No notes loaded yet.', n > 0);

    if (s.latestResult) renderResult(s.latestResult);
    renderHistory(s.history || []);
  } catch(e) {
    console.warn('StudyRAG panel init:', e);
  }

  // Tell background panel is open
  sendMsg({ action: 'panelReady' });
}

// ── Notes loading ──────────────────────────────────────────────
loadBtn.addEventListener('click', async () => {
  const text = notesInput.value.trim();
  if (!text) { setStatus('Please paste some notes first.', false); return; }

  loadBtn.disabled = true;
  setStatus('Indexing…', false);

  try {
    // Save raw text, clear old index so background rebuilds
    await chrome.storage.session.set({ ragData: text, ragIndex: null });
    const res = await sendMsg({ action: 'dataUpdated' });
    const n = res?.chunkCount ?? 0;
    if (n === 0) {
      setStatus('⚠ 0 chunks — paste in Q: / A: format or plain paragraphs', false);
    } else {
      setStatus(`✓ ${n} chunks indexed — go to Search tab!`, true);
      // Auto-switch to search tab
      document.querySelector('[data-tab="searchPage"]').click();
    }
  } catch(e) {
    setStatus('Error: ' + e.message, false);
  } finally {
    loadBtn.disabled = false;
  }
});

function setStatus(msg, ok) {
  statusBar.textContent = msg;
  statusBar.className = 'status-bar' + (ok ? '' : ' warn');
}

// ── Search ─────────────────────────────────────────────────────
searchBtn.addEventListener('click', () => runSearch(queryInput.value));
queryInput.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(queryInput.value); });

async function runSearch(q) {
  q = (q || '').trim();
  if (!q) return;

  queryInput.value = q;
  setResultLoading();

  const res = await sendMsg({ action: 'manualSearch', query: q });
  if (res) renderResult(res);
  else renderError('Search failed — check background errors.');
}

function setResultLoading() {
  notesResult.className = 'card-body muted';
  notesResult.textContent = 'Searching…';
  aiResult.className = 'card-body muted';
  aiResult.textContent = 'Waiting…';
  confidence.textContent = '0%';
  confidence.className = 'badge';
  provider.textContent = '';
}

function renderResult(result) {
  if (!result) return;
  currentResult = result;
  if (result.query) queryInput.value = result.query;

  // Confidence badge
  const pct = Math.min(99, Math.round((result.score || 0) * 100));
  confidence.textContent = pct + '%';
  confidence.className = 'badge' + (pct > 35 ? ' good' : '');

  // Notes chunks
  const chunks = result.chunks || [];
  if (!chunks.length) {
    notesResult.className = 'card-body muted';
    notesResult.textContent = result.message || 'No matching chunks found in your notes.';
  } else {
    notesResult.className = 'card-body';
    notesResult.innerHTML = chunks.slice(0, 3).map((c, i) => {
      const meta = `<div style="font-size:11px;color:#9ca3af;margin-bottom:3px">${c.source || 'notes'} · ${Math.round((c.score||0)*100)}%</div>`;
      const body = highlight(c.answer || c.text || '', result.query || '');
      return `<div style="${i > 0 ? 'margin-top:10px;padding-top:10px;border-top:1px solid #f0f0f0' : ''}">${meta}${body}</div>`;
    }).join('');
  }

  // AI answer
  const directAnswer = result.directAnswer;
  const aiText = directAnswer || result.aiAnswer || '';
  if (!aiText || result.status === 'no-notes' || result.status === 'no-match') {
    aiResult.className = 'card-body muted';
    aiResult.textContent = result.message || (result.status === 'no-notes'
      ? 'Go to Notes tab and load your notes first.'
      : 'No AI answer. Add an API key in Settings tab.');
  } else {
    aiResult.className = 'card-body';
    aiResult.textContent = aiText;
  }
  provider.textContent = result.aiProvider ? result.aiProvider.toUpperCase() : (directAnswer ? 'NOTES' : '');

  // History
  addToHistory(result.query);
}

function renderError(msg) {
  notesResult.className = 'card-body muted';
  notesResult.textContent = msg;
}

// ── Quiz ───────────────────────────────────────────────────────
quizBtn.addEventListener('click', async () => {
  const chunk = currentResult?.chunks?.[0];
  if (!chunk) { alert('Search something first, then click Quiz me.'); return; }
  quizCard.style.display = 'block';
  quizResult.textContent = 'Generating…';
  const res = await sendMsg({ action: 'quizMe', chunk });
  quizResult.textContent = res?.quiz || res?.answer || 'Failed to generate question.';
  quizProvider.textContent = res?.aiProvider ? res.aiProvider.toUpperCase() : '';
});

// ── History ────────────────────────────────────────────────────
const sessionHistory = [];

function addToHistory(q) {
  if (!q) return;
  const idx = sessionHistory.indexOf(q);
  if (idx > -1) sessionHistory.splice(idx, 1);
  sessionHistory.unshift(q);
  renderHistory(sessionHistory.slice(0, 5));
}

function renderHistory(items) {
  if (!items.length) { historyList.innerHTML = ''; return; }
  historyList.innerHTML = items.map(q =>
    `<button onclick="document.getElementById('query').value=${JSON.stringify(q)};runSearchFromHistory(${JSON.stringify(q)})">${escHtml(q)}</button>`
  ).join('');
}

window.runSearchFromHistory = (q) => runSearch(q);

// ── Settings ───────────────────────────────────────────────────
saveSettings.addEventListener('click', async () => {
  await chrome.storage.session.set({
    apiKeys: {
      grok: grokKey.value.trim(),
      gemini: geminiKey.value.trim(),
      ollamaUrl: ollamaUrl.value.trim() || 'http://localhost:11434'
    },
    primaryAI: primaryAI.value
  });
  savedMsg.textContent = '✓ Saved!';
  setTimeout(() => { savedMsg.textContent = ''; }, 2000);
});

// ── Listen for background broadcasts ──────────────────────────
chrome.runtime.onMessage.addListener(msg => {
  if (!msg?.action) return;
  if (msg.action === 'showResult' && msg.result) renderResult(msg.result);
  if (msg.action === 'quizResult' && msg.result) {
    quizCard.style.display = 'block';
    quizResult.textContent = msg.result.quiz || '';
    quizProvider.textContent = msg.result.aiProvider?.toUpperCase() || '';
  }
});

// ── Helpers ────────────────────────────────────────────────────
function sendMsg(m) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(m, res => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(res);
      });
    } catch(e) { resolve(null); }
  });
}

function highlight(text, query) {
  const safe = escHtml(text);
  const terms = [...new Set((query.toLowerCase().match(/[a-z0-9]{3,}/g) || []))].slice(0, 8);
  if (!terms.length) return safe;
  const re = new RegExp(`\\b(${terms.map(escRe).join('|')})\\b`, 'gi');
  return safe.replace(re, '<mark>$1</mark>');
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
}
