import crypto from "node:crypto";
import { watch as fsWatch } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  appendJsonl,
  appendText,
  ensureDir,
  fileExists,
  readJsonOrDefault,
  readJsonl,
  readTextOrDefault,
  writeJson,
  writeJsonl,
  writeText,
} from "../utils/fs.js";

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "that",
  "this",
  "with",
  "from",
  "have",
  "will",
  "were",
  "your",
  "about",
  "into",
  "after",
  "before",
  "while",
  "there",
  "where",
  "when",
  "what",
  "which",
  "whose",
  "would",
  "could",
  "should",
  "task",
  "agent",
  "user",
  "assistant",
  "code",
  "need",
  "done",
  "next",
  "then",
]);

function nowIso() {
  return new Date().toISOString();
}

function toDayKey(iso = nowIso()) {
  const date = new Date(iso);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function hashText(text) {
  return crypto.createHash("sha256").update(String(text ?? "")).digest("hex");
}

function normalizeConversationContent(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function looksLikeHealthPing(text) {
  if (!text) {
    return false;
  }
  return /^(health ping|healthcheck|health check|ping|status|check health)\b/.test(text);
}

function shouldSkipConversationEntry(entry, recentEntries = []) {
  const actor = String(entry?.actor || "").trim().toLowerCase();
  const source = String(entry?.source || "").trim().toLowerCase();
  const contentRaw = String(entry?.content || "");
  const content = normalizeConversationContent(contentRaw);
  if (!content) {
    return true;
  }

  if (
    actor === "user" &&
    looksLikeHealthPing(content) &&
    (source.startsWith("cli:") ||
      source.startsWith("dashboard:") ||
      source.startsWith("slack:") ||
      source.startsWith("telegram:"))
  ) {
    return true;
  }

  if (actor === "assistant" && content.startsWith("pong") && content.includes("nxclaw is healthy")) {
    return true;
  }

  if (
    actor === "user" &&
    source.startsWith("autonomous:") &&
    (content.startsWith("[autonomous maintenance cycle]") ||
      content.startsWith("[autonomous objective cycle]"))
  ) {
    return true;
  }

  if (actor === "assistant" && source.startsWith("autonomous:")) {
    const meaningful =
      /(completed|blocked|failed|critical|decision|objective|created objective|updated objective|error|exception|deploy|release|fix|bug)/i.test(
        contentRaw,
      );
    if (!meaningful && content.length < 420) {
      return true;
    }
  }

  const recent = Array.isArray(recentEntries) ? recentEntries.slice(-120) : [];
  const currentTs = Date.parse(String(entry?.createdAt || ""));
  for (const prev of recent) {
    if (!prev || typeof prev !== "object") {
      continue;
    }
    if (String(prev.actor || "").toLowerCase() !== actor) {
      continue;
    }
    if (String(prev.source || "").toLowerCase() !== source) {
      continue;
    }

    const prevNorm = normalizeConversationContent(prev.content);
    if (!prevNorm || prevNorm !== content) {
      continue;
    }

    const prevTs = Date.parse(String(prev.createdAt || ""));
    if (!Number.isFinite(currentTs) || !Number.isFinite(prevTs)) {
      return true;
    }
    if (currentTs >= prevTs && currentTs - prevTs < 6 * 60 * 60 * 1000) {
      return true;
    }
  }

  return false;
}

function tokenize(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

function safeSessionFileName(sessionKey) {
  return String(sessionKey ?? "default")
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) {
    return 0;
  }
  const size = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < size; i += 1) {
    const av = Number(a[i] || 0);
    const bv = Number(b[i] || 0);
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function normalizeVector(vector) {
  let norm = 0;
  for (const value of vector) {
    norm += value * value;
  }
  if (norm <= 0) {
    return vector;
  }
  const scale = 1 / Math.sqrt(norm);
  return vector.map((value) => value * scale);
}

function localEmbedText(text, dims = 256) {
  const vector = new Array(Math.max(8, dims)).fill(0);
  const tokens = tokenize(text);
  if (tokens.length === 0) {
    return vector;
  }

  for (const token of tokens) {
    const digest = crypto.createHash("sha1").update(token).digest();
    const idx = ((digest[0] << 8) | digest[1]) % vector.length;
    const sign = digest[2] % 2 === 0 ? 1 : -1;
    const weight = 1 + (digest[3] % 7) * 0.1;
    vector[idx] += sign * weight;
  }

  return normalizeVector(vector);
}

function sourceBoost(sourceType) {
  if (sourceType === "memory_main") {
    return 0.1;
  }
  if (sourceType === "memory_daily") {
    return 0.06;
  }
  if (sourceType === "session") {
    return 0.05;
  }
  if (sourceType === "soul") {
    return 0.07;
  }
  if (sourceType === "compact") {
    return 0.045;
  }
  if (sourceType === "raw") {
    return 0.04;
  }
  return 0.025;
}

function splitMarkdownIntoChunks(content, { maxChars = 1100, overlapChars = 180 } = {}) {
  const lines = String(content ?? "").split("\n");
  if (lines.length === 0) {
    return [];
  }

  const chunks = [];
  let currentLines = [];
  let currentChars = 0;
  let startLine = 1;

  const flush = () => {
    if (currentLines.length === 0) {
      return;
    }
    const text = currentLines.join("\n").trim();
    if (!text) {
      currentLines = [];
      currentChars = 0;
      return;
    }
    chunks.push({
      startLine,
      endLine: startLine + currentLines.length - 1,
      text,
      hash: hashText(text),
    });

    if (overlapChars <= 0) {
      currentLines = [];
      currentChars = 0;
      return;
    }

    let keepChars = 0;
    const kept = [];
    for (let i = currentLines.length - 1; i >= 0; i -= 1) {
      const line = currentLines[i];
      keepChars += line.length + 1;
      kept.unshift(line);
      if (keepChars >= overlapChars) {
        break;
      }
    }

    const offset = currentLines.length - kept.length;
    startLine += offset;
    currentLines = kept;
    currentChars = kept.reduce((acc, line) => acc + line.length + 1, 0);
  };

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx] ?? "";
    const lineSize = line.length + 1;

    if (currentLines.length === 0) {
      startLine = idx + 1;
    }

    const shouldFlush = currentChars + lineSize > maxChars && currentLines.length > 0;
    if (shouldFlush) {
      flush();
      if (currentLines.length === 0) {
        startLine = idx + 1;
      }
    }

    currentLines.push(line);
    currentChars += lineSize;
  }

  flush();
  return chunks;
}

function splitMarkdownBySections(content, { maxSectionChars = 2200 } = {}) {
  const lines = String(content ?? "").split("\n");
  if (lines.length === 0) {
    return [];
  }

  const sections = [];
  let start = 0;

  const flush = (endExclusive) => {
    if (endExclusive <= start) {
      return;
    }
    const blockLines = lines.slice(start, endExclusive);
    const text = blockLines.join("\n").trim();
    if (!text) {
      start = endExclusive;
      return;
    }

    const startLine = start + 1;
    const endLine = endExclusive;
    if (text.length <= maxSectionChars) {
      sections.push({
        startLine,
        endLine,
        text,
        hash: hashText(text),
      });
      start = endExclusive;
      return;
    }

    const nested = splitMarkdownIntoChunks(text, {
      maxChars: Math.max(900, Math.floor(maxSectionChars * 0.75)),
      overlapChars: 120,
    });
    for (const piece of nested) {
      sections.push({
        startLine: startLine + piece.startLine - 1,
        endLine: startLine + piece.endLine - 1,
        text: piece.text,
        hash: piece.hash,
      });
    }
    start = endExclusive;
  };

  for (let i = 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) {
      flush(i);
    }
  }
  flush(lines.length);
  return sections;
}

