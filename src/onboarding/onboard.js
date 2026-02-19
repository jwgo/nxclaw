import path from "node:path";
import { askText } from "../utils/prompt.js";
import {
  ensureDir,
  fileExists,
  readJsonOrDefault,
  readTextOrDefault,
  writeJson,
  writeText,
} from "../utils/fs.js";
import { setupAuth } from "../auth/setup-auth.js";

const PROVIDERS = ["google-gemini-cli", "openai-codex", "anthropic"];
const CHANNELS = ["web", "telegram", "slack"];
const DEFAULT_AUTO_GOAL =
  "Autonomously recover stalled tasks, clean up dead background jobs, compact memory, and continuously advance top-priority objectives with concrete progress updates.";
const ENV_BLOCK_START = "# >>> nxclaw onboarding >>>";
const ENV_BLOCK_END = "# <<< nxclaw onboarding <<<";

function toBool(value, fallback = false) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  if (["y", "yes", "1", "true", "on"].includes(raw)) {
    return true;
  }
  if (["n", "no", "0", "false", "off"].includes(raw)) {
    return false;
  }
  return fallback;
}

function toNumber(value, fallback) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function pickProvider(input, fallback) {
  const normalized = String(input ?? "").trim();
  if (PROVIDERS.includes(normalized)) {
    return normalized;
  }
  return fallback;
}

