import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { ensureDir, readJsonOrDefault, writeJson } from "../utils/fs.js";

function now() {
  return new Date().toISOString();
}

function withTail(lines, append, max = 120) {
  const next = [...lines, append];
  return next.slice(-max);
}

export class BackgroundTaskManager {
  constructor({
    statePath,
    logDir,
    eventBus = null,
    maxConcurrentProcesses = 6,
    defaultRetryLimit = 2,
    defaultRetryDelayMs = 5000,
    maxTasks = 4000,
    maxFinishedTasks = 1200,
  }) {
    this.statePath = statePath;
    this.logDir = logDir;
    this.eventBus = eventBus;
    this.maxConcurrentProcesses = Math.max(1, Number(maxConcurrentProcesses) || 6);
    this.defaultRetryLimit = Math.max(0, Number(defaultRetryLimit) || 0);
    this.defaultRetryDelayMs = Math.max(250, Number(defaultRetryDelayMs) || 5000);
    this.maxTasks = Math.max(500, Number(maxTasks) || 4000);
    this.maxFinishedTasks = Math.max(100, Number(maxFinishedTasks) || 1200);

    this.tasks = [];
    this.processes = new Map();
    this.schedulers = new Map();
    this.pendingQueue = [];
    this.waiters = new Map();
    this.queueTimer = null;
    this.dispatching = false;
    this.persistChain = Promise.resolve();
    this.persistTimer = null;
  }

  emit(type, payload = {}) {
    if (this.eventBus) {
      this.eventBus.emit(type, payload);
    }
  }

  async init() {
    await ensureDir(path.dirname(this.statePath));
    await ensureDir(this.logDir);
    const state = await readJsonOrDefault(this.statePath, { tasks: [] });
    this.tasks = Array.isArray(state.tasks) ? state.tasks : [];

    for (const task of this.tasks) {
      if (task.type === "schedule" && task.status !== "cancelled") {
        task.status = "running";
      } else if (task.status === "running" || task.status === "queued") {
        task.status = "queued";
      }
      task.updatedAt = now();

      if (task.type === "command" && task.status === "queued") {
        this.enqueueExistingTask(task, {
          timeoutMs: Number(task.timeoutMs) || 0,
          retryDelayMs: Number(task.retryDelayMs) || this.defaultRetryDelayMs,
          waitForCompletion: false,
          retryAt: Date.now(),
        });
      }
    }

    this.pruneTasks();
    await this.persist();

    for (const task of this.tasks.filter((item) => item.type === "schedule" && item.status !== "cancelled")) {
      this.startScheduler(task);
    }

    this.emit("task.manager.init", {
      totalTasks: this.tasks.length,
      activeSchedules: this.schedulers.size,
      queueDepth: this.pendingQueue.length,
      maxConcurrentProcesses: this.maxConcurrentProcesses,
    });

    await this.dispatchPending();
  }

  async persist() {
    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(async () => {
        await writeJson(this.statePath, { tasks: this.tasks });
      });
    await this.persistChain;
  }

