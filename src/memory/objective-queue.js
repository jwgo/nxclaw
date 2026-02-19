import crypto from "node:crypto";
import { readJsonOrDefault, writeJson } from "../utils/fs.js";

const FINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

function now() {
  return new Date().toISOString();
}

function parseIsoMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function normalizeStatus(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (
    ["pending", "in_progress", "blocked", "completed", "failed", "cancelled"].includes(
      normalized,
    )
  ) {
    return normalized;
  }
  return "pending";
}

export class ObjectiveQueue {
  constructor({ path }) {
    this.path = path;
    this.objectives = [];
  }

  async init() {
    await this.reload();
  }

  async reload() {
    const state = await readJsonOrDefault(this.path, { objectives: [] });
    this.objectives = Array.isArray(state.objectives) ? state.objectives : [];
    return this.objectives.length;
  }

  async persist() {
    await writeJson(this.path, { objectives: this.objectives });
  }

  async add({ title, description = "", priority = 3, source = "manual" }) {
    const objective = {
      id: crypto.randomUUID(),
      title: String(title ?? "").trim(),
      description: String(description ?? "").trim(),
      priority: Number.isFinite(Number(priority)) ? Number(priority) : 3,
      status: "pending",
      source,
      createdAt: now(),
      updatedAt: now(),
      runCount: 0,
      lastRunAt: null,
      notes: [],
    };

    if (!objective.title) {
      throw new Error("Objective title is required");
    }

    this.objectives.push(objective);
    await this.persist();
    return objective;
  }

  list({ status } = {}) {
    const normalized = status ? normalizeStatus(status) : null;
    const filtered = normalized
      ? this.objectives.filter((item) => item.status === normalized)
      : [...this.objectives];

    return filtered.sort((a, b) => {
      if (a.status === b.status) {
        if (a.priority === b.priority) {
          return b.updatedAt.localeCompare(a.updatedAt);
        }
        return a.priority - b.priority;
      }
      if (a.status === "in_progress") {
        return -1;
      }
      if (b.status === "in_progress") {
        return 1;
      }
      if (a.status === "pending") {
        return -1;
      }
      if (b.status === "pending") {
        return 1;
      }
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }

  getById(id) {
    return this.objectives.find((item) => item.id === id) ?? null;
  }

  pickForAutonomous() {
    const inProgress = this.objectives
      .filter((item) => item.status === "in_progress")
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    if (inProgress.length > 0) {
      return inProgress[0];
    }

    const pending = this.objectives
      .filter((item) => item.status === "pending")
      .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));

    return pending[0] ?? null;
  }

  async markPicked(id) {
    const objective = this.getById(id);
    if (!objective) {
      return null;
    }

    if (!FINAL_STATUSES.has(objective.status)) {
      objective.status = "in_progress";
      objective.updatedAt = now();
      objective.lastRunAt = now();
      objective.runCount += 1;
      await this.persist();
    }

    return objective;
  }

  async update({ id, status, notes }) {
    const objective = this.getById(id);
    if (!objective) {
      throw new Error(`Objective not found: ${id}`);
    }

    const normalized = normalizeStatus(status);
    objective.status = normalized;
    objective.updatedAt = now();
    if (notes && String(notes).trim()) {
      objective.notes.push({ at: now(), text: String(notes).trim() });
    }

    await this.persist();
    return objective;
  }

  async expireStale({ pendingMaxAgeHours = 24 * 14, inProgressMaxIdleHours = 24 * 3 } = {}) {
    const pendingCutoffMs =
      Number.isFinite(Number(pendingMaxAgeHours)) && Number(pendingMaxAgeHours) > 0
        ? Number(pendingMaxAgeHours) * 60 * 60 * 1000
        : 0;
    const inProgressIdleCutoffMs =
      Number.isFinite(Number(inProgressMaxIdleHours)) && Number(inProgressMaxIdleHours) > 0
        ? Number(inProgressMaxIdleHours) * 60 * 60 * 1000
        : 0;

    const nowMs = Date.now();
    const changed = [];

    for (const objective of this.objectives) {
      if (!objective || FINAL_STATUSES.has(normalizeStatus(objective.status))) {
        continue;
      }
      if (!Array.isArray(objective.notes)) {
        objective.notes = [];
      }

      if (objective.status === "pending" && pendingCutoffMs > 0) {
        const ageMs = nowMs - Math.max(parseIsoMs(objective.createdAt), parseIsoMs(objective.updatedAt));
        if (ageMs > pendingCutoffMs) {
          objective.status = "cancelled";
          objective.updatedAt = now();
          objective.notes.push({
            at: now(),
            text: `auto-cancelled stale pending objective (age=${Math.round(ageMs / (60 * 60 * 1000))}h > ${Math.round(pendingCutoffMs / (60 * 60 * 1000))}h)`,
          });
          changed.push({
            id: objective.id,
            status: objective.status,
            reason: "pending_too_old",
          });
        }
        continue;
      }

      if (objective.status === "in_progress" && inProgressIdleCutoffMs > 0) {
        const idleBaseMs = Math.max(
          parseIsoMs(objective.lastRunAt),
          parseIsoMs(objective.updatedAt),
          parseIsoMs(objective.createdAt),
        );
        const idleMs = nowMs - idleBaseMs;
        if (idleMs > inProgressIdleCutoffMs) {
          objective.status = "blocked";
          objective.updatedAt = now();
          objective.notes.push({
            at: now(),
            text: `auto-blocked stale in_progress objective (idle=${Math.round(idleMs / (60 * 60 * 1000))}h > ${Math.round(inProgressIdleCutoffMs / (60 * 60 * 1000))}h)`,
          });
          changed.push({
            id: objective.id,
            status: objective.status,
            reason: "in_progress_idle_too_long",
          });
        }
      }
    }

    if (changed.length > 0) {
      await this.persist();
    }
    return {
      changedCount: changed.length,
      changed,
      pendingMaxAgeHours:
        pendingCutoffMs > 0 ? Math.round(pendingCutoffMs / (60 * 60 * 1000)) : null,
      inProgressMaxIdleHours:
        inProgressIdleCutoffMs > 0 ? Math.round(inProgressIdleCutoffMs / (60 * 60 * 1000)) : null,
    };
  }

  stats() {
    const tally = {
      pending: 0,
      in_progress: 0,
      blocked: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      total: this.objectives.length,
    };

    for (const item of this.objectives) {
      const key = normalizeStatus(item.status);
      tally[key] += 1;
    }

    return tally;
  }
}
