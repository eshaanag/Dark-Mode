const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "but", "by",
  "can", "could", "did", "do", "does", "for", "from", "had", "has", "have",
  "how", "i", "if", "in", "into", "is", "it", "its", "may", "might", "must",
  "of", "on", "or", "our", "should", "so", "than", "that", "the", "their",
  "then", "there", "these", "this", "those", "to", "was", "were", "what",
  "when", "where", "which", "who", "why", "will", "with", "you", "your"
]);

let state = emptyState();

export function initRetriever(text = "") {
  const chunks = parseChunks(text);
  const indexedChunks = chunks.map((chunk, index) => {
    const searchText = [chunk.text, chunk.answer || ""].filter(Boolean).join("\n");
    const tokens = tokenize(searchText);
    const tf = {};

    for (const token of tokens) {
      tf[token] = (tf[token] || 0) + 1;
    }

    return {
      ...chunk,
      id: `chunk-${index}`,
      text: chunk.text,
      answer: chunk.answer || "",
      score: 0,
      tf,
      length: Math.max(tokens.length, 1)
    };
  });

  const idf = {};
  const documentFrequency = {};

  for (const chunk of indexedChunks) {
    for (const token of Object.keys(chunk.tf)) {
      documentFrequency[token] = (documentFrequency[token] || 0) + 1;
    }
  }

  const totalDocs = indexedChunks.length;
  for (const [token, frequency] of Object.entries(documentFrequency)) {
    idf[token] = Math.log(1 + (totalDocs - frequency + 0.5) / (frequency + 0.5));
  }

  const avgLen = totalDocs
    ? indexedChunks.reduce((sum, chunk) => sum + chunk.length, 0) / totalDocs
    : 1;

  state = {
    chunks: indexedChunks,
    idf,
    avgLen: avgLen || 1,
    totalDocs,
    ready: true
  };

  return getIndexSnapshot();
}

export function loadRetriever(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.chunks) || !snapshot.idf) {
    state = emptyState();
    return false;
  }

  state = {
    chunks: snapshot.chunks,
    idf: snapshot.idf,
    avgLen: snapshot.avgLen || 1,
    totalDocs: snapshot.totalDocs || snapshot.chunks.length,
    ready: true
  };

  return true;
}

export function getIndexSnapshot() {
  return {
    chunks: state.chunks,
    idf: state.idf,
    avgLen: state.avgLen,
    totalDocs: state.totalDocs,
    ready: state.ready
  };
}

export function query(questionText = "") {
  if (!state.ready || !state.chunks.length) {
    return { directAnswer: null, chunks: [], score: 0 };
  }

  const queryTokens = tokenize(questionText);
  if (!queryTokens.length) {
    return { directAnswer: null, chunks: [], score: 0 };
  }

  const scored = state.chunks
    .map((chunk) => {
      const score = retrievalScore(queryTokens, chunk);
      return {
        id: chunk.id,
        text: chunk.text,
        answer: chunk.answer || "",
        source: chunk.source || "unknown",
        score
      };
    })
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  const top = scored[0] || null;
  const score = top ? top.score : 0;

  return {
    directAnswer: top && top.answer && score > 0.7 ? top.answer : null,
    chunks: scored,
    score
  };
}

export function parseChunks(input = "") {
  const text = normalizeText(input);
  if (!text) return [];

  const chunks = [];
  collectStructuredData(text, chunks);
  collectRegexObjects(text, chunks);
  collectExplicitQa(text, chunks);
  collectNumberedPairs(text, chunks);
  collectLinePairs(text, chunks);

  const hasStructuredChunks = chunks.length > 0;

  if (!hasStructuredChunks) {
    collectParagraphs(text, chunks);
  }

  if (!hasStructuredChunks) {
    collectSentences(text, chunks);
  }

  return dedupeChunks(chunks).map((chunk, index) => ({
    id: `chunk-${index}`,
    text: cleanChunkText(chunk.text),
    answer: chunk.answer ? cleanChunkText(chunk.answer) : "",
    source: chunk.source || "text",
    score: 0
  }));
}

export function tokenize(text = "") {
  return String(text)
    .toLowerCase()
    .replace(/&nbsp;/g, " ")
    .replace(/[_-]/g, " ")
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .map((token) => stem(token.replace(/^'+|'+$/g, "")))
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

function collectStructuredData(text, chunks) {
  for (const candidate of jsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate);
      walkStructuredValue(parsed, chunks);
    } catch {
      // Raw JS-like notes are handled by regex parsing below.
    }
  }
}

function collectRegexObjects(text, chunks) {
  const objectRe = /(?:^|[{,\[])\s*["']?(?:question|q)["']?\s*:\s*["'`]([\s\S]{5,}?)["'`]\s*,?\s*["']?(?:answer|a)["']?\s*:\s*["'`]([\s\S]{2,}?)["'`]/gi;
  let match;

  while ((match = objectRe.exec(text)) !== null) {
    addChunk(chunks, match[1], match[2], "js-object");
  }
}

function collectExplicitQa(text, chunks) {
  const qaRe = /(?:^|\n)\s*(?:Q|Question)\s*[:\-]\s*(.+?)\s*\n\s*(?:A|Answer)\s*[:\-]\s*([\s\S]+?)(?=\n\s*(?:Q|Question)\s*[:\-]|\n\s*\d+[.)]\s+|$)/gi;
  let match;

  while ((match = qaRe.exec(text)) !== null) {
    addChunk(chunks, match[1], match[2], "qa-format");
  }
}

function collectNumberedPairs(text, chunks) {
  const numberedRe = /(?:^|\n)\s*\d+[.)]\s*(.{5,}?)(?:\s*[-:–]\s*|\n\s*)(.{3,}?)(?=\n\s*\d+[.)]\s+|\n\s*(?:Q|Question)\s*[:\-]|$)/gis;
  let match;

  while ((match = numberedRe.exec(text)) !== null) {
    const question = match[1].trim();
    const answer = match[2].trim();
    if (question && answer && question !== answer) {
      addChunk(chunks, question, answer, "numbered");
    }
  }
}