function pickChannels(input, fallback = []) {
  const raw = String(input ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const next = raw.length > 0 ? raw : fallback;
  const unique = [...new Set(next)];
  const accepted = unique.filter((item) => CHANNELS.includes(item));
  if (accepted.length === 0) {
    return ["web"];
  }
  return accepted;
}

function parseEnvMap(raw) {
  const map = {};
  const text = String(raw || "");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const idx = trimmed.indexOf("=");
    if (idx <= 0) {
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    map[key] = value;
  }
  return map;
}

function envLine(key, value) {
  return `${key}=${JSON.stringify(String(value ?? ""))}`;
}

function buildOnboardingEnvBlock({
  provider,
  dashboardHost,
  dashboardPort,
  autoEnabled,
  autoGoal,
  autoIntervalMs,
  stalePendingHours,
  staleInProgressIdleHours,
  channels,
  telegramToken,
  slackBotToken,
  slackAppToken,
  slackSigningSecret,
  slackAllowedChannels,
}) {
  const hasTelegram = channels.includes("telegram");
  const hasSlack = channels.includes("slack");
  const hasWeb = channels.includes("web");

  const lines = [
    ENV_BLOCK_START,
    `# generated: ${new Date().toISOString()}`,
    "# provider / runtime",
    envLine("NXCLAW_DEFAULT_PROVIDER", provider),
    envLine("NXCLAW_DASHBOARD_HOST", hasWeb ? dashboardHost : "127.0.0.1"),
    envLine("NXCLAW_DASHBOARD_PORT", dashboardPort),
    envLine("NXCLAW_AUTO_ENABLED", autoEnabled ? "true" : "false"),
    envLine("NXCLAW_AUTO_GOAL", autoGoal || ""),
    envLine("NXCLAW_AUTO_INTERVAL_MS", autoIntervalMs),
    envLine("NXCLAW_AUTO_STALE_PENDING_HOURS", stalePendingHours),
    envLine("NXCLAW_AUTO_STALE_IN_PROGRESS_IDLE_HOURS", staleInProgressIdleHours),
    envLine("NXCLAW_CHANNELS", channels.join(",")),
    "",
    "# channels",
    envLine("NXCLAW_TELEGRAM_BOT_TOKEN", hasTelegram ? telegramToken : ""),
    envLine("NXCLAW_SLACK_BOT_TOKEN", hasSlack ? slackBotToken : ""),
    envLine("NXCLAW_SLACK_APP_TOKEN", hasSlack ? slackAppToken : ""),
    envLine("NXCLAW_SLACK_SIGNING_SECRET", hasSlack ? slackSigningSecret : ""),
    envLine("NXCLAW_SLACK_CHANNELS", hasSlack ? slackAllowedChannels : ""),
    "",
    "# note:",
    "# - web dashboard is enabled by default unless you start with --no-dashboard",
    "# - telegram/slack require valid tokens",
    ENV_BLOCK_END,
  ];

  return lines.join("\n");
}

function mergeOnboardingEnvSection(existingRaw, sectionText) {
  const raw = String(existingRaw || "").trimEnd();
  const start = raw.indexOf(ENV_BLOCK_START);
  const end = raw.indexOf(ENV_BLOCK_END);

  if (start >= 0 && end >= start) {
    const before = raw.slice(0, start).trimEnd();
    const after = raw.slice(end + ENV_BLOCK_END.length).trimStart();
    const parts = [before, sectionText, after].filter((item) => String(item || "").trim().length > 0);
    return `${parts.join("\n\n")}\n`;
  }

  if (!raw) {
    return `${sectionText}\n`;
  }
  return `${raw}\n\n${sectionText}\n`;
}

function makeRunbook(config, workspacePaths = null) {
  const paths = workspacePaths || config.paths;
  return [
    "# NXClaw Runbook",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Runtime Paths",
    `- home: ${config.homeDir}`,
    `- workspace: ${workspacePaths ? workspacePaths.workspace : config.workspaceDir}`,
    `- auth: ${config.paths.authPath}`,
    `- skills install dir: ${config.paths.skillsInstallDir}`,
    `- skills registry: ${config.paths.skillsRegistryPath}`,
    `- memory main: ${paths.memoryMainPath}`,
    `- memory daily dir: ${paths.memoryDailyDir}`,
    `- memory sessions dir: ${paths.sessionMemoryDir ?? config.paths.sessionMemoryDir}`,
    `- memory raw: ${config.paths.memoryRawPath}`,
    `- chrome profile: ${config.chromeDir}`,
    `- chrome screenshots: ${config.chrome.screenshotDir}`,
    `- soul: ${paths.soulMainPath}`,
    `- bootstrap: ${paths.bootstrapPath}`,
    `- heartbeat: ${paths.heartbeatPath}`,
    `- identity: ${paths.identityPath}`,
    `- docs: ${config.docsDir}`,
    `- objectives: ${config.paths.objectivesPath}`,
    `- tasks: ${config.paths.tasksPath}`,
    `- events: ${config.paths.eventsPath}`,
    "",
    "## Start Commands",
    "- npm run auth -- --status",
    "- npm run skills -- catalog",
    "- npm run skills -- list",
    "- npm run start",
    "- npm run status",
    "- npm run objective -- list",
    "",
    "## Core Flows",
    "1. Add objective",
    "2. Start runtime",
    "3. Watch dashboard events",
    "4. Update objective status as work progresses",
    "",
    "## Reliability Tips",
    "- Keep `NXCLAW_AUTO_ENABLED=true` for continuous work.",
    "- Set a precise `NXCLAW_AUTO_GOAL` for better autonomous output.",
    "- Use `nx_terminal_schedule` for recurring command checks.",
    "- Use memory soul notes for durable long-term context.",
    "- Install and enable skills for repeatable high-level workflows.",
    "",
  ].join("\n");
}

function makeStartHere(config) {
  return [
    "# START HERE",
    "",
    "## 1) Verify auth",
    "```bash",
    "npm run auth -- --status",
    "```",
    "",
    "## 2) Optional objective",
    "```bash",
    "npm run objective -- add \"First autonomous mission\" --priority 2",
    "```",
    "",
    "## 3) Optional skills",
    "```bash",
    "npm run skills -- catalog",
    "npm run skills -- install <catalog-id-or-source>",
    "npm run skills -- enable <skill-id>",
    "```",
    "",
    "## 4) Start runtime",
    "```bash",
    "npm run start",
    "```",
    "",
    `Dashboard: http://localhost:${config.dashboardPort}`,
    "",
    "## 5) Monitor",
    "- Watch dashboard event stream panel",
    "- Check objective queue status",
    "- Use terminal/chrome tools for concrete actions",
    "",
  ].join("\n");
}

function makeSoulSeed() {
  return [
    "# NXClaw Soul",
    "",
    "## Identity",
    "- You are nxclaw, a persistent autonomous execution agent.",
    "- You maximize continuity and concrete results.",
    "",
    "## Execution Doctrine",
    "- Prefer tool actions over abstract replies.",
    "- Track objective status precisely.",
    "- Keep long-term memory compact and structured.",
    "",
    "## Operator Preferences",
    "- (Fill this section with human preferences)",
    "",
    "## Long-Term Missions",
    "- (List durable missions and quality bars)",
    "",
  ].join("\n");
}

function makeMemorySeed() {
  return [
    "# MEMORY",
    "",
    "## Stable Decisions",
    "- (durable decisions are recorded here)",
    "",
    "## Preferences",
    "- (operator/user preferences are recorded here)",
    "",
    "## Long-Term Facts",
    "- (persistent operational facts are recorded here)",
    "",
  ].join("\n");
}

function makeIdentitySeed() {
  return [
    "# IDENTITY",
    "",
    "- Project: nxclaw",
    "- Runtime: JS-only autonomous multi-tool agent",
    "- Core objective: continuously execute large tasks with durable memory continuity",
    "",
  ].join("\n");
}

function makeBootstrapSeed() {
  return [
    "# BOOTSTRAP",
    "",
    "1. Read IDENTITY.md, USER.md, TOOLS.md, MEMORY.md, and today's memory log.",
    "2. Load active objectives and running tasks.",
    "3. Continue highest-priority in-progress objective.",
    "4. Persist durable findings to MEMORY.md and daily logs.",
    "",
  ].join("\n");
}

function makeHeartbeatSeed() {
  return [
    "# HEARTBEAT",
    "",
    "- Check objective queue and running background tasks.",
    "- Verify Slack/Telegram/dashboard status.",
    "- If no pending objective, run one maintenance action.",
    "- Persist durable updates to memory files.",
    "",
  ].join("\n");
}

function makeToolsSeed() {
  return [
    "# TOOLS",
    "",
    "- terminal: execute/start/schedule/list/stop/logs/health",
    "- chrome: session open/navigate/snapshot/click_ref/type_ref/click/type/wait/extract/eval/screenshot/close",
    "- web dashboard: live chat sessions/new-session/archive, settings edit, memory search/note/compact/sync",
    "- memory: search/note/compact/soul/sync/status",
    "- objective: add/list/update",
    "",
  ].join("\n");
}

function makeUserSeed() {
  return [
    "# USER",
    "",
    "- Preferred channels: Slack, Telegram",
    "- Preferred operation mode: fully autonomous with strong continuity",
    "- Critical requirement: robust long-term memory and memory compaction",
    "",
  ].join("\n");
}

function makeAgentsSeed() {
  return [
    "# AGENTS",
    "",
    "- Primary runtime: nxclaw",
    "- Language: JavaScript only",
    "- Key constraints:",
    "  - keep objectives current",
    "  - avoid duplicate running tasks",
    "  - keep memory files as source of truth",
    "",
  ].join("\n");
}

export async function runOnboarding({ config, authStorage, opts = {} }) {
  const existing = await readJsonOrDefault(config.paths.configPath, {});
  const quick = !!opts.quick;
  const envPath = path.join(process.cwd(), ".env");
  const envRaw = await readTextOrDefault(envPath, "");
  const envMap = parseEnvMap(envRaw);

  let workspace = config.workspaceDir;
  let provider = config.defaultProvider;
  let dashboardHost = config.dashboardHost;
  let dashboardPort = config.dashboardPort;
  let autoEnabled = config.autonomous.enabled;
  let autoGoal = String(config.autonomous.goal || "").trim() || DEFAULT_AUTO_GOAL;
  let autoIntervalMs = config.autonomous.intervalMs;
  let stalePendingHours = config.autonomous.stalePendingHours || 24 * 14;
  let staleInProgressIdleHours = config.autonomous.staleInProgressIdleHours || 24 * 3;
  let channels = pickChannels(
    envMap.NXCLAW_CHANNELS ||
      [
        "web",
        envMap.NXCLAW_TELEGRAM_BOT_TOKEN ? "telegram" : "",
        envMap.NXCLAW_SLACK_BOT_TOKEN && envMap.NXCLAW_SLACK_APP_TOKEN ? "slack" : "",
      ]
        .filter(Boolean)
        .join(","),
    ["web"],
  );
  let telegramToken =
    process.env.NXCLAW_TELEGRAM_BOT_TOKEN ||
    envMap.NXCLAW_TELEGRAM_BOT_TOKEN ||
    config.telegram.botToken ||
    "";
  let slackBotToken =
    process.env.NXCLAW_SLACK_BOT_TOKEN ||
    envMap.NXCLAW_SLACK_BOT_TOKEN ||
    config.slack.botToken ||
    "";
  let slackAppToken =
    process.env.NXCLAW_SLACK_APP_TOKEN ||
    envMap.NXCLAW_SLACK_APP_TOKEN ||
    config.slack.appToken ||
    "";
  let slackSigningSecret =
    process.env.NXCLAW_SLACK_SIGNING_SECRET ||
    envMap.NXCLAW_SLACK_SIGNING_SECRET ||
    config.slack.signingSecret ||
    "";
  let slackAllowedChannels =
    envMap.NXCLAW_SLACK_CHANNELS ||
    (Array.isArray(config.slack.allowedChannels) ? config.slack.allowedChannels.join(",") : "");

  if (!quick) {
    const workspaceInput = await askText(`Workspace path [${workspace}] :`);
    if (workspaceInput) {
      workspace = workspaceInput;
    }

    const providerInput = await askText(
      `Default provider (${PROVIDERS.join("|")}) [${provider}] :`,
    );
    provider = pickProvider(providerInput, provider);

    const channelsInput = await askText(
      `Enable channels (web,telegram,slack) [${channels.join(",")}] :`,
    );
    channels = pickChannels(channelsInput, channels);

    const dashboardHostInput = await askText(`Dashboard host [${dashboardHost}] :`);
    if (dashboardHostInput) {
      dashboardHost = String(dashboardHostInput).trim() || dashboardHost;
    }

    const dashboardInput = await askText(`Dashboard port [${dashboardPort}] :`);
    dashboardPort = Math.max(1, toNumber(dashboardInput, dashboardPort));

    const autoEnabledInput = await askText(
      `Enable autonomous loop? (y/n) [${autoEnabled ? "y" : "n"}] :`,
    );
    autoEnabled = toBool(autoEnabledInput, autoEnabled);

    const autoGoalInput = await askText(`Autonomous default goal [${autoGoal}] :`);
    if (String(autoGoalInput || "").trim()) {
      autoGoal = String(autoGoalInput).trim();
    }

    const autoIntervalInput = await askText(`Autonomous interval ms [${autoIntervalMs}] :`);
    autoIntervalMs = Math.max(5000, toNumber(autoIntervalInput, autoIntervalMs));

    if (channels.includes("telegram")) {
      const tgHint = telegramToken ? "<configured>" : "(required)";
      const tgInput = await askText(`Telegram bot token [${tgHint}] :`);
      if (tgInput) {
        telegramToken = tgInput.trim();
      }
    } else {
      telegramToken = "";
    }

    if (channels.includes("slack")) {
      const slackBotHint = slackBotToken ? "<configured>" : "(required)";
      const slackAppHint = slackAppToken ? "<configured>" : "(required)";
      const slackBotInput = await askText(`Slack bot token [${slackBotHint}] :`);
      if (slackBotInput) {
        slackBotToken = slackBotInput.trim();
      }

      const slackAppInput = await askText(`Slack app token [${slackAppHint}] :`);
      if (slackAppInput) {
        slackAppToken = slackAppInput.trim();
      }

      const slackSecretHint = slackSigningSecret ? "<configured>" : "(optional)";
      const slackSecretInput = await askText(`Slack signing secret [${slackSecretHint}] :`);
      if (slackSecretInput) {
        slackSigningSecret = slackSecretInput.trim();
      }

      const slackChannelsInput = await askText(
        `Slack allowed channels (comma) [${slackAllowedChannels || "(all)"}] :`,
      );
      if (slackChannelsInput) {
        slackAllowedChannels = slackChannelsInput.trim();
      }
    } else {
      slackBotToken = "";
      slackAppToken = "";
      slackSigningSecret = "";
      slackAllowedChannels = "";
    }
  }

  const normalizedDashboardPort = Math.max(1, Number(dashboardPort) || 3020);
  const normalizedAutoIntervalMs = Math.max(5000, Number(autoIntervalMs) || 90000);
  const normalizedAutoGoal = String(autoGoal || "").trim() || DEFAULT_AUTO_GOAL;
  const normalizedStalePendingHours = Math.max(1, Number(stalePendingHours) || 24 * 14);
  const normalizedStaleInProgressIdleHours = Math.max(
    1,
    Number(staleInProgressIdleHours) || 24 * 3,
  );

  const nextConfig = {
    ...existing,
    defaultProvider: provider,
    workspace,
    dashboardHost,
    dashboardPort: normalizedDashboardPort,
    slack: {
      ...(existing.slack || {}),
      enabled: channels.includes("slack"),
      allowedChannels: slackAllowedChannels
        ? String(slackAllowedChannels)
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
        : existing?.slack?.allowedChannels || [],
    },
    telegram: {
      ...(existing.telegram || {}),
      enabled: channels.includes("telegram"),
    },
    channels: {
      ...(existing.channels || {}),
      selected: channels,
    },
    autonomous: {
      ...(existing.autonomous || {}),
      enabled: autoEnabled,
      goal: normalizedAutoGoal,
      intervalMs: normalizedAutoIntervalMs,
      stalePendingHours: normalizedStalePendingHours,
      staleInProgressIdleHours: normalizedStaleInProgressIdleHours,
    },
    runtime: {
      ...(existing.runtime || {}),
      promptTimeoutMs: existing?.runtime?.promptTimeoutMs ?? 300000,
      maxPromptRetries: existing?.runtime?.maxPromptRetries ?? 2,
      maxQueueDepth: existing?.runtime?.maxQueueDepth ?? 100,
      maxConcurrentTasks: existing?.runtime?.maxConcurrentTasks ?? 6,
      taskRetryLimit: existing?.runtime?.taskRetryLimit ?? 2,
      taskRetryDelayMs: existing?.runtime?.taskRetryDelayMs ?? 5000,
      maxOverflowCompactionAttempts: existing?.runtime?.maxOverflowCompactionAttempts ?? 3,
    },
    diagnostics: {
      ...(existing.diagnostics || {}),
      enabled: existing?.diagnostics?.enabled ?? true,
      eventBufferSize: existing?.diagnostics?.eventBufferSize ?? 500,
    },
    memory: {
      ...(existing.memory || {}),
      extraPaths: existing?.memory?.extraPaths ?? [],
      sessionMemoryEnabled: existing?.memory?.sessionMemoryEnabled ?? true,
      vector: {
        ...(existing?.memory?.vector || {}),
        enabled: existing?.memory?.vector?.enabled ?? true,
        provider: existing?.memory?.vector?.provider ?? "auto",
        model: existing?.memory?.vector?.model ?? "text-embedding-3-small",
        dims: existing?.memory?.vector?.dims ?? 256,
        batchSize: existing?.memory?.vector?.batchSize ?? 32,
        cacheEnabled: existing?.memory?.vector?.cacheEnabled ?? true,
      },
      search: {
        ...(existing?.memory?.search || {}),
        vectorWeight: existing?.memory?.search?.vectorWeight ?? 0.65,
        textWeight: existing?.memory?.search?.textWeight ?? 0.35,
        minScore: existing?.memory?.search?.minScore ?? 0.12,
      },
    },
    skills: {
      ...(existing.skills || {}),
      enabled: existing?.skills?.enabled ?? true,
      autoEnableOnInstall: existing?.skills?.autoEnableOnInstall ?? true,
      codexSkillsDir:
        existing?.skills?.codexSkillsDir ?? config.skills.codexSkillsDir ?? "",
      maxCatalogEntries: existing?.skills?.maxCatalogEntries ?? 500,
      maxSkillFileBytes: existing?.skills?.maxSkillFileBytes ?? 256000,
      maxInstallFiles: existing?.skills?.maxInstallFiles ?? 3000,
      maxInstallBytes: existing?.skills?.maxInstallBytes ?? 30 * 1024 * 1024,
      installTimeoutMs: existing?.skills?.installTimeoutMs ?? 120000,
      maxPromptSkills: existing?.skills?.maxPromptSkills ?? 6,
      maxPromptChars: existing?.skills?.maxPromptChars ?? 8000,
    },
    chrome: {
      ...(existing.chrome || {}),
      mode: existing?.chrome?.mode ?? config.chrome.mode ?? "launch",
      cdpUrl: existing?.chrome?.cdpUrl ?? config.chrome.cdpUrl ?? "http://127.0.0.1:9222",
      cdpConnectTimeoutMs:
        existing?.chrome?.cdpConnectTimeoutMs ?? config.chrome.cdpConnectTimeoutMs ?? 15000,
      cdpReuseExistingPage:
        existing?.chrome?.cdpReuseExistingPage ?? config.chrome.cdpReuseExistingPage ?? true,
      cdpFallbackToLaunch:
        existing?.chrome?.cdpFallbackToLaunch ?? config.chrome.cdpFallbackToLaunch ?? true,
      headless: existing?.chrome?.headless ?? config.chrome.headless ?? true,
      maxSessions: existing?.chrome?.maxSessions ?? config.chrome.maxSessions ?? 6,
    },
  };

  await writeJson(config.paths.configPath, nextConfig);

  const envBlock = buildOnboardingEnvBlock({
    provider,
    dashboardHost,
    dashboardPort: normalizedDashboardPort,
    autoEnabled,
    autoGoal: normalizedAutoGoal,
    autoIntervalMs: normalizedAutoIntervalMs,
    stalePendingHours: normalizedStalePendingHours,
    staleInProgressIdleHours: normalizedStaleInProgressIdleHours,
    channels,
    telegramToken,
    slackBotToken,
    slackAppToken,
    slackSigningSecret,
    slackAllowedChannels,
  });
  const nextEnv = mergeOnboardingEnvSection(envRaw, envBlock);
  await writeText(envPath, nextEnv);

  const workspacePaths = {
    workspace,
    memoryMainPath: path.join(workspace, "MEMORY.md"),
    memoryDailyDir: path.join(workspace, "memory"),
    sessionMemoryDir: path.join(workspace, "memory", "sessions"),
    soulMainPath: path.join(workspace, "SOUL.md"),
    agentsPath: path.join(workspace, "AGENTS.md"),
    bootstrapPath: path.join(workspace, "BOOTSTRAP.md"),
    heartbeatPath: path.join(workspace, "HEARTBEAT.md"),
    identityPath: path.join(workspace, "IDENTITY.md"),
    toolsDocPath: path.join(workspace, "TOOLS.md"),
    userDocPath: path.join(workspace, "USER.md"),
  };

  await ensureDir(workspacePaths.memoryDailyDir);
  await ensureDir(workspacePaths.sessionMemoryDir);
  if (!(await fileExists(workspacePaths.soulMainPath))) {
    await writeText(workspacePaths.soulMainPath, makeSoulSeed());
  }
  if (!(await fileExists(workspacePaths.memoryMainPath))) {
    await writeText(workspacePaths.memoryMainPath, makeMemorySeed());
  }
  const todayMemoryPath = path.join(workspacePaths.memoryDailyDir, `${new Date().toISOString().slice(0, 10)}.md`);
  if (!(await fileExists(todayMemoryPath))) {
    await writeText(todayMemoryPath, `# Daily Memory ${new Date().toISOString().slice(0, 10)}\n\n`);
  }
  if (!(await fileExists(workspacePaths.identityPath))) {
    await writeText(workspacePaths.identityPath, makeIdentitySeed());
  }
  if (!(await fileExists(workspacePaths.bootstrapPath))) {
    await writeText(workspacePaths.bootstrapPath, makeBootstrapSeed());
  }
  if (!(await fileExists(workspacePaths.heartbeatPath))) {
    await writeText(workspacePaths.heartbeatPath, makeHeartbeatSeed());
  }
  if (!(await fileExists(workspacePaths.toolsDocPath))) {
    await writeText(workspacePaths.toolsDocPath, makeToolsSeed());
  }
  if (!(await fileExists(workspacePaths.userDocPath))) {
    await writeText(workspacePaths.userDocPath, makeUserSeed());
  }
  if (!(await fileExists(workspacePaths.agentsPath))) {
    await writeText(workspacePaths.agentsPath, makeAgentsSeed());
  }

  await writeText(
    config.paths.runbookPath,
    makeRunbook({ ...config, dashboardPort: normalizedDashboardPort }, workspacePaths),
  );
  await writeText(
    config.paths.startHerePath,
    makeStartHere({ ...config, dashboardPort: normalizedDashboardPort }),
  );

  if (!quick) {
    const setupNow = await askText("Run auth setup now? (y/n) [y] :");
    if (toBool(setupNow || "y", true)) {
      await setupAuth({ provider, authStorage });
    }
  }

  return {
    configPath: config.paths.configPath,
    envPath,
    startHerePath: config.paths.startHerePath,
    runbookPath: config.paths.runbookPath,
    soulPath: workspacePaths.soulMainPath,
    memoryPath: workspacePaths.memoryMainPath,
    bootstrapPath: workspacePaths.bootstrapPath,
    heartbeatPath: workspacePaths.heartbeatPath,
    identityPath: workspacePaths.identityPath,
    toolsDocPath: workspacePaths.toolsDocPath,
    userDocPath: workspacePaths.userDocPath,
    agentsPath: workspacePaths.agentsPath,
    provider,
    channels,
    workspace,
    dashboardPort: normalizedDashboardPort,
    autonomous: {
      enabled: autoEnabled,
      goal: normalizedAutoGoal,
      intervalMs: normalizedAutoIntervalMs,
      stalePendingHours: normalizedStalePendingHours,
      staleInProgressIdleHours: normalizedStaleInProgressIdleHours,
    },
  };
}