function parseSoulSections(markdown) {
  const lines = String(markdown ?? "").split("\n");
  const blocks = [];
  let current = { title: "SOUL", content: [] };

  for (const line of lines) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      if (current.content.length > 0) {
        blocks.push({ title: current.title, content: current.content.join("\n").trim() });
      }
      current = { title: heading[1].trim(), content: [] };
      continue;
    }
    current.content.push(line);
  }

  if (current.content.length > 0) {
    blocks.push({ title: current.title, content: current.content.join("\n").trim() });
  }

  return blocks.filter((entry) => entry.content);
}

function topKeywords(entries, count = 12) {
  const freq = new Map();
  for (const entry of entries) {
    for (const token of tokenize(entry.content)) {
      freq.set(token, (freq.get(token) ?? 0) + 1);
    }
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([word, hits]) => ({ word, hits }));
}

function sampleKeyEvents(entries, maxItems = 10) {
  const important = [];
  const regex = /(error|fail|fixed|done|deploy|release|issue|plan|task|run|build|test|blocked|decision)/i;

  for (const entry of entries) {
    if (regex.test(entry.content)) {
      important.push(entry.content.replace(/\s+/g, " ").trim());
    }
  }

  return important.slice(-maxItems);
}

function collectTokenStats(chunks) {
  const docFreq = new Map();
  let totalLen = 0;

  for (const chunk of chunks) {
    const tokens = tokenize(chunk.text);
    const tf = new Map();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1);
    }
    const unique = new Set(tf.keys());
    for (const token of unique) {
      docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
    }
    chunk._tf = tf;
    chunk._len = tokens.length || 1;
    totalLen += chunk._len;
  }

  const avgDocLen = chunks.length > 0 ? totalLen / chunks.length : 1;
  return { docFreq, avgDocLen: Math.max(1, avgDocLen), docs: Math.max(1, chunks.length) };
}

function bm25Score(queryTokens, chunk, bm25) {
  if (!chunk || !bm25 || queryTokens.length === 0) {
    return 0;
  }
  const tf = chunk._tf instanceof Map ? chunk._tf : new Map();
  const docLen = chunk._len || 1;
  const avgDocLen = bm25.avgDocLen || 1;
  const docs = bm25.docs || 1;
  const k1 = 1.4;
  const b = 0.75;

  let score = 0;
  for (const token of queryTokens) {
    const termFreq = tf.get(token) ?? 0;
    if (termFreq <= 0) {
      continue;
    }
    const df = bm25.docFreq.get(token) ?? 0;
    const idf = Math.log(1 + (docs - df + 0.5) / (df + 0.5));
    const numer = termFreq * (k1 + 1);
    const denom = termFreq + k1 * (1 - b + (b * docLen) / avgDocLen);
    score += idf * (numer / denom);
  }
  return score;
}