function collectLinePairs(text, chunks) {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = 0; index < lines.length - 1; index += 1) {
    const current = lines[index];
    const next = lines[index + 1];

    if (/^(?:q|question)\s*[:\-]/i.test(current) && /^(?:a|answer)\s*[:\-]/i.test(next)) {
      continue;
    }

    if (looksLikeQuestion(current) && next.length > 2 && !looksLikeQuestion(next)) {
      addChunk(chunks, current.replace(/^\d+[.)]\s*/, ""), next, "line-pair");
      index += 1;
    }
  }
}

function collectParagraphs(text, chunks) {
  const paragraphs = text
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 25);

  for (const paragraph of paragraphs) {
    addChunk(chunks, paragraph, "", "paragraph");
  }
}

function collectSentences(text, chunks) {
  const compact = text.replace(/\s+/g, " ");
  const sentences = compact
    .split(/(?<=[.!?])\s+|;\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 12);

  for (const sentence of sentences) {
    addChunk(chunks, sentence, "", "sentence");
  }
}

function addChunk(chunks, text, answer, source) {
  const cleanText = cleanChunkText(text);
  const cleanAnswer = cleanChunkText(answer || "");
  if (!cleanText || cleanText.length < 2) return;

  chunks.push({
    id: `chunk-${chunks.length}`,
    text: cleanAnswer ? `${cleanText}\n${cleanAnswer}` : cleanText,
    answer: cleanAnswer,
    source,
    score: 0
  });
}

function walkStructuredValue(value, chunks) {
  if (Array.isArray(value)) {
    for (const item of value) walkStructuredValue(item, chunks);
    return;
  }

  if (!value || typeof value !== "object") return;

  const question = value.question ?? value.q ?? value.prompt ?? value.term ?? value.front;
  const answer = value.answer ?? value.a ?? value.response ?? value.definition ?? value.back;

  if (question && answer) {
    addChunk(chunks, String(question), String(answer), "json-object");
  }

  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object") walkStructuredValue(nested, chunks);
  }
}

function jsonCandidates(text) {
  const candidates = [];
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) candidates.push(trimmed);

  const arrayStart = text.indexOf("[");
  const arrayEnd = text.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    candidates.push(text.slice(arrayStart, arrayEnd + 1));
  }

  const objectStart = text.indexOf("{");
  const objectEnd = text.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(text.slice(objectStart, objectEnd + 1));
  }

  return Array.from(new Set(candidates));
}

function retrievalScore(queryTokens, chunk) {
  const bm25 = bm25Score(queryTokens, chunk);
  const uniqueTokens = Array.from(new Set(queryTokens));
  const matches = uniqueTokens.filter((token) => chunk.tf[token]).length;
  const coverage = uniqueTokens.length ? matches / uniqueTokens.length : 0;
  const exactBoost = exactPhraseBoost(queryTokens, chunk);
  return Number((bm25 + coverage + exactBoost).toFixed(4));
}

function bm25Score(queryTokens, chunk) {
  const k1 = 1.5;
  const b = 0.75;
  let score = 0;

  for (const token of new Set(queryTokens)) {
    const frequency = chunk.tf[token] || 0;
    if (!frequency) continue;

    const idf = state.idf[token] || 0.1;
    const denominator = frequency + k1 * (1 - b + b * (chunk.length / state.avgLen));
    score += idf * ((frequency * (k1 + 1)) / denominator);
  }

  return score;
}

function exactPhraseBoost(queryTokens, chunk) {
  const chunkTokens = new Set(Object.keys(chunk.tf || {}));
  const matched = queryTokens.filter((token) => chunkTokens.has(token)).length;
  if (queryTokens.length <= 2 && matched) return 0.45;
  if (matched === queryTokens.length) return 0.35;
  return 0;
}

function stem(token) {
  if (token.length <= 3) return token;

  const suffixes = [
    "ization", "ational", "fulness", "iveness", "tional", "ments", "ment",
    "ingly", "edly", "ing", "ies", "ied", "ed", "es", "s"
  ];

  for (const suffix of suffixes) {
    if (token.endsWith(suffix) && token.length > suffix.length + 2) {
      if (suffix === "ies" || suffix === "ied") return `${token.slice(0, -suffix.length)}y`;
      return token.slice(0, -suffix.length);
    }
  }

  return token;
}

function looksLikeQuestion(text) {
  return /\?$/.test(text) || /^(?:q|question)\s*[:\-]/i.test(text) || /^\d+[.)]\s+/.test(text);
}

function dedupeChunks(chunks) {
  const seen = new Set();
  const result = [];

  for (const chunk of chunks) {
    const key = cleanChunkText(chunk.text).toLowerCase().slice(0, 220);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(chunk);
  }

  return result;
}

function cleanChunkText(value) {
  return String(value || "")
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim();
}

function emptyState() {
  return {
    chunks: [],
    idf: {},
    avgLen: 1,
    totalDocs: 0,
    ready: false
  };
}
