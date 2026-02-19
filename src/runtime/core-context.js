import crypto from "node:crypto";
import path from "node:path";
import { ensureDir, readJsonOrDefault, readTextOrDefault, writeJson } from "../utils/fs.js";

const ALGO_VERSION = "v2-raw-first";
const COMPRESS_THRESHOLD_CHARS = 12000;
const COMPRESSED_MAX_CHARS = 4200;
const MAX_TOOL_LINES = 48;

function clipChars(text, max) {
  const raw = String(text || "").trim();
  if (!raw) {
    return "";
  }
  if (raw.length <= max) {
    return raw;
  }
  return `${raw.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function normalizeLine(line) {
  return String(line || "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildRawToolsSummary(runtimeTools) {
  const tools = Array.isArray(runtimeTools) ? runtimeTools : [];
  if (tools.length === 0) {
    return "- (no registered tools)";
  }

  const out = [];
  for (const tool of tools) {
    const name = normalizeLine(tool?.name || "");
    const desc = clipChars(normalizeLine(tool?.description || ""), 140);
    if (!name) {
      continue;
    }
    out.push(`- ${name}${desc ? `: ${desc}` : ""}`);
    if (out.length >= MAX_TOOL_LINES) {
      break;
    }
  }
  return out.length > 0 ? out.join("\n") : "- (no registered tools)";
}

function buildSection(title, text) {
  const body = String(text || "").trim() || "(empty)";
  return `## ${title}\n${body}`;
}

function summarizeMarkdown(name, text, maxChars = 520) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map(normalizeLine)
    .filter(Boolean);

  if (lines.length === 0) {
    return `## ${name}\n- (empty)`;
  }

  const priority = [];
  const rest = [];
  for (const line of lines) {
    if (
      line.startsWith("#") ||
      line.startsWith("- ") ||
      line.startsWith("* ") ||
      /^\d+\./.test(line)
    ) {
      priority.push(line);
    } else {
      rest.push(line);
    }
  }

  const picked = [...priority, ...rest];
  const out = [];
  let used = 0;
  for (const line of picked) {
    const row = line.startsWith("- ") ? line : `- ${line}`;
    if (used + row.length + 1 > maxChars) {
      break;
    }
    out.push(row);
    used += row.length + 1;
    if (out.length >= 18) {
      break;
    }
  }
  return `## ${name}\n${out.join("\n")}`;
}

function computeHash(payload) {
  return crypto.createHash("sha1").update(JSON.stringify(payload)).digest("hex");
}

export async function compileCoreContext({
  paths,
  stateDir,
  runtimeTools = [],
} = {}) {
  const cachePath = path.join(String(stateDir || "."), "core-context.json");

  const agents = await readTextOrDefault(paths?.agentsPath, "");
  const bootstrap = await readTextOrDefault(paths?.bootstrapPath, "");
  const heartbeat = await readTextOrDefault(paths?.heartbeatPath, "");
  const identity = await readTextOrDefault(paths?.identityPath, "");
  const toolsDoc = await readTextOrDefault(paths?.toolsDocPath, "");
  const userDoc = await readTextOrDefault(paths?.userDocPath, "");
  const runtimeToolsSummary = buildRawToolsSummary(runtimeTools);

  const current = {
    algorithmVersion: ALGO_VERSION,
    agents,
    bootstrap,
    heartbeat,
    identity,
    toolsDoc,
    userDoc,
    runtimeTools: (Array.isArray(runtimeTools) ? runtimeTools : []).map((tool) => ({
      name: String(tool?.name || ""),
      description: String(tool?.description || ""),
    })),
  };
  const sourceHash = computeHash(current);

  const cached = await readJsonOrDefault(cachePath, {});
  if (cached?.sourceHash === sourceHash && typeof cached?.compiled === "string" && cached.compiled) {
    return {
      text: cached.compiled,
      sourceHash,
      cacheHit: true,
      cachePath,
      compressed: !!cached.compressed,
      originalChars: Number(cached.originalChars || cached.compiled.length || 0),
      finalChars: Number(cached.finalChars || cached.compiled.length || 0),
    };
  }

  const rawBlocks = [
    buildSection("IDENTITY.md", identity),
    buildSection("USER.md", userDoc),
    buildSection("AGENTS.md", agents),
    buildSection("BOOTSTRAP.md", bootstrap),
    buildSection("HEARTBEAT.md", heartbeat),
    buildSection("TOOLS.md", toolsDoc),
    buildSection("TOOLS(runtime)", runtimeToolsSummary),
  ];
  const rawCompiled = rawBlocks.join("\n\n");

  let compressed = false;
  let compiled = rawCompiled;
  const originalChars = rawCompiled.length;

  if (rawCompiled.length > COMPRESS_THRESHOLD_CHARS) {
    compressed = true;
    const compactBlocks = [
      summarizeMarkdown("TOOLS(runtime)", runtimeToolsSummary, 700),
      summarizeMarkdown("IDENTITY.md", identity, 620),
      summarizeMarkdown("USER.md", userDoc, 520),
      summarizeMarkdown("AGENTS.md", agents, 520),
      summarizeMarkdown("BOOTSTRAP.md", bootstrap, 480),
      summarizeMarkdown("HEARTBEAT.md", heartbeat, 480),
      summarizeMarkdown("TOOLS.md", toolsDoc, 620),
    ];
    compiled = clipChars(compactBlocks.join("\n\n"), COMPRESSED_MAX_CHARS);
  }

  const finalChars = compiled.length;
  await ensureDir(path.dirname(cachePath));
  await writeJson(cachePath, {
    sourceHash,
    compiled,
    compressed,
    originalChars,
    finalChars,
    updatedAt: new Date().toISOString(),
  });

  return {
    text: compiled,
    sourceHash,
    cacheHit: false,
    cachePath,
    compressed,
    originalChars,
    finalChars,
  };
}