async function walkMarkdownFiles(entryPath, out = []) {
  let stat;
  try {
    stat = await fs.lstat(entryPath);
  } catch {
    return out;
  }

  if (stat.isSymbolicLink()) {
    return out;
  }

  if (stat.isDirectory()) {
    let entries = [];
    try {
      entries = await fs.readdir(entryPath, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      await walkMarkdownFiles(path.join(entryPath, entry.name), out);
    }
    return out;
  }

  if (stat.isFile() && entryPath.toLowerCase().endsWith(".md")) {
    out.push(entryPath);
  }

  return out;
}

export class MemoryStore {
  constructor({
    rawPath,
    compactPath,
    soulMainPath,
    soulJournalDir,
    compactMarkdownDir,
    memoryMainPath,
    memoryDailyDir,
    memoryIndexPath,
    embeddingCachePath,
    sessionMemoryDir,
    extraPaths = [],
    sessionMemoryEnabled = true,
    vector = {},
    search = {},
  }) {
    this.rawPath = rawPath;
    this.compactPath = compactPath;
    this.soulMainPath = soulMainPath;
    this.soulJournalDir = soulJournalDir;
    this.compactMarkdownDir = compactMarkdownDir;
    this.memoryMainPath = memoryMainPath;
    this.memoryDailyDir = memoryDailyDir;
    this.memoryIndexPath = memoryIndexPath;
    this.embeddingCachePath = embeddingCachePath;
    this.sessionMemoryDir = sessionMemoryDir;
    this.extraPaths = Array.isArray(extraPaths) ? extraPaths : [];
    this.sessionMemoryEnabled = !!sessionMemoryEnabled;

    this.vector = {
      enabled: vector.enabled !== false,
      provider: String(vector.provider || "auto"),
      model: String(vector.model || "text-embedding-3-small"),
      dims: Math.max(32, Number(vector.dims) || 256),
      batchSize: Math.max(1, Number(vector.batchSize) || 32),
      cacheEnabled: vector.cacheEnabled !== false,
    };
    this.searchCfg = {
      vectorWeight: clamp(Number(search.vectorWeight ?? 0.65), 0, 1),
      textWeight: clamp(Number(search.textWeight ?? 0.35), 0, 1),
      minScore: clamp(Number(search.minScore ?? 0.12), 0, 1),
    };
    this.maxIndexedDailyFiles = Math.max(
      7,
      Number(process.env.NXCLAW_MEMORY_INDEX_MAX_DAILY_FILES || 180) || 180,
    );
    this.maxIndexedSessionFiles = Math.max(
      20,
      Number(process.env.NXCLAW_MEMORY_INDEX_MAX_SESSION_FILES || 400) || 400,
    );

    const weightTotal = this.searchCfg.vectorWeight + this.searchCfg.textWeight;
    if (weightTotal > 0) {
      this.searchCfg.vectorWeight /= weightTotal;
      this.searchCfg.textWeight /= weightTotal;
    } else {
      this.searchCfg.vectorWeight = 0.65;
      this.searchCfg.textWeight = 0.35;
    }

    this.rawEntries = [];
    this.compactEntries = [];
    this.soulMainText = "";
    this.soulJournalEntries = [];
    this.embeddingCache = new Map();
    this.knowledgeChunks = [];
    this.bm25 = { docFreq: new Map(), avgDocLen: 1, docs: 1 };
    this.indexDirty = true;
    this.lastIndexedAt = null;
    this.lastIndexError = null;
    this.syncInFlight = null;
    this.knowledgeWatchers = [];
    this.watchSyncTimer = null;
    this.closed = false;
  }

  resolveEmbeddingProvider() {
    const preferred = String(this.vector.provider || "auto").toLowerCase();
    if (preferred === "openai" || preferred === "gemini" || preferred === "local") {
      return preferred;
    }
    if (process.env.OPENAI_API_KEY) {
      return "openai";
    }
    if (process.env.GEMINI_API_KEY) {
      return "gemini";
    }
    return "local";
  }

  async ensureCoreMemoryBootstrap() {
    await ensureDir(path.dirname(this.rawPath));
    await ensureDir(path.dirname(this.compactPath));
    await ensureDir(path.dirname(this.memoryMainPath));
    await ensureDir(this.memoryDailyDir);
    await ensureDir(path.dirname(this.soulMainPath));
    await ensureDir(this.soulJournalDir);
    await ensureDir(this.compactMarkdownDir);
    await ensureDir(path.dirname(this.memoryIndexPath));
    await ensureDir(path.dirname(this.embeddingCachePath));
    await ensureDir(this.sessionMemoryDir);

    if (!(await fileExists(this.memoryMainPath))) {
      await writeText(
        this.memoryMainPath,
        [
          "# MEMORY",
          "",
          "Long-term durable memory for nxclaw.",
          "",
          "## Stable Decisions",
          "- (append durable decisions here)",
          "",
          "## Preferences",
          "- (append user/system preferences here)",
          "",
          "## Operational Facts",
          "- (append long-lived facts here)",
          "",
        ].join("\n"),
      );
    }

    if (!(await fileExists(this.soulMainPath))) {
      await writeText(
        this.soulMainPath,
        [
          "# SOUL",
          "",
          "## Identity",
          "- You are nxclaw, a durable autonomous execution agent.",
          "",
          "## Principles",
          "- Prefer concrete tool actions over abstraction.",
          "- Keep continuity and preserve long-term context.",
          "",
          "## Mission",
          "- Execute large tasks continuously and safely.",
          "",
        ].join("\n"),
      );
    }
  }

  async loadSoulJournalEntries() {
    let files = [];
    try {
      files = await fs.readdir(this.soulJournalDir);
    } catch {
      files = [];
    }

    const mdFiles = files
      .filter((file) => file.toLowerCase().endsWith(".md"))
      .sort()
      .slice(-60);

    const entries = [];
    for (const file of mdFiles) {
      const full = path.join(this.soulJournalDir, file);
      const text = await readTextOrDefault(full, "");
      if (!text.trim()) {
        continue;
      }
      entries.push({
        id: file,
        title: file,
        content: text,
        source: "soul-journal",
        kind: "soul",
        createdAt: null,
      });
    }
    this.soulJournalEntries = entries;
  }

  async loadEmbeddingCache() {
    if (!this.vector.cacheEnabled) {
      this.embeddingCache = new Map();
      return;
    }
    const stored = await readJsonOrDefault(this.embeddingCachePath, {});
    const map = new Map();
    for (const [hash, vector] of Object.entries(stored || {})) {
      if (Array.isArray(vector) && vector.length > 0) {
        map.set(hash, vector.map((value) => Number(value) || 0));
      }
    }
    this.embeddingCache = map;
  }

  async persistEmbeddingCache() {
    if (!this.vector.cacheEnabled) {
      return;
    }
    const obj = {};
    for (const [hash, vector] of this.embeddingCache.entries()) {
      obj[hash] = vector;
    }
    await writeJson(this.embeddingCachePath, obj);
  }

  async init() {
    await this.ensureCoreMemoryBootstrap();
    this.rawEntries = await readJsonl(this.rawPath);
    this.compactEntries = await readJsonl(this.compactPath);
    this.soulMainText = await readTextOrDefault(this.soulMainPath, "");
    await this.loadSoulJournalEntries();
    await this.loadEmbeddingCache();
    await this.syncKnowledgeIndex({ force: false, reason: "init" });
    void this.startKnowledgeWatchers().catch(() => undefined);
  }

  async resolveKnowledgeFiles() {
    const files = [];
    if (await fileExists(this.memoryMainPath)) {
      files.push(this.memoryMainPath);
    }

    const daily = (await walkMarkdownFiles(this.memoryDailyDir))
      .sort()
      .slice(-this.maxIndexedDailyFiles);
    for (const file of daily) {
      files.push(file);
    }

    for (const extraPath of this.extraPaths) {
      const resolved = path.isAbsolute(extraPath)
        ? path.resolve(extraPath)
        : path.resolve(path.dirname(this.memoryMainPath), extraPath);
      const discovered = await walkMarkdownFiles(resolved);
      for (const file of discovered.sort()) {
        files.push(file);
      }
    }

    if (this.sessionMemoryEnabled) {
      const sessions = await walkMarkdownFiles(this.sessionMemoryDir);
      const sessionRows = [];
      for (const file of sessions) {
        let mtimeMs = 0;
        try {
          const stat = await fs.stat(file);
          mtimeMs = Number(stat?.mtimeMs || 0);
        } catch {}
        sessionRows.push({ file, mtimeMs });
      }
      sessionRows
        .sort((a, b) => a.mtimeMs - b.mtimeMs)
        .slice(-this.maxIndexedSessionFiles)
        .sort((a, b) => a.file.localeCompare(b.file))
        .forEach((row) => {
          files.push(row.file);
        });
    }

    if (this.closed) {
      return [];
    }

    const seen = new Set();
    const deduped = [];
    for (const file of files) {
      let key = file;
      try {
        key = await fs.realpath(file);
      } catch {}
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deduped.push(file);
    }
    return deduped;
  }

  classifyPathSource(filePath) {
    if (path.resolve(filePath) === path.resolve(this.memoryMainPath)) {
      return "memory_main";
    }
    const dailyRoot = path.resolve(this.memoryDailyDir);
    const sessionRoot = path.resolve(this.sessionMemoryDir);
    const resolved = path.resolve(filePath);

    if (resolved.startsWith(`${sessionRoot}${path.sep}`) || resolved === sessionRoot) {
      return "session";
    }
    if (resolved.startsWith(`${dailyRoot}${path.sep}`) || resolved === dailyRoot) {
      return "memory_daily";
    }
    return "extra";
  }

  async embedWithOpenAi(texts) {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      return texts.map((text) => localEmbedText(text, this.vector.dims));
    }

    const endpoint = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(
      /\/$/,
      "",
    );

    const response = await fetch(`${endpoint}/embeddings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.vector.model || "text-embedding-3-small",
        input: texts,
      }),
    });

    if (!response.ok) {
      return texts.map((text) => localEmbedText(text, this.vector.dims));
    }

    const payload = await response.json();
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    if (rows.length === 0) {
      return texts.map((text) => localEmbedText(text, this.vector.dims));
    }

    return texts.map((text, idx) => {
      const vector = Array.isArray(rows[idx]?.embedding) ? rows[idx].embedding : null;
      if (!vector) {
        return localEmbedText(text, this.vector.dims);
      }
      return normalizeVector(vector.map((value) => Number(value) || 0));
    });
  }

  async embedWithGemini(texts) {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      return texts.map((text) => localEmbedText(text, this.vector.dims));
    }

    const base = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta";
    const model = this.vector.model || "text-embedding-004";
    const vectors = [];

    for (const text of texts) {
      const response = await fetch(
        `${base}/models/${model}:embedContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: `models/${model}`,
            content: {
              parts: [{ text }],
            },
          }),
        },
      );

      if (!response.ok) {
        vectors.push(localEmbedText(text, this.vector.dims));
        continue;
      }

      const payload = await response.json();
      const values = payload?.embedding?.values;
      if (!Array.isArray(values) || values.length === 0) {
        vectors.push(localEmbedText(text, this.vector.dims));
      } else {
        vectors.push(normalizeVector(values.map((value) => Number(value) || 0)));
      }
    }

    return vectors;
  }

  async embedTexts(texts, { cache = true } = {}) {
    const provider = this.resolveEmbeddingProvider();
    const results = new Array(texts.length);
    const missing = [];

    for (let index = 0; index < texts.length; index += 1) {
      const text = String(texts[index] ?? "");
      const hash = hashText(text);
      const cached = cache ? this.embeddingCache.get(hash) : null;
      if (cached && cached.length > 0) {
        results[index] = cached;
        continue;
      }
      missing.push({ index, text, hash });
    }

    const size = Math.max(1, this.vector.batchSize);
    for (let start = 0; start < missing.length; start += size) {
      const batch = missing.slice(start, start + size);
      const batchTexts = batch.map((item) => item.text);
      let vectors = [];

      try {
        if (!this.vector.enabled || provider === "local") {
          vectors = batchTexts.map((text) => localEmbedText(text, this.vector.dims));
        } else if (provider === "openai") {
          vectors = await this.embedWithOpenAi(batchTexts);
        } else if (provider === "gemini") {
          vectors = await this.embedWithGemini(batchTexts);
        } else {
          vectors = batchTexts.map((text) => localEmbedText(text, this.vector.dims));
        }
      } catch {
        vectors = batchTexts.map((text) => localEmbedText(text, this.vector.dims));
      }

      for (let idx = 0; idx < batch.length; idx += 1) {
        const item = batch[idx];
        const vector = Array.isArray(vectors[idx]) ? vectors[idx] : localEmbedText(item.text);
        results[item.index] = vector;
        if (cache && this.vector.cacheEnabled) {
          this.embeddingCache.set(item.hash, vector);
        }
      }
    }

    if (cache && this.vector.cacheEnabled && missing.length > 0) {
      await this.persistEmbeddingCache();
    }

    return results.map((vector, index) => vector || localEmbedText(texts[index], this.vector.dims));
  }

  async syncKnowledgeIndex({ force = false, reason = "manual" } = {}) {
    if (this.closed) {
      return;
    }

    if (this.syncInFlight) {
      return await this.syncInFlight;
    }

    this.syncInFlight = (async () => {
      try {
        const files = await this.resolveKnowledgeFiles();
        const previous = await readJsonOrDefault(this.memoryIndexPath, { chunks: [] });
        const prevVectors = new Map();
        const prevChunks = Array.isArray(previous?.chunks) ? previous.chunks : [];
        for (const item of prevChunks) {
          if (item?.hash && Array.isArray(item?.vector)) {
            prevVectors.set(item.hash, item.vector.map((value) => Number(value) || 0));
          }
        }

        const chunks = [];
        for (const filePath of files) {
          const content = await readTextOrDefault(filePath, "");
          if (!content.trim()) {
            continue;
          }
          const sourceType = this.classifyPathSource(filePath);
          const split =
            sourceType === "memory_daily" || sourceType === "session"
              ? splitMarkdownBySections(content, {
                  maxSectionChars: sourceType === "session" ? 1800 : 2200,
                })
              : splitMarkdownIntoChunks(content, {
                  maxChars: sourceType === "memory_main" ? 1400 : 1100,
                  overlapChars: 180,
                });

          for (const piece of split) {
            const chunk = {
              id: crypto.randomUUID(),
              hash: piece.hash,
              text: piece.text,
              path: filePath,
              sourceType,
              startLine: piece.startLine,
              endLine: piece.endLine,
              vector: null,
              reason,
            };
            const fromPrev = prevVectors.get(chunk.hash);
            const fromCache = this.embeddingCache.get(chunk.hash);
            if (Array.isArray(fromPrev) && fromPrev.length > 0) {
              chunk.vector = fromPrev;
            } else if (Array.isArray(fromCache) && fromCache.length > 0) {
              chunk.vector = fromCache;
            }
            chunks.push(chunk);
          }
        }

        const missing = chunks.filter((chunk) => !Array.isArray(chunk.vector) || chunk.vector.length === 0);
        if (missing.length > 0) {
          const vectors = await this.embedTexts(
            missing.map((chunk) => chunk.text),
            { cache: true },
          );
          for (let idx = 0; idx < missing.length; idx += 1) {
            const target = missing[idx];
            target.vector = vectors[idx];
          }
        }

        this.knowledgeChunks = chunks.map((chunk) => ({
          ...chunk,
          vector: Array.isArray(chunk.vector) ? chunk.vector : localEmbedText(chunk.text, this.vector.dims),
        }));
        this.bm25 = collectTokenStats(this.knowledgeChunks);
        this.indexDirty = false;
        this.lastIndexedAt = nowIso();
        this.lastIndexError = null;

        await writeJson(this.memoryIndexPath, {
          indexedAt: this.lastIndexedAt,
          reason,
          chunks: this.knowledgeChunks.map((chunk) => ({
            hash: chunk.hash,
            path: chunk.path,
            sourceType: chunk.sourceType,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            vector: chunk.vector,
          })),
        });
      } catch (error) {
        this.lastIndexError = String(error?.message || error || "memory index sync failed");
      } finally {
        this.syncInFlight = null;
      }
    })();

    return await this.syncInFlight;
  }

  markIndexDirty() {
    this.indexDirty = true;
  }

  queueWatchSync(reason = "fs_watch") {
    if (this.closed) {
      return;
    }

    this.markIndexDirty();
    if (this.watchSyncTimer) {
      clearTimeout(this.watchSyncTimer);
    }

    this.watchSyncTimer = setTimeout(() => {
      this.watchSyncTimer = null;
      if (this.closed) {
        return;
      }
      void this.syncKnowledgeIndex({ force: false, reason }).catch((error) => {
        this.lastIndexError = String(error?.message || error || "watch sync failed");
      });
    }, 1200);
  }

  closeKnowledgeWatchers() {
    for (const watcher of this.knowledgeWatchers) {
      try {
        watcher.close();
      } catch {}
    }
    this.knowledgeWatchers = [];
  }

  watchKnowledgePath(targetPath) {
    try {
      const watcher = fsWatch(targetPath, (eventType, fileName) => {
        if (this.closed) {
          return;
        }
        const name = String(fileName || "").toLowerCase();
        if (
          name &&
          !name.endsWith(".md") &&
          !name.includes("memory") &&
          name !== "soul.md" &&
          name !== "memory.md"
        ) {
          return;
        }
        this.queueWatchSync(`fs_watch:${eventType}`);
      });
      watcher.on("error", () => undefined);
      this.knowledgeWatchers.push(watcher);
    } catch {}
  }

  async startKnowledgeWatchers() {
    this.closeKnowledgeWatchers();

    const roots = new Set([
      path.dirname(this.memoryMainPath),
      this.memoryDailyDir,
      this.soulJournalDir,
      this.sessionMemoryDir,
    ]);

    for (const extraPath of this.extraPaths) {
      const resolved = path.isAbsolute(extraPath)
        ? path.resolve(extraPath)
        : path.resolve(path.dirname(this.memoryMainPath), extraPath);
      roots.add(resolved);
    }

    for (const root of roots) {
      if (!root) {
        continue;
      }
      try {
        const stat = await fs.lstat(root);
        if (stat.isSymbolicLink()) {
          continue;
        }
        if (stat.isDirectory() || stat.isFile()) {
          this.watchKnowledgePath(root);
        }
      } catch {}
    }
  }

  async appendDailyLog({ title = "Memory", content, source = "runtime", sessionKey = "" }) {
    const body = String(content ?? "").trim();
    if (!body) {
      return null;
    }

    const ts = nowIso();
    const day = toDayKey(ts);
    const file = path.join(this.memoryDailyDir, `${day}.md`);
    const lines = [
      "",
      `## ${ts} | ${title} | ${source}${sessionKey ? ` | session=${sessionKey}` : ""}`,
      "",
      body,
      "",
    ].join("\n");
    await appendText(file, lines);
    this.markIndexDirty();
    return { path: file, day };
  }

  async appendSessionMemory({ sessionKey, actor, content, source = "runtime" }) {
    if (!this.sessionMemoryEnabled) {
      return null;
    }
    const text = String(content ?? "").trim();
    if (!text) {
      return null;
    }
    const safe = safeSessionFileName(sessionKey || "default");
    const file = path.join(this.sessionMemoryDir, `${safe}.md`);
    const ts = nowIso();
    const lines = [
      "",
      `## ${ts} | ${actor || "actor"} | ${source}`,
      "",
      text,
      "",
    ].join("\n");
    await appendText(file, lines);
    this.markIndexDirty();
    return { path: file };
  }

  async addConversation({ actor, content, source, tags = [], sessionKey = "" }) {
    const entry = {
      id: crypto.randomUUID(),
      kind: "raw",
      actor,
      content: String(content ?? "").trim(),
      source: String(source ?? "unknown"),
      tags,
      createdAt: nowIso(),
      sessionKey: String(sessionKey || ""),
    };

    if (!entry.content) {
      return null;
    }
    if (shouldSkipConversationEntry(entry, this.rawEntries)) {
      return null;
    }

    this.rawEntries.push(entry);
    await appendJsonl(this.rawPath, entry);

    await this.appendDailyLog({
      title: `${actor || "actor"} message`,
      content: entry.content,
      source: entry.source,
      sessionKey: entry.sessionKey,
    });
    await this.appendSessionMemory({
      sessionKey: entry.sessionKey,
      actor: actor || "actor",
      content: entry.content,
      source: entry.source,
    });

    return entry;
  }

  async appendLongTermMemory({ title, content, source = "runtime", tags = [] }) {
    const text = String(content ?? "").trim();
    if (!text) {
      return null;
    }

    const heading = String(title || "Long-term memory").trim();
    const block = [
      "",
      `## ${nowIso()} | ${heading} | ${source}`,
      "",
      text,
      "",
      tags.length > 0 ? `Tags: ${tags.join(", ")}` : "",
      "",
    ].join("\n");

    await appendText(this.memoryMainPath, block);
    this.markIndexDirty();
    return { path: this.memoryMainPath };
  }

  async addLongTermNote({ title, content, source = "manual", tags = [] }) {
    const entry = {
      id: crypto.randomUUID(),
      kind: "compact",
      title: String(title || "Long-term note"),
      content: String(content || "").trim(),
      source,
      tags,
      createdAt: nowIso(),
      compactedRange: null,
      compactedCount: null,
      markdownPath: null,
    };

    if (!entry.content) {
      return null;
    }

    this.compactEntries.push(entry);
    await appendJsonl(this.compactPath, entry);
    await this.appendLongTermMemory({
      title: entry.title,
      content: entry.content,
      source: entry.source,
      tags: entry.tags,
    });
    return entry;
  }

  async readSoul() {
    this.soulMainText = await readTextOrDefault(this.soulMainPath, "");
    return this.soulMainText;
  }

  async writeSoul({ content, mode = "append" }) {
    const incoming = String(content ?? "").trim();
    if (!incoming) {
      return { changed: false, length: 0 };
    }

    const current = await this.readSoul();
    const next =
      mode === "replace"
        ? incoming
        : `${current.trimEnd()}\n\n## Update ${nowIso()}\n${incoming}\n`;

    await writeText(this.soulMainPath, `${next.trimEnd()}\n`);
    this.soulMainText = next;
    this.markIndexDirty();

    return { changed: true, length: next.length };
  }

  async appendSoulJournal({ title = "Journal", content, source = "runtime" }) {
    const body = String(content ?? "").trim();
    if (!body) {
      return null;
    }

    const ts = nowIso();
    const file = path.join(this.soulJournalDir, `${toDayKey(ts)}.md`);
    const block = [`\n## ${ts} | ${title} | ${source}`, "", body, ""].join("\n");
    await appendText(file, block);

    const entry = {
      id: `${toDayKey(ts)}-${crypto.randomUUID().slice(0, 8)}`,
      kind: "soul",
      title,
      content: body,
      source,
      createdAt: ts,
    };
    this.soulJournalEntries.push(entry);
    return entry;
  }

  getSoulSummary(limit = 6) {
    const sections = parseSoulSections(this.soulMainText)
      .slice(0, limit)
      .map((section) => `[${section.title}] ${section.content.slice(0, 180)}`);

    const journals = this.soulJournalEntries
      .slice(-4)
      .map((entry) => `[${entry.title || "journal"}] ${String(entry.content).slice(0, 160)}`);

    return [...sections, ...journals].slice(0, limit + 2);
  }

  getWorkingMemoryContext(limit = 12) {
    const out = [];
    const nowDay = toDayKey(nowIso());
    const yesterDay = toDayKey(new Date(Date.now() - 24 * 3600 * 1000).toISOString());
    out.push(`[MEMORY.md]`);
    out.push(String(this.lastIndexError ? "index_warning=" + this.lastIndexError : ""));

    const memoryCore = this.knowledgeChunks
      .filter((chunk) => chunk.sourceType === "memory_main")
      .slice(0, 4)
      .map((chunk) => `[MEMORY ${chunk.startLine}] ${chunk.text.slice(0, 180)}`);
    for (const line of memoryCore) {
      out.push(line);
    }

    const soulLines = this.getSoulSummary(3);
    for (const line of soulLines) {
      out.push(`[SOUL] ${line}`);
    }

    const dailyHints = this.knowledgeChunks
      .filter(
        (chunk) =>
          chunk.sourceType === "memory_daily" &&
          (chunk.path.endsWith(`${nowDay}.md`) || chunk.path.endsWith(`${yesterDay}.md`)),
      )
      .slice(-6)
      .map((chunk) => `[DAILY ${path.basename(chunk.path)}:${chunk.startLine}] ${chunk.text.slice(0, 180)}`);

    for (const line of dailyHints) {
      out.push(line);
    }

    return out.filter(Boolean).slice(0, limit);
  }

  async scoreKnowledge(query, queryTokens, queryVector, limit, sessionKey = "", mode = "global") {
    if (this.indexDirty) {
      this.queueWatchSync("search_dirty");
    }

    const candidates = [];
    const qv = Array.isArray(queryVector) ? queryVector : [];
    const qSession = String(sessionKey || "").trim();
    const scopeMode = String(mode || "global").trim().toLowerCase();
    const strictSessionFile = qSession ? `${safeSessionFileName(qSession)}.md` : "";

    for (const chunk of this.knowledgeChunks) {
      if (qSession && scopeMode === "session_strict") {
        if (!(chunk.sourceType === "session" && chunk.path.endsWith(strictSessionFile))) {
          continue;
        }
      }
      if (
        qSession &&
        chunk.sourceType === "session" &&
        !chunk.path.endsWith(`${safeSessionFileName(qSession)}.md`)
      ) {
        continue;
      }
      if (
        qSession &&
        chunk.sourceType === "memory_daily" &&
        String(chunk.text || "").includes("| session=") &&
        !String(chunk.text || "").includes(`| session=${qSession}`)
      ) {
        continue;
      }
      const textScore = bm25Score(queryTokens, chunk, this.bm25);
      const vectorScore =
        this.vector.enabled && qv.length > 0 ? Math.max(0, cosineSimilarity(qv, chunk.vector || [])) : 0;
      if (textScore <= 0 && vectorScore <= 0) {
        continue;
      }
      const combined =
        this.searchCfg.textWeight * textScore +
        this.searchCfg.vectorWeight * vectorScore +
        sourceBoost(chunk.sourceType);

      candidates.push({
        id: chunk.hash,
        kind: "knowledge",
        title: `${path.basename(chunk.path)}:${chunk.startLine}`,
        content: chunk.text,
        source: chunk.path,
        sourceType: chunk.sourceType,
        score: combined,
        vectorScore,
        textScore,
        path: chunk.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
      });
    }

    const final = candidates
      .filter((item) => item.score >= this.searchCfg.minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return final;
  }

  async search(query, limit = 8, opts = {}) {
    const q = String(query ?? "").trim();
    if (!q) {
      return [];
    }

    const queryTokens = tokenize(q);
    const queryVector = this.vector.enabled
      ? (await this.embedTexts([q], { cache: false }))[0] || localEmbedText(q, this.vector.dims)
      : localEmbedText(q, this.vector.dims);
    const scopedSessionKey = String(opts.sessionKey || "").trim();
    const scopeMode = String(opts.mode || "global").trim().toLowerCase();

    const indexed = await this.scoreKnowledge(
      q,
      queryTokens,
      queryVector,
      Math.max(limit * 3, 20),
      scopedSessionKey,
      scopeMode,
    );

    const dynamic = [];
    const recentRaw = [...this.rawEntries].slice(-140);
    for (const entry of recentRaw) {
      if (
        scopedSessionKey &&
        scopeMode === "session_strict" &&
        String(entry.sessionKey || "").trim() !== scopedSessionKey
      ) {
        continue;
      }
      if (
        scopedSessionKey &&
        String(entry.sessionKey || "").trim() &&
        String(entry.sessionKey || "").trim() !== scopedSessionKey
      ) {
        continue;
      }
      const textScore = queryTokens.length > 0 ? bm25Score(queryTokens, { _tf: new Map(tokenize(entry.content).map((t) => [t, 1])), _len: tokenize(entry.content).length || 1 }, {
        docFreq: new Map(queryTokens.map((token) => [token, 1])),
        avgDocLen: 12,
        docs: 2,
      }) : 0;
      if (textScore <= 0 && !q.toLowerCase().includes(String(entry.actor || "").toLowerCase())) {
        continue;
      }
      dynamic.push({
        ...entry,
        sourceType: "raw",
        score: textScore + sourceBoost("raw"),
      });
    }

    if (scopeMode !== "session_strict") {
      for (const entry of this.compactEntries.slice(-80)) {
        const tokenSet = new Set(tokenize(entry.content));
        const textScore = queryTokens.reduce((acc, token) => acc + (tokenSet.has(token) ? 1 : 0), 0);
        if (textScore <= 0) {
          continue;
        }
        dynamic.push({
          ...entry,
          sourceType: "compact",
          score: textScore + sourceBoost("compact"),
        });
      }

      for (const section of parseSoulSections(this.soulMainText)) {
        const tokenSet = new Set(tokenize(section.content));
        const textScore = queryTokens.reduce((acc, token) => acc + (tokenSet.has(token) ? 1 : 0), 0);
        if (textScore <= 0) {
          continue;
        }
        dynamic.push({
          id: `soul:${hashText(section.title + section.content)}`,
          kind: "soul",
          title: section.title,
          content: section.content,
          source: this.soulMainPath,
          sourceType: "soul",
          score: textScore + sourceBoost("soul"),
        });
      }
    }

    const merged = [...indexed, ...dynamic]
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(limit, 1));

    return merged;
  }

  listRecent(limit = 25) {
    return [...this.rawEntries].slice(-limit).reverse();
  }

  getStats() {
    const filesBySource = this.knowledgeChunks.reduce(
      (acc, chunk) => {
        acc[chunk.sourceType] = acc[chunk.sourceType] ?? new Set();
        acc[chunk.sourceType].add(chunk.path);
        return acc;
      },
      {},
    );

    return {
      raw: this.rawEntries.length,
      compact: this.compactEntries.length,
      soulJournal: this.soulJournalEntries.length,
      soulChars: this.soulMainText.length,
      indexChunks: this.knowledgeChunks.length,
      indexFiles: Object.values(filesBySource).reduce((acc, set) => acc + set.size, 0),
      indexDirty: this.indexDirty,
      lastIndexedAt: this.lastIndexedAt,
      lastIndexError: this.lastIndexError,
      vector: {
        enabled: this.vector.enabled,
        provider: this.resolveEmbeddingProvider(),
        model: this.vector.model,
        dims: this.vector.dims,
        cache: this.embeddingCache.size,
      },
      extraPaths: this.extraPaths,
      sessionMemoryEnabled: this.sessionMemoryEnabled,
      total: this.rawEntries.length + this.compactEntries.length + this.soulJournalEntries.length,
    };
  }

  async memoryFlushBeforeCompaction({ reason = "compaction" } = {}) {
    const focus = this.rawEntries.slice(-120);
    if (focus.length === 0) {
      return null;
    }

    const keyEvents = sampleKeyEvents(focus, 18);
    const keywords = topKeywords(focus, 14);
    if (keyEvents.length === 0 && keywords.length === 0) {
      return null;
    }

    const flushText = [
      `Reason: ${reason}`,
      `Events: ${keyEvents.length}`,
      `Keywords: ${keywords.map((item) => `${item.word}:${item.hits}`).join(", ") || "none"}`,
      "",
      ...keyEvents.map((line) => `- ${line}`),
    ].join("\n");

    await this.appendDailyLog({
      title: "Memory flush",
      content: flushText,
      source: "compaction-flush",
    });

    await this.appendLongTermMemory({
      title: `Compaction pre-flush ${nowIso()}`,
      content: flushText.slice(0, 3000),
      source: "compaction-flush",
      tags: ["memory-flush", "pre-compaction"],
    });

    return { keyEvents: keyEvents.length, keywords: keywords.length };
  }

  async compact({ keepRecentRaw = 80, batchSize = 250, reason = "periodic" } = {}) {
    if (this.rawEntries.length <= keepRecentRaw + 20) {
      return null;
    }

    await this.memoryFlushBeforeCompaction({ reason });

    const movable = Math.min(batchSize, this.rawEntries.length - keepRecentRaw);
    if (movable <= 0) {
      return null;
    }

    const chunk = this.rawEntries.slice(0, movable);
    const remainder = this.rawEntries.slice(movable);
    const keywords = topKeywords(chunk, 12);
    const keyEvents = sampleKeyEvents(chunk, 10);
    const firstAt = chunk[0]?.createdAt ?? null;
    const lastAt = chunk[chunk.length - 1]?.createdAt ?? null;

    const summaryText = [
      `Compaction reason: ${reason}`,
      `Compacted entries: ${chunk.length}`,
      `Range: ${firstAt ?? "unknown"} -> ${lastAt ?? "unknown"}`,
      `Actors: ${JSON.stringify(
        chunk.reduce((acc, item) => {
          acc[item.actor] = (acc[item.actor] ?? 0) + 1;
          return acc;
        }, {}),
      )}`,
      `Top keywords: ${keywords.map((item) => `${item.word}:${item.hits}`).join(", ") || "none"}`,
      "Key events:",
      ...keyEvents.map((line) => `- ${line}`),
    ].join("\n");

    const stamp = nowIso().replace(/[:.]/g, "-");
    const markdownPath = path.join(this.compactMarkdownDir, `compact-${stamp}.md`);
    const markdownBody = [
      `# Memory Compaction ${nowIso()}`,
      "",
      `- Reason: ${reason}`,
      `- Compacted entries: ${chunk.length}`,
      `- Range: ${firstAt ?? "unknown"} -> ${lastAt ?? "unknown"}`,
      "",
      "## Summary",
      summaryText,
      "",
    ].join("\n");
    await writeText(markdownPath, markdownBody);

    const summary = {
      id: crypto.randomUUID(),
      kind: "compact",
      title: `Compacted memory ${nowIso()}`,
      content: summaryText,
      source: "compactor",
      tags: ["compaction", "long-term"],
      createdAt: nowIso(),
      compactedRange: { from: firstAt, to: lastAt },
      compactedCount: chunk.length,
      markdownPath,
    };

    await appendJsonl(this.compactPath, summary);
    await this.appendLongTermMemory({
      title: summary.title,
      content: summaryText,
      source: "compactor",
      tags: summary.tags,
    });
    await this.appendSoulJournal({
      title: "Compaction",
      content: `Compacted ${chunk.length} entries. Summary file: ${markdownPath}`,
      source: "memory-compactor",
    });
    await writeJsonl(this.rawPath, remainder);
    this.rawEntries = remainder;
    this.compactEntries.push(summary);
    await this.syncKnowledgeIndex({ force: false, reason: "post_compaction" });

    return {
      summary,
      compactedCount: chunk.length,
      remainingRaw: this.rawEntries.length,
    };
  }

  async shutdown() {
    this.closed = true;
    if (this.watchSyncTimer) {
      clearTimeout(this.watchSyncTimer);
      this.watchSyncTimer = null;
    }
    this.closeKnowledgeWatchers();
  }
}
