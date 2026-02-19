import crypto from "node:crypto";
import path from "node:path";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import { createAllTools } from "../tools/index.js";
import { compileCoreContext } from "./core-context.js";
import { ensureDir, fileExists, writeJson, writeText } from "../utils/fs.js";
import { LaneQueue } from "./lane-queue.js";

function safeText(value) {
  return String(value ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

async function withTimeout(promise, timeoutMs, onTimeoutMessage = "operation timed out") {
  if (!timeoutMs || timeoutMs <= 0) {
    return await promise;
  }

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(onTimeoutMessage)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class NxClawRuntime {
  constructor({
    config,
    memoryStore,
    objectiveQueue,
    backgroundManager,
    chromeController,
    skillManager = null,
    eventBus,
  }) {
    this.config = config;
    this.memoryStore = memoryStore;
    this.objectiveQueue = objectiveQueue;
    this.backgroundManager = backgroundManager;
    this.chromeController = chromeController;
    this.skillManager = skillManager;
    this.eventBus = eventBus;

    this.authStorage = null;
    this.modelRegistry = null;
    this.session = null;
    this.sessionByLane = new Map();
    this.sessionUnsubscribers = new Map();
    this.sessionMetaByLane = new Map();
    this.customTools = null;
    this.model = null;
    this.authStatus = null;
    this.authReady = false;
    this.busy = false;
    this.queueDepth = 0;
    this.activeRuns = new Map();
    this.laneQueue = new LaneQueue({
      maxDepth: this.config?.runtime?.maxQueueDepth ?? 100,
      onEvent: (type, payload) => {
        this.queueDepth = Number(payload?.totalDepth) || 0;
        if (type === "lane.enqueue") {
          this.emit("runtime.queue.enqueue", payload);
        } else if (type === "lane.start") {
          this.emit("runtime.queue.start", payload);
        } else if (type === "lane.end") {
          this.emit("runtime.queue.end", payload);
        }
      },
    });
    this.maxOverflowCompactionAttempts = Math.max(
      1,
      Number(this.config?.runtime?.maxOverflowCompactionAttempts) || 3,
    );
    this.maxSessionLanes = Math.max(20, Number(this.config?.runtime?.maxSessionLanes) || 240);
    this.maxSessionIdleMs = Math.max(
      5 * 60 * 1000,
      (Math.max(5, Number(this.config?.runtime?.maxSessionIdleMinutes) || 240) * 60 * 1000),
    );

    this.channelState = new Map([
      ["slack", false],
      ["telegram", false],
      ["dashboard", false],
      ["autonomous", false],
    ]);

    this.last = {
      messageAt: null,
      reply: "",
      error: null,
      runAttempt: 0,
    };

    this.activeRun = null;
    this.lastCoreContextCompressionHash = "";
  }

  emit(type, payload = {}) {
    if (this.eventBus) {
      this.eventBus.emit(type, payload);
    }
  }

  async persistStateSnapshot(extra = {}) {
    const state = await this.getState({ autonomousLoop: null, includeEvents: false });
    const payload = {
      ...state,
      ...extra,
      snapshotAt: nowIso(),
    };
    await writeJson(this.config.paths.dashboardStatePath, payload);
  }

  async ensureCoreDocsBootstrap() {
    const seeds = [
      {
        path: this.config.paths.identityPath,
        body: [
          "# IDENTITY",
          "",
          "- Project: nxclaw",
          "- Runtime: JavaScript autonomous agent",
          "- Mission: complete large tasks continuously with durable memory",
          "",
        ].join("\n"),
      },
      {
        path: this.config.paths.toolsDocPath,
        body: [
          "# TOOLS",
          "",
          "- memory: search/note/compact/soul/sync/status",
          "- objective: add/list/update",
          "- task: create/start/list/logs/stop/health",
          "- chrome: open/navigate/snapshot/click/type/extract/screenshot/close",
          "- terminal: execute/start/schedule/list/stop/logs/health",
          "- skills: install/list/enable/disable/remove/show",
          "",
        ].join("\n"),
      },
      {
        path: this.config.paths.userDocPath,
        body: [
          "# USER",
          "",
          "- Preferred channels: Telegram, Slack, Dashboard",
          "- Preferred mode: autonomous with clear progress updates",
          "- Requirement: high-reliability memory continuity",
          "",
        ].join("\n"),
      },
      {
        path: this.config.paths.agentsPath,
        body: [
          "# AGENTS",
          "",
          "- Primary agent: nxclaw",
          "- Constraints: avoid duplicate tasks, keep objective status accurate, persist durable memory",
          "",
        ].join("\n"),
      },
      {
        path: this.config.paths.bootstrapPath,
        body: [
          "# BOOTSTRAP",
          "",
          "1. Read IDENTITY.md, USER.md, TOOLS.md, MEMORY.md, and today's memory log.",
          "2. Load active objectives and running tasks.",
          "3. Continue highest-priority in-progress objective.",
          "4. Persist durable facts to MEMORY.md and daily logs.",
          "",
        ].join("\n"),
      },
      {
        path: this.config.paths.heartbeatPath,
        body: [
          "# HEARTBEAT",
          "",
          "- Check queue depth and background task health.",
          "- Check Telegram/Slack/dashboard channel health.",
          "- If idle, run one maintenance action and persist memory.",
          "",
        ].join("\n"),
      },
    ];

    for (const seed of seeds) {
      if (!(await fileExists(seed.path))) {
        await writeText(seed.path, seed.body);
      }
    }
  }

  async init() {
    await this.memoryStore.init();
    await this.ensureCoreDocsBootstrap();
    await this.objectiveQueue.init();
    await this.backgroundManager.init();

    this.authStorage = AuthStorage.create(this.config.paths.authPath);
    this.modelRegistry = new ModelRegistry(this.authStorage, this.config.paths.modelsPath);
    this.refreshAuthStatus();
    this.model = this.resolveModel();

    this.customTools = createAllTools({
      memoryStore: this.memoryStore,
      objectiveQueue: this.objectiveQueue,
      backgroundManager: this.backgroundManager,
      chromeController: this.chromeController,
      skillManager: this.skillManager,
    });
    this.session = await this.getOrCreateSession("default");

    await this.persistStateSnapshot();
    this.emit("runtime.init", {
      model: this.model ? `${this.model.provider}/${this.model.id}` : "unknown",
      provider: this.model?.provider || this.config.defaultProvider,
    });
    this.emit("runtime.auth.status", {
      auth: this.authStatus,
      authReady: this.authReady,
    });
  }

  safeSessionId(rawSessionId) {
    return String(rawSessionId ?? "")
      .trim()
      .replace(/[^a-zA-Z0-9_.-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 100);
  }

  buildBaseLaneKey(incoming) {
    const source = String(incoming?.source || "unknown");
    const channel = String(incoming?.channelId || incoming?.userId || "default");
    return `${source}:${channel}`;
  }

  buildLaneKey(incoming) {
    const base = this.buildBaseLaneKey(incoming);
    const sessionId = this.safeSessionId(incoming?.sessionId || "");
    if (!sessionId) {
      return base;
    }
    return `${base}::session::${sessionId}`;
  }

  parseLaneKey(laneKey) {
    const marker = "::session::";
    const lane = String(laneKey || "default");
    const idx = lane.indexOf(marker);
    if (idx === -1) {
      const sep = lane.indexOf(":");
      const source = sep === -1 ? lane : lane.slice(0, sep);
      const channelId = sep === -1 ? "default" : lane.slice(sep + 1);
      return {
        lane,
        baseLane: lane,
        source,
        channelId,
        sessionId: "default",
        hasCustomSession: false,
      };
    }

    const baseLane = lane.slice(0, idx);
    const rawSessionId = lane.slice(idx + marker.length);
    const sessionId = this.safeSessionId(rawSessionId) || "default";
    const sep = baseLane.indexOf(":");
    const source = sep === -1 ? baseLane : baseLane.slice(0, sep);
    const channelId = sep === -1 ? "default" : baseLane.slice(sep + 1);
    return {
      lane,
      baseLane,
      source,
      channelId,
      sessionId,
      hasCustomSession: true,
    };
  }

  touchSessionMeta(laneKey, { messageCount } = {}) {
    const parsed = this.parseLaneKey(laneKey);
    const existing = this.sessionMetaByLane.get(parsed.lane);
    const ts = nowIso();
    const next = {
      lane: parsed.lane,
      baseLane: parsed.baseLane,
      source: parsed.source,
      channelId: parsed.channelId,
      sessionId: parsed.sessionId,
      hasCustomSession: parsed.hasCustomSession,
      createdAt: existing?.createdAt || ts,
      lastUsedAt: ts,
      messageCount:
        Number.isFinite(Number(messageCount))
          ? Number(messageCount)
          : Number(existing?.messageCount || 0),
    };
    this.sessionMetaByLane.set(parsed.lane, next);
    return next;
  }

  async archiveSessionLane(laneKey, { reason = "manual" } = {}) {
    const key = String(laneKey || "default");
    const unsubscribe = this.sessionUnsubscribers.get(key);
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch {}
      this.sessionUnsubscribers.delete(key);
    }
    this.sessionByLane.delete(key);
    this.sessionMetaByLane.delete(key);
    this.activeRuns.delete(key);
    if (this.activeRun?.lane === key) {
      const first = this.activeRuns.values().next();
      this.activeRun = first.done ? null : first.value;
    }
    this.emit("runtime.session.archive", {
      lane: key,
      reason,
    });
    return {
      lane: key,
      archived: true,
      reason,
    };
  }

  async enforceSessionLimits() {
    const nowMs = Date.now();
    const stale = [];

    for (const meta of this.sessionMetaByLane.values()) {
      const last = Date.parse(meta.lastUsedAt || meta.createdAt || nowIso());
      if (!Number.isFinite(last)) {
        continue;
      }
      if (this.activeRuns.has(meta.lane)) {
        continue;
      }
      if (nowMs - last > this.maxSessionIdleMs) {
        stale.push(meta);
      }
    }

    for (const meta of stale) {
      await this.archiveSessionLane(meta.lane, { reason: "idle_timeout" });
    }

    if (this.sessionByLane.size <= this.maxSessionLanes) {
      return;
    }

    const ordered = [...this.sessionMetaByLane.values()]
      .filter((meta) => !this.activeRuns.has(meta.lane))
      .sort((a, b) => {
        const ax = Date.parse(a.lastUsedAt || a.createdAt || nowIso());
        const bx = Date.parse(b.lastUsedAt || b.createdAt || nowIso());
        return ax - bx;
      });

    let overshoot = this.sessionByLane.size - this.maxSessionLanes;
    for (const meta of ordered) {
      if (overshoot <= 0) {
        break;
      }
      await this.archiveSessionLane(meta.lane, { reason: "max_session_lanes" });
      overshoot -= 1;
    }
  }

  listConversationSessions({ source = "dashboard", channelId = "dashboard" } = {}) {
    const baseLane = `${String(source || "dashboard")}:${String(channelId || "dashboard")}`;
    const out = [];

    for (const meta of this.sessionMetaByLane.values()) {
      if (meta.baseLane !== baseLane) {
        continue;
      }
      const session = this.sessionByLane.get(meta.lane);
      out.push({
        sessionId: meta.sessionId,
        lane: meta.lane,
        createdAt: meta.createdAt,
        lastUsedAt: meta.lastUsedAt,
        messageCount: Number(session?.messages?.length || meta.messageCount || 0),
        active: this.activeRuns.has(meta.lane),
      });
    }

    return out.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  }

  async createConversationSession({
    source = "dashboard",
    channelId = "dashboard",
    userId = "dashboard",
    sessionId = "",
  } = {}) {
    const safe =
      this.safeSessionId(sessionId) ||
      `s-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    const lane = this.buildLaneKey({ source, channelId, userId, sessionId: safe });
    await this.getOrCreateSession(lane);
    const meta = this.touchSessionMeta(lane, {
      messageCount: this.sessionByLane.get(lane)?.messages?.length || 0,
    });
    return {
      sessionId: meta.sessionId,
      lane: meta.lane,
      createdAt: meta.createdAt,
      lastUsedAt: meta.lastUsedAt,
      messageCount: meta.messageCount,
    };
  }

  async archiveConversationSession({
    source = "dashboard",
    channelId = "dashboard",
    userId = "dashboard",
    sessionId,
  } = {}) {
    const safe = this.safeSessionId(sessionId);
    if (!safe) {
      throw new Error("sessionId is required");
    }
    const lane = this.buildLaneKey({ source, channelId, userId, sessionId: safe });
    const result = await this.archiveSessionLane(lane, { reason: "manual_archive" });
    return {
      ...result,
      sessionId: safe,
    };
  }

  async getOrCreateSession(laneKey = "default") {
    const key = String(laneKey || "default");
    const existing = this.sessionByLane.get(key);
    if (existing) {
      this.touchSessionMeta(key, {
        messageCount: Number(existing?.messages?.length || 0),
      });
      return existing;
    }

    await this.enforceSessionLimits();

    if (!this.authStorage || !this.modelRegistry || !this.model || !this.customTools) {
      throw new Error("Runtime session prerequisites are not initialized");
    }

    const safeLane = key.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 120) || "default";
    const sessionWorkspace = path.join(this.config.stateDir, "lane-sessions", safeLane);
    await ensureDir(sessionWorkspace);

    const built = await createAgentSession({
      cwd: this.config.workspaceDir,
      agentDir: this.config.agentDir,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      model: this.model,
      customTools: this.customTools,
      settingsManager: SettingsManager.create(this.config.workspaceDir, this.config.agentDir),
      sessionManager: SessionManager.create(sessionWorkspace),
    });

    const session = built.session;
    const unsubscribe = session.subscribe((event) => {
      if (!event || !event.type) {
        return;
      }

      if (event.type === "tool_execution_start") {
        this.emit("runtime.tool.start", {
          lane: key,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          args: event.args,
        });
      } else if (event.type === "tool_execution_end") {
        this.emit("runtime.tool.end", {
          lane: key,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          isError: !!event.isError,
        });
      } else if (event.type === "message_end") {
        this.emit("runtime.message.end", {
          lane: key,
          role: event.message?.role,
        });
      }
    });

    this.sessionByLane.set(key, session);
    this.sessionUnsubscribers.set(key, unsubscribe);
    const meta = this.touchSessionMeta(key, {
      messageCount: Number(session?.messages?.length || 0),
    });
    this.emit("runtime.session.create", { lane: key });
    this.emit("runtime.session.meta", {
      lane: key,
      sessionId: meta.sessionId,
      source: meta.source,
      channelId: meta.channelId,
    });
    return session;
  }

  resolveModel() {
    const preferred = this.config.defaultModel;
    if (preferred && preferred.includes("/")) {
      const [provider, modelId] = preferred.split("/");
      const found = this.modelRegistry.find(provider, modelId);
      if (found && this.isProviderAuthenticated(found.provider)) {
        return found;
      }
    }

    const fallback =
      this.config.defaultProvider === "openai-codex"
        ? [
            ["openai-codex", "gpt-5.3-codex"],
            ["anthropic", "claude-sonnet-4-6"],
            ["google", "gemini-3-pro-preview"],
          ]
        : this.config.defaultProvider === "anthropic"
          ? [
              ["anthropic", "claude-sonnet-4-6"],
              ["openai-codex", "gpt-5.3-codex"],
              ["google", "gemini-3-pro-preview"],
            ]
          : [
              ["google", "gemini-3-pro-preview"],
              ["openai-codex", "gpt-5.3-codex"],
              ["anthropic", "claude-sonnet-4-6"],
            ];

    for (const [provider, modelId] of fallback) {
      if (!this.isProviderAuthenticated(provider)) {
        continue;
      }
      try {
        return getModel(provider, modelId);
      } catch {
        // continue
      }
    }

    const available = this.modelRegistry.getAvailable();
    const availablePreferred = available.find((entry) =>
      this.isProviderAuthenticated(entry.provider),
    );
    if (availablePreferred) {
      return availablePreferred;
    }
    if (available.length > 0) {
      return available[0];
    }

    const all = this.modelRegistry.getAll();
    const allPreferred = all.find((entry) => this.isProviderAuthenticated(entry.provider));
    if (allPreferred) {
      return allPreferred;
    }
    if (all.length > 0) {
      return all[0];
    }

    const [provider, modelId] = fallback[0];
    return getModel(provider, modelId);
  }

  setChannelHealth(name, active) {
    this.channelState.set(name, !!active);
    this.emit("runtime.channel.health", { name, active: !!active });
  }

  isBusy() {
    return this.activeRuns.size > 0;
  }

  getQueueDepth() {
    return this.laneQueue.getDepth();
  }

  getQueueLanes(limit = 12) {
    return this.laneQueue.getLaneStats(limit);
  }

  isLikelyContextOverflow(error) {
    const text = String(error?.message || error || "").toLowerCase();
    if (!text) {
      return false;
    }
    return (
      text.includes("context length") ||
      text.includes("context window") ||
      text.includes("context overflow") ||
      text.includes("maximum context") ||
      text.includes("prompt is too long") ||
      text.includes("token limit") ||
      text.includes("too many tokens") ||
      (text.includes("too large") && text.includes("prompt"))
    );
  }

  trimSessionHistoryForOverflow(session) {
    const messages = session?.messages;
    if (!Array.isArray(messages) || messages.length < 14) {
      return { trimmed: false, removed: 0 };
    }

    const keepHead = 2;
    const keepTail = 8;
    const removable = messages.length - (keepHead + keepTail);
    if (removable <= 0) {
      return { trimmed: false, removed: 0 };
    }

    messages.splice(
      keepHead,
      removable,
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "[compacted context removed after overflow]",
          },
        ],
      },
    );
    return { trimmed: true, removed: removable };
  }

  getAuthStorage() {
    if (!this.authStorage) {
      this.authStorage = AuthStorage.create(this.config.paths.authPath);
    }
    return this.authStorage;
  }

  refreshAuthStatus() {
    const storage = this.getAuthStorage();
    const status = {
      "google-gemini-cli": false,
      "openai-codex": false,
      anthropic: false,
    };

    try {
      status["google-gemini-cli"] = !!storage.hasAuth("google-gemini-cli");
      status["openai-codex"] = !!storage.hasAuth("openai-codex");
      status.anthropic = !!storage.hasAuth("anthropic");
    } catch {}

    this.authStatus = status;
    this.authReady = Object.values(status).some(Boolean);
    return status;
  }

  hasAnyAuth() {
    if (!this.authStatus) {
      this.refreshAuthStatus();
    }
    return !!this.authReady;
  }

  isProviderAuthenticated(providerName) {
    const normalized = String(providerName || "").trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    const status = this.authStatus || this.refreshAuthStatus();
    if (normalized === "google" || normalized === "google-gemini-cli") {
      return !!status["google-gemini-cli"];
    }
    if (normalized === "openai-codex") {
      return !!status["openai-codex"];
    }
    if (normalized === "anthropic") {
      return !!status.anthropic;
    }
    return true;
  }

  async composeContextPrompt({ incoming, memoryMatches, text, sessionKey }) {
    await this.objectiveQueue.reload().catch(() => undefined);

    const clipSection = (value, maxChars = 1200) => {
      const raw = String(value || "").trim();
      if (!raw) {
        return "";
      }
      if (raw.length <= maxChars) {
        return raw;
      }
      return `${raw.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
    };

    const budgets = {
      objectives: 900,
      tasks: 900,
      memory: 1500,
      soul: 700,
      working: 1400,
      skills: 1400,
    };

    let coreContext = "(unavailable)";
    try {
      const compiled = await compileCoreContext({
        paths: this.config?.paths,
        stateDir: this.config?.stateDir,
        runtimeTools: this.customTools,
      });
      coreContext = String(compiled?.text || "").trim() || "(empty)";

      if (compiled?.compressed && this.lastCoreContextCompressionHash !== compiled.sourceHash) {
        const originalChars = Number(compiled?.originalChars || 0);
        const finalChars = Number(compiled?.finalChars || 0);
        console.log(
          `[nxclaw] core context compressed (${originalChars} -> ${finalChars} chars)`,
        );
        this.emit("runtime.core_context.compressed", {
          sourceHash: compiled.sourceHash,
          originalChars,
          finalChars,
          cacheHit: !!compiled.cacheHit,
        });
        this.lastCoreContextCompressionHash = compiled.sourceHash;
      }
    } catch (error) {
      coreContext = `(compile error: ${String(error?.message || error || "unknown")})`;
    }

    const objectivePreview = this.objectiveQueue
      .list({})
      .filter((item) => ["pending", "in_progress", "blocked"].includes(item.status))
      .slice(0, 6)
      .map((item) => `${item.id} | ${item.status} | P${item.priority} | ${item.title}`)
      .join("\n");

    const memoryPreview = memoryMatches
      .slice(0, 8)
      .map((entry) => {
        const label = entry.title ? `[${entry.title}]` : `[${entry.actor || entry.kind || "memory"}]`;
        return `${label} ${safeText(entry.content).slice(0, 180)}`;
      })
      .join("\n");

    const soulPreview = this.memoryStore.getSoulSummary(6).join("\n");
    const workingMemory = this.memoryStore.getWorkingMemoryContext(12).join("\n");
    let skillPreview = "";
    if (this.skillManager) {
      try {
        skillPreview = (
          await this.skillManager.getPromptContext({
            query: text,
            limit: this.config?.skills?.maxPromptSkills ?? 6,
            maxChars: this.config?.skills?.maxPromptChars ?? 8000,
          })
        ).join("\n");
      } catch (error) {
        this.emit("runtime.skills.context.error", {
          error: String(error?.message || error),
        });
      }
    }

    const taskPreview = this.backgroundManager
      .list({ includeFinished: false })
      .slice(0, 10)
      .map((task) => `${task.id} | ${task.status} | ${task.name}`)
      .join("\n");

    const objectivePreviewClipped = clipSection(objectivePreview, budgets.objectives);
    const taskPreviewClipped = clipSection(taskPreview, budgets.tasks);
    const memoryPreviewClipped = clipSection(memoryPreview, budgets.memory);
    const soulPreviewClipped = clipSection(soulPreview, budgets.soul);
    const workingMemoryClipped = clipSection(workingMemory, budgets.working);
    const skillPreviewClipped = clipSection(skillPreview, budgets.skills);

    return [
      "[NXCLAW CORE CONTEXT]",
      `Source: ${incoming.source}`,
      `Channel: ${incoming.channelId || "unknown"}`,
      `Session: ${sessionKey || "default"}`,
      `QueueDepth: ${this.getQueueDepth()}`,
      "",
      "Core markdown context (compiled):",
      coreContext || "(none)",
      "",
      "Active objectives:",
      objectivePreviewClipped || "(none)",
      "",
      "Running/queued tasks:",
      taskPreviewClipped || "(none)",
      "",
      "Relevant memory:",
      memoryPreviewClipped || "(none)",
      "",
      "SOUL memory:",
      soulPreviewClipped || "(none)",
      "",
      "Working memory (MEMORY.md + recent logs):",
      workingMemoryClipped || "(none)",
      "",
      "Enabled skills context:",
      skillPreviewClipped || "(none)",
      "",
      "Rules:",
      "1. Prefer concrete tool actions over pure text.",
      "2. Keep continuity; do not duplicate already running tasks.",
      "3. Save high-value facts to memory tools and soul journal.",
      "4. Update objective status when progress changes.",
      "5. Prefer installed skills for repeatable high-level workflows.",
      "6. When referencing tool names, use only registered nx_* tool ids from Core markdown context.",
      "",
      "[USER REQUEST]",
      text,
    ].join("\n");
  }

  extractAssistantText(message) {
    if (!message || message.role !== "assistant") {
      return "";
    }

    if (!Array.isArray(message.content)) {
      return "";
    }

    return message.content
      .map((part) => {
        if (part && part.type === "text" && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .join("")
      .trim();
  }

  async enqueueByLane(laneKey, fn) {
    return await this.laneQueue.enqueue(String(laneKey || "default"), fn);
  }

  async maybeCompactMemory() {
    const stats = this.memoryStore.getStats();
    if (stats.raw < 120) {
      return null;
    }

    const result = await this.memoryStore.compact({ reason: "runtime_threshold" });
    if (result) {
      this.emit("runtime.memory.compact", {
        compactedCount: result.compactedCount,
        remainingRaw: result.remainingRaw,
      });
    }
    return result;
  }

  async runPromptWithRetry(prompt, incoming, session) {
    const maxRetries = Math.max(1, Number(this.config.runtime.maxPromptRetries) || 2);
    const maxAttempts = maxRetries + this.maxOverflowCompactionAttempts + 1;
    let lastError = null;
    let overflowCompactionAttempts = 0;
    let overflowTruncationAttempts = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.last.runAttempt = attempt;
      this.emit("runtime.run.attempt", {
        attempt,
        maxRetries: maxAttempts,
        source: incoming.source,
      });

      try {
        await withTimeout(
          session.prompt(prompt),
          this.config.runtime.promptTimeoutMs,
          `Prompt timeout after ${this.config.runtime.promptTimeoutMs}ms`,
        );
        return { ok: true, attempt };
      } catch (error) {
        lastError = error;
        const errorText = String(error?.message || error || "unknown runtime error");
        const isOverflow = this.isLikelyContextOverflow(errorText);

        if (
          isOverflow &&
          overflowCompactionAttempts < this.maxOverflowCompactionAttempts
        ) {
          overflowCompactionAttempts += 1;
          this.emit("runtime.run.overflow", {
            attempt,
            overflowCompactionAttempts,
            maxOverflowCompactionAttempts: this.maxOverflowCompactionAttempts,
            error: errorText,
          });

          const compacted = await this.memoryStore.compact({
            reason: `context_overflow_attempt_${overflowCompactionAttempts}`,
          });
          if (compacted) {
            this.emit("runtime.run.overflow.compacted", {
              attempt,
              compactedCount: compacted.compactedCount,
              remainingRaw: compacted.remainingRaw,
            });
            continue;
          }

          if (overflowTruncationAttempts < 1) {
            overflowTruncationAttempts += 1;
            const trimmed = this.trimSessionHistoryForOverflow(session);
            if (trimmed.trimmed) {
              this.emit("runtime.run.overflow.trimmed", {
                attempt,
                removedMessages: trimmed.removed,
              });
              continue;
            }
          }
        }

        this.emit("runtime.run.attempt.error", {
          attempt,
          error: errorText,
        });

        if (!isOverflow && attempt >= maxRetries) {
          break;
        }
      }
    }

    return { ok: false, error: lastError };
  }

  async handleIncoming(incoming, text) {
    this.refreshAuthStatus();
    if (!this.hasAnyAuth()) {
      const message =
        "Authentication required. Run `nxclaw auth --provider google-gemini-cli` (or openai-codex / anthropic) before prompting.";
      this.last.messageAt = nowIso();
      this.last.reply = message;
      this.last.error = null;
      this.emit("runtime.auth.required", {
        source: String(incoming?.source || "unknown"),
      });
      return message;
    }

    if (!this.model || !this.isProviderAuthenticated(this.model.provider)) {
      try {
        this.model = this.resolveModel();
      } catch (error) {
        const message = `Authentication required for an active provider. ${String(error?.message || error || "")}`.trim();
        this.last.messageAt = nowIso();
        this.last.reply = message;
        this.last.error = null;
        this.emit("runtime.auth.required", {
          source: String(incoming?.source || "unknown"),
          reason: "model_resolution_failed",
        });
        return message;
      }
    }

    const safeIncoming = {
      source: String(incoming?.source || "unknown"),
      channelId: String(incoming?.channelId || incoming?.userId || "default"),
      userId: String(incoming?.userId || "unknown"),
      sessionId: this.safeSessionId(incoming?.sessionId || ""),
    };
    const sessionKey = this.buildLaneKey(safeIncoming);

    if (this.getQueueDepth() >= this.config.runtime.maxQueueDepth) {
      const message = `Queue overflow: depth ${this.getQueueDepth()} >= ${this.config.runtime.maxQueueDepth}`;
      this.emit("runtime.queue.overflow", {
        queueDepth: this.getQueueDepth(),
        maxQueueDepth: this.config.runtime.maxQueueDepth,
      });
      return message;
    }

    try {
      return await this.enqueueByLane(sessionKey, async () => {
      if (!this.customTools) {
        throw new Error("Runtime not initialized");
      }

      const session = await this.getOrCreateSession(sessionKey);
      this.touchSessionMeta(sessionKey, {
        messageCount: Number(session?.messages?.length || 0),
      });

      this.last.messageAt = nowIso();
      this.last.error = null;
      const activeRun = {
        runId: crypto.randomUUID(),
        source: safeIncoming.source,
        lane: sessionKey,
        startedAt: nowIso(),
        textPreview: safeText(text).slice(0, 220),
      };
      this.activeRuns.set(sessionKey, activeRun);
      this.activeRun = activeRun;
      this.busy = true;

      this.emit("runtime.run.start", {
        runId: activeRun.runId,
        source: safeIncoming.source,
        channelId: safeIncoming.channelId || "unknown",
        lane: sessionKey,
      });

      try {
        const rawText = safeText(text);
        if (!rawText) {
          return "";
        }

        await this.memoryStore.addConversation({
          actor: "user",
          content: rawText,
          source: `${safeIncoming.source}:${safeIncoming.channelId || safeIncoming.userId || "unknown"}`,
          tags: [safeIncoming.source],
          sessionKey,
        });

        const before = session.messages.length;
        const memoryMatches = await this.memoryStore.search(rawText, 8, {
          sessionKey,
          mode: "session_strict",
        });
        const prompt = await this.composeContextPrompt({
          incoming,
          memoryMatches,
          text: rawText,
          sessionKey,
        });

        const run = await this.runPromptWithRetry(prompt, incoming, session);
        if (!run.ok) {
          throw run.error;
        }

        const after = session.messages.slice(before);
        const latestAssistant = [...after].reverse().find((entry) => entry.role === "assistant");
        const reply = this.extractAssistantText(latestAssistant) || "No response body generated.";

        await this.memoryStore.addConversation({
          actor: "assistant",
          content: reply,
          source: `${safeIncoming.source}:${safeIncoming.channelId || safeIncoming.userId || "unknown"}`,
          tags: [safeIncoming.source],
          sessionKey,
        });

        if (/done|completed|blocked|failed|critical|decision|release|deploy/i.test(reply)) {
          await this.memoryStore.appendSoulJournal({
            title: `Run ${safeIncoming.source}`,
            content: reply.slice(0, 800),
            source: safeIncoming.source,
          });
        }

        await this.maybeCompactMemory();
        await this.enforceSessionLimits();
        this.touchSessionMeta(sessionKey, {
          messageCount: Number(session?.messages?.length || 0),
        });

        this.last.reply = reply;
        this.emit("runtime.run.success", {
          runId: activeRun.runId,
          replyChars: reply.length,
        });
        await this.persistStateSnapshot();
        return reply;
      } catch (error) {
        const message = String(error?.message || error || "unknown runtime error");
        this.last.error = message;
        this.emit("runtime.run.error", {
          runId: activeRun.runId,
          error: message,
        });
        await this.persistStateSnapshot();
        return `Runtime error: ${message}`;
      } finally {
        const laneRun = this.activeRuns.get(sessionKey);
        if (laneRun?.runId === activeRun.runId) {
          this.activeRuns.delete(sessionKey);
        }
        this.busy = this.activeRuns.size > 0;
        this.emit("runtime.run.end", {
          runId: activeRun.runId,
        });
        if (this.activeRun?.runId === activeRun.runId) {
          const first = this.activeRuns.values().next();
          this.activeRun = first.done ? null : first.value;
        }
        this.touchSessionMeta(sessionKey, {
          messageCount: Number(session?.messages?.length || 0),
        });
      }
      });
    } catch (error) {
      const message = String(error?.message || error || "lane queue failure");
      this.last.error = message;
      this.emit("runtime.queue.error", {
        lane: sessionKey,
        error: message,
      });
      return `Runtime error: ${message}`;
    }
  }

  async getState({ autonomousLoop = null, includeEvents = true } = {}) {
    await this.objectiveQueue.reload().catch(() => undefined);
    const objectives = this.objectiveQueue.stats();
    const memoryStats = this.memoryStore.getStats();
    const tasks = this.backgroundManager.list({ includeFinished: false });

    return {
      provider: this.model?.provider || this.config.defaultProvider,
      model: this.model ? `${this.model.provider}/${this.model.id}` : "unknown",
      busy: this.busy,
      queueDepth: this.getQueueDepth(),
      queueLanes: this.getQueueLanes(16),
      sessionLanes: this.sessionByLane.size,
      sessionLimits: {
        maxSessionLanes: this.maxSessionLanes,
        maxSessionIdleMinutes: Math.round(this.maxSessionIdleMs / 60000),
      },
      webSessions: this.listConversationSessions({
        source: "dashboard",
        channelId: "dashboard",
      }),
      activeRun: this.activeRun,
      activeRuns: [...this.activeRuns.values()],
      lastMessageAt: this.last.messageAt,
      lastReply: this.last.reply,
      lastError: this.last.error,
      channels: [...this.channelState.entries()].map(([name, active]) => ({ name, active })),
      auth: this.authStatus || this.refreshAuthStatus(),
      authReady: this.hasAnyAuth(),
      memory: memoryStats,
      objectives,
      tasks,
      taskHealth: this.backgroundManager.getHealth(),
      skills: this.skillManager ? this.skillManager.getStatusSummary() : null,
      chromeSessions: this.chromeController.listSessions(),
      autonomous: autonomousLoop ? autonomousLoop.getState() : null,
      events: includeEvents && this.eventBus ? this.eventBus.getRecent(60) : [],
    };
  }

  async shutdown() {
    for (const unsubscribe of this.sessionUnsubscribers.values()) {
      try {
        unsubscribe();
      } catch {}
    }
    this.sessionUnsubscribers.clear();
    this.sessionByLane.clear();
    this.sessionMetaByLane.clear();
    this.session = null;

    await this.chromeController.closeAll();
    await this.backgroundManager.shutdown({ stopSchedulesOnly: false });
    if (this.memoryStore && typeof this.memoryStore.shutdown === "function") {
      await this.memoryStore.shutdown();
    }
    await this.persistStateSnapshot({ shutdownAt: nowIso() });
    this.emit("runtime.shutdown", {});
    if (this.eventBus && typeof this.eventBus.shutdown === "function") {
      await this.eventBus.shutdown();
    }
  }
}
