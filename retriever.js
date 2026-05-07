const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "did", "do",
  "does", "for", "from", "had", "has", "have", "how", "i", "if", "in", "into",
  "is", "it", "its", "of", "on", "or", "should", "so", "than", "that", "the",
  "their", "then", "there", "these", "this", "to", "was", "were", "what",
  "when", "where", "which", "who", "why", "will", "with", "you", "your"
]);

let state = emptyState();

function emptyState() {
  return {
    chunks: [],
    idf: {},
    avgLen: 0,
    totalDocs: 0,
    ready: false
  };
}

export function initRetriever(text = "") {
  const chunks = parseChunks(text);
  const indexedChunks = chunks.map((chunk) => {
    const tokens = tokenize(chunk.text);
    const tf = {};
    for (const token of tokens) {
      tf[token] = (tf[token] || 0) + 1;
    }
    return {
      ...chunk,
      tf,
      length: tokens.length || 1
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
  for (const [token, frequency] of Object.entries(documentFrequency)) {
    idf[token] = Math.log(1 + (totalDocs - frequency + 0.5) / (frequency + 0.5));
  }

  const avgLen = totalDocs
    ? indexedChunks.reduce((sum, chunk) => sum + chunk.length, 0) / totalDocs
    : 0;

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
    .map((chunk) => ({
      id: chunk.id,
      text: chunk.text,
      answer: chunk.answer || "",
      score: retrievalScore(queryTokens, chunk)
    }))
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  const top = scored[0];
  const score = top ? top.score : 0;
  const directAnswer = top && score > 0.7 && top.answer ? top.answer : null;

  return {
    directAnswer,
    chunks: scored,
    score
  };
}

export function tokenize(text = "") {
  return String(text)
    .toLowerCase()
    .replace(/&nbsp;/g, " ")
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .map((token) => stem(token.replace(/^'+|'+$/g, "")))
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

function bm25Score(queryTokens, chunk) {
  const k1 = 1.5;
  const b = 0.75;
  const seen = new Set(queryTokens);
  let score = 0;

  for (const token of seen) {
    const termFrequency = chunk.tf[token] || 0;
    if (!termFrequency) continue;

    const idf = state.idf[token] || 0;
    const denominator =
      termFrequency + k1 * (1 - b + b * (chunk.length / state.avgLen));
    score += idf * ((termFrequency * (k1 + 1)) / denominator);
  }

  return Number(score.toFixed(4));
}

function retrievalScore(queryTokens, chunk) {
  const uniqueTokens = Array.from(new Set(queryTokens));
  const matchingTokens = uniqueTokens.filter((token) => chunk.tf[token]);
  const coverageBoost = uniqueTokens.length ? matchingTokens.length / uniqueTokens.length : 0;
  return Number((bm25Score(queryTokens, chunk) + coverageBoost).toFixed(4));
}

function stem(token) {
  if (token.length <= 3) return token;

  const suffixes = ["ization", "ational", "fulness", "iveness", "tional", "ments", "ment", "ingly", "edly", "ing", "ies", "ied", "ed", "es", "s"];
  for (const suffix of suffixes) {
    if (token.endsWith(suffix) && token.length > suffix.length + 2) {
      if (suffix === "ies" || suffix === "ied") return `${token.slice(0, -suffix.length)}y`;
      return token.slice(0, -suffix.length);
    }
  }
  return token;
}

function parseChunks(text) {
  const normalized = String(text || "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];

  const chunks = [];
  const rawParagraphs = [];
  const lines = normalized.split("\n");
  let current = null;
  let rawBuffer = [];

  const flushRaw = () => {
    const raw = rawBuffer.join("\n").trim();
    if (raw) rawParagraphs.push(raw);
    rawBuffer = [];
  };

  const flushCurrent = () => {
    if (!current) return;

    const question = current.question.trim();
    const answer = current.answerLines.join("\n").trim();
    const textParts = [question, answer].filter(Boolean);

    if (question || answer) {
      chunks.push({
        id: `chunk-${chunks.length + rawParagraphs.length}`,
        text: textParts.join("\n"),
        answer,
        score: 0
      });
    }
    current = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      if (current && current.sawAnswer) {
        flushCurrent();
      }
      flushRaw();
      continue;
    }

    const qMatch = trimmed.match(/^(?:q(?:uestion)?\s*:|\d+[\.)]\s+)(.+)$/i);
    if (qMatch) {
      flushRaw();
      flushCurrent();
      const split = splitInlineAnswer(qMatch[1].trim());
      current = {
        question: split.question,
        answerLines: split.answer ? [split.answer] : [],
        sawAnswer: Boolean(split.answer)
      };
      continue;
    }

    const aMatch = trimmed.match(/^a(?:nswer)?\s*:\s*(.+)$/i);
    if (aMatch && current) {
      current.sawAnswer = true;
      current.answerLines.push(aMatch[1].trim());
      continue;
    }

    if (current) {
      current.answerLines.push(trimmed);
      continue;
    }

    rawBuffer.push(trimmed);
  }

  flushCurrent();
  flushRaw();

  for (const paragraph of splitRawParagraphs(rawParagraphs.join("\n\n"))) {
    chunks.push({
      id: `chunk-${chunks.length}`,
      text: paragraph,
      answer: "",
      score: 0
    });
  }

  return chunks.map((chunk, index) => ({ ...chunk, id: `chunk-${index}` }));
}

function splitInlineAnswer(text) {
  const match = text.match(/^(.*?)\s+(?:a|answer)\s*:\s*(.+)$/i);
  if (!match) return { question: text, answer: "" };
  return {
    question: match[1].trim(),
    answer: match[2].trim()
  };
}

function splitRawParagraphs(text) {
  return String(text || "")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}
