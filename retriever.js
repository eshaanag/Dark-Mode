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
      tf,
      length: Math.max(tokens.length, 1)
    };
  });

  const documentFrequency = {};
  for (const chunk of indexedChunks) {
    for (const token of Object.keys(chunk.tf)) {
      documentFrequency[token] = (documentFrequency[token] || 0) + 1;
    }
  }

  const totalDocs = indexedChunks.length;
  const idf = {};
  for (const [token, freq] of Object.entries(documentFrequency)) {
    idf[token] = Math.log(1 + (totalDocs - freq + 0.5) / (freq + 0.5));
  }

  const avgLen = totalDocs
    ? indexedChunks.reduce((sum, c) => sum + c.length, 0) / totalDocs
    : 1;

  state = { chunks: indexedChunks, idf, avgLen: avgLen || 1, totalDocs, ready: true };
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
    .map((chunk) => ({
      id: chunk.id,
      text: chunk.text,
      answer: chunk.answer || "",
      source: chunk.source || "unknown",
      score: retrievalScore(queryTokens, chunk)
    }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  const top = scored[0] || null;
  const score = top ? top.score : 0;

  // FIX: Lower threshold from 0.7 to 0.35 so short queries still get direct answers
  // A chunk with an explicit answer field AND any meaningful match should return directly
  const directAnswer = top && top.answer && score > 0.35 ? top.answer : null;

  return { directAnswer, chunks: scored, score };
}

export function parseChunks(input = "") {
  const text = normalizeText(input);
  if (!text) return [];

  const chunks = [];

  // Format 1: JSON/JS arrays and objects {question, answer}
  collectStructuredData(text, chunks);

  // Format 2: JS-style object literals question: "...", answer: "..."
  collectRegexObjects(text, chunks);

  // Format 3: Explicit "Q: ...\nA: ..." pairs
  collectExplicitQa(text, chunks);

  // Format 4: Numbered pairs "1. question\nanswer"
  collectNumberedPairs(text, chunks);

  // Format 5: Line pairs (question line followed by answer line)
  collectLinePairs(text, chunks);

  const hasStructured = chunks.length > 0;

  // Fallback: raw paragraphs
  if (!hasStructured) collectParagraphs(text, chunks);

  // Last resort: individual sentences
  if (!hasStructured && chunks.length === 0) collectSentences(text, chunks);

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
    .map((t) => stem(t.replace(/^'+|'+$/g, "")))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function collectStructuredData(text, chunks) {
  for (const candidate of jsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate);
      walkStructuredValue(parsed, chunks);
    } catch {
      // Not valid JSON, handled by regex below
    }
  }
}

function collectRegexObjects(text, chunks) {
  // Matches JS object literals: question: "...", answer: "..."
  const re = /(?:^|[{,\[])\s*["']?(?:question|q)["']?\s*:\s*["'`]([\s\S]{3,}?)["'`]\s*,?\s*["']?(?:answer|a)["']?\s*:\s*["'`]([\s\S]{2,}?)["'`]/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    addChunk(chunks, m[1], m[2], "js-object");
  }
}

function collectExplicitQa(text, chunks) {
  const re = /(?:^|\n)\s*(?:Q|Question)\s*[:\-]\s*(.+?)\s*\n\s*(?:A|Answer)\s*[:\-]\s*([\s\S]+?)(?=\n\s*(?:Q|Question)\s*[:\-]|\n\s*\d+[.)]\s+|$)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    addChunk(chunks, m[1], m[2], "qa-format");
  }
}

function collectNumberedPairs(text, chunks) {
  const re = /(?:^|\n)\s*\d+[.)]\s*(.{5,}?)(?:\s*[-:–]\s*|\n\s*)(.{3,}?)(?=\n\s*\d+[.)]\s+|\n\s*(?:Q|Question)\s*[:\-]|$)/gis;
  let m;
  while ((m = re.exec(text)) !== null) {
    const q = m[1].trim(), a = m[2].trim();
    if (q && a && q !== a) addChunk(chunks, q, a, "numbered");
  }
}

function collectLinePairs(text, chunks) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length - 1; i++) {
    const cur = lines[i], next = lines[i + 1];
    if (/^(?:q|question)\s*[:\-]/i.test(cur) && /^(?:a|answer)\s*[:\-]/i.test(next)) continue;
    if (looksLikeQuestion(cur) && next.length > 2 && !looksLikeQuestion(next)) {
      addChunk(chunks, cur.replace(/^\d+[.)]\s*/, ""), next, "line-pair");
      i++;
    }
  }
}

