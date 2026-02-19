import express from "express";
import { getSupportedProviders, readAuthStatus } from "../auth/setup-auth.js";
import { readJsonOrDefault, writeJson } from "../utils/fs.js";
import { dashboardHtml } from "./html.js";

function writeSse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function toInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function toBool(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

function toText(value, { max = 10000 } = {}) {
  return String(value ?? "")
    .trim()
    .slice(0, max);
}

function parseTags(input) {
  if (Array.isArray(input)) {
    return input
      .map((entry) => String(entry ?? "").trim())
      .filter(Boolean)
      .slice(0, 40);
  }
  return String(input ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 40);
}

function normalizeIp(raw) {
  const ip = String(raw || "").trim();
  if (!ip) {
    return "";
  }
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

function isLoopbackAddress(raw) {
  const ip = normalizeIp(raw);
  if (!ip) {
    return false;
  }
  return ip === "127.0.0.1" || ip === "::1" || ip === "localhost" || ip.startsWith("127.");
}

function isTrustedLocalRequest(req) {
  if (isLoopbackAddress(req.ip)) {
    return true;
  }
  if (isLoopbackAddress(req.socket?.remoteAddress)) {
    return true;
  }
  return false;
}

function buildSettingsPayload({ runtime, autonomousLoop, auth }) {
  const cfg = runtime.config;
  return {
    providers: getSupportedProviders(),
    auth,
    channels: {
      slackConfigured: !!(cfg?.slack?.botToken && cfg?.slack?.appToken),
      telegramConfigured: !!cfg?.telegram?.botToken,
      webDashboard: true,
      active: [...runtime.channelState.entries()].map(([name, active]) => ({ name, active: !!active })),
    },
    settings: {
      defaultProvider: cfg.defaultProvider,
      defaultModel: cfg.defaultModel || "",
      runtime: {
        promptTimeoutMs: cfg.runtime.promptTimeoutMs,
        maxQueueDepth: cfg.runtime.maxQueueDepth,
        maxConcurrentTasks: cfg.runtime.maxConcurrentTasks,
        maxPromptRetries: cfg.runtime.maxPromptRetries,
        maxOverflowCompactionAttempts: cfg.runtime.maxOverflowCompactionAttempts,
        maxSessionLanes: cfg.runtime.maxSessionLanes,
        maxSessionIdleMinutes: cfg.runtime.maxSessionIdleMinutes,
        maxStoredTasks: cfg.runtime.maxStoredTasks,
        maxFinishedTasks: cfg.runtime.maxFinishedTasks,
      },
      autonomous: autonomousLoop
        ? {
            enabled: !!autonomousLoop.autoConfig.enabled,
            goal: autonomousLoop.autoConfig.goal || "",
            intervalMs: autonomousLoop.autoConfig.intervalMs,
            skipWhenQueueAbove: autonomousLoop.autoConfig.skipWhenQueueAbove,
            maxConsecutiveFailures: autonomousLoop.autoConfig.maxConsecutiveFailures,
            stalePendingHours: autonomousLoop.autoConfig.stalePendingHours,
            staleInProgressIdleHours: autonomousLoop.autoConfig.staleInProgressIdleHours,
          }
        : {
            enabled: false,
            goal: "",
            intervalMs: 90000,
            skipWhenQueueAbove: 2,
            maxConsecutiveFailures: 5,
            stalePendingHours: 24 * 14,
            staleInProgressIdleHours: 24 * 3,
          },
      memory: {
        sessionMemoryEnabled: !!cfg.memory.sessionMemoryEnabled,
        vectorEnabled: !!cfg.memory.vector.enabled,
      },
    },
  };
}

function parseSettingsPatch(body = {}) {
  const raw = body && typeof body === "object" ? body : {};
  const patch = {};
  const providers = new Set(getSupportedProviders());

  if (typeof raw.defaultProvider === "string") {
    const provider = raw.defaultProvider.trim();
    if (providers.has(provider)) {
      patch.defaultProvider = provider;
    }
  }
  if (raw.defaultModel != null) {
    patch.defaultModel = toText(raw.defaultModel, { max: 240 });
  }

  if (raw.runtime && typeof raw.runtime === "object") {
    const runtimePatch = {};
    if (raw.runtime.promptTimeoutMs != null) {
      runtimePatch.promptTimeoutMs = toInt(raw.runtime.promptTimeoutMs, 300000, {
        min: 10000,
        max: 3600000,
      });
    }
    if (raw.runtime.maxQueueDepth != null) {
      runtimePatch.maxQueueDepth = toInt(raw.runtime.maxQueueDepth, 100, { min: 10, max: 2000 });
    }
    if (raw.runtime.maxConcurrentTasks != null) {
      runtimePatch.maxConcurrentTasks = toInt(raw.runtime.maxConcurrentTasks, 6, { min: 1, max: 64 });
    }
    if (raw.runtime.maxPromptRetries != null) {
      runtimePatch.maxPromptRetries = toInt(raw.runtime.maxPromptRetries, 2, { min: 1, max: 10 });
    }
    if (raw.runtime.maxOverflowCompactionAttempts != null) {
      runtimePatch.maxOverflowCompactionAttempts = toInt(
        raw.runtime.maxOverflowCompactionAttempts,
        3,
        { min: 1, max: 10 },
      );
    }
    if (raw.runtime.maxSessionLanes != null) {
      runtimePatch.maxSessionLanes = toInt(raw.runtime.maxSessionLanes, 240, { min: 20, max: 2000 });
    }
    if (raw.runtime.maxSessionIdleMinutes != null) {
      runtimePatch.maxSessionIdleMinutes = toInt(raw.runtime.maxSessionIdleMinutes, 240, {
        min: 5,
        max: 24 * 60,
      });
    }
    if (raw.runtime.maxStoredTasks != null) {
      runtimePatch.maxStoredTasks = toInt(raw.runtime.maxStoredTasks, 4000, {
        min: 500,
        max: 200000,
      });
    }
    if (raw.runtime.maxFinishedTasks != null) {
      runtimePatch.maxFinishedTasks = toInt(raw.runtime.maxFinishedTasks, 1200, {
        min: 100,
        max: 100000,
      });
    }
    if (Object.keys(runtimePatch).length > 0) {
      patch.runtime = runtimePatch;
    }
  }

  if (raw.autonomous && typeof raw.autonomous === "object") {
    const autoPatch = {};
    if (raw.autonomous.enabled != null) {
      autoPatch.enabled = toBool(raw.autonomous.enabled, true);
    }
    if (raw.autonomous.goal != null) {
      autoPatch.goal = toText(raw.autonomous.goal, { max: 2000 });
    }
    if (raw.autonomous.intervalMs != null) {
      autoPatch.intervalMs = toInt(raw.autonomous.intervalMs, 90000, { min: 5000, max: 3600000 });
    }
    if (raw.autonomous.skipWhenQueueAbove != null) {
      autoPatch.skipWhenQueueAbove = toInt(raw.autonomous.skipWhenQueueAbove, 2, {
        min: 0,
        max: 200,
      });
    }
    if (raw.autonomous.maxConsecutiveFailures != null) {
      autoPatch.maxConsecutiveFailures = toInt(raw.autonomous.maxConsecutiveFailures, 5, {
        min: 1,
        max: 50,
      });
    }
    if (raw.autonomous.stalePendingHours != null) {
      autoPatch.stalePendingHours = toInt(raw.autonomous.stalePendingHours, 24 * 14, {
        min: 1,
        max: 24 * 365,
      });
    }
    if (raw.autonomous.staleInProgressIdleHours != null) {
      autoPatch.staleInProgressIdleHours = toInt(
        raw.autonomous.staleInProgressIdleHours,
        24 * 3,
        { min: 1, max: 24 * 365 },
      );
    }
    if (Object.keys(autoPatch).length > 0) {
      patch.autonomous = autoPatch;
    }
  }

  if (raw.memory && typeof raw.memory === "object") {
    const memoryPatch = {};
    if (raw.memory.sessionMemoryEnabled != null) {
      memoryPatch.sessionMemoryEnabled = toBool(raw.memory.sessionMemoryEnabled, true);
    }
    if (raw.memory.vectorEnabled != null) {
      memoryPatch.vectorEnabled = toBool(raw.memory.vectorEnabled, true);
    }
    if (Object.keys(memoryPatch).length > 0) {
      patch.memory = memoryPatch;
    }
  }

  return patch;
}

async function persistSettingsPatch(runtime, patch) {
  const configPath = runtime.config.paths.configPath;
  const current = await readJsonOrDefault(configPath, {});
  const next = {
    ...current,
  };

  if (patch.defaultProvider !== undefined) {
    next.defaultProvider = patch.defaultProvider;
  }
  if (patch.defaultModel !== undefined) {
    next.defaultModel = patch.defaultModel;
  }
  if (patch.runtime) {
    next.runtime = {
      ...(next.runtime || {}),
      ...patch.runtime,
    };
  }
  if (patch.autonomous) {
    next.autonomous = {
      ...(next.autonomous || {}),
      ...patch.autonomous,
    };
  }
  if (patch.memory) {
    next.memory = {
      ...(next.memory || {}),
      ...(patch.memory.sessionMemoryEnabled !== undefined
        ? { sessionMemoryEnabled: patch.memory.sessionMemoryEnabled }
        : {}),
      ...(patch.memory.vectorEnabled !== undefined
        ? {
            vector: {
              ...((next.memory && next.memory.vector) || {}),
              enabled: patch.memory.vectorEnabled,
            },
          }
        : {}),
    };
  }

  await writeJson(configPath, next);
}

function applySettingsToRuntime(runtime, autonomousLoop, patch) {
  let modelWarning = null;

  if (patch.defaultProvider !== undefined) {
    runtime.config.defaultProvider = patch.defaultProvider;
  }
  if (patch.defaultModel !== undefined) {
    runtime.config.defaultModel = patch.defaultModel || undefined;
  }
  if (patch.defaultProvider !== undefined || patch.defaultModel !== undefined) {
    const prevModel = runtime.model;
    try {
      if (typeof runtime.refreshAuthStatus === "function") {
        runtime.refreshAuthStatus();
      }
      runtime.model = runtime.resolveModel();
    } catch (error) {
      runtime.model = prevModel;
      modelWarning = String(error?.message || error || "model reload failed");
    }
  }

  if (patch.runtime) {
    runtime.config.runtime = {
      ...runtime.config.runtime,
      ...patch.runtime,
    };
    if (patch.runtime.maxQueueDepth !== undefined) {
      runtime.laneQueue.maxDepth = patch.runtime.maxQueueDepth;
    }
    if (patch.runtime.maxConcurrentTasks !== undefined) {
      runtime.backgroundManager.maxConcurrentProcesses = patch.runtime.maxConcurrentTasks;
    }
    if (patch.runtime.maxSessionLanes !== undefined) {
      runtime.maxSessionLanes = Math.max(20, Number(patch.runtime.maxSessionLanes) || 240);
    }
    if (patch.runtime.maxSessionIdleMinutes !== undefined) {
      runtime.maxSessionIdleMs = Math.max(
        5 * 60 * 1000,
        (Math.max(5, Number(patch.runtime.maxSessionIdleMinutes) || 240) * 60 * 1000),
      );
    }
    if (patch.runtime.maxStoredTasks !== undefined) {
      runtime.backgroundManager.maxTasks = Math.max(500, Number(patch.runtime.maxStoredTasks) || 4000);
      runtime.backgroundManager.pruneTasks();
    }
    if (patch.runtime.maxFinishedTasks !== undefined) {
      runtime.backgroundManager.maxFinishedTasks = Math.max(
        100,
        Number(patch.runtime.maxFinishedTasks) || 1200,
      );
      runtime.backgroundManager.pruneTasks();
    }
  }

  if (patch.memory) {
    if (patch.memory.sessionMemoryEnabled !== undefined) {
      runtime.config.memory.sessionMemoryEnabled = patch.memory.sessionMemoryEnabled;
      runtime.memoryStore.sessionMemoryEnabled = patch.memory.sessionMemoryEnabled;
    }
    if (patch.memory.vectorEnabled !== undefined) {
      runtime.config.memory.vector.enabled = patch.memory.vectorEnabled;
      runtime.memoryStore.vector.enabled = patch.memory.vectorEnabled;
      runtime.memoryStore.markIndexDirty();
    }
  }

  if (patch.autonomous && autonomousLoop) {
    runtime.config.autonomous = {
      ...runtime.config.autonomous,
      ...patch.autonomous,
    };
    autonomousLoop.applyConfig(patch.autonomous);
  }

  return { modelWarning };
}

export function createDashboardServer({ runtime, autonomousLoop, eventBus = null }) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const dashboardToken = toText(runtime?.config?.dashboardToken || "", { max: 512 });
  if (dashboardToken) {
    app.use((req, res, next) => {
      if (isTrustedLocalRequest(req)) {
        return next();
      }
      const supplied = toText(req.get("x-nxclaw-token") || req.query.token || "", { max: 512 });
      if (supplied && supplied === dashboardToken) {
        return next();
      }
      return res.status(401).json({ ok: false, error: "unauthorized dashboard api access" });
    });
  }

  app.get("/", (_req, res) => {
    res.type("html").send(dashboardHtml());
  });

  app.get("/api/state", async (_req, res) => {
    const state = await runtime.getState({ autonomousLoop });
    res.json(state);
  });

  app.get("/api/settings", async (_req, res) => {
    try {
      const auth = await readAuthStatus(runtime.getAuthStorage());
      return res.json({
        ok: true,
        ...buildSettingsPayload({ runtime, autonomousLoop, auth }),
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: String(error?.message || error || "settings read failed"),
      });
    }
  });

  app.post("/api/settings", async (req, res) => {
    const patch = parseSettingsPatch(req.body?.settings || req.body || {});
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ ok: false, error: "no valid settings provided" });
    }

    try {
      await persistSettingsPatch(runtime, patch);
      const { modelWarning } = applySettingsToRuntime(runtime, autonomousLoop, patch);
      if (typeof runtime.persistStateSnapshot === "function") {
        await runtime.persistStateSnapshot({ settingsUpdatedAt: new Date().toISOString() });
      }
      const auth = await readAuthStatus(runtime.getAuthStorage());
      return res.json({
        ok: true,
        ...(modelWarning ? { warning: modelWarning } : {}),
        ...buildSettingsPayload({ runtime, autonomousLoop, auth }),
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: String(error?.message || error || "settings update failed"),
      });
    }
  });

  app.get("/api/sessions", (req, res) => {
    const source = toText(req.query.source || "dashboard", { max: 60 }) || "dashboard";
    const channelId = toText(req.query.channelId || "dashboard", { max: 120 }) || "dashboard";
    const sessions = runtime.listConversationSessions({ source, channelId });
    return res.json({ ok: true, sessions });
  });

  app.post("/api/sessions", async (req, res) => {
    try {
      const source = toText(req.body?.source || "dashboard", { max: 60 }) || "dashboard";
      const channelId = toText(req.body?.channelId || "dashboard", { max: 120 }) || "dashboard";
      const userId = toText(req.body?.userId || "dashboard", { max: 120 }) || "dashboard";
      const sessionId = toText(req.body?.sessionId || "", { max: 120 });
      const session = await runtime.createConversationSession({
        source,
        channelId,
        userId,
        sessionId,
      });
      return res.json({ ok: true, session });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: String(error?.message || error || "session create failed"),
      });
    }
  });

  app.post("/api/sessions/archive", async (req, res) => {
    try {
      const source = toText(req.body?.source || "dashboard", { max: 60 }) || "dashboard";
      const channelId = toText(req.body?.channelId || "dashboard", { max: 120 }) || "dashboard";
      const userId = toText(req.body?.userId || "dashboard", { max: 120 }) || "dashboard";
      const sessionId = toText(req.body?.sessionId || "", { max: 120 });
      if (!sessionId) {
        return res.status(400).json({ ok: false, error: "sessionId is required" });
      }
      const result = await runtime.archiveConversationSession({
        source,
        channelId,
        userId,
        sessionId,
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: String(error?.message || error || "session archive failed"),
      });
    }
  });

  app.get("/api/memory/stats", (_req, res) => {
    return res.json({
      ok: true,
      stats: runtime.memoryStore.getStats(),
    });
  });

  app.get("/api/memory/recent", (req, res) => {
    const limit = toInt(req.query.limit, 30, { min: 1, max: 200 });
    return res.json({
      ok: true,
      items: runtime.memoryStore.listRecent(limit),
    });
  });

  app.get("/api/memory/search", async (req, res) => {
    const query = toText(req.query.q || "", { max: 800 });
    const limit = toInt(req.query.limit, 12, { min: 1, max: 80 });
    const sessionKey = toText(req.query.sessionKey || "", { max: 180 });
    const modeRaw = toText(req.query.mode || "", { max: 40 }).toLowerCase();
    const mode =
      modeRaw === "session_strict" || modeRaw === "global"
        ? modeRaw
        : sessionKey
          ? "session_strict"
          : "global";
    if (!query) {
      return res.json({ ok: true, items: [] });
    }
    try {
      const items = await runtime.memoryStore.search(query, limit, { sessionKey, mode });
      return res.json({ ok: true, items });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: String(error?.message || error || "memory search failed"),
      });
    }
  });

  app.post("/api/memory/note", async (req, res) => {
    const title = toText(req.body?.title || "Dashboard note", { max: 160 });
    const content = toText(req.body?.content || "", { max: 20000 });
    const tags = parseTags(req.body?.tags);
    if (!content) {
      return res.status(400).json({ ok: false, error: "content is required" });
    }
    try {
      const note = await runtime.memoryStore.addLongTermNote({
        title,
        content,
        source: "dashboard",
        tags,
      });
      return res.json({ ok: true, note });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: String(error?.message || error || "memory note failed"),
      });
    }
  });

  app.get("/api/memory/soul", async (_req, res) => {
    try {
      const text = await runtime.memoryStore.readSoul();
      return res.json({ ok: true, text });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: String(error?.message || error || "soul read failed"),
      });
    }
  });

  app.post("/api/memory/soul", async (req, res) => {
    const content = toText(req.body?.content || "", { max: 20000 });
    const mode = toText(req.body?.mode || "append", { max: 20 }) === "replace" ? "replace" : "append";
    if (!content) {
      return res.status(400).json({ ok: false, error: "content is required" });
    }
    try {
      const changed = await runtime.memoryStore.writeSoul({ content, mode });
      if (toBool(req.body?.journal, false)) {
        await runtime.memoryStore.appendSoulJournal({
          title: toText(req.body?.title || "Dashboard SOUL update", { max: 120 }),
          content,
          source: "dashboard",
        });
      }
      return res.json({ ok: true, changed });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: String(error?.message || error || "soul write failed"),
      });
    }
  });

  app.post("/api/memory/compact", async (req, res) => {
    try {
      const result = await runtime.memoryStore.compact({
        reason: toText(req.body?.reason || "dashboard_manual", { max: 120 }) || "dashboard_manual",
      });
      return res.json({
        ok: true,
        result: result || null,
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: String(error?.message || error || "memory compact failed"),
      });
    }
  });

  app.post("/api/memory/sync", async (_req, res) => {
    try {
      if (typeof runtime.memoryStore.syncKnowledgeIndex === "function") {
        await runtime.memoryStore.syncKnowledgeIndex({ force: true, reason: "dashboard_manual_sync" });
      }
      return res.json({ ok: true, stats: runtime.memoryStore.getStats() });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: String(error?.message || error || "memory sync failed"),
      });
    }
  });

  app.get("/api/events/recent", (req, res) => {
    if (!eventBus) {
      return res.json([]);
    }

    const requested = Number(req.query.limit);
    const limit = Number.isFinite(requested)
      ? Math.max(1, Math.min(500, requested))
      : 100;

    return res.json(eventBus.getRecent(limit));
  });

  app.get("/api/events/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const emitEvent = (event) => {
      writeSse(res, event);
    };

    if (eventBus) {
      const recent = eventBus.getRecent(40);
      for (const event of recent) {
        emitEvent(event);
      }
    }

    const unsubscribe = eventBus ? eventBus.on(emitEvent) : () => undefined;
    const heartbeat = setInterval(() => {
      res.write(": ping\n\n");
    }, 15000);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  });

  app.post("/api/prompt", async (req, res) => {
    const message = String(req.body?.message || "").trim();
    const sessionId = toText(req.body?.sessionId || "", { max: 120 });
    if (!message) {
      return res.status(400).json({ ok: false, error: "message is required" });
    }

    try {
      const reply = await runtime.handleIncoming(
        {
          source: "dashboard",
          channelId: "dashboard",
          userId: "dashboard",
          sessionId,
        },
        message,
      );

      return res.json({ ok: true, reply });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: String(error?.message || error || "dashboard prompt error"),
      });
    }
  });

  return app;
}
