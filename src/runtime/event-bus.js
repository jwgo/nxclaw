import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir } from "../utils/fs.js";

export class RuntimeEventBus {
  constructor({ eventsPath, bufferSize = 500, enabled = true, flushIntervalMs = 200, maxFileBytes = 20 * 1024 * 1024 }) {
    this.eventsPath = eventsPath;
    this.bufferSize = Math.max(100, Number(bufferSize) || 500);
    this.enabled = enabled;
    this.flushIntervalMs = Math.max(20, Number(flushIntervalMs) || 200);
    this.maxFileBytes = Math.max(1024 * 1024, Number(maxFileBytes) || 20 * 1024 * 1024);
    this.seq = 0;
    this.listeners = new Set();
    this.buffer = [];
    this.pending = [];
    this.flushTimer = null;
    this.flushInFlight = false;
  }

  async init() {
    if (!this.enabled) {
      return;
    }
    await ensureDir(path.dirname(this.eventsPath));
  }

  on(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  scheduleFlush() {
    if (this.flushTimer || this.flushInFlight) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.flushIntervalMs);
  }

  async rotateIfNeeded(incomingBytes = 0) {
    try {
      const stat = await fs.stat(this.eventsPath);
      if (Number(stat.size || 0) + incomingBytes <= this.maxFileBytes) {
        return;
      }
      const rotated = `${this.eventsPath}.1`;
      await fs.rm(rotated, { force: true }).catch(() => undefined);
      await fs.rename(this.eventsPath, rotated);
    } catch {
      // ignore when file does not exist or rotate fails
    }
  }

  async flush() {
    if (!this.enabled || this.flushInFlight || this.pending.length === 0) {
      return;
    }
    this.flushInFlight = true;
    const batch = this.pending.splice(0);
    try {
      await ensureDir(path.dirname(this.eventsPath));
      const payload = `${batch.map((event) => JSON.stringify(event)).join("\n")}\n`;
      await this.rotateIfNeeded(Buffer.byteLength(payload, "utf8"));
      await fs.appendFile(this.eventsPath, payload, { mode: 0o600 });
    } catch {
      // drop batch on flush failure; in-memory buffer still keeps recent events
    } finally {
      this.flushInFlight = false;
      if (this.pending.length > 0) {
        this.scheduleFlush();
      }
    }
  }

  emit(type, payload = {}) {
    if (!this.enabled) {
      return null;
    }

    const event = {
      seq: (this.seq += 1),
      ts: Date.now(),
      type,
      payload,
    };

    this.buffer.push(event);
    if (this.buffer.length > this.bufferSize) {
      this.buffer.shift();
    }

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {}
    }

    this.pending.push(event);
    this.scheduleFlush();
    return event;
  }

  getRecent(limit = 100) {
    return this.buffer.slice(-Math.max(1, limit));
  }

  async shutdown() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}
