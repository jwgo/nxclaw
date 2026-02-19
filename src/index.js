import { Command } from "commander";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "./config/load-config.js";
import { setupAuth, readAuthStatus, getSupportedProviders } from "./auth/setup-auth.js";
import { MemoryStore } from "./memory/memory-store.js";
import { ObjectiveQueue } from "./memory/objective-queue.js";
import { BackgroundTaskManager } from "./tasks/background-manager.js";
import { ChromeController } from "./controllers/chrome-controller.js";
import { SkillManager } from "./skills/skill-manager.js";
import { NxClawRuntime } from "./runtime/nxclaw-runtime.js";
import { AutonomousLoop } from "./runtime/autonomous-loop.js";
import { RuntimeEventBus } from "./runtime/event-bus.js";
import { runOnboarding } from "./onboarding/onboard.js";
import { SlackChannel } from "./channels/slack-channel.js";
import { TelegramChannel } from "./channels/telegram-channel.js";
import { createDashboardServer } from "./dashboard/server.js";

function isLoopbackHost(value) {
  const host = String(value || "").trim().toLowerCase();
  if (!host) {
    return false;
  }
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function previewText(value, max = 96) {
  const raw = String(value || "").replace(/\s+/g, " ").trim();
  if (!raw) {
    return "(empty)";
  }
  if (raw.length <= max) {
    return raw;
  }
  return `${raw.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

async function createRuntimeBundle() {
  const config = await loadConfig();

  const eventBus = new RuntimeEventBus({
    eventsPath: config.paths.eventsPath,
    bufferSize: config.diagnostics.eventBufferSize,
    enabled: config.diagnostics.enabled,
  });
  await eventBus.init();

  const memoryStore = new MemoryStore({
    rawPath: config.paths.memoryRawPath,
    compactPath: config.paths.memoryCompactPath,
    soulMainPath: config.paths.soulMainPath,
    soulJournalDir: config.soulJournalDir,
    compactMarkdownDir: config.compactMdDir,
    memoryMainPath: config.paths.memoryMainPath,
    memoryDailyDir: config.paths.memoryDailyDir,
    memoryIndexPath: config.paths.memoryIndexPath,
    embeddingCachePath: config.paths.embeddingCachePath,
    sessionMemoryDir: config.paths.sessionMemoryDir,
    extraPaths: config.memory.extraPaths,
    sessionMemoryEnabled: config.memory.sessionMemoryEnabled,
    vector: config.memory.vector,
    search: config.memory.search,
  });

  const objectiveQueue = new ObjectiveQueue({
    path: config.paths.objectivesPath,
  });

  const backgroundManager = new BackgroundTaskManager({
    statePath: config.paths.tasksPath,
    logDir: config.logsDir,
    eventBus,
    maxConcurrentProcesses: config.runtime.maxConcurrentTasks,
    defaultRetryLimit: config.runtime.taskRetryLimit,
    defaultRetryDelayMs: config.runtime.taskRetryDelayMs,
    maxTasks: config.runtime.maxStoredTasks,
    maxFinishedTasks: config.runtime.maxFinishedTasks,
  });

  const skillManager = config.skills.enabled
    ? new SkillManager({
        registryPath: config.paths.skillsRegistryPath,
        installDir: config.paths.skillsInstallDir,
        workspaceDir: config.workspaceDir,
        codexSkillsDir: config.skills.codexSkillsDir,
        autoEnableOnInstall: config.skills.autoEnableOnInstall,
        maxCatalogEntries: config.skills.maxCatalogEntries,
        maxSkillFileBytes: config.skills.maxSkillFileBytes,
        maxInstallFiles: config.skills.maxInstallFiles,
        maxInstallBytes: config.skills.maxInstallBytes,
        installTimeoutMs: config.skills.installTimeoutMs,
        eventBus,
      })
    : null;
  if (skillManager) {
    await skillManager.init();
  }

  const chromeController = new ChromeController({
    mode: config.chrome.mode,
    cdpUrl: config.chrome.cdpUrl,
    cdpConnectTimeoutMs: config.chrome.cdpConnectTimeoutMs,
    cdpReuseExistingPage: config.chrome.cdpReuseExistingPage,
    cdpFallbackToLaunch: config.chrome.cdpFallbackToLaunch,
    headless: config.chrome.headless,
    executablePath: config.chrome.executablePath,
    screenshotDir: config.chrome.screenshotDir,
    maxSessions: config.chrome.maxSessions,
    eventBus,
  });

  const runtime = new NxClawRuntime({
    config,
    memoryStore,
    objectiveQueue,
    backgroundManager,
    chromeController,
    skillManager,
    eventBus,
  });

  return {
    config,
    runtime,
    objectiveQueue,
    eventBus,
    skillManager,
  };
}

const program = new Command();
program.name("nxclaw").description("NXClaw JS autonomous core runtime");

program
  .command("auth")
  .option("--provider <provider>", "google-gemini-cli | openai-codex | anthropic")
  .option("--status", "show auth status")
  .action(async (opts) => {
    const config = await loadConfig();
    const storage = AuthStorage.create(config.paths.authPath);

    if (opts.status) {
      const status = await readAuthStatus(storage);
      console.log(JSON.stringify(status, null, 2));
      return;
    }

    const provider = String(opts.provider || "").trim();
    if (!provider) {
      console.error(`provider is required. supported: ${getSupportedProviders().join(", ")}`);
      process.exit(1);
    }

    const result = await setupAuth({ provider, authStorage: storage });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  });

program
  .command("onboard")
  .option("--quick", "write defaults and bootstrap docs/soul without prompts")
  .action(async (opts) => {
    const config = await loadConfig();
    const storage = AuthStorage.create(config.paths.authPath);
    const result = await runOnboarding({
      config,
      authStorage: storage,
      opts: { quick: !!opts.quick },
    });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  });

program
  .command("status")
  .action(async () => {
    const { runtime, config } = await createRuntimeBundle();
    await runtime.init();
    const state = await runtime.getState({ autonomousLoop: null, includeEvents: true });
    const payload = {
      ...state,
      wiring: {
        homeDir: config.homeDir,
        workspaceDir: config.workspaceDir,
        stateDir: config.stateDir,
        agentDir: config.agentDir,
        skillsDir: config.paths.skillsInstallDir,
        memoryDir: config.memoryDir,
        chromeDir: config.chromeDir,
        docsDir: config.docsDir,
        chrome: {
          mode: config.chrome.mode,
          cdpUrl: config.chrome.cdpUrl,
          cdpConnectTimeoutMs: config.chrome.cdpConnectTimeoutMs,
          cdpReuseExistingPage: config.chrome.cdpReuseExistingPage,
          cdpFallbackToLaunch: config.chrome.cdpFallbackToLaunch,
          headless: config.chrome.headless,
          executablePathConfigured: !!config.chrome.executablePath,
          maxSessions: config.chrome.maxSessions,
        },
        runtime: config.runtime,
        autonomous: config.autonomous,
        memory: config.memory,
        skills: config.skills,
        dashboard: {
          host: config.dashboardHost,
          port: config.dashboardPort,
          tokenConfigured: !!config.dashboardToken,
        },
        channels: {
          slackConfigured: !!(config.slack.botToken && config.slack.appToken),
          telegramConfigured: !!config.telegram.botToken,
        },
      },
    };
    console.log(JSON.stringify(payload, null, 2));
    await runtime.shutdown();
  });

program
  .command("skills")
  .argument("<action>", "catalog | list | install | bootstrap | enable | disable | show | remove")
  .argument("[value]", "skill id or source")
  .option("--id <id>", "skill id override")
  .option("--source <source>", "install source (catalog id, local path, owner/repo[/path])")
  .option("--skills <ids>", "comma-separated skill ids (for bootstrap/install batch)")
  .option("--ids <ids>", "comma-separated skill ids (for enable/disable/remove batch)")
  .option("--all", "apply to all installed skills (for enable/disable/remove)")
  .option("--disable", "install but keep disabled")
  .option("--max-chars <num>", "max chars for show output", "3000")
  .action(async (action, value, opts) => {
    const { skillManager } = await createRuntimeBundle();
    if (!skillManager) {
      throw new Error("skills are disabled. set NXCLAW_SKILLS_ENABLED=true");
    }
    await skillManager.init();
    const parseIds = (raw) =>
      String(raw || "")
        .split(",")
        .map((item) => String(item || "").trim())
        .filter(Boolean);

    if (action === "catalog") {
      const items = await skillManager.refreshCatalog();
      console.log(JSON.stringify(items, null, 2));
      return;
    }

    if (action === "list") {
      console.log(JSON.stringify(skillManager.listInstalled(), null, 2));
      return;
    }

    if (action === "install") {
      const source = String(opts.source || value || "").trim();
      if (!source) {
        throw new Error("skill source is required");
      }
      const ids = String(opts.skills || "")
        .split(",")
        .map((item) => String(item || "").trim())
        .filter(Boolean);
      if (ids.length > 0) {
        const installed = [];
        for (const skillId of ids) {
          installed.push(
            await skillManager.installSkill({
              source,
              id: skillId,
              enable: !opts.disable,
            }),
          );
        }
        console.log(JSON.stringify({ source, installed }, null, 2));
        return;
      }
      const installed = await skillManager.installSkill({
        source,
        id: String(opts.id || "").trim(),
        enable: !opts.disable,
      });
      console.log(JSON.stringify(installed, null, 2));
      return;
    }

    if (action === "bootstrap") {
      const source = String(
        opts.source ||
          value ||
          process.env.NXCLAW_SKILLS_BOOTSTRAP_SOURCE ||
          "skills:vercel-labs/agent-skills",
      ).trim();
      if (!source) {
        throw new Error("bootstrap source is required");
      }
      const ids = String(
        opts.skills || process.env.NXCLAW_SKILLS_BOOTSTRAP_IDS || "web-design-guidelines",
      )
        .split(",")
        .map((item) => String(item || "").trim())
        .filter(Boolean);
      if (ids.length === 0) {
        throw new Error("at least one skill id is required. use --skills a,b");
      }

      const installed = [];
      for (const skillId of ids) {
        installed.push(
          await skillManager.installSkill({
            source,
            id: skillId,
            enable: !opts.disable,
          }),
        );
      }
      console.log(JSON.stringify({ source, installed }, null, 2));
      return;
    }

    if (action === "enable") {
      const targets = opts.all
        ? skillManager.listInstalled().map((item) => item.id)
        : parseIds(opts.ids || value);
      if (targets.length === 0) {
        throw new Error("skill id is required (or use --ids / --all)");
      }
      const unique = [...new Set(targets)];
      const result = [];
      for (const skillId of unique) {
        result.push(await skillManager.setSkillEnabled(skillId, true));
      }
      console.log(JSON.stringify({ enabled: result.map((item) => item.id), count: result.length }, null, 2));
      return;
    }

    if (action === "disable") {
      const targets = opts.all
        ? skillManager.listInstalled().map((item) => item.id)
        : parseIds(opts.ids || value);
      if (targets.length === 0) {
        throw new Error("skill id is required (or use --ids / --all)");
      }
      const unique = [...new Set(targets)];
      const result = [];
      for (const skillId of unique) {
        result.push(await skillManager.setSkillEnabled(skillId, false));
      }
      console.log(
        JSON.stringify({ disabled: result.map((item) => item.id), count: result.length }, null, 2),
      );
      return;
    }

    if (action === "show") {
      if (!value) {
        throw new Error("skill id is required");
      }
      const item = await skillManager.readSkill(value, Number(opts.maxChars || 3000));
      if (!item) {
        throw new Error(`skill not found: ${value}`);
      }
      console.log(JSON.stringify(item, null, 2));
      return;
    }

    if (action === "remove") {
      const targets = opts.all
        ? skillManager.listInstalled().map((item) => item.id)
        : parseIds(opts.ids || value);
      if (targets.length === 0) {
        throw new Error("skill id is required (or use --ids / --all)");
      }
      const unique = [...new Set(targets)];
      const rows = [];
      for (const skillId of unique) {
        rows.push({ skillId, removed: await skillManager.removeSkill(skillId) });
      }
      console.log(
        JSON.stringify(
          {
            removed: rows.filter((row) => row.removed).map((row) => row.skillId),
            failed: rows.filter((row) => !row.removed).map((row) => row.skillId),
            count: rows.length,
          },
          null,
          2,
        ),
      );
      return;
    }

    throw new Error(`Unknown skills action: ${action}`);
  });

program
  .command("objective")
  .argument("<action>", "add | list | update")
  .argument("[value]", "objective title for add, objective id for update")
  .option("--priority <num>", "priority 1..5", "3")
  .option("--description <text>", "description")
  .option("--status <status>", "pending|in_progress|blocked|completed|failed|cancelled")
  .option("--notes <text>", "update notes")
  .action(async (action, value, opts) => {
    const { objectiveQueue } = await createRuntimeBundle();
    await objectiveQueue.init();

    if (action === "add") {
      if (!value) {
        throw new Error("objective title is required");
      }
      const objective = await objectiveQueue.add({
        title: value,
        description: opts.description || "",
        priority: Number(opts.priority || 3),
      });
      console.log(JSON.stringify(objective, null, 2));
      return;
    }

    if (action === "list") {
      const list = objectiveQueue.list({ status: opts.status || undefined });
      console.log(JSON.stringify(list, null, 2));
      return;
    }

    if (action === "update") {
      if (!value || !opts.status) {
        throw new Error("objective id and --status are required");
      }
      const updated = await objectiveQueue.update({
        id: value,
        status: opts.status,
        notes: opts.notes || "",
      });
      console.log(JSON.stringify(updated, null, 2));
      return;
    }

    throw new Error(`Unknown objective action: ${action}`);
  });

program
  .command("start")
  .option("--once <message>", "single prompt run")
  .option("--no-slack", "disable Slack")
  .option("--no-telegram", "disable Telegram")
  .option("--no-dashboard", "disable dashboard")
  .action(async (opts) => {
    const { config, runtime, objectiveQueue, eventBus } = await createRuntimeBundle();
    await runtime.init();

    const autonomousLoop = new AutonomousLoop({
      runtime,
      objectiveQueue,
      autoConfig: config.autonomous,
      eventBus,
    });

    const channels = [];
    let dashboardServer = null;
    const runOnce = typeof opts.once === "string" && opts.once.trim().length > 0;

    const slackEnabled = opts.slack !== false;
    const telegramEnabled = opts.telegram !== false;
    const dashboardEnabled = opts.dashboard !== false;

    console.log(
      `[nxclaw] runtime initialized provider=${config.defaultProvider} model=${config.defaultModel || "(auto)"}`,
    );
    console.log(
      `[nxclaw] startup flags slack=${slackEnabled ? "on" : "off"} telegram=${telegramEnabled ? "on" : "off"} dashboard=${dashboardEnabled ? "on" : "off"} autonomous=${config.autonomous.enabled ? "on" : "off"}`,
    );

    const startDashboard = async () => {
      if (!dashboardEnabled) {
        console.log("[nxclaw] dashboard disabled (--no-dashboard)");
        return;
      }

      try {
        let bindHost = String(config.dashboardHost || "127.0.0.1").trim() || "127.0.0.1";
        const hasToken = !!String(config.dashboardToken || "").trim();
        if (!isLoopbackHost(bindHost) && !hasToken) {
          const warning = `dashboard host '${bindHost}' requires NXCLAW_DASHBOARD_TOKEN. falling back to 127.0.0.1`;
          eventBus.emit("channel.start.warn", { channel: "dashboard", warning });
          console.warn(`[nxclaw] ${warning}`);
          bindHost = "127.0.0.1";
        }
        const app = createDashboardServer({ runtime, autonomousLoop, eventBus });
        dashboardServer = app.listen(config.dashboardPort, bindHost, () => {
          console.log(`[nxclaw] dashboard listening: http://${bindHost}:${config.dashboardPort}`);
        });
        dashboardServer.on("error", (error) => {
          const message = String(error?.message || error || "dashboard server error");
          runtime.setChannelHealth("dashboard", false);
          eventBus.emit("channel.runtime.error", { channel: "dashboard", error: message });
          console.error(`[nxclaw] dashboard runtime error: ${message}`);
        });
        runtime.setChannelHealth("dashboard", true);
      } catch (error) {
        runtime.setChannelHealth("dashboard", false);
        const message = String(error?.message || error || "dashboard start failed");
        eventBus.emit("channel.start.error", { channel: "dashboard", error: message });
        console.error(`[nxclaw] dashboard start failed: ${message}`);
      }
    };

    await startDashboard();

    if (slackEnabled && config.slack.botToken && config.slack.appToken) {
      try {
        const slack = new SlackChannel(config.slack);
        await slack.start(async (incoming, text) => {
          console.log(
            `[nxclaw][slack] incoming channel=${incoming.channelId} session=${incoming.sessionId || "default"} text="${previewText(text)}"`,
          );
          const reply = await runtime.handleIncoming(incoming, text);
          console.log(`[nxclaw][slack] reply chars=${String(reply || "").length}`);
          return reply;
        });
        runtime.setChannelHealth("slack", true);
        channels.push(slack);
        console.log("[nxclaw] slack channel online");
      } catch (error) {
        runtime.setChannelHealth("slack", false);
        const message = String(error?.message || error || "slack start failed");
        eventBus.emit("channel.start.error", { channel: "slack", error: message });
        console.error(`[nxclaw] slack start failed: ${message}`);
      }
    } else if (slackEnabled) {
      console.warn("[nxclaw] slack skipped: NXCLAW_SLACK_BOT_TOKEN / NXCLAW_SLACK_APP_TOKEN missing");
    }

    if (telegramEnabled && config.telegram.botToken) {
      try {
        const telegram = new TelegramChannel({
          ...config.telegram,
          statusProvider: async () => {
            return await runtime.getState({ autonomousLoop, includeEvents: true });
          },
        });
        await telegram.start(async (incoming, text) => {
          console.log(
            `[nxclaw][telegram] incoming channel=${incoming.channelId} session=${incoming.sessionId || "default"} text="${previewText(text)}"`,
          );
          const reply = await runtime.handleIncoming(incoming, text);
          console.log(`[nxclaw][telegram] reply chars=${String(reply || "").length}`);
          return reply;
        });
        runtime.setChannelHealth("telegram", true);
        channels.push(telegram);
        console.log("[nxclaw] telegram channel online");
      } catch (error) {
        runtime.setChannelHealth("telegram", false);
        const message = String(error?.message || error || "telegram start failed");
        eventBus.emit("channel.start.error", { channel: "telegram", error: message });
        console.error(`[nxclaw] telegram start failed: ${message}`);
      }
    } else if (telegramEnabled) {
      console.warn("[nxclaw] telegram skipped: NXCLAW_TELEGRAM_BOT_TOKEN missing");
    }

    runtime.setChannelHealth("autonomous", !runOnce && config.autonomous.enabled);
    if (!runOnce && config.autonomous.enabled) {
      autonomousLoop.start();
      console.log(
        `[nxclaw] autonomous loop started intervalMs=${config.autonomous.intervalMs} goal="${previewText(config.autonomous.goal, 140)}"`,
      );
    } else if (!runOnce) {
      console.log("[nxclaw] autonomous loop is disabled");
    }

    const watchdog = setInterval(() => {
      try {
        const health = runtime.backgroundManager.getHealth();
        eventBus.emit("runtime.watchdog", {
          queueDepth: runtime.getQueueDepth(),
          taskQueueDepth: health.queueDepth,
          runningTasks: health.running,
          sessionLanes: runtime.sessionByLane.size,
        });
        console.log(
          `[nxclaw] watchdog queue=${runtime.getQueueDepth()} taskQueue=${health.queueDepth} runningTasks=${health.running} sessionLanes=${runtime.sessionByLane.size}`,
        );
        if (typeof runtime.enforceSessionLimits === "function") {
          void runtime.enforceSessionLimits().catch((error) => {
            eventBus.emit("runtime.watchdog.error", {
              error: String(error?.message || error || "session limit check failed"),
            });
          });
        }
      } catch (error) {
        eventBus.emit("runtime.watchdog.error", {
          error: String(error?.message || error || "watchdog failed"),
        });
      }
    }, 15000);

    const closeDashboard = async () => {
      if (!dashboardServer) {
        return;
      }
      await new Promise((resolve) => {
        dashboardServer.close(() => resolve());
      });
      dashboardServer = null;
    };

    if (runOnce) {
      const reply = await runtime.handleIncoming(
        {
          source: "cli",
          channelId: "cli",
          userId: "local",
        },
        opts.once,
      );
      console.log(reply);
      clearInterval(watchdog);
      autonomousLoop.stop();
      for (const channel of channels) {
        await channel.stop();
      }
      await closeDashboard();
      await runtime.shutdown();
      return;
    }

    const graceful = async (exitCode = null) => {
      clearInterval(watchdog);
      autonomousLoop.stop();
      for (const channel of channels) {
        await channel.stop();
      }
      await closeDashboard();
      await runtime.shutdown();
      if (Number.isInteger(exitCode)) {
        process.exit(exitCode);
      }
    };

    let fatalInProgress = false;
    const fatalShutdown = async (kind, error) => {
      if (fatalInProgress) {
        return;
      }
      fatalInProgress = true;
      const message = String(error?.stack || error?.message || error || "uncaught");
      eventBus.emit("runtime.fatal", { kind, error: message });
      console.error(`[nxclaw] ${kind}:`, message);
      try {
        await graceful();
      } catch (shutdownError) {
        const shutdownMsg = String(
          shutdownError?.stack || shutdownError?.message || shutdownError || "fatal shutdown failed",
        );
        console.error("[nxclaw] fatal shutdown error:", shutdownMsg);
      } finally {
        process.exit(1);
      }
    };

    process.on("uncaughtException", (error) => {
      void fatalShutdown("uncaughtException", error);
    });

    process.on("unhandledRejection", (reason) => {
      void fatalShutdown("unhandledRejection", reason);
    });

    process.on("SIGINT", () => {
      void graceful(0);
    });
    process.on("SIGTERM", () => {
      void graceful(0);
    });

    await new Promise(() => undefined);
  });

program.parse(process.argv);