function collectParagraphs(text, chunks) {
  text.split(/\n\s*\n+/).map((p) => p.trim()).filter((p) => p.length > 25).forEach((p) => {
    addChunk(chunks, p, "", "paragraph");
  });
}

function collectSentences(text, chunks) {
  text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+|;\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 12).forEach((s) => {
    addChunk(chunks, s, "", "sentence");
  });
}

function addChunk(chunks, text, answer, source) {
  const t = cleanChunkText(text);
  const a = cleanChunkText(answer || "");
  if (!t || t.length < 2) return;
  chunks.push({
    id: `chunk-${chunks.length}`,
    text: a ? `${t}\n${a}` : t,
    answer: a,
    source,
    score: 0
  });
}

function walkStructuredValue(value, chunks) {
  if (Array.isArray(value)) {
    value.forEach((item) => walkStructuredValue(item, chunks));
    return;
  }
  if (!value || typeof value !== "object") return;
  const q = value.question ?? value.q ?? value.prompt ?? value.term ?? value.front;
  const a = value.answer ?? value.a ?? value.response ?? value.definition ?? value.back;
  if (q && a) addChunk(chunks, String(q), String(a), "json-object");
  for (const v of Object.values(value)) {
    if (v && typeof v === "object") walkStructuredValue(v, chunks);
  }
}

function jsonCandidates(text) {
  const candidates = [];
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) candidates.push(t);
  const ai = text.indexOf("["), ae = text.lastIndexOf("]");
  if (ai >= 0 && ae > ai) candidates.push(text.slice(ai, ae + 1));
  const oi = text.indexOf("{"), oe = text.lastIndexOf("}");
  if (oi >= 0 && oe > oi) candidates.push(text.slice(oi, oe + 1));
  return [...new Set(candidates)];
}

function retrievalScore(queryTokens, chunk) {
  const bm25 = bm25Score(queryTokens, chunk);
  const unique = [...new Set(queryTokens)];
  const matches = unique.filter((t) => chunk.tf[t]).length;
  const coverage = unique.length ? matches / unique.length : 0;
  const boost = exactPhraseBoost(queryTokens, chunk);
  return Number((bm25 + coverage + boost).toFixed(4));
}

function bm25Score(queryTokens, chunk) {
  const k1 = 1.5, b = 0.75;
  let score = 0;
  for (const token of new Set(queryTokens)) {
    const freq = chunk.tf[token] || 0;
    if (!freq) continue;
    const idf = state.idf[token] || 0.1;
    const denom = freq + k1 * (1 - b + b * (chunk.length / state.avgLen));
    score += idf * ((freq * (k1 + 1)) / denom);
  }
  return score;
}

function exactPhraseBoost(queryTokens, chunk) {
  const chunkTokens = new Set(Object.keys(chunk.tf || {}));
  const matched = queryTokens.filter((t) => chunkTokens.has(t)).length;
  if (queryTokens.length <= 2 && matched) return 0.5;
  if (matched === queryTokens.length) return 0.4;
  return 0;
}

function stem(token) {
  if (token.length <= 3) return token;
  const suffixes = ["ization", "ational", "fulness", "iveness", "tional", "ments", "ment", "ingly", "edly", "ing", "ies", "ied", "ed", "es", "s"];
  for (const s of suffixes) {
    if (token.endsWith(s) && token.length > s.length + 2) {
      if (s === "ies" || s === "ied") return `${token.slice(0, -s.length)}y`;
      return token.slice(0, -s.length);
    }
  }
  return token;
}

function looksLikeQuestion(text) {
  return /\?$/.test(text) || /^(?:q|question)\s*[:\-]/i.test(text) || /^\d+[.)]\s+/.test(text);
}

function dedupeChunks(chunks) {
  const seen = new Set();
  return chunks.filter((c) => {
    const key = cleanChunkText(c.text).toLowerCase().slice(0, 220);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cleanChunkText(v) {
  return String(v || "").replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\s+/g, " ").trim();
}

function normalizeText(v) {
  return String(v || "").replace(/\r\n?/g, "\n").replace(/[""]/g, '"').replace(/['']/g, "'").trim();
}

function emptyState() {
  return { chunks: [], idf: {}, avgLen: 1, totalDocs: 0, ready: false };
}
