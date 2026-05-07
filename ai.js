const DEFAULT_ORDER = ["grok", "gemini", "ollama"];
const SYSTEM_PROMPT =
  "You are a study assistant helping a student understand their own notes. Explain the concept clearly, relate it to the provided context, and suggest a way to remember it. Do not just give the answer - help them understand.";

export async function explainWithAI({ question, chunks = [], apiKeys = {}, primaryAI = "grok" }) {
  const context = selectContext(chunks);
  const userPrompt = `Context:\n${context || "No matching notes were found."}\n\nQuestion: ${question}\n\nExplanation:`;
  return callProviderChain({ systemPrompt: SYSTEM_PROMPT, userPrompt, apiKeys, primaryAI });
}

export async function generatePracticeQuestion({ chunk, apiKeys = {}, primaryAI = "grok" }) {
  const source = typeof chunk === "string" ? chunk : chunk?.text || "";
  const userPrompt = `Create one active-recall practice question from this study note. Include a short expected answer after it.\n\nStudy note:\n${source}`;
  return callProviderChain({ systemPrompt: SYSTEM_PROMPT, userPrompt, apiKeys, primaryAI });
}

async function callProviderChain({ systemPrompt, userPrompt, apiKeys, primaryAI }) {
  const order = buildProviderOrder(primaryAI);
  const errors = [];

  for (const provider of order) {
    try {
      const answer = await withTimeout(
        (signal) => callProvider(provider, { systemPrompt, userPrompt, apiKeys, signal }),
        3000
      );
      if (answer) {
        return {
          answer: answer.trim(),
          provider,
          ok: true,
          errors
        };
      }
    } catch (error) {
      errors.push(`${provider}: ${error.message || "request failed"}`);
    }
  }

  return {
    answer: "No AI explanation available. Check your API keys, network, or local Ollama server.",
    provider: null,
    ok: false,
    errors
  };
}

function buildProviderOrder(primaryAI) {
  const normalized = DEFAULT_ORDER.includes(primaryAI) ? primaryAI : "grok";
  return [normalized, ...DEFAULT_ORDER.filter((provider) => provider !== normalized)];
}

function selectContext(chunks) {
  const usable = chunks && chunks.length ? chunks : [];
  const limit = usable[0]?.score > 0.7 ? 1 : 3;
  return usable
    .slice(0, limit)
    .map((chunk, index) => `[${index + 1}] ${chunk.text}`)
    .join("\n\n")
    .slice(0, 1800);
}

async function callProvider(provider, options) {
  if (provider === "grok") return callGrok(options);
  if (provider === "gemini") return callGemini(options);
  return callOllama(options);
}

async function callGrok({ systemPrompt, userPrompt, apiKeys, signal }) {
  if (!apiKeys?.grok) throw new Error("missing Grok API key");

  const response = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKeys.grok}`,
      "X-Priority": "high"
    },
    signal,
    body: JSON.stringify({
      model: "grok-3-mini",
      max_tokens: 200,
      temperature: 0.3,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    })
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  return data?.choices?.[0]?.message?.content || "";
}

async function callGemini({ systemPrompt, userPrompt, apiKeys, signal }) {
  if (!apiKeys?.gemini) throw new Error("missing Gemini API key");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(apiKeys.gemini)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Priority": "high"
      },
      signal,
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemPrompt }]
        },
        contents: [
          {
            role: "user",
            parts: [{ text: userPrompt }]
          }
        ],
        generationConfig: {
          maxOutputTokens: 200,
          temperature: 0.3
        }
      })
    }
  );

  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  return data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
}

async function callOllama({ systemPrompt, userPrompt, apiKeys, signal }) {
  const baseUrl = (apiKeys?.ollamaUrl || "http://localhost:11434").replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Priority": "high"
    },
    signal,
    body: JSON.stringify({
      model: "mistral",
      stream: false,
      prompt: `${systemPrompt}\n\n${userPrompt}`
    })
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  return data?.response || "";
}

function withTimeout(task, timeoutMs) {
  const controller = new AbortController();
  let timeoutId;

  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error("timeout"));
    }, timeoutMs);
  });

  return Promise.race([task(controller.signal), timeout]).finally(() => clearTimeout(timeoutId));
}
