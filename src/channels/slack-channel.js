import { App } from "@slack/bolt";
import { createIncomingMessage } from "./channel-types.js";

function clean(text, max = 3800) {
  return String(text ?? "").replace(/[<>]/g, "").slice(0, max);
}

export class SlackChannel {
  constructor({ botToken, appToken, signingSecret, allowedChannels = [] }) {
    this.botToken = botToken;
    this.appToken = appToken;
    this.signingSecret = signingSecret;
    this.allowedChannels = allowedChannels;
    this.app = null;
    this.started = false;
  }

  isHealthy() {
    return this.started;
  }

  async start(handler) {
    if (!this.botToken || !this.appToken) {
      throw new Error("Slack token missing: NXCLAW_SLACK_BOT_TOKEN and NXCLAW_SLACK_APP_TOKEN are required");
    }

    this.app = new App({
      token: this.botToken,
      appToken: this.appToken,
      signingSecret: this.signingSecret,
      socketMode: true,
    });

    this.app.message(async ({ message, logger }) => {
      try {
        if (!message || typeof message !== "object") {
          return;
        }

        if ("bot_id" in message || ("subtype" in message && message.subtype)) {
          return;
        }

        const text = message.text;
        const channelId = message.channel;
        if (typeof text !== "string" || typeof channelId !== "string") {
          return;
        }

        if (
          Array.isArray(this.allowedChannels) &&
          this.allowedChannels.length > 0 &&
          !this.allowedChannels.includes(channelId)
        ) {
          return;
        }

        const userId = typeof message.user === "string" ? message.user : "unknown";
        const threadTs = typeof message.thread_ts === "string" ? message.thread_ts : "";
        const sessionId = threadTs ? `thread-${threadTs}` : `user-${userId}`;

        const incoming = createIncomingMessage({
          source: "slack",
          channelId,
          userId,
          sessionId,
        });

        const reply = await handler(incoming, text);
        if (reply && this.app) {
          const payload = {
            channel: channelId,
            text: clean(reply),
          };
          if (threadTs) {
            payload.thread_ts = threadTs;
          }
          await this.app.client.chat.postMessage(payload);
        }
      } catch (error) {
        logger.error(error);
      }
    });

    await this.app.start();
    this.started = true;
  }

  async send(channelId, text) {
    if (!this.app || !channelId) {
      return;
    }

    await this.app.client.chat.postMessage({
      channel: channelId,
      text: clean(text),
    });
  }

  async stop() {
    if (!this.app) {
      return;
    }

    await this.app.stop();
    this.started = false;
    this.app = null;
  }
}
