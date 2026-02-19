import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import { ensureDir, readJsonOrDefault } from "../utils/fs.js";

const PROVIDERS = new Set(["google-gemini-cli", "openai-codex", "anthropic"]);
const DEFAULT_AUTO_GOAL =
  "Autonomously recover stalled tasks, clean up dead background jobs, compact memory, and continuously advance top-priority objectives with concrete progress updates.";

function expandHome(value) {
  if (!value) {
    return "";
  }
  return value.startsWith("~") ? value.replace("~", os.homedir()) : value;
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }
  const normalized = String(value).toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseComma(value) {
  return String(value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((part) => String(part ?? "").trim()).filter(Boolean);
  }
  return parseComma(value);
}

export async function loadConfig() {
  dotenv.config();

  const homeDir = expandHome(process.env.NXCLAW_HOME) || path.join(os.homedir(), ".nxclaw");
  await ensureDir(homeDir);

  const configPath = path.join(homeDir, "config.json");
  const fileConfig = await readJsonOrDefault(configPath, {});
  const defaultWorkspaceDir = path.join(homeDir, "workspace");
  const workspaceDir =
    expandHome(process.env.NXCLAW_WORKSPACE ?? fileConfig.workspace ?? defaultWorkspaceDir) ||
    defaultWorkspaceDir;

  const providerRaw =
    process.env.NXCLAW_DEFAULT_PROVIDER ?? fileConfig.defaultProvider ?? "google-gemini-cli";
  const defaultProvider = PROVIDERS.has(providerRaw) ? providerRaw : "google-gemini-cli";

  const dirs = {
    homeDir,
    workspaceDir,
    stateDir: path.join(homeDir, "state"),
    agentDir: path.join(homeDir, "agent"),
    skillsDir: path.join(homeDir, "skills"),
    memoryDir: path.join(homeDir, "memory"),
    workspaceMemoryDir: path.join(workspaceDir, "memory"),
    sessionMemoryDir: path.join(workspaceDir, "memory", "sessions"),
    soulJournalDir: path.join(workspaceDir, "memory", "soul-journal"),
    compactMdDir: path.join(workspaceDir, "memory", "compact-md"),
    logsDir: path.join(homeDir, "logs"),
    chromeDir: path.join(homeDir, "chrome"),
    chromeShotsDir: path.join(homeDir, "chrome", "shots"),
    docsDir: path.join(homeDir, "docs"),
  };

  await Promise.all(
    Object.values(dirs)
      .filter((entry) => entry !== workspaceDir)
      .map((dir) => ensureDir(dir)),
  );

  const runtimeCfg = fileConfig.runtime || {};
  const fileMemory = fileConfig.memory || {};
  const fileSkills = fileConfig.skills || {};
  const envExtraPaths = parseComma(process.env.NXCLAW_MEMORY_EXTRA_PATHS);

  return {
    ...dirs,
    paths: {
      configPath,
      authPath: path.join(dirs.agentDir, "auth.json"),
      modelsPath: path.join(dirs.agentDir, "models.json"),
      memoryRawPath: path.join(dirs.memoryDir, "raw.jsonl"),
      memoryCompactPath: path.join(dirs.memoryDir, "compact.jsonl"),
      memoryMainPath: path.join(workspaceDir, "MEMORY.md"),
      memoryDailyDir: dirs.workspaceMemoryDir,
      soulMainPath: path.join(workspaceDir, "SOUL.md"),
      agentsPath: path.join(workspaceDir, "AGENTS.md"),
      bootstrapPath: path.join(workspaceDir, "BOOTSTRAP.md"),
      heartbeatPath: path.join(workspaceDir, "HEARTBEAT.md"),
      identityPath: path.join(workspaceDir, "IDENTITY.md"),
      toolsDocPath: path.join(workspaceDir, "TOOLS.md"),
      userDocPath: path.join(workspaceDir, "USER.md"),
      objectivesPath: path.join(dirs.stateDir, "objectives.json"),
      tasksPath: path.join(dirs.stateDir, "tasks.json"),
      dashboardStatePath: path.join(dirs.stateDir, "dashboard.json"),
      eventsPath: path.join(dirs.stateDir, "events.jsonl"),
      skillsRegistryPath: path.join(dirs.stateDir, "skills.json"),
      skillsInstallDir: dirs.skillsDir,
      memoryIndexPath: path.join(dirs.stateDir, "memory-index.json"),
      embeddingCachePath: path.join(dirs.stateDir, "embedding-cache.json"),
      sessionMemoryDir: dirs.sessionMemoryDir,
      runbookPath: path.join(dirs.docsDir, "RUNBOOK.md"),
      startHerePath: path.join(dirs.docsDir, "START_HERE.md"),
    },
    defaultProvider,
    defaultModel: process.env.NXCLAW_DEFAULT_MODEL ?? fileConfig.defaultModel ?? undefined,
    dashboardPort: toNumber(
      process.env.NXCLAW_DASHBOARD_PORT,
      toNumber(fileConfig.dashboardPort, 3020),
    ),
    dashboardHost:
      String(process.env.NXCLAW_DASHBOARD_HOST ?? fileConfig.dashboardHost ?? "127.0.0.1").trim() ||
      "127.0.0.1",
    dashboardToken: String(
      process.env.NXCLAW_DASHBOARD_TOKEN ?? fileConfig.dashboardToken ?? "",
    ).trim(),
    diagnostics: {
      enabled: toBoolean(
        process.env.NXCLAW_DIAGNOSTICS_ENABLED,
        toBoolean(fileConfig?.diagnostics?.enabled, true),
      ),
      eventBufferSize: toNumber(
        process.env.NXCLAW_EVENT_BUFFER_SIZE,
        toNumber(fileConfig?.diagnostics?.eventBufferSize, 500),
      ),
    },
    runtime: {
      promptTimeoutMs: toNumber(
        process.env.NXCLAW_PROMPT_TIMEOUT_MS,
        toNumber(runtimeCfg.promptTimeoutMs, 300_000),
      ),
      maxPromptRetries: toNumber(
        process.env.NXCLAW_MAX_PROMPT_RETRIES,
        toNumber(runtimeCfg.maxPromptRetries, 2),
      ),
      maxQueueDepth: toNumber(
        process.env.NXCLAW_MAX_QUEUE_DEPTH,
        toNumber(runtimeCfg.maxQueueDepth, 100),
      ),
      maxConcurrentTasks: toNumber(
        process.env.NXCLAW_MAX_CONCURRENT_TASKS,
        toNumber(runtimeCfg.maxConcurrentTasks, 6),
      ),
      taskRetryLimit: toNumber(
        process.env.NXCLAW_TASK_RETRY_LIMIT,
        toNumber(runtimeCfg.taskRetryLimit, 2),
      ),
      taskRetryDelayMs: toNumber(
        process.env.NXCLAW_TASK_RETRY_DELAY_MS,
        toNumber(runtimeCfg.taskRetryDelayMs, 5000),
      ),
      maxOverflowCompactionAttempts: toNumber(
        process.env.NXCLAW_MAX_OVERFLOW_COMPACTIONS,
        toNumber(runtimeCfg.maxOverflowCompactionAttempts, 3),
      ),
      maxSessionLanes: toNumber(
        process.env.NXCLAW_MAX_SESSION_LANES,
        toNumber(runtimeCfg.maxSessionLanes, 240),
      ),
      maxSessionIdleMinutes: toNumber(
        process.env.NXCLAW_SESSION_IDLE_MINUTES,
        toNumber(runtimeCfg.maxSessionIdleMinutes, 240),
      ),
      maxStoredTasks: toNumber(
        process.env.NXCLAW_MAX_STORED_TASKS,
        toNumber(runtimeCfg.maxStoredTasks, 4000),
      ),
      maxFinishedTasks: toNumber(
        process.env.NXCLAW_MAX_FINISHED_TASKS,
        toNumber(runtimeCfg.maxFinishedTasks, 1200),
      ),
      maxPendingMergeItems: toNumber(
        process.env.NXCLAW_MAX_PENDING_MERGE_ITEMS,
        toNumber(runtimeCfg.maxPendingMergeItems, 8),
      ),
      maxPendingMergeChars: toNumber(
        process.env.NXCLAW_MAX_PENDING_MERGE_CHARS,
        toNumber(runtimeCfg.maxPendingMergeChars, 6000),
      ),
    },
    autonomous: {
      enabled: toBoolean(
        process.env.NXCLAW_AUTO_ENABLED,
        toBoolean(fileConfig?.autonomous?.enabled, true),
      ),
      goal:
        String(
          process.env.NXCLAW_AUTO_GOAL ??
            fileConfig?.autonomous?.goal ??
            DEFAULT_AUTO_GOAL,
        ).trim() || DEFAULT_AUTO_GOAL,
      intervalMs: toNumber(
        process.env.NXCLAW_AUTO_INTERVAL_MS,
        toNumber(fileConfig?.autonomous?.intervalMs, 90_000),
      ),
      skipWhenQueueAbove: toNumber(
        process.env.NXCLAW_AUTO_SKIP_QUEUE_ABOVE,
        toNumber(fileConfig?.autonomous?.skipWhenQueueAbove, 2),
      ),
      maxConsecutiveFailures: toNumber(
        process.env.NXCLAW_AUTO_MAX_FAILURES,
        toNumber(fileConfig?.autonomous?.maxConsecutiveFailures, 5),
      ),
      stalePendingHours: toNumber(
        process.env.NXCLAW_AUTO_STALE_PENDING_HOURS,
        toNumber(fileConfig?.autonomous?.stalePendingHours, 24 * 14),
      ),
      staleInProgressIdleHours: toNumber(
        process.env.NXCLAW_AUTO_STALE_IN_PROGRESS_IDLE_HOURS,
        toNumber(fileConfig?.autonomous?.staleInProgressIdleHours, 24 * 3),
      ),
    },
    slack: {
      botToken: process.env.NXCLAW_SLACK_BOT_TOKEN ?? process.env.SLACK_BOT_TOKEN,
      appToken: process.env.NXCLAW_SLACK_APP_TOKEN ?? process.env.SLACK_APP_TOKEN,
      signingSecret:
        process.env.NXCLAW_SLACK_SIGNING_SECRET ?? process.env.SLACK_SIGNING_SECRET,
      allowedChannels:
        parseComma(process.env.NXCLAW_SLACK_CHANNELS).length > 0
          ? parseComma(process.env.NXCLAW_SLACK_CHANNELS)
          : parseComma(fileConfig?.slack?.allowedChannels),
    },
    telegram: {
      botToken: process.env.NXCLAW_TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN,
    },
    chrome: {
      mode:
        String(process.env.NXCLAW_CHROME_MODE ?? fileConfig?.chrome?.mode ?? "launch")
          .trim()
          .toLowerCase() === "cdp"
          ? "cdp"
          : "launch",
      cdpUrl:
        String(process.env.NXCLAW_CHROME_CDP_URL ?? fileConfig?.chrome?.cdpUrl ?? "").trim() ||
        "http://127.0.0.1:9222",
      cdpConnectTimeoutMs: toNumber(
        process.env.NXCLAW_CHROME_CDP_CONNECT_TIMEOUT_MS,
        toNumber(fileConfig?.chrome?.cdpConnectTimeoutMs, 15_000),
      ),
      cdpReuseExistingPage: toBoolean(
        process.env.NXCLAW_CHROME_CDP_REUSE_EXISTING_PAGE,
        toBoolean(fileConfig?.chrome?.cdpReuseExistingPage, true),
      ),
      cdpFallbackToLaunch: toBoolean(
        process.env.NXCLAW_CHROME_CDP_FALLBACK_TO_LAUNCH,
        toBoolean(fileConfig?.chrome?.cdpFallbackToLaunch, true),
      ),
      headless: toBoolean(
        process.env.NXCLAW_CHROME_HEADLESS,
        toBoolean(fileConfig?.chrome?.headless, true),
      ),
      executablePath:
        process.env.NXCLAW_CHROME_PATH ??
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
        process.env.PUPPETEER_EXECUTABLE_PATH ??
        undefined,
      screenshotDir: dirs.chromeShotsDir,
      maxSessions: toNumber(
        process.env.NXCLAW_CHROME_MAX_SESSIONS,
        toNumber(fileConfig?.chrome?.maxSessions, 6),
      ),
    },
    memory: {
      extraPaths: envExtraPaths.length > 0 ? envExtraPaths : parseStringArray(fileMemory.extraPaths),
      sessionMemoryEnabled: toBoolean(
        process.env.NXCLAW_MEMORY_SESSION_ENABLED,
        toBoolean(fileMemory.sessionMemoryEnabled, true),
      ),
      vector: {
        enabled: toBoolean(
          process.env.NXCLAW_MEMORY_VECTOR_ENABLED,
          toBoolean(fileMemory?.vector?.enabled, true),
        ),
        provider:
          process.env.NXCLAW_MEMORY_VECTOR_PROVIDER ??
          fileMemory?.vector?.provider ??
          "auto",
        model:
          process.env.NXCLAW_MEMORY_VECTOR_MODEL ??
          fileMemory?.vector?.model ??
          "text-embedding-3-small",
        dims: toNumber(
          process.env.NXCLAW_MEMORY_VECTOR_DIMS,
          toNumber(fileMemory?.vector?.dims, 256),
        ),
        batchSize: toNumber(
          process.env.NXCLAW_MEMORY_VECTOR_BATCH_SIZE,
          toNumber(fileMemory?.vector?.batchSize, 32),
        ),
        cacheEnabled: toBoolean(
          process.env.NXCLAW_MEMORY_VECTOR_CACHE_ENABLED,
          toBoolean(fileMemory?.vector?.cacheEnabled, true),
        ),
      },
      search: {
        vectorWeight: toNumber(
          process.env.NXCLAW_MEMORY_VECTOR_WEIGHT,
          toNumber(fileMemory?.search?.vectorWeight, 0.65),
        ),
        textWeight: toNumber(
          process.env.NXCLAW_MEMORY_TEXT_WEIGHT,
          toNumber(fileMemory?.search?.textWeight, 0.35),
        ),
        minScore: toNumber(
          process.env.NXCLAW_MEMORY_MIN_SCORE,
          toNumber(fileMemory?.search?.minScore, 0.12),
        ),
      },
    },
    skills: {
      enabled: toBoolean(
        process.env.NXCLAW_SKILLS_ENABLED,
        toBoolean(fileSkills.enabled, true),
      ),
      autoEnableOnInstall: toBoolean(
        process.env.NXCLAW_SKILLS_AUTO_ENABLE,
        toBoolean(fileSkills.autoEnableOnInstall, true),
      ),
      codexSkillsDir: expandHome(
        process.env.NXCLAW_CODEX_SKILLS_DIR ??
          fileSkills.codexSkillsDir ??
          path.join(os.homedir(), ".codex", "skills"),
      ),
      maxCatalogEntries: toNumber(
        process.env.NXCLAW_SKILLS_MAX_CATALOG,
        toNumber(fileSkills.maxCatalogEntries, 500),
      ),
      maxSkillFileBytes: toNumber(
        process.env.NXCLAW_SKILLS_MAX_FILE_BYTES,
        toNumber(fileSkills.maxSkillFileBytes, 256000),
      ),
      maxInstallFiles: toNumber(
        process.env.NXCLAW_SKILLS_MAX_INSTALL_FILES,
        toNumber(fileSkills.maxInstallFiles, 3000),
      ),
      maxInstallBytes: toNumber(
        process.env.NXCLAW_SKILLS_MAX_INSTALL_BYTES,
        toNumber(fileSkills.maxInstallBytes, 30 * 1024 * 1024),
      ),
      installTimeoutMs: toNumber(
        process.env.NXCLAW_SKILLS_INSTALL_TIMEOUT_MS,
        toNumber(fileSkills.installTimeoutMs, 120000),
      ),
      maxPromptSkills: toNumber(
        process.env.NXCLAW_SKILLS_MAX_PROMPT,
        toNumber(fileSkills.maxPromptSkills, 6),
      ),
      maxPromptChars: toNumber(
        process.env.NXCLAW_SKILLS_MAX_PROMPT_CHARS,
        toNumber(fileSkills.maxPromptChars, 8000),
      ),
    },
  };
}