  schedulePersist(delayMs = 120) {
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, Math.max(10, Number(delayMs) || 120));
  }

  clearPersistTimer() {
    if (!this.persistTimer) {
      return;
    }
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
  }

  pruneTasks() {
    const finalStatuses = new Set(["completed", "failed", "cancelled", "stopped"]);
    const active = [];
    const finished = [];

    for (const task of this.tasks) {
      if (task.type === "schedule" && task.status !== "cancelled") {
        active.push(task);
        continue;
      }
      if (finalStatuses.has(task.status)) {
        finished.push(task);
      } else {
        active.push(task);
      }
    }

    finished.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    let keptFinished = finished.slice(0, this.maxFinishedTasks);
    const mergedCount = active.length + keptFinished.length;
    if (mergedCount > this.maxTasks) {
      const over = mergedCount - this.maxTasks;
      if (over > 0 && keptFinished.length > 0) {
        keptFinished = keptFinished.slice(0, Math.max(0, keptFinished.length - over));
      }
    }

    this.tasks = [...active, ...keptFinished].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  clearQueueTimer() {
    if (this.queueTimer) {
      clearTimeout(this.queueTimer);
      this.queueTimer = null;
    }
  }

  scheduleNextQueueTick() {
    this.clearQueueTimer();
    if (this.pendingQueue.length === 0) {
      return;
    }
    const nextAt = this.pendingQueue.reduce((min, item) => Math.min(min, item.retryAt || Date.now()), Infinity);
    const delay = Math.max(25, nextAt - Date.now());
    this.queueTimer = setTimeout(() => {
      this.queueTimer = null;
      void this.dispatchPending();
    }, delay);
  }

  getQueueSnapshot(limit = 80) {
    const lines = this.pendingQueue
      .slice(0, Math.max(1, limit))
      .map((item) => {
        const task = this.getById(item.taskId);
        return {
          taskId: item.taskId,
          name: task?.name || "",
          status: task?.status || "missing",
          attempts: task?.attempts || 0,
          maxRetries: task?.maxRetries || 0,
          retryAt: new Date(item.retryAt || Date.now()).toISOString(),
          waitForCompletion: !!item.waitForCompletion,
        };
      });
    return lines;
  }

  list({ includeFinished = true } = {}) {
    const items = includeFinished
      ? [...this.tasks]
      : this.tasks.filter((task) => !["completed", "failed", "cancelled"].includes(task.status));
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getById(taskId) {
    return this.tasks.find((task) => task.id === taskId) ?? null;
  }

  runningCount() {
    return this.tasks.filter((task) => task.status === "running").length;
  }

  queuedCount() {
    return this.tasks.filter((task) => task.status === "queued").length;
  }

  getHealth() {
    const running = this.runningCount();
    const queued = this.queuedCount();
    const scheduled = this.tasks.filter((task) => task.type === "schedule" && task.status !== "cancelled").length;
    const failedRecent = this.tasks
      .slice(-60)
      .filter((task) => task.status === "failed")
      .length;

    return {
      running,
      queued,
      scheduled,
      failedRecent,
      processes: this.processes.size,
      queueDepth: this.pendingQueue.length,
      maxConcurrentProcesses: this.maxConcurrentProcesses,
      slotsAvailable: Math.max(0, this.maxConcurrentProcesses - this.processes.size),
    };
  }

  findRunningByCommand(command, cwd) {
    const normalizedCmd = String(command || "").trim();
    const normalizedCwd = String(cwd || "").trim();
    if (!normalizedCmd) {
      return null;
    }

    return (
      this.tasks.find(
        (task) =>
          task.status === "running" &&
          String(task.command || "").trim() === normalizedCmd &&
          String(task.cwd || "").trim() === normalizedCwd,
      ) ?? null
    );
  }

  createTaskBase({
    name,
    type,
    command = "",
    cwd = "",
    intervalMs = null,
    parentTaskId = null,
    background = true,
    maxRetries = null,
    retryDelayMs = null,
    timeoutMs = 0,
  }) {
    const id = crypto.randomUUID();
    return {
      id,
      name: name || type,
      type,
      command,
      cwd,
      status: type === "schedule" ? "running" : "queued",
      createdAt: now(),
      updatedAt: now(),
      lastRunAt: null,
      nextRunAt: null,
      intervalMs,
      parentTaskId,
      exitCode: null,
      pid: null,
      error: null,
      logPath: path.join(this.logDir, `${id}.log`),
      tail: [],
      attempts: 0,
      maxRetries: maxRetries ?? this.defaultRetryLimit,
      retryDelayMs: retryDelayMs ?? this.defaultRetryDelayMs,
      timeoutMs: Number(timeoutMs) || 0,
      background: !!background,
    };
  }

  addWaiter(taskId, waiter) {
    const list = this.waiters.get(taskId) ?? [];
    list.push(waiter);
    this.waiters.set(taskId, list);
  }

  resolveWaiters(task) {
    const waiters = this.waiters.get(task.id);
    if (!waiters || waiters.length === 0) {
      return;
    }
    this.waiters.delete(task.id);
    for (const waiter of waiters) {
      waiter.resolve(task);
    }
  }

  rejectWaiters(taskId, error) {
    const waiters = this.waiters.get(taskId);
    if (!waiters || waiters.length === 0) {
      return;
    }
    this.waiters.delete(taskId);
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }

  async appendLog(task, line) {
    if (!line) {
      return;
    }
    task.tail = withTail(task.tail || [], line);
    await fsp.appendFile(task.logPath, `${line}\n`, { mode: 0o600 });
  }

  enqueueExistingTask(
    task,
    {
      timeoutMs = 0,
      retryDelayMs = this.defaultRetryDelayMs,
      waitForCompletion = false,
      retryAt = Date.now(),
    } = {},
  ) {
    const already = this.pendingQueue.some((entry) => entry.taskId === task.id);
    if (already) {
      return;
    }

    task.status = "queued";
    task.updatedAt = now();
    task.timeoutMs = Number(timeoutMs) || task.timeoutMs || 0;
    task.retryDelayMs = Number(retryDelayMs) || task.retryDelayMs || this.defaultRetryDelayMs;
    this.pendingQueue.push({
      taskId: task.id,
      timeoutMs: task.timeoutMs,
      retryDelayMs: task.retryDelayMs,
      waitForCompletion: !!waitForCompletion,
      retryAt: Number(retryAt) || Date.now(),
      enqueuedAt: Date.now(),
    });
  }

  async dispatchPending() {
    if (this.dispatching) {
      return;
    }
    this.dispatching = true;

    try {
      this.clearQueueTimer();
      let progressed = false;

      while (this.processes.size < this.maxConcurrentProcesses) {
        const nowMs = Date.now();
        const nextIndex = this.pendingQueue.findIndex((item) => (item.retryAt || 0) <= nowMs);
        if (nextIndex < 0) {
          break;
        }
        const [item] = this.pendingQueue.splice(nextIndex, 1);
        if (!item) {
          break;
        }
        const task = this.getById(item.taskId);
        if (!task || task.status === "cancelled") {
          continue;
        }
        await this.launchTaskNow(task, item, { fromQueue: true });
        progressed = true;
      }

      if (this.pendingQueue.length > 0) {
        this.scheduleNextQueueTick();
      }
      if (progressed) {
        await this.persist();
      }
    } finally {
      this.dispatching = false;
    }
  }

  async launchTaskNow(task, queueItem, { fromQueue = false } = {}) {
    task.status = "running";
    task.attempts = Number(task.attempts || 0) + 1;
    task.pid = null;
    task.error = null;
    task.exitCode = null;
    task.lastRunAt = now();
    task.updatedAt = now();
    await this.persist();

    this.emit("task.command.start", {
      taskId: task.id,
      name: task.name,
      command: task.command,
      cwd: task.cwd,
      parentTaskId: task.parentTaskId,
      background: task.background,
      queued: fromQueue,
      attempts: task.attempts,
      maxRetries: task.maxRetries,
    });

    const proc = spawn(task.command, {
      cwd: task.cwd || process.cwd(),
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.processes.set(task.id, proc);
    task.pid = proc.pid;
    task.updatedAt = now();
    this.schedulePersist(20);

    const onData = async (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      const lines = text
        .split("\n")
        .map((line) => line.trimEnd())
        .filter(Boolean);
      for (const line of lines) {
        await this.appendLog(task, line);
      }
      task.updatedAt = now();
      this.schedulePersist(150);
      this.emit("task.command.output", {
        taskId: task.id,
        lines: lines.slice(-10),
      });
    };

    proc.stdout?.on("data", (chunk) => {
      void onData(chunk);
    });
    proc.stderr?.on("data", (chunk) => {
      void onData(chunk);
    });

    const timeoutMs = Number(queueItem?.timeoutMs ?? task.timeoutMs ?? 0);
    if (timeoutMs > 0) {
      setTimeout(() => {
        if (!this.processes.has(task.id)) {
          return;
        }
        proc.kill("SIGTERM");
        task.status = "stopped";
        task.updatedAt = now();
        void this.appendLog(task, `Stopped due to timeout after ${timeoutMs}ms`);
        this.schedulePersist(20);
        this.emit("task.command.timeout", { taskId: task.id, timeoutMs });
      }, timeoutMs);
    }

    proc.on("close", async (code) => {
      this.processes.delete(task.id);
      if (task.status === "cancelled") {
        task.updatedAt = now();
        await this.persist();
        this.resolveWaiters(task);
        await this.dispatchPending();
        return;
      }

      const exitCode = Number.isFinite(code) ? code : null;
      task.exitCode = exitCode;
      task.updatedAt = now();

      if (exitCode === 0) {
        task.status = "completed";
        this.pruneTasks();
        await this.persist();
        this.emit("task.command.end", {
          taskId: task.id,
          status: task.status,
          exitCode: task.exitCode,
          error: task.error,
          attempts: task.attempts,
        });
        this.resolveWaiters(task);
      } else {
        const canRetry = Number(task.attempts || 0) <= Number(task.maxRetries || 0);
        task.error = `exit_code=${exitCode}`;
        if (canRetry && task.status !== "stopped") {
          task.status = "queued";
          const delay = Number(task.retryDelayMs || this.defaultRetryDelayMs);
          const retryAt = Date.now() + Math.max(250, delay);
          this.enqueueExistingTask(task, {
            timeoutMs,
            retryDelayMs: delay,
            waitForCompletion: queueItem?.waitForCompletion ?? false,
            retryAt,
          });
          await this.appendLog(task, `Retry scheduled at ${new Date(retryAt).toISOString()}`);
          this.emit("task.command.retry", {
            taskId: task.id,
            attempts: task.attempts,
            maxRetries: task.maxRetries,
            retryAt: new Date(retryAt).toISOString(),
          });
          await this.persist();
        } else {
          task.status = task.status === "stopped" ? "stopped" : "failed";
          this.pruneTasks();
          await this.persist();
          this.emit("task.command.end", {
            taskId: task.id,
            status: task.status,
            exitCode: task.exitCode,
            error: task.error,
            attempts: task.attempts,
          });
          this.resolveWaiters(task);
        }
      }

      await this.dispatchPending();
    });

    proc.on("error", async (error) => {
      this.processes.delete(task.id);
      task.status = "failed";
      task.error = error.message;
      task.updatedAt = now();
      await this.appendLog(task, `ERROR: ${error.message}`);
      this.pruneTasks();
      await this.persist();
      this.emit("task.command.error", {
        taskId: task.id,
        error: error.message,
      });
      this.resolveWaiters(task);
      await this.dispatchPending();
    });
  }

  async runCommand({
    name = "terminal",
    command,
    cwd = process.cwd(),
    timeoutMs = 0,
    background = false,
    parentTaskId = null,
    dedupeRunning = false,
    queueIfBusy = true,
    forceQueue = false,
    maxRetries = null,
    retryDelayMs = null,
  }) {
    if (!command || !String(command).trim()) {
      throw new Error("Command is required");
    }

    const normalizedCwd = String(cwd || process.cwd());
    if (dedupeRunning) {
      const existing = this.findRunningByCommand(command, normalizedCwd);
      if (existing) {
        this.emit("task.command.duplicate", {
          existingTaskId: existing.id,
          command,
          cwd: normalizedCwd,
        });
        return existing;
      }
    }

    const task = this.createTaskBase({
      name,
      type: "command",
      command: String(command),
      cwd: normalizedCwd,
      parentTaskId,
      background,
      maxRetries,
      retryDelayMs,
      timeoutMs,
    });
    this.tasks.push(task);
    this.pruneTasks();
    await ensureDir(path.dirname(task.logPath));
    const waiterPromise = background
      ? null
      : new Promise((resolve, reject) => {
          this.addWaiter(task.id, { resolve, reject });
        });

    const shouldQueue =
      forceQueue ||
      (queueIfBusy && this.processes.size >= this.maxConcurrentProcesses) ||
      this.pendingQueue.length > 0;

    if (shouldQueue) {
      this.enqueueExistingTask(task, {
        timeoutMs,
        retryDelayMs: task.retryDelayMs,
        waitForCompletion: !background,
        retryAt: Date.now(),
      });
      await this.persist();
      this.emit("task.command.queued", {
        taskId: task.id,
        queueDepth: this.pendingQueue.length,
        maxConcurrentProcesses: this.maxConcurrentProcesses,
      });
      try {
        await this.dispatchPending();
      } catch (error) {
        this.rejectWaiters(task.id, error);
        throw error;
      }
      if (background) {
        return task;
      }
      return await waiterPromise;
    }

    try {
      await this.launchTaskNow(
        task,
        {
          timeoutMs,
          retryDelayMs: task.retryDelayMs,
          waitForCompletion: !background,
        },
        { fromQueue: false },
      );
    } catch (error) {
      this.rejectWaiters(task.id, error);
      throw error;
    }

    if (background) {
      return task;
    }

    return await waiterPromise;
  }

  async enqueueCommand(options) {
    return await this.runCommand({
      ...options,
      background: true,
      queueIfBusy: true,
      forceQueue: true,
    });
  }

  startScheduler(task) {
    if (!task || !task.intervalMs || task.intervalMs <= 0) {
      return;
    }

    if (this.schedulers.has(task.id)) {
      clearInterval(this.schedulers.get(task.id));
    }

    const timer = setInterval(() => {
      task.lastRunAt = now();
      task.nextRunAt = new Date(Date.now() + task.intervalMs).toISOString();
      task.updatedAt = now();
      this.schedulePersist(120);
      this.emit("task.schedule.tick", {
        taskId: task.id,
        command: task.command,
        nextRunAt: task.nextRunAt,
      });
      void this.runCommand({
        name: `${task.name}:tick`,
        command: task.command,
        cwd: task.cwd || process.cwd(),
        background: true,
        queueIfBusy: true,
        forceQueue: false,
        dedupeRunning: false,
        parentTaskId: task.id,
        maxRetries: task.maxRetries ?? this.defaultRetryLimit,
        retryDelayMs: task.retryDelayMs ?? this.defaultRetryDelayMs,
      });
    }, task.intervalMs);

    this.schedulers.set(task.id, timer);
    this.emit("task.schedule.start", {
      taskId: task.id,
      intervalMs: task.intervalMs,
    });
  }

  async scheduleCommand({
    name = "schedule",
    command,
    cwd = process.cwd(),
    intervalMs,
    maxRetries = null,
    retryDelayMs = null,
  }) {
    const ms = Number(intervalMs);
    if (!Number.isFinite(ms) || ms < 1000) {
      throw new Error("intervalMs must be >= 1000");
    }

    const task = this.createTaskBase({
      name,
      type: "schedule",
      command: String(command),
      cwd: String(cwd || process.cwd()),
      intervalMs: ms,
      background: true,
      maxRetries,
      retryDelayMs,
    });
    task.nextRunAt = new Date(Date.now() + ms).toISOString();
    this.tasks.push(task);
    this.pruneTasks();
    this.startScheduler(task);
    await this.persist();
    return task;
  }

  async stop(taskId) {
    const task = this.getById(taskId);
    if (!task) {
      return false;
    }

    const timer = this.schedulers.get(taskId);
    if (timer) {
      clearInterval(timer);
      this.schedulers.delete(taskId);
    }

    this.pendingQueue = this.pendingQueue.filter((item) => item.taskId !== taskId);

    const proc = this.processes.get(taskId);
    if (proc) {
      proc.kill("SIGTERM");
      this.processes.delete(taskId);
    }

    task.status = "cancelled";
    task.updatedAt = now();
    await this.appendLog(task, "Task was manually stopped");
    this.pruneTasks();
    await this.persist();

    this.emit("task.stop", { taskId, status: task.status });
    this.resolveWaiters(task);
    await this.dispatchPending();
    return true;
  }

  async tail(taskId, lines = 80) {
    const task = this.getById(taskId);
    if (!task) {
      return { task: null, lines: [] };
    }

    try {
      const raw = await fsp.readFile(task.logPath, "utf8");
      const all = raw.split("\n").filter(Boolean);
      return { task, lines: all.slice(-Math.max(1, lines)) };
    } catch {
      return { task, lines: task.tail || [] };
    }
  }

  async shutdown({ stopSchedulesOnly = true } = {}) {
    this.clearQueueTimer();
    this.clearPersistTimer();
    for (const [id, timer] of this.schedulers.entries()) {
      clearInterval(timer);
      this.schedulers.delete(id);
      const task = this.getById(id);
      if (task && task.status === "running") {
        task.status = "stopped";
        task.updatedAt = now();
      }
    }

    if (!stopSchedulesOnly) {
      for (const [id, proc] of this.processes.entries()) {
        proc.kill("SIGTERM");
        this.processes.delete(id);
        const task = this.getById(id);
        if (task && task.status === "running") {
          task.status = "stopped";
          task.updatedAt = now();
          this.resolveWaiters(task);
        }
      }
      this.pendingQueue = [];
    }

    await this.persist();
    this.emit("task.manager.shutdown", {
      stopSchedulesOnly,
      activeProcesses: this.processes.size,
      queueDepth: this.pendingQueue.length,
    });
  }
}
