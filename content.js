(function () {
  "use strict";

  if (window.__studyRAGInjected) return;
  window.__studyRAGInjected = true;

  let floatingBtn = null;
  let answerBubble = null;
  let lastSelectedText = "";
  let hideTimer = null;

  // ── Floating search button ──────────────────────────────────────
  function createButton() {
    const btn = document.createElement("div");
    btn.id = "__studyrag_btn";
    btn.textContent = "Search my notes →";
    btn.style.cssText = "position:fixed!important;z-index:2147483646!important;background:#2563eb!important;color:#fff!important;padding:6px 12px!important;border-radius:6px!important;font-size:12px!important;font-family:system-ui,sans-serif!important;font-weight:600!important;cursor:pointer!important;box-shadow:0 3px 10px rgba(0,0,0,0.3)!important;display:none!important;border:none!important;user-select:none!important;white-space:nowrap!important;line-height:1.4!important;";
    btn.addEventListener("mousedown", e => { e.preventDefault(); e.stopPropagation(); });
    btn.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation();
      const text = lastSelectedText;
      hideButton();
      if (text) triggerSearch(text);
    });
    (document.body || document.documentElement).appendChild(btn);
    return btn;
  }

  function showButton(x, y, text) {
    if (!document.body) return;
    if (!floatingBtn || !floatingBtn.isConnected) floatingBtn = createButton();
    clearTimeout(hideTimer);
    lastSelectedText = text;
    floatingBtn.style.setProperty("left", Math.max(8, Math.min(x, window.innerWidth - 180)) + "px", "important");
    floatingBtn.style.setProperty("top", Math.max(8, Math.min(y + 10, window.innerHeight - 40)) + "px", "important");
    floatingBtn.style.setProperty("display", "block", "important");
  }

  function hideButton() {
    clearTimeout(hideTimer);
    if (floatingBtn) floatingBtn.style.setProperty("display", "none", "important");
    lastSelectedText = "";
  }

  // ── Tiny answer bubble (bottom-right, no panel opening) ─────────
  function getBubble() {
    if (answerBubble && answerBubble.isConnected) return answerBubble;

    const b = document.createElement("div");
    b.id = "__studyrag_bubble";

    const head = document.createElement("div");
    head.style.cssText = "display:flex!important;align-items:center!important;justify-content:space-between!important;padding:7px 11px!important;background:#0f172a!important;font-size:10px!important;font-weight:700!important;color:#94a3b8!important;letter-spacing:.05em!important;text-transform:uppercase!important;";
    const lbl = document.createElement("span"); lbl.textContent = "StudyRAG";
    const x = document.createElement("span");
    x.textContent = "✕";
    x.style.cssText = "cursor:pointer!important;color:#64748b!important;font-size:13px!important;";
    x.addEventListener("click", hideBubble);
    head.appendChild(lbl); head.appendChild(x);

    const body = document.createElement("div");
    body.id = "__srag_body";
    body.style.cssText = "padding:10px 12px!important;font-size:13px!important;color:#f1f5f9!important;word-break:break-word!important;line-height:1.5!important;";

    const foot = document.createElement("div");
    foot.id = "__srag_foot";
    foot.style.cssText = "padding:2px 12px 8px!important;font-size:11px!important;color:#64748b!important;";

    b.appendChild(head); b.appendChild(body); b.appendChild(foot);
    b.style.cssText = "position:fixed!important;z-index:2147483647!important;bottom:20px!important;right:20px!important;max-width:300px!important;min-width:200px!important;background:#1e293b!important;border-radius:10px!important;box-shadow:0 8px 24px rgba(0,0,0,0.45)!important;display:none!important;border:none!important;overflow:hidden!important;font-family:system-ui,sans-serif!important;";
    (document.body || document.documentElement).appendChild(b);
    answerBubble = b;
    return b;
  }

  function showBubble(answer, score, src) {
    const b = getBubble();
    const body = document.getElementById("__srag_body");
    const foot = document.getElementById("__srag_foot");
    if (body) body.textContent = answer;
    if (foot) {
      const pct = Math.min(99, Math.round((score || 0) * 100));
      foot.textContent = (pct > 35 ? "🟢" : "🟡") + " " + pct + "% · " + (src || "notes");
    }
    b.style.setProperty("display", "block", "important");
    clearTimeout(b.__t);
    b.__t = setTimeout(hideBubble, 12000);
  }

  function showBubbleLoading() {
    const b = getBubble();
    const body = document.getElementById("__srag_body");
    const foot = document.getElementById("__srag_foot");
    if (body) body.textContent = "Searching…";
    if (foot) foot.textContent = "";
    b.style.setProperty("display", "block", "important");
  }

  function hideBubble() {
    if (answerBubble) answerBubble.style.setProperty("display", "none", "important");
  }

  // ── Search → result in bubble, no panel ────────────────────────
  function triggerSearch(text) {
    const q = text.trim();
    if (!q || q.length < 2) return;
    showBubbleLoading();
    try {
      chrome.runtime.sendMessage({ action: "manualSearch", query: q }, function (res) {
        if (chrome.runtime.lastError) { showBubble("Extension error — reload tab.", 0, "err"); return; }
        if (!res) { showBubble("No response.", 0, "err"); return; }
        if (res.status === "no-notes") {
          showBubble("No notes loaded. Click the S icon → Notes tab → paste notes.", 0, "info");
          return;
        }
        const answer = res.directAnswer || res.aiAnswer || res.chunks?.[0]?.answer || res.chunks?.[0]?.text || "No match found.";
        showBubble(answer, res.score || 0, res.aiProvider || res.chunks?.[0]?.source || "notes");
      });
    } catch(e) { showBubble("Error: " + e.message, 0, "err"); }
  }

  // ── Selection detection ─────────────────────────────────────────
  function getSel() { try { return (window.getSelection()||"").toString().trim(); } catch(e) { return ""; } }

  function getSelPos() {
    try {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      const r = sel.getRangeAt(0).getBoundingClientRect();
      if (r && r.width + r.height > 0) return { x: r.left, y: r.bottom };
    } catch(e) {}
    return null;
  }

  document.addEventListener("mouseup", function(e) {
    if (floatingBtn && floatingBtn.contains(e.target)) return;
    if (answerBubble && answerBubble.contains(e.target)) return;
    setTimeout(() => {
      const text = getSel();
      if (text.length > 2) { const p = getSelPos(); if (p) showButton(p.x, p.y, text); }
      else hideButton();
    }, 20);
  }, true);

  document.addEventListener("selectionchange", function() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (!getSel()) hideButton(); }, 200);
  }, true);

  document.addEventListener("keydown", function(e) {
    if (e.altKey && e.key && e.key.toLowerCase() === "q") {
      const text = getSel() || lastSelectedText;
      if (text && text.length > 2) { e.preventDefault(); triggerSearch(text); hideButton(); }
    }
    if (e.key === "Escape") { hideButton(); hideBubble(); }
  }, true);

  document.addEventListener("mousedown", function(e) {
    if (floatingBtn && !floatingBtn.contains(e.target)) {
      hideTimer = setTimeout(() => { if (!getSel()) hideButton(); }, 80);
    }
    if (answerBubble && answerBubble.style.display !== "none" &&
        !answerBubble.contains(e.target) && (!floatingBtn || !floatingBtn.contains(e.target))) {
      hideBubble();
    }
  }, true);

  chrome.runtime.onMessage.addListener(function(msg) {
    if (!msg?.action) return;
    if (msg.action === "collectSelectionAndSearch") {
      const text = getSel() || lastSelectedText;
      if (text && text.length > 2) triggerSearch(text);
      hideButton();
    }
    if (msg.action === "dataUpdated") hideButton();
  });

})();
