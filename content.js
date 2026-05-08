(function () {
  "use strict";

  if (window.__studyRAGInjected) return;
  window.__studyRAGInjected = true;

  let floatingBtn = null;
  let lastSelectedText = "";
  let hideTimer = null;

  function createButton() {
    const btn = document.createElement("div");
    btn.id = "__studyrag_btn";
    btn.innerHTML = "🔍 Search my notes &rarr;";
    btn.setAttribute("role", "button");
    btn.setAttribute("aria-label", "Search selected text in StudyRAG notes");
    btn.style.cssText = [
      "position: fixed",
      "z-index: 2147483647",
      "background: #2563eb",
      "color: #fff",
      "padding: 7px 13px",
      "border-radius: 6px",
      "font-size: 13px",
      "font-family: system-ui, -apple-system, sans-serif",
      "font-weight: 600",
      "line-height: 1.4",
      "cursor: pointer",
      "box-shadow: 0 3px 10px rgba(0,0,0,0.35)",
      "display: none",
      "border: none",
      "user-select: none",
      "max-width: 240px",
      "white-space: nowrap",
      "pointer-events: all"
    ].join(" !important;") + " !important";

    btn.addEventListener("mousedown", function (e) {
      e.preventDefault();
      e.stopPropagation();
    });

    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      const text = lastSelectedText;
      hideButton();
      if (text) triggerSearch(text);
    });

    (document.body || document.documentElement).appendChild(btn);
    return btn;
  }

  function showButton(x, y, text) {
    if (!document.body && !document.documentElement) return;
    if (!floatingBtn || !floatingBtn.isConnected) {
      floatingBtn = createButton();
    }

    clearTimeout(hideTimer);
    lastSelectedText = text;

    // Clamp position inside viewport
    const btnW = 240;
    const btnH = 34;
    const left = Math.max(8, Math.min(x, window.innerWidth - btnW - 8));
    const top = Math.max(8, Math.min(y + 12, window.innerHeight - btnH - 8));

    floatingBtn.style.setProperty("left", left + "px", "important");
    floatingBtn.style.setProperty("top", top + "px", "important");
    floatingBtn.style.setProperty("display", "block", "important");
  }

  function hideButton() {
    clearTimeout(hideTimer);
    if (floatingBtn) {
      floatingBtn.style.setProperty("display", "none", "important");
    }
    lastSelectedText = "";
  }

  function getSelectedText() {
    try {
      const sel = window.getSelection();
      return sel ? sel.toString().trim() : "";
    } catch (e) {
      return "";
    }
  }

  function getSelectionBottom() {
    try {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect && rect.width + rect.height > 0) {
        return { x: rect.left, y: rect.bottom };
      }
      // Fallback: use last client rect
      const rects = range.getClientRects();
      if (rects.length) {
        const last = rects[rects.length - 1];
        return { x: last.left, y: last.bottom };
      }
    } catch (e) {}
    return null;
  }

  function triggerSearch(text) {
    const query = String(text || "").trim();
    if (!query || query.length < 2) return;

    // Run the search - result goes to storage, panel reads it
    safeSendMessage({ action: "search", query }, function (response) {
      if (response && !response.ok && response.status === "no-notes") {
        showTemporaryTip("Open StudyRAG popup and paste notes first!");
      }
    });
  }

  function safeSendMessage(msg, callback) {
    try {
      chrome.runtime.sendMessage(msg, function (response) {
        if (chrome.runtime.lastError) {
          console.warn("StudyRAG:", chrome.runtime.lastError.message);
          if (callback) callback(null);
          return;
        }
        if (callback) callback(response);
      });
    } catch (e) {
      console.warn("StudyRAG: sendMessage failed", e);
    }
  }

  // Show a brief tip near the button position
  function showTemporaryTip(message) {
    const tip = document.createElement("div");
    tip.style.cssText = [
      "position: fixed",
      "z-index: 2147483647",
      "background: #1e293b",
      "color: #fff",
      "padding: 6px 12px",
      "border-radius: 6px",
      "font-size: 12px",
      "font-family: system-ui, sans-serif",
      "bottom: 16px",
      "right: 16px",
      "pointer-events: none"
    ].join(" !important;") + " !important";
    tip.textContent = message;
    document.body.appendChild(tip);
    setTimeout(() => tip.remove(), 3000);
  }

  // Mouseup: check for selection and show button
  document.addEventListener("mouseup", function (e) {
    // Don't trigger if clicking our own button
    if (floatingBtn && floatingBtn.contains(e.target)) return;

    setTimeout(function () {
      const text = getSelectedText();
      if (text.length > 2) {
        const pos = getSelectionBottom();
        if (pos) {
          showButton(pos.x, pos.y, text);
        }
      } else {
        hideButton();
      }
    }, 20);
  }, true);

  // Hide button when selection is cleared
  document.addEventListener("selectionchange", function () {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      const text = getSelectedText();
      if (!text) hideButton();
    }, 200);
  }, true);

  // Keyboard shortcuts
  document.addEventListener("keydown", function (e) {
    // Alt+Q: search selected text
    if (e.altKey && e.key && e.key.toLowerCase() === "q") {
      const text = getSelectedText() || lastSelectedText;
      if (text && text.length > 2) {
        e.preventDefault();
        triggerSearch(text);
        hideButton();
        showTemporaryTip("Searching... Open panel with Alt+S to see results");
      }
    }

    // Alt+S: toggle panel (via background which has the gesture context via command)
    if (e.altKey && e.key && e.key.toLowerCase() === "s") {
      e.preventDefault();
      safeSendMessage({ action: "togglePanel" });
    }

    if (e.key === "Escape") hideButton();
  }, true);

  // Hide button on mousedown outside it
  document.addEventListener("mousedown", function (e) {
    if (floatingBtn && !floatingBtn.contains(e.target)) {
      hideTimer = setTimeout(function () {
        if (!getSelectedText()) hideButton();
      }, 80);
    }
  }, true);

  // Listen for messages from background/popup
  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || !message.action) return;

    if (message.action === "collectSelectionAndSearch") {
      const text = getSelectedText() || lastSelectedText;
      if (text && text.length > 2) {
        triggerSearch(text);
      }
      hideButton();
    }

    if (message.action === "dataUpdated") {
      hideButton();
      showTemporaryTip("✓ Notes loaded in StudyRAG");
    }
  });

})();
