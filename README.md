# StudyRAG

Lightweight browser-side study assistant for searching pasted notes without
leaving the current tab.

## Problem

Studying across browser tabs makes it slow to find relevant context in personal
notes. StudyRAG keeps notes and retrieval inside a browser side panel so answers
stay close to the material being reviewed.

## How It Works

The Manifest V3 extension stores pasted notes locally, opens a dedicated side
panel, and retrieves relevant note context for selected text or direct queries.
It supports Gemini, xAI, and local model endpoints.

## Tech Stack

- JavaScript
- Chrome Extension Manifest V3
- Browser storage and side-panel APIs
- Gemini, xAI, and local model endpoints

## Run Locally

```bash
git clone https://github.com/eshaanag/Dark-Mode.git
cd Dark-Mode
```

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the cloned `Dark-Mode` directory.
5. Open StudyRAG from the browser toolbar or side panel.

## Notable Implementation Detail

The extension uses the browser side-panel API and local storage to keep study
context accessible without navigating away from the active page.
