let selectionButton = null;
let lastSelection = "";

document.addEventListener("mouseup", () => {
  setTimeout(showSelectionButton, 0);
});

document.addEventListener("keyup", (event) => {
  if (event.key === "Escape") removeSelectionButton();
});

document.addEventListener("keydown", (event) => {
  if (event.altKey && event.key.toLowerCase() === "q") {
    event.preventDefault();
    searchCurrentSelection();
  }

  if (event.altKey && event.key.toLowerCase() === "s") {
    chrome.runtime.sendMessage({ action: "openPanel" }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.action === "collectSelectionAndSearch") {
    searchCurrentSelection();
  }

  if (message?.action === "dataUpdated") {
    removeSelectionButton();
  }
});

function showSelectionButton() {
  const selection = window.getSelection();
  const text = selection?.toString().trim() || "";

  if (!text || text.length < 2) {
    removeSelectionButton();
    return;
  }

  lastSelection = text;
  const rect = getSelectionRect(selection);
  if (!rect) return;

  if (!selectionButton) {
    selectionButton = document.createElement("button");
    selectionButton.type = "button";
    selectionButton.textContent = "Search my notes ->";
    selectionButton.setAttribute("aria-label", "Search selected text in StudyRAG notes");
    Object.assign(selectionButton.style, {
      position: "fixed",
      zIndex: "2147483647",
      padding: "7px 10px",
      border: "1px solid rgba(255,255,255,0.18)",
      borderRadius: "6px",
      background: "rgba(17, 24, 39, 0.96)",
      color: "#fff",
      font: "12px system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      boxShadow: "0 8px 24px rgba(0,0,0,0.22)",
      cursor: "pointer"
    });
    selectionButton.addEventListener("mousedown", (event) => event.preventDefault());
    selectionButton.addEventListener("click", () => {
      searchCurrentSelection(lastSelection);
      removeSelectionButton();
    });
    document.documentElement.appendChild(selectionButton);
  }

  const top = Math.max(8, rect.bottom + 8);
  const left = Math.min(window.innerWidth - 150, Math.max(8, rect.left));
  selectionButton.style.top = `${top}px`;
  selectionButton.style.left = `${left}px`;
}

function searchCurrentSelection(fallbackText = "") {
  const selectedText = (window.getSelection()?.toString() || fallbackText || lastSelection).trim();
  if (!selectedText) return;

  chrome.runtime.sendMessage({
    action: "searchNotes",
    query: selectedText
  }).catch(() => {});
}

function getSelectionRect(selection) {
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (rect && (rect.width || rect.height)) return rect;

  const rects = range.getClientRects();
  return rects.length ? rects[0] : null;
}

function removeSelectionButton() {
  if (selectionButton) {
    selectionButton.remove();
    selectionButton = null;
  }
}
