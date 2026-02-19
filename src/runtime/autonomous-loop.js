function nowIso() {
  return new Date().toISOString();
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export class AutonomousLoop {
  constructor({ runtime, objectiveQueue, autoConfig, eventBus = null }) {
    this.runtime = runtime;
    this.objectiveQueue = objectiveQueue;
    this.autoConfig = autoConfig;
    this.eventBus = eventBus;
    this.timer = null;
    this.running = false;
    this.lastTickAt = null;
    this.lastError = null;
    this.consecutiveFailures = 0;
    this.totalTicks = 0;
    this.skippedTicks = 0;
    this.disabledReason = null;
  }

  emit(type, payload = {}) {
    if (this.eventBus) {
      this.eventBus.emit(type, payload);
    }
  }

  getQueueSkipLimit() {
    return toNumber(this.autoConfig.skipWhenQueueAbove, 2);
  }

  getMaxConsecutiveFailures() {
    return Math.max(1, toNumber(this.autoConfig.maxConsecutiveFailures, 5));
  }

  getStalePendingHours() {
    return Math.max(1, toNumber(this.autoConfig.stalePendingHours, 24 * 14));
  }

  getStaleInProgressIdleHours() {
    return Math.max(1, toNumber(this.autoConfig.staleInProgressIdleHours, 24 * 3));
  }

  shouldSkipForQueuePressure() {
    const limit = this.getQueueSkipLimit();
    if (!Number.isFinite(limit) || limit < 0) {
      return false;
    }
    return this.runtime.getQueueDepth() > limit;
  }

  getTaskPressure() {
    const health = this.runtime?.backgroundManager?.getHealth?.();
    if (!health) {
      return { skip: false, reason: "none", health: null };
    }

    const maxConcurrent = Math.max(1, Number(this.runtime?.config?.runtime?.maxConcurrentTasks) || 6);
    const queueLimit = maxConcurrent * 3;
    const failLimit = Math.max(6, maxConcurrent);

    if (Number(health.queueDepth || 0) > queueLimit) {
      return { skip: true, reason: "queue_overflow", health };
    }
    if (Number(health.failedRecent || 0) > failLimit) {
      return { skip: true, reason: "recent_failures", health };
    }
    return { skip: false, reason: "ok", health };
  }

  buildPrompt({ objective, fallbackGoal }) {
    if (objective) {
      return [
        "[AUTONOMOUS OBJECTIVE CYCLE]",
        `Objective ID: ${objective.id}`,
        `Title: ${objective.title}`,
        `Description: ${objective.description || "(none)"}`,
        "",
        "Execution rules:",
        "1. Do concrete work using tools (terminal/chrome/memory/objectives).",
        "2. Keep continuity: check running tasks before starting duplicates.",
        "3. If objective is complete, call nx_objective_update with completed.",
        "4. If blocked, call nx_objective_update with blocked and detailed notes.",
        "5. If long history grows, call nx_memory_compact.",
        "",
        "Start now and return concise progress update.",
      ].join("\n");
    }

    return [
      "[AUTONOMOUS MAINTENANCE CYCLE]",
      `Fallback goal: ${fallbackGoal || "Keep making useful progress and monitor running tasks."}`,
      "",
      "Execution rules:",
      "1. Inspect current tasks and objective queue first.",
      "2. Take one concrete useful action.",
      "3. Add objective if new long-running work appears.",
      "4. Persist important findings in long-term memory.",
      "",
      "Execute immediately.",
    ].join("\n");
  }

  async tick() {
    if (!this.autoConfig.enabled) {
      return;
    }

    if (this.disabledReason) {
      this.skippedTicks += 1;
      this.emit("autonomous.tick.skip", {
        reason: "disabled",
        disabledReason: this.disabledReason,
      });
      return;
    }

    if (this.running || this.runtime.isBusy()) {
      this.skippedTicks += 1;
      this.emit("autonomous.tick.skip", {
        reason: "runtime_busy",
        queueDepth: this.runtime.getQueueDepth(),
      });
      return;
    }

    if (this.shouldSkipForQueuePressure()) {
      this.skippedTicks += 1;
      this.emit("autonomous.tick.skip", {
        reason: "queue_pressure",
        queueDepth: this.runtime.getQueueDepth(),
        skipWhenQueueAbove: this.getQueueSkipLimit(),
      });
      return;
    }

    const pressure = this.getTaskPressure();
    if (pressure.skip) {
      this.skippedTicks += 1;
      this.emit("autonomous.tick.skip", {
        reason: "task_pressure",
        detail: pressure.reason,
        health: pressure.health,
      });
      return;
    }

    this.running = true;
    this.lastTickAt = nowIso();
    this.totalTicks += 1;

    this.emit("autonomous.tick.start", {
      tick: this.totalTicks,
      queueDepth: this.runtime.getQueueDepth(),
    });

    try {
      await this.objectiveQueue.reload().catch(() => undefined);
      const staleResult = await this.objectiveQueue
        .expireStale({
          pendingMaxAgeHours: this.getStalePendingHours(),
          inProgressMaxIdleHours: this.getStaleInProgressIdleHours(),
        })
        .catch(() => ({ changedCount: 0, changed: [] }));
      if (Number(staleResult?.changedCount || 0) > 0) {
        this.emit("autonomous.objective.stale_pruned", {
          changedCount: staleResult.changedCount,
          changed: staleResult.changed,
          pendingMaxAgeHours: staleResult.pendingMaxAgeHours,
          inProgressMaxIdleHours: staleResult.inProgressMaxIdleHours,
        });
      }
      let objective = this.objectiveQueue.pickForAutonomous();
      if (objective) {
        objective = await this.objectiveQueue.markPicked(objective.id);
      }

      const prompt = this.buildPrompt({
        objective,
        fallbackGoal: this.autoConfig.goal,
      });

      const reply = await this.runtime.handleIncoming(
        {
          source: "autonomous",
          channelId: "auto",
          userId: "system",
        },
        prompt,
      );

      if (typeof reply === "string" && reply.startsWith("Runtime error:")) {
        throw new Error(reply);
      }

      this.consecutiveFailures = 0;
      this.lastError = null;
      this.emit("autonomous.tick.success", {
        objectiveId: objective?.id ?? null,
        objectiveStatus: objective?.status ?? null,
        queueDepth: this.runtime.getQueueDepth(),
        taskHealth: this.runtime?.backgroundManager?.getHealth?.() || null,
      });
    } catch (error) {
      this.lastError = String(error?.message || error || "unknown autonomous error");
      this.consecutiveFailures += 1;

      const maxFailures = this.getMaxConsecutiveFailures();
      this.emit("autonomous.tick.error", {
        error: this.lastError,
        consecutiveFailures: this.consecutiveFailures,
        maxConsecutiveFailures: maxFailures,
      });

      if (this.consecutiveFailures >= maxFailures) {
        this.disabledReason = `disabled after ${this.consecutiveFailures} consecutive failures`;
        this.runtime.setChannelHealth("autonomous", false);
        this.emit("autonomous.loop.disabled", {
          reason: this.disabledReason,
          lastError: this.lastError,
        });
      }
    } finally {
      this.running = false;
      this.emit("autonomous.tick.end", {
        tick: this.totalTicks,
        queueDepth: this.runtime.getQueueDepth(),
      });
    }
  }

  start() {
    if (!this.autoConfig.enabled || this.timer) {
      return;
    }

    const interval = Math.max(5000, Number(this.autoConfig.intervalMs) || 90000);
    this.timer = setInterval(() => {
      void this.tick();
    }, interval);
    this.runtime.setChannelHealth("autonomous", true);

    this.emit("autonomous.loop.start", {
      intervalMs: interval,
      goal: this.autoConfig.goal || "",
    });

    void this.tick();
  }

  applyConfig(next = {}) {
    const prevEnabled = !!this.autoConfig.enabled;
    const prevInterval = Number(this.autoConfig.intervalMs) || 90000;

    if (typeof next.enabled === "boolean") {
      this.autoConfig.enabled = next.enabled;
    }
    if (typeof next.goal === "string") {
      this.autoConfig.goal = next.goal.trim();
    }
    if (Number.isFinite(Number(next.intervalMs))) {
      this.autoConfig.intervalMs = Math.max(5000, Number(next.intervalMs));
    }
    if (Number.isFinite(Number(next.skipWhenQueueAbove))) {
      this.autoConfig.skipWhenQueueAbove = Math.max(0, Number(next.skipWhenQueueAbove));
    }
    if (Number.isFinite(Number(next.maxConsecutiveFailures))) {
      this.autoConfig.maxConsecutiveFailures = Math.max(1, Number(next.maxConsecutiveFailures));
    }
    if (Number.isFinite(Number(next.stalePendingHours))) {
      this.autoConfig.stalePendingHours = Math.max(1, Number(next.stalePendingHours));
    }
    if (Number.isFinite(Number(next.staleInProgressIdleHours))) {
      this.autoConfig.staleInProgressIdleHours = Math.max(1, Number(next.staleInProgressIdleHours));
    }

    if (!this.autoConfig.enabled) {
      this.stop();
      return this.getState();
    }

    this.disabledReason = null;
    if (!prevEnabled && this.autoConfig.enabled) {
      this.consecutiveFailures = 0;
      this.lastError = null;
    }

    const nextInterval = Number(this.autoConfig.intervalMs) || 90000;
    const shouldRestartTimer = this.timer && prevInterval !== nextInterval;
    if (shouldRestartTimer) {
      this.stop();
      this.start();
      return this.getState();
    }

    if (!this.timer) {
      this.start();
    }
    return this.getState();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.runtime.setChannelHealth("autonomous", false);
    this.emit("autonomous.loop.stop", {});
  }

  getState() {
    return {
      enabled: !!this.autoConfig.enabled,
      active: !!this.autoConfig.enabled && !this.disabledReason,
      running: this.running,
      lastTickAt: this.lastTickAt,
      lastError: this.lastError,
      consecutiveFailures: this.consecutiveFailures,
      maxConsecutiveFailures: this.getMaxConsecutiveFailures(),
      skippedTicks: this.skippedTicks,
      totalTicks: this.totalTicks,
      disabledReason: this.disabledReason,
      intervalMs: this.autoConfig.intervalMs,
      goal: this.autoConfig.goal || "",
      skipWhenQueueAbove: this.getQueueSkipLimit(),
      stalePendingHours: this.getStalePendingHours(),
      staleInProgressIdleHours: this.getStaleInProgressIdleHours(),
      taskHealth: this.runtime?.backgroundManager?.getHealth?.() || null,
    };
  }
}
