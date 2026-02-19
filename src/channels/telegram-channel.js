import { Telegraf } from "telegraf";
import { createIncomingMessage } from "./channel-types.js";

const TELEGRAM_MAX_MESSAGE = 3800;

function splitText(text, maxChars = TELEGRAM_MAX_MESSAGE) {
  const raw = String(text ?? "");
  if (!raw) {
    return [""];
  }
  if (raw.length <= maxChars) {
    return [raw];
  }

  const out = [];
  let cursor = 0;
  while (cursor < raw.length) {
    const end = Math.min(raw.length, cursor + maxChars);
    out.push(raw.slice(cursor, end));
    cursor = end;
  }
  return out;
}

function isStatusCommand(text) {
  const raw = String(text ?? "").trim();
  return /^\/status(?:@\w+)?(?:\s|$)/i.test(raw) || /^!status$/i.test(raw);
}

function isHelpCommand(text) {
  const raw = String(text ?? "").trim();
  return /^\/help(?:@\w+)?(?:\s|$)/i.test(raw) || /^!help$/i.test(raw);
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clipText(value, max = 100) {
  const raw = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!raw) {
    return "";
  }
  if (raw.length <= max) {
    return raw;
  }
  return `${raw.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function formatEventClock(ts) {
  const ms = Number(ts);
  if (!Number.isFinite(ms) || ms <= 0) {
    return "--:--:--";
  }
  return new Date(ms).toTimeString().slice(0, 8);
}

function collectRecentStepLines(events, limit = 4) {
  const rows = [];
  const ignore = new Set([
    "runtime.watchdog",
    "lane.enqueue",
    "lane.start",
    "lane.end",
    "runtime.queue.enqueue",
    "runtime.queue.start",
    "runtime.queue.end",
  ]);

  const list = Array.isArray(events) ? events : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const event = list[i];
    const type = String(event?.type || "");
    if (!type || ignore.has(type)) {
      continue;
    }
    const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
    const detailParts = [];

    if (payload.sessionId) {
      detailParts.push(`session=${clipText(payload.sessionId, 16)}`);
    }
    if (payload.taskId) {
      detailParts.push(`task=${clipText(payload.taskId, 10)}`);
    }
    if (payload.url) {
      detailParts.push(`url=${clipText(payload.url, 56)}`);
    }
    if (payload.selector) {
      detailParts.push(`selector=${clipText(payload.selector, 28)}`);
    }
    if (payload.command) {
      detailParts.push(`cmd=${clipText(payload.command, 42)}`);
    }
    if (payload.error) {
      detailParts.push(`error=${clipText(payload.error, 48)}`);
    }
    if (payload.reason && !payload.error) {
      detailParts.push(`reason=${clipText(payload.reason, 36)}`);
    }

    const detail = detailParts.length > 0 ? ` ${detailParts.join(" | ")}` : "";
    rows.push(`  • ${formatEventClock(event?.ts)} ${type}${detail}`);
    if (rows.length >= Math.max(1, Number(limit) || 4)) {
      break;
    }
  }

  return rows;
}

export class TelegramChannel {
  constructor({
    botToken,
    statusProvider = null,
    progressIntervalMs = 15_000,
    maxProgressUpdates = 0,
    statusCooldownMs = 4_000,
    busyNoticeCooldownMs = 5_000,
  }) {
    this.botToken = botToken;
    this.statusProvider = typeof statusProvider === "function" ? statusProvider : null;
    this.progressIntervalMs = Math.max(5_000, Number(progressIntervalMs) || 15_000);
    this.maxProgressUpdates = Math.max(1, Number(maxProgressUpdates) || 3);
    this.statusCooldownMs = Math.max(500, Number(statusCooldownMs) || 4_000);
    this.busyNoticeCooldownMs = Math.max(1_000, Number(busyNoticeCooldownMs) || 5_000);
    this.bot = null;
    this.started = false;
    this.inFlightBySession = new Map();
    this.lastStatusAtBySession = new Map();
    this.lastBusyNoticeAtBySession = new Map();
  }

  isHealthy() {
    return this.started;
  }

  buildThreadOptions(ctx) {
    const threadId = ctx?.message?.message_thread_id;
    if (Number.isFinite(Number(threadId)) && Number(threadId) > 0) {
      return { message_thread_id: Number(threadId) };
    }
    return {};
  }

  buildSessionKey(ctx, sessionId) {
    const chatId = String(ctx?.chat?.id ?? "unknown");
    return `${chatId}:${String(sessionId || "default")}`;
  }

  canEmitStatus(sessionKey) {
    const now = Date.now();
    const last = toNumber(this.lastStatusAtBySession.get(sessionKey), 0);
    if (now - last < this.statusCooldownMs) {
      return false;
    }
    this.lastStatusAtBySession.set(sessionKey, now);
    return true;
  }

  canEmitBusyNotice(sessionKey) {
    const now = Date.now();
    const last = toNumber(this.lastBusyNoticeAtBySession.get(sessionKey), 0);
    if (now - last < this.busyNoticeCooldownMs) {
      return false;
    }
    this.lastBusyNoticeAtBySession.set(sessionKey, now);
    return true;
  }

  buildReplyTarget(ctx, options = {}) {
    return {
      chatId: ctx?.chat?.id,
      options,
    };
  }

  async safeReply(ctx, text, options = {}) {
    const chunks = splitText(text, TELEGRAM_MAX_MESSAGE);
    for (const chunk of chunks) {
      if (chunk) {
        await ctx.reply(chunk, options).catch(() => undefined);
      }
    }
  }

  async safeReplyTarget(target, text) {
    if (!this.bot || !target?.chatId) {
      return;
    }
    const chunks = splitText(text, TELEGRAM_MAX_MESSAGE);
    for (const chunk of chunks) {
      if (!chunk) {
        continue;
      }
      await this.bot.telegram.sendMessage(target.chatId, chunk, target.options || {}).catch(() => undefined);
    }
  }

  async safeTyping(target) {
    if (!this.bot || !target?.chatId) {
      return;
    }
    await this.bot.telegram
      .sendChatAction(target.chatId, "typing", target.options || {})
      .catch(() => undefined);
  }

  async processTextRequest({ target, sessionKey, incoming, text, handler }) {
    let progressTimer = null;
    let progressCount = 0;
    const startedAt = Date.now();
    try {
      await this.safeReplyTarget(target, "요청 받았습니다. 처리 중입니다.");

      await this.safeTyping(target);
      progressTimer = setInterval(() => {
        void (async () => {
          if (this.maxProgressUpdates > 0 && progressCount >= this.maxProgressUpdates) {
            return;
          }
          progressCount += 1;
          await this.safeTyping(target);
          if (!this.canEmitStatus(sessionKey)) {
            return;
          }
          const statusText = await this.buildStatusText({ includeRunPreview: false });
          const elapsedSec = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
          await this.safeReplyTarget(target, `진행상황 업데이트 (${elapsedSec}s)\n${statusText}`);
        })();
      }, this.progressIntervalMs);

      const reply = await handler(incoming, text);
      if (reply) {
        await this.safeReplyTarget(target, reply);
      } else {
        await this.safeReplyTarget(target, "(응답이 비어 있습니다)");
      }
    } catch (error) {
      const message = String(error?.message || error || "telegram handler error");
      await this.safeReplyTarget(target, `처리 중 오류가 발생했습니다: ${message}`);
    } finally {
      if (progressTimer) {
        clearInterval(progressTimer);
      }
    }
  }

  async buildStatusText({ includeRunPreview = true } = {}) {
    if (!this.statusProvider) {
      return [
        "[nxclaw status]",
        "- status provider not configured",
      ].join("\n");
    }

    let state = null;
    try {
      state = await this.statusProvider();
    } catch (error) {
      return `[nxclaw status]\n- failed to read runtime state: ${String(error?.message || error || "unknown")}`;
    }

    const busy = !!state?.busy;
    const queueDepth = toNumber(state?.queueDepth, 0);
    const activeRuns = Array.isArray(state?.activeRuns) ? state.activeRuns : [];
    const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
    const pendingMerge = state?.pendingMerge || {};
    const pendingLanes = Array.isArray(state?.pendingLanes) ? state.pendingLanes : [];
    const taskHealth = state?.taskHealth || {};
    const memory = state?.memory || {};
    const autonomous = state?.autonomous || {};
    const chromeSessions = Array.isArray(state?.chromeSessions) ? state.chromeSessions : [];
    const recentStepLines = collectRecentStepLines(state?.events, 4);
    const runningTasks = tasks.filter((task) => String(task?.status || "") === "running");
    const queuedTasks = tasks.filter((task) => String(task?.status || "") === "queued");

    const lines = [
      "[nxclaw status]",
      `- busy: ${busy ? "yes" : "no"}`,
      `- queueDepth: ${queueDepth}`,
      `- activeRuns: ${activeRuns.length}`,
      `- tasks: running=${toNumber(taskHealth.running, 0)} queued=${toNumber(taskHealth.queued, 0)}`,
      `- chrome: sessions=${chromeSessions.length}`,
      `- follow-up buffer: lanes=${toNumber(pendingMerge.lanes, 0)} msgs=${toNumber(pendingMerge.totalMessages, 0)} dropped=${toNumber(pendingMerge.dropped, 0)}`,
      `- memory: raw=${toNumber(memory.raw, 0)} compact=${toNumber(memory.compact, 0)} indexChunks=${toNumber(memory.indexChunks, 0)}`,
      `- autonomous: ${autonomous && autonomous.enabled ? `enabled(active=${autonomous.active ? "yes" : "no"})` : "disabled"}`,
    ];

    if (includeRunPreview && activeRuns.length > 0) {
      lines.push("- run previews:");
      for (const run of activeRuns.slice(0, 2)) {
        const source = String(run?.source || "unknown");
        const preview = String(run?.textPreview || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 90);
        lines.push(`  • ${source}: ${preview || "(empty)"}`);
      }
    }

    if (runningTasks.length > 0) {
      lines.push("- running jobs:");
      for (const task of runningTasks.slice(0, 2)) {
        lines.push(
          `  • ${clipText(task?.name || task?.id || "task", 34)} pid=${task?.pid || "-"} retry=${toNumber(task?.attempts, 0)}/${toNumber(task?.maxRetries, 0)} cmd=${clipText(task?.command || "", 58) || "(none)"}`,
        );
      }
    }

    if (queuedTasks.length > 0) {
      const queuedPreview = queuedTasks
        .slice(0, 2)
        .map((task) => clipText(task?.name || task?.id || "task", 26))
        .filter(Boolean)
        .join(", ");
      lines.push(`- queued jobs preview: ${queuedPreview || queuedTasks.length}`);
    }

    if (chromeSessions.length > 0) {
      lines.push("- chrome sessions:");
      for (const session of chromeSessions.slice(0, 2)) {
        lines.push(
          `  • ${clipText(session?.id || "session", 10)} mode=${clipText(session?.mode || "?", 8)} title=${clipText(session?.title || "(no title)", 34)} url=${clipText(session?.url || "", 58) || "(none)"}`,
        );
      }
    }

    if (recentStepLines.length > 0) {
      lines.push("- recent steps:");
      lines.push(...recentStepLines);
    }

    if (pendingLanes.length > 0) {
      lines.push("- buffered lanes:");
      for (const lane of pendingLanes.slice(0, 2)) {
        lines.push(
          `  • ${clipText(lane?.lane || "", 28)} items=${toNumber(lane?.items, 0)} dropped=${toNumber(lane?.dropped, 0)} latest=${clipText(lane?.latestPreview || "", 64) || "(none)"}`,
        );
      }
    }

    return lines.join("\n");
  }

  async start(handler) {
    if (!this.botToken) {
      throw new Error("Telegram token missing: NXCLAW_TELEGRAM_BOT_TOKEN is required");
    }

    this.bot = new Telegraf(this.botToken);

    this.bot.on("text", async (ctx, next) => {
      if (!ctx.message?.text || !ctx.chat?.id) {
        return next();
      }

      const text = String(ctx.message.text || "").trim();
      const threadId = ctx.message?.message_thread_id;
      const userId = String(ctx.from?.id ?? "unknown");
      const sessionId =
        Number.isFinite(Number(threadId)) && Number(threadId) > 0
          ? `topic-${threadId}`
          : `user-${userId}`;
      const options = this.buildThreadOptions(ctx);
      const replyTarget = this.buildReplyTarget(ctx, options);
      const sessionKey = this.buildSessionKey(ctx, sessionId);
      const incoming = createIncomingMessage({
        source: "telegram",
        channelId: String(ctx.chat.id),
        userId,
        sessionId,
      });

      if (isHelpCommand(text)) {
        await this.safeReply(
          ctx,
          [
            "Available commands:",
            "- /status or !status : show runtime status",
            "- /help : show this help",
            "",
            "Any other text is sent to nxclaw runtime.",
          ].join("\n"),
          options,
        );
        return next();
      }

      if (isStatusCommand(text)) {
        if (!this.canEmitStatus(sessionKey)) {
          await this.safeReply(ctx, "status 요청이 너무 빠릅니다. 잠시 후 다시 시도해주세요.", options);
          return next();
        }
        const statusText = await this.buildStatusText({ includeRunPreview: true });
        await this.safeReply(ctx, statusText, options);
        return next();
      }

      const inFlight = toNumber(this.inFlightBySession.get(sessionKey), 0);
      if (inFlight > 0) {
        try {
          const reply = await handler(incoming, text);
          if (this.canEmitBusyNotice(sessionKey)) {
            if (reply) {
              await this.safeReplyTarget(replyTarget, reply);
            } else {
              const statusText = await this.buildStatusText({ includeRunPreview: false });
              await this.safeReplyTarget(
                replyTarget,
                `현재 요청 처리 중이며 추가 요청은 병합 보관 중입니다.\n\n현재 상황\n${statusText}`,
              );
            }
          } else {
            await this.safeReplyTarget(
              replyTarget,
              "현재 요청 처리 중입니다. 추가 요청은 병합 보관되었습니다. (/status 로 확인)",
            );
          }
        } catch (error) {
          const message = String(error?.message || error || "telegram handler error");
          await this.safeReplyTarget(replyTarget, `처리 중 오류가 발생했습니다: ${message}`);
        }
        return next();
      }

      this.inFlightBySession.set(sessionKey, 1);
      try {
        await this.processTextRequest({
          target: replyTarget,
          sessionKey,
          incoming,
          text,
          handler,
        });
      } finally {
        this.inFlightBySession.delete(sessionKey);
      }
      return next();
    });

    await this.bot.launch({ allowedUpdates: ["message"] });
    this.started = true;
  }

  async send(channelId, text) {
    if (!this.bot || !channelId) {
      return;
    }

    const chunks = splitText(String(text ?? ""), TELEGRAM_MAX_MESSAGE);
    for (const chunk of chunks) {
      if (!chunk) {
        continue;
      }
      await this.bot.telegram.sendMessage(channelId, chunk);
    }
  }

  async stop() {
    if (!this.bot) {
      return;
    }

    await this.bot.stop("SIGTERM");
    this.started = false;
    this.bot = null;
    this.inFlightBySession.clear();
  }
}
