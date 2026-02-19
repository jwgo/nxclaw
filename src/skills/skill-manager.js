import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import {
  ensureDir,
  fileExists,
  readJsonOrDefault,
  readTextOrDefault,
  writeJson,
} from "../utils/fs.js";

const DEFAULT_MAX_CATALOG_ENTRIES = 500;
const DEFAULT_MAX_SKILL_FILE_BYTES = 256_000;
const DEFAULT_MAX_INSTALL_FILES = 3000;
const DEFAULT_MAX_INSTALL_BYTES = 30 * 1024 * 1024;
const DEFAULT_INSTALL_TIMEOUT_MS = 120_000;

function nowIso() {
  return new Date().toISOString();
}

function normalizeSkillId(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) {
    return "";
  }
  return raw.replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function normalizeText(value, max = 240) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function parseSkillHeader(markdown) {
  const text = String(markdown ?? "");
  const lines = text.split("\n");
  const titleLine = lines.find((line) => line.startsWith("# "));
  const title = titleLine ? titleLine.replace(/^#\s+/, "").trim() : "Untitled skill";

  const bodyLine = lines
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#") && !line.startsWith("```"));

  return {
    name: title || "Untitled skill",
    summary: normalizeText(bodyLine || "", 320),
  };
}

function tokenize(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function toNumber(value, fallback, { min = null, max = null } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  let next = parsed;
  if (min != null) {
    next = Math.max(min, next);
  }
  if (max != null) {
    next = Math.min(max, next);
  }
  return next;
}

async function walkSkillCandidates(root, out = []) {
  let stat;
  try {
    stat = await fs.lstat(root);
  } catch {
    return out;
  }
  if (stat.isSymbolicLink()) {
    return out;
  }
  if (stat.isFile()) {
    if (path.basename(root).toLowerCase() === "skill.md") {
      out.push(path.dirname(root));
    }
    return out;
  }
  if (!stat.isDirectory()) {
    return out;
  }

  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }

  const hasSkill = entries.some(
    (entry) => entry.isFile() && entry.name.toLowerCase() === "skill.md",
  );
  if (hasSkill) {
    out.push(root);
    return out;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const name = entry.name.toLowerCase();
    if (name === "node_modules" || name === ".git" || name === ".svn") {
      continue;
    }
    await walkSkillCandidates(path.join(root, entry.name), out);
  }

  return out;
}

async function inspectTreeBudget(root, { maxFiles, maxBytes }) {
  let files = 0;
  let bytes = 0;
  const queue = [path.resolve(root)];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    let stat;
    try {
      stat = await fs.lstat(current);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      continue;
    }
    if (stat.isFile()) {
      files += 1;
      bytes += stat.size;
      if (files > maxFiles) {
        throw new Error(`skill install rejected: too many files (${files} > ${maxFiles})`);
      }
      if (bytes > maxBytes) {
        throw new Error(`skill install rejected: too large (${bytes} > ${maxBytes} bytes)`);
      }
      continue;
    }
    if (!stat.isDirectory()) {
      continue;
    }

    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      queue.push(path.join(current, entry.name));
    }
  }
}

