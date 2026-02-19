import { Telegraf } from "telegraf";
import fs from "node:fs/promises";
import path from "node:path";
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

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".webm"]);
const FILE_PATH_PATTERN =
  /(?:^|[\s(`'"])((?:\/|\.\/|\.\.\/)[^\s`"'\\)\]]+\.[A-Za-z0-9]{1,8})(?=$|[\s`"'),\]])/g;
const MARKDOWN_LINK_PATTERN = /\[[^\]]*]\(((?:\/|\.\/|\.\.\/)[^\s)]+\.[A-Za-z0-9]{1,8})\)/g;
const MAX_FILES_PER_REPLY = 4;

async function pathExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function extOf(filePath) {
  return String(path.extname(String(filePath || "")) || "").toLowerCase();
}

function normalizeCandidatePath(value) {
  return String(value || "")
    .trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/[),.;:]+$/g, "");
}

function collectFileCandidates(text) {
  const raw = String(text || "");
  const out = [];
  const seen = new Set();

  let match = null;
  while ((match = FILE_PATH_PATTERN.exec(raw)) !== null) {
    const candidate = normalizeCandidatePath(match[1]);
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    out.push(candidate);
  }

  while ((match = MARKDOWN_LINK_PATTERN.exec(raw)) !== null) {
    const candidate = normalizeCandidatePath(match[1]);
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    out.push(candidate);
  }

  return out.slice(0, MAX_FILES_PER_REPLY);
}

function summarizeTelegramAttachments(message) {
  const out = [];
  const msg = message && typeof message === "object" ? message : {};

  if (msg.document) {
    out.push(
      `- document: name=${msg.document.file_name || "(unknown)"} mime=${msg.document.mime_type || "(unknown)"} size=${msg.document.file_size || 0} file_id=${msg.document.file_id || ""}`,
    );
  }
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const photo = msg.photo[msg.photo.length - 1];
    out.push(
      `- photo: ${photo?.width || 0}x${photo?.height || 0} size=${photo?.file_size || 0} file_id=${photo?.file_id || ""}`,
    );
  }
  if (msg.video) {
    out.push(
      `- video: ${msg.video.width || 0}x${msg.video.height || 0} duration=${msg.video.duration || 0}s size=${msg.video.file_size || 0} file_id=${msg.video.file_id || ""}`,
    );
  }
  if (msg.audio) {
    out.push(
      `- audio: title=${msg.audio.title || ""} performer=${msg.audio.performer || ""} duration=${msg.audio.duration || 0}s size=${msg.audio.file_size || 0} file_id=${msg.audio.file_id || ""}`,
    );
  }
  if (msg.voice) {
    out.push(
      `- voice: duration=${msg.voice.duration || 0}s size=${msg.voice.file_size || 0} file_id=${msg.voice.file_id || ""}`,
    );
  }
  if (msg.animation) {
    out.push(
      `- animation: ${msg.animation.width || 0}x${msg.animation.height || 0} duration=${msg.animation.duration || 0}s size=${msg.animation.file_size || 0} file_id=${msg.animation.file_id || ""}`,
    );
  }
  if (msg.sticker) {
    out.push(`- sticker: emoji=${msg.sticker.emoji || ""} file_id=${msg.sticker.file_id || ""}`);
  }

  return out;
}

function buildIncomingUserText(message) {
  const msg = message && typeof message === "object" ? message : {};
  const text = String(msg.text || msg.caption || "").trim();
  const attachments = summarizeTelegramAttachments(msg);

  if (attachments.length === 0) {
    return text;
  }

  return [
    text || "(no text)",
    "",
    "[telegram attachments]",
    ...attachments,
  ].join("\n");
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
    this.maxProgressUpdates = Number.isFinite(Number(maxProgressUpdates))
      ? Math.max(0, Number(maxProgressUpdates))
      : 0;
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

  async sendFileTarget(target, filePath) {
    if (!this.bot || !target?.chatId) {
      return { ok: false, reason: "bot_or_chat_missing", path: filePath };
    }

    const resolved = path.resolve(String(filePath || ""));
    if (!(await pathExists(resolved))) {
      return { ok: false, reason: "file_not_found", path: resolved };
    }

    const ext = extOf(resolved);
    try {
      if (IMAGE_EXT.has(ext)) {
        await this.bot.telegram.sendPhoto(
          target.chatId,
          { source: resolved },
          {
            ...(target.options || {}),
            caption: path.basename(resolved),
          },
        );
        return { ok: true, kind: "photo", path: resolved };
      }

      if (VIDEO_EXT.has(ext)) {
        await this.bot.telegram.sendVideo(
          target.chatId,
          { source: resolved },
          {
            ...(target.options || {}),
            caption: path.basename(resolved),
          },
        );
        return { ok: true, kind: "video", path: resolved };
      }

      await this.bot.telegram.sendDocument(
        target.chatId,
        { source: resolved },
        {
          ...(target.options || {}),
          caption: path.basename(resolved),
        },
      );
      return { ok: true, kind: "document", path: resolved };
    } catch (error) {
      return {
        ok: false,
        reason: String(error?.message || error || "telegram_send_failed"),
        path: resolved,
      };
    }
  }

  async maybeSendFilesFromReply(target, replyText) {
    const candidates = collectFileCandidates(replyText);
    if (candidates.length === 0) {
      return { sent: 0, attempted: 0, failed: [] };
    }

    let sent = 0;
    const failed = [];
    for (const candidate of candidates) {
      const result = await this.sendFileTarget(target, candidate);
      if (result?.ok) {
        sent += 1;
      } else {
        failed.push({
          path: result?.path || candidate,
          reason: result?.reason || "unknown",
        });
      }
    }
    return { sent, attempted: candidates.length, failed };
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
        const fileResult = await this.maybeSendFilesFromReply(target, reply);
        if (fileResult.sent > 0) {
          await this.safeReplyTarget(
            target,
            `파일 ${fileResult.sent}개를 전송했습니다.${fileResult.attempted > fileResult.sent ? ` (실패 ${fileResult.attempted - fileResult.sent}개)` : ""}`,
          );
        } else if (fileResult.attempted > 0) {
          const first = fileResult.failed[0];
          await this.safeReplyTarget(
            target,
            `파일 전송을 시도했지만 실패했습니다. path=${first?.path || "(unknown)"} reason=${first?.reason || "unknown"}`,
          );
        }
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

    this.bot.on("message", async (ctx, next) => {
      if (!ctx.message || !ctx.chat?.id) {
        return next();
      }

      const commandText = String(ctx.message?.text || "").trim();
      const text = buildIncomingUserText(ctx.message);
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

      if (isHelpCommand(commandText)) {
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

      if (isStatusCommand(commandText)) {
        if (!this.canEmitStatus(sessionKey)) {
          await this.safeReply(ctx, "status 요청이 너무 빠릅니다. 잠시 후 다시 시도해주세요.", options);
          return next();
        }
        const statusText = await this.buildStatusText({ includeRunPreview: true });
        await this.safeReply(ctx, statusText, options);
        return next();
      }

      if (!text) {
        await this.safeReplyTarget(
          replyTarget,
          "텍스트/첨부를 인식하지 못했습니다. 텍스트나 파일 설명을 함께 보내주세요.",
        );
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
