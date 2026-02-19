function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

export class LaneQueue {
  constructor({ maxDepth = 100, onEvent = null } = {}) {
    this.maxDepth = Math.max(1, toNumber(maxDepth, 100));
    this.onEvent = typeof onEvent === "function" ? onEvent : null;
    this.lanes = new Map();
    this.totalDepth = 0;
  }

  emit(type, payload = {}) {
    if (this.onEvent) {
      this.onEvent(type, payload);
    }
  }

  getDepth() {
    return this.totalDepth;
  }

  getLaneDepth(laneKey) {
    const lane = this.lanes.get(String(laneKey || "default"));
    if (!lane) {
      return 0;
    }
    return lane.depth + lane.active;
  }

  getLaneStats(limit = 16) {
    return [...this.lanes.entries()]
      .map(([key, lane]) => ({
        lane: key,
        depth: lane.depth,
        active: lane.active,
        updatedAt: lane.updatedAt,
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, Math.max(1, Number(limit) || 16));
  }

  async enqueue(rawLaneKey, fn) {
    if (typeof fn !== "function") {
      throw new Error("LaneQueue enqueue requires a function");
    }

    if (this.totalDepth >= this.maxDepth) {
      throw new Error(`lane queue overflow: ${this.totalDepth} >= ${this.maxDepth}`);
    }

    const laneKey = String(rawLaneKey || "default");
    let lane = this.lanes.get(laneKey);
    if (!lane) {
      lane = {
        promise: Promise.resolve(),
        depth: 0,
        active: 0,
        updatedAt: nowIso(),
      };
      this.lanes.set(laneKey, lane);
    }

    lane.depth += 1;
    lane.updatedAt = nowIso();
    this.totalDepth += 1;
    this.emit("lane.enqueue", {
      lane: laneKey,
      laneDepth: lane.depth,
      totalDepth: this.totalDepth,
    });

    const run = lane.promise.then(async () => {
      lane.depth = Math.max(0, lane.depth - 1);
      this.totalDepth = Math.max(0, this.totalDepth - 1);
      lane.active += 1;
      lane.updatedAt = nowIso();
      this.emit("lane.start", {
        lane: laneKey,
        laneDepth: lane.depth,
        active: lane.active,
        totalDepth: this.totalDepth,
      });

      try {
        return await fn();
      } finally {
        lane.active = Math.max(0, lane.active - 1);
        lane.updatedAt = nowIso();
        this.emit("lane.end", {
          lane: laneKey,
          laneDepth: lane.depth,
          active: lane.active,
          totalDepth: this.totalDepth,
        });
        if (lane.depth === 0 && lane.active === 0) {
          this.lanes.delete(laneKey);
        }
      }
    });

    lane.promise = run.catch(() => undefined);
    return await run;
  }
}
