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

export class TelegramChannel {
  constructor({
    botToken,
    statusProvider = null,
    progressIntervalMs = 15_000,
    maxProgressUpdates = 3,
    statusCooldownMs = 4_000,
  }) {
    this.botToken = botToken;
    this.statusProvider = typeof statusProvider === "function" ? statusProvider : null;
    this.progressIntervalMs = Math.max(5_000, Number(progressIntervalMs) || 15_000);
    this.maxProgressUpdates = Math.max(1, Number(maxProgressUpdates) || 3);
    this.statusCooldownMs = Math.max(500, Number(statusCooldownMs) || 4_000);
    this.bot = null;
    this.started = false;
    this.inFlightBySession = new Map();
    this.lastStatusAtBySession = new Map();
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

  async safeReply(ctx, text, options = {}) {
    const chunks = splitText(text, TELEGRAM_MAX_MESSAGE);
    for (const chunk of chunks) {
      if (chunk) {
        await ctx.reply(chunk, options).catch(() => undefined);
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
    const taskHealth = state?.taskHealth || {};
    const memory = state?.memory || {};
    const autonomous = state?.autonomous || {};

    const lines = [
      "[nxclaw status]",
      `- busy: ${busy ? "yes" : "no"}`,
      `- queueDepth: ${queueDepth}`,
      `- activeRuns: ${activeRuns.length}`,
      `- tasks: running=${toNumber(taskHealth.running, 0)} queued=${toNumber(taskHealth.queued, 0)}`,
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

      const queuedBefore = toNumber(this.inFlightBySession.get(sessionKey), 0);
      this.inFlightBySession.set(sessionKey, queuedBefore + 1);

      let progressTimer = null;
      let progressCount = 0;

      try {
        if (queuedBefore > 0) {
          await this.safeReply(
            ctx,
            `이전 요청 처리 중입니다. 현재 세션 대기: ${queuedBefore}`,
            options,
          );
        } else {
          await this.safeReply(ctx, "요청 받았습니다. 처리 중입니다.", options);
        }

        await ctx.sendChatAction("typing").catch(() => undefined);

        progressTimer = setInterval(() => {
          void (async () => {
            if (progressCount >= this.maxProgressUpdates) {
              return;
            }
            progressCount += 1;
            await ctx.sendChatAction("typing").catch(() => undefined);
            if (!this.canEmitStatus(sessionKey)) {
              return;
            }
            const statusText = await this.buildStatusText({ includeRunPreview: false });
            await this.safeReply(ctx, `진행상황 업데이트\n${statusText}`, options);
          })();
        }, this.progressIntervalMs);

        const reply = await handler(incoming, text);
        if (reply) {
          await this.safeReply(ctx, reply, options);
        } else {
          await this.safeReply(ctx, "(응답이 비어 있습니다)", options);
        }
      } catch (error) {
        const message = String(error?.message || error || "telegram handler error");
        await this.safeReply(ctx, `처리 중 오류가 발생했습니다: ${message}`, options);
      } finally {
        if (progressTimer) {
          clearInterval(progressTimer);
        }
        const nowInFlight = toNumber(this.inFlightBySession.get(sessionKey), 1);
        if (nowInFlight <= 1) {
          this.inFlightBySession.delete(sessionKey);
        } else {
          this.inFlightBySession.set(sessionKey, nowInFlight - 1);
        }
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
  }
}