function runProcess(cmd, args, cwd, { timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const child = spawn(cmd, args, {
      cwd,
      stdio: "inherit",
      shell: false,
    });

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            if (done) {
              return;
            }
            done = true;
            child.kill("SIGTERM");
            setTimeout(() => {
              child.kill("SIGKILL");
            }, 1200);
            reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : null;

    child.on("error", (error) => {
      if (done) {
        return;
      }
      done = true;
      if (timer) {
        clearTimeout(timer);
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (done) {
        return;
      }
      done = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${cmd} exited with code ${code}`));
      }
    });
  });
}

export class SkillManager {
  constructor({
    registryPath,
    installDir,
    workspaceDir,
    codexSkillsDir,
    autoEnableOnInstall = true,
    maxCatalogEntries = DEFAULT_MAX_CATALOG_ENTRIES,
    maxSkillFileBytes = DEFAULT_MAX_SKILL_FILE_BYTES,
    maxInstallFiles = DEFAULT_MAX_INSTALL_FILES,
    maxInstallBytes = DEFAULT_MAX_INSTALL_BYTES,
    installTimeoutMs = DEFAULT_INSTALL_TIMEOUT_MS,
    eventBus = null,
  }) {
    this.registryPath = registryPath;
    this.installDir = installDir;
    this.workspaceDir = workspaceDir;
    this.codexSkillsDir = codexSkillsDir;
    this.autoEnableOnInstall = !!autoEnableOnInstall;
    this.maxCatalogEntries = Math.max(10, toNumber(maxCatalogEntries, DEFAULT_MAX_CATALOG_ENTRIES));
    this.maxSkillFileBytes = Math.max(
      8_000,
      toNumber(maxSkillFileBytes, DEFAULT_MAX_SKILL_FILE_BYTES),
    );
    this.maxInstallFiles = Math.max(
      100,
      toNumber(maxInstallFiles, DEFAULT_MAX_INSTALL_FILES),
    );
    this.maxInstallBytes = Math.max(
      256_000,
      toNumber(maxInstallBytes, DEFAULT_MAX_INSTALL_BYTES),
    );
    this.installTimeoutMs = Math.max(
      5_000,
      toNumber(installTimeoutMs, DEFAULT_INSTALL_TIMEOUT_MS),
    );
    this.eventBus = eventBus;

    this.registry = { skills: [] };
    this.catalogCache = [];
    this.initialized = false;
  }

  emit(type, payload = {}) {
    if (this.eventBus) {
      this.eventBus.emit(type, payload);
    }
  }

  async init() {
    if (this.initialized) {
      return;
    }
    await ensureDir(path.dirname(this.registryPath));
    await ensureDir(this.installDir);
    this.registry = await readJsonOrDefault(this.registryPath, { skills: [] });
    if (!Array.isArray(this.registry.skills)) {
      this.registry.skills = [];
    }
    this.initialized = true;
  }

  async persist() {
    await writeJson(this.registryPath, this.registry);
  }

  async refreshCatalog() {
    const roots = [path.join(this.workspaceDir, "skills"), this.codexSkillsDir]
      .map((item) => String(item || "").trim())
      .filter(Boolean);

    const catalog = [];
    for (const root of roots) {
      if (!(await fileExists(root))) {
        continue;
      }
      const candidates = await walkSkillCandidates(root);
      for (const dir of candidates) {
        if (catalog.length >= this.maxCatalogEntries) {
          break;
        }
        const skillPath = path.join(dir, "SKILL.md");
        try {
          const stat = await fs.lstat(skillPath);
          if (!stat.isFile() || stat.size > this.maxSkillFileBytes) {
            continue;
          }
        } catch {
          continue;
        }
        const text = await readTextOrDefault(skillPath, "");
        if (!text.trim()) {
          continue;
        }
        const header = parseSkillHeader(text);
        const id = normalizeSkillId(path.basename(dir));
        catalog.push({
          id,
          name: header.name,
          summary: header.summary,
          path: dir,
          source: root,
          installed: this.registry.skills.some((entry) => entry.id === id),
        });
      }
      if (catalog.length >= this.maxCatalogEntries) {
        break;
      }
    }

    const deduped = new Map();
    for (const item of catalog) {
      if (!deduped.has(item.id)) {
        deduped.set(item.id, item);
      }
    }

    this.catalogCache = [...deduped.values()].sort((a, b) => a.id.localeCompare(b.id));
    return this.catalogCache;
  }

  getCatalog() {
    return [...this.catalogCache];
  }

  listInstalled() {
    return [...this.registry.skills].sort((a, b) => a.id.localeCompare(b.id));
  }

  getSkill(id) {
    const normalized = normalizeSkillId(id);
    return this.registry.skills.find((entry) => entry.id === normalized) ?? null;
  }

  listEnabled() {
    return this.registry.skills.filter((entry) => entry.enabled);
  }

  async ensureSkillInstalledByPath({ id, sourceDir, source = "local", enable = true }) {
    const normalizedId = normalizeSkillId(id || path.basename(sourceDir));
    if (!normalizedId) {
      throw new Error("skill id is empty");
    }
    const src = path.resolve(sourceDir);
    const skillMd = path.join(src, "SKILL.md");
    if (!(await fileExists(skillMd))) {
      throw new Error(`SKILL.md not found in ${src}`);
    }
    const skillStat = await fs.lstat(skillMd);
    if (!skillStat.isFile()) {
      throw new Error(`SKILL.md is not a file in ${src}`);
    }
    if (skillStat.size > this.maxSkillFileBytes) {
      throw new Error(
        `SKILL.md too large (${skillStat.size} bytes > ${this.maxSkillFileBytes} bytes)`,
      );
    }
    await inspectTreeBudget(src, {
      maxFiles: this.maxInstallFiles,
      maxBytes: this.maxInstallBytes,
    });

    const destination = path.join(this.installDir, normalizedId);
    await fs.rm(destination, { recursive: true, force: true });
    await fs.cp(src, destination, { recursive: true, force: true });

    const text = await readTextOrDefault(path.join(destination, "SKILL.md"), "");
    const header = parseSkillHeader(text);
    const existing = this.getSkill(normalizedId);
    const item = {
      id: normalizedId,
      name: header.name,
      summary: header.summary,
      path: destination,
      source,
      enabled: enable,
      updatedAt: nowIso(),
      installedAt: existing?.installedAt || nowIso(),
    };

    this.registry.skills = this.registry.skills.filter((entry) => entry.id !== normalizedId);
    this.registry.skills.push(item);
    await this.persist();
    this.emit("skills.install", { skillId: normalizedId, source, enabled: item.enabled });
    return item;
  }

  parseGitHubSource(source) {
    const raw = String(source ?? "").trim();
    if (!raw) {
      return null;
    }

    if (raw.startsWith("https://github.com/") || raw.startsWith("http://github.com/")) {
      const url = new URL(raw);
      const parts = url.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
      if (parts.length < 2) {
        return null;
      }
      const owner = parts[0];
      const repo = parts[1].replace(/\.git$/, "");
      const subPath = parts.slice(2).join("/");
      return {
        repoUrl: `https://github.com/${owner}/${repo}.git`,
        owner,
        repo,
        subPath,
      };
    }

    const matched = raw.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)(\/.*)?$/);
    if (!matched) {
      return null;
    }
    return {
      repoUrl: `https://github.com/${matched[1]}/${matched[2]}.git`,
      owner: matched[1],
      repo: matched[2],
      subPath: matched[3] ? matched[3].replace(/^\/+/, "") : "",
    };
  }

  parseSkillsSource(source) {
    const raw = String(source ?? "").trim();
    if (!raw) {
      return null;
    }

    if (raw.startsWith("skills:")) {
      const packageRef = raw.slice("skills:".length).trim();
      return packageRef ? { packageRef, kind: "skills" } : null;
    }

    if (raw.startsWith("vercel:")) {
      const packageRef = raw.slice("vercel:".length).trim();
      return packageRef ? { packageRef, kind: "vercel" } : null;
    }

    return null;
  }

  async installFromSkillsSource({ source, id = "", enable = true }) {
    const parsed = this.parseSkillsSource(source);
    if (!parsed) {
      throw new Error(`invalid skills source: ${source}`);
    }

    const normalizedId = normalizeSkillId(id || "");
    const tempRoot = path.join(os.tmpdir(), `nxclaw-skillsh-${crypto.randomUUID()}`);
    await ensureDir(tempRoot);

    try {
      const args = ["-y", "skills", "add", parsed.packageRef, "--agent", "codex", "--yes"];
      if (normalizedId) {
        args.push("--skill", normalizedId);
      }
      await runProcess("npx", args, tempRoot, { timeoutMs: this.installTimeoutMs });

      const installedRoot = path.join(tempRoot, ".agents", "skills");
      const candidates = await walkSkillCandidates(installedRoot);
      if (candidates.length === 0) {
        throw new Error(
          `skills source '${source}' installed no SKILL.md entries. package='${parsed.packageRef}'`,
        );
      }

      let selected = null;
      if (normalizedId) {
        selected =
          candidates.find((dir) => normalizeSkillId(path.basename(dir)) === normalizedId) || null;
        if (!selected) {
          const available = candidates.map((dir) => normalizeSkillId(path.basename(dir))).join(", ");
          throw new Error(
            `skill '${normalizedId}' not found in '${source}'. available: ${available || "(none)"}`,
          );
        }
      } else if (candidates.length === 1) {
        selected = candidates[0];
      } else {
        const available = candidates.map((dir) => normalizeSkillId(path.basename(dir))).join(", ");
        throw new Error(
          `multiple skills found in '${source}': ${available}. pass --id <skill-id> to select one.`,
        );
      }

      return await this.ensureSkillInstalledByPath({
        id: normalizeSkillId(id || path.basename(selected)),
        sourceDir: selected,
        source,
        enable,
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async installFromGitHub({ source, id = "", enable = true }) {
    const parsed = this.parseGitHubSource(source);
    if (!parsed) {
      throw new Error(`invalid github source: ${source}`);
    }

    const tempRoot = path.join(os.tmpdir(), `nxclaw-skill-${crypto.randomUUID()}`);
    await ensureDir(tempRoot);

    try {
      await runProcess(
        "git",
        ["clone", "--depth", "1", "--filter=blob:none", parsed.repoUrl, tempRoot],
        process.cwd(),
        { timeoutMs: this.installTimeoutMs },
      );
      const fromDir = parsed.subPath ? path.join(tempRoot, parsed.subPath) : tempRoot;
      const skillId = normalizeSkillId(id || path.basename(fromDir) || parsed.repo);
      return await this.ensureSkillInstalledByPath({
        id: skillId,
        sourceDir: fromDir,
        source,
        enable,
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async installSkill({ id = "", source, enable } = {}) {
    await this.init();
    if (this.catalogCache.length === 0) {
      await this.refreshCatalog();
    }

    const shouldEnable = enable ?? this.autoEnableOnInstall;
    const catalog = this.getCatalog();
    const fromCatalog = catalog.find(
      (entry) => entry.id === normalizeSkillId(source) || entry.id === normalizeSkillId(id),
    );
    if (fromCatalog) {
      return await this.ensureSkillInstalledByPath({
        id: fromCatalog.id,
        sourceDir: fromCatalog.path,
        source: `catalog:${fromCatalog.source}`,
        enable: shouldEnable,
      });
    }

    const skillsSource = this.parseSkillsSource(source);
    if (skillsSource) {
      return await this.installFromSkillsSource({
        source,
        id: normalizeSkillId(id || ""),
        enable: shouldEnable,
      });
    }

    const localSource = source ? path.resolve(source) : "";
    if (localSource && (await fileExists(localSource))) {
      const stat = await fs.lstat(localSource);
      const sourceDir = stat.isDirectory() ? localSource : path.dirname(localSource);
      return await this.ensureSkillInstalledByPath({
        id: normalizeSkillId(id || path.basename(sourceDir)),
        sourceDir,
        source: localSource,
        enable: shouldEnable,
      });
    }

    return await this.installFromGitHub({
      source,
      id: normalizeSkillId(id || source),
      enable: shouldEnable,
    });
  }

  async setSkillEnabled(id, enabled) {
    await this.init();
    const target = this.getSkill(id);
    if (!target) {
      throw new Error(`skill not found: ${id}`);
    }
    target.enabled = !!enabled;
    target.updatedAt = nowIso();
    await this.persist();
    this.emit("skills.enabled", { skillId: target.id, enabled: target.enabled });
    return target;
  }

  async removeSkill(id) {
    await this.init();
    const target = this.getSkill(id);
    if (!target) {
      return false;
    }
    await fs.rm(target.path, { recursive: true, force: true }).catch(() => undefined);
    this.registry.skills = this.registry.skills.filter((entry) => entry.id !== target.id);
    await this.persist();
    this.emit("skills.remove", { skillId: target.id });
    return true;
  }

  async readSkill(id, maxChars = 3000) {
    await this.init();
    const target = this.getSkill(id);
    if (!target) {
      return null;
    }
    const text = await readTextOrDefault(path.join(target.path, "SKILL.md"), "");
    return {
      ...target,
      content: text.slice(0, Math.max(200, maxChars)),
    };
  }

  async getPromptContext({ query = "", limit = 6, maxChars = 8000 } = {}) {
    await this.init();
    const enabled = this.listEnabled();
    if (enabled.length === 0) {
      return [];
    }

    const queryTokens = tokenize(query);
    const scored = [];
    for (const skill of enabled) {
      const skillMd = await readTextOrDefault(path.join(skill.path, "SKILL.md"), "");
      const header = parseSkillHeader(skillMd);
      const text = normalizeText(skillMd, 1500);

      const tokens = new Set([...tokenize(skill.id), ...tokenize(header.name), ...tokenize(header.summary)]);
      let score = 0;
      for (const token of queryTokens) {
        if (tokens.has(token)) {
          score += 1;
        }
      }

      scored.push({
        id: skill.id,
        name: header.name || skill.name,
        summary: header.summary || skill.summary || "",
        content: text,
        score,
      });
    }

    const ordered = scored
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, Math.max(1, limit));

    const output = [];
    let usedChars = 0;
    for (const item of ordered) {
      const block = `[skill:${item.id}] ${item.name}\n${item.summary}\n${item.content}`;
      if (usedChars + block.length > maxChars && output.length > 0) {
        break;
      }
      output.push(block.slice(0, Math.min(block.length, 1800)));
      usedChars += block.length;
    }
    return output;
  }

  getStatusSummary() {
    const installed = this.listInstalled();
    const enabled = installed.filter((entry) => entry.enabled);
    return {
      installed: installed.length,
      enabled: enabled.length,
      ids: enabled.map((entry) => entry.id),
    };
  }
}
