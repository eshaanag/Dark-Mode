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
    btn.textContent = "Search my notes ->";
    btn.setAttribute("role", "button");
    btn.setAttribute("aria-label", "Search selected text in StudyRAG notes");
    btn.style.cssText = [
      "position: fixed !important",
      "z-index: 2147483647 !important",
      "background: #0046fa !important",
      "color: #fff !important",
      "padding: 8px 14px !important",
      "border-radius: 6px !important",
      "font-size: 13px !important",
      "font-family: system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif !important",
      "font-weight: 600 !important",
      "line-height: 1 !important",
      "cursor: pointer !important",
      "box-shadow: 0 4px 12px rgba(0,0,0,0.3) !important",
      "display: none !important",
      "border: none !important",
      "user-select: none !important",
      "transition: opacity 0.15s ease !important",
      "max-width: 220px !important",
      "white-space: nowrap !important"
    ].join(";");

    btn.addEventListener("mousedown", function (event) {
      event.preventDefault();
      event.stopPropagation();
    });

    btn.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      const selectedText = lastSelectedText || getSelectedText();
      if (selectedText) triggerSearch(selectedText);
      hideButton();
    });

    const parent = document.body || document.documentElement;
    parent.appendChild(btn);
    return btn;
  }

  function showButton(x, y, text) {
    if (!document.body) return;
    if (!floatingBtn || !floatingBtn.isConnected) floatingBtn = createButton();

    clearTimeout(hideTimer);
    lastSelectedText = text;

    const left = Math.max(8, Math.min(x, window.innerWidth - 220));
    const top = Math.max(8, Math.min(y + 10, window.innerHeight - 44));

    floatingBtn.style.left = left + "px";
    floatingBtn.style.top = top + "px";
    floatingBtn.style.display = "block";
    floatingBtn.style.opacity = "1";
  }

  function hideButton() {
    clearTimeout(hideTimer);
    if (floatingBtn) {
      floatingBtn.style.display = "none";
      floatingBtn.style.opacity = "0";
    }
    lastSelectedText = "";
  }

  function getSelectedText() {
    const selection = window.getSelection();
    return selection ? selection.toString().trim() : "";
  }

  function getSelectionRect() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;

    try {
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect && (rect.width || rect.height)) return rect;

      const rects = range.getClientRects();
      return rects.length ? rects[rects.length - 1] : null;
    } catch (error) {
      console.warn("StudyRAG: could not read selection bounds", error);
      return null;
    }
  }

  function inspectSelection() {
    const text = getSelectedText();
    if (text.length <= 3) {
      hideButton();
      return;
    }

    const rect = getSelectionRect();
    if (!rect) {
      hideButton();
      return;
    }

    showButton(rect.left, rect.bottom, text);
  }

  function triggerSearch(text) {
    const query = String(text || "").trim();
    if (!query) return;

    try {
      chrome.runtime.sendMessage({ action: "openPanel" }, function () {
        if (chrome.runtime.lastError) {
          console.warn("StudyRAG: openPanel failed:", chrome.runtime.lastError.message);
        }
      });

      chrome.runtime.sendMessage({ action: "search", query }, function (response) {
        if (chrome.runtime.lastError) {
          console.warn("StudyRAG: search failed:", chrome.runtime.lastError.message);
          return;
        }
        if (response && response.ok === false) {
          console.warn("StudyRAG:", response.error || response.message || "search failed");
        }
      });
    } catch (error) {
      console.warn("StudyRAG: could not send search message", error);
    }
  }

  document.addEventListener(
    "mouseup",
    function () {
      setTimeout(inspectSelection, 20);
    },
    true
  );

  document.addEventListener(
    "selectionchange",
    function () {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(function () {
        if (!getSelectedText()) hideButton();
      }, 180);
    },
    true
  );

  document.addEventListener(
    "keydown",
    function (event) {
      if (event.altKey && event.key && event.key.toLowerCase() === "q") {
        const text = getSelectedText() || lastSelectedText;
        if (text && text.length > 3) {
          event.preventDefault();
          triggerSearch(text);
          hideButton();
        }
      }

      if (event.altKey && event.key && event.key.toLowerCase() === "s") {
        event.preventDefault();
        try {
          chrome.runtime.sendMessage({ action: "togglePanel" }, function () {
            if (chrome.runtime.lastError) {
              console.warn("StudyRAG: togglePanel failed:", chrome.runtime.lastError.message);
            }
          });
        } catch (error) {
          console.warn("StudyRAG: could not toggle panel", error);
        }
      }

      if (event.key === "Escape") hideButton();
    },
    true
  );

  document.addEventListener(
    "mousedown",
    function (event) {
      if (floatingBtn && event.target !== floatingBtn && !floatingBtn.contains(event.target)) {
        hideTimer = setTimeout(function () {
          if (!getSelectedText()) hideButton();
        }, 60);
      }
    },
    true
  );

  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || !message.action) return;

    if (message.action === "collectSelectionAndSearch") {
      const text = getSelectedText() || lastSelectedText;
      if (text && text.length > 3) triggerSearch(text);
      hideButton();
    }

    if (message.action === "dataUpdated") {
      hideButton();
    }
  });
})();
