import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function percentile(sorted, p) {
  if (!sorted.length) {
    return 0;
  }
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx];
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = String(argv[i] || "");
    if (!key.startsWith("--")) {
      continue;
    }
    const name = key.slice(2);
    const next = argv[i + 1];
    if (!next || String(next).startsWith("--")) {
      out[name] = "true";
      continue;
    }
    out[name] = String(next);
    i += 1;
  }
  return out;
}

function buildMessage(token, sessionId) {
  return [
    "NXCLAW_SOAK_CHECK",
    `session=${sessionId}`,
    `reply_token=${token}`,
    "Reply with the exact token on the first line.",
  ].join("\n");
}

async function fetchJson(baseUrl, route, { method = "GET", body, timeoutMs = 60000 } = {}) {
  const url = new URL(route, baseUrl).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method,
      headers: {
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${JSON.stringify(payload)}`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function extractQueueDepth(stateBody) {
  return Number(stateBody?.queueDepth ?? stateBody?.runtime?.queueDepth ?? 0) || 0;
}

function extractBusy(stateBody) {
  return Boolean(stateBody?.busy ?? stateBody?.runtime?.busy ?? false);
}

function buildSearchRoute({ query, limit = 8, sessionKey, mode = "session_strict" }) {
  const params = new URLSearchParams();
  params.set("q", query);
  params.set("limit", String(limit));
  if (sessionKey) {
    params.set("sessionKey", sessionKey);
  }
  if (mode) {
    params.set("mode", mode);
  }
  return `/api/memory/search?${params.toString()}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = String(args["base-url"] || "http://localhost:3020").trim();
  const minutes = clamp(toNumber(args.minutes, 60), 1, 24 * 12);
  const parallel = clamp(toNumber(args.parallel, 3), 1, 20);
  const sessionCount = clamp(toNumber(args["session-count"], 4), 2, 40);
  const intervalMs = clamp(toNumber(args["interval-ms"], 2000), 200, 60000);
  const syncEvery = clamp(toNumber(args["sync-every"], 10), 1, 500);
  const timeoutMs = clamp(toNumber(args.timeout, 90000), 5000, 300000);

  const runId = `soak-${Date.now().toString(36)}`;
  const startedAt = nowIso();
  const durationMs = minutes * 60 * 1000;
  const deadline = Date.now() + durationMs;
  const sessionIds = Array.from({ length: sessionCount }, (_, i) => `${runId}-s${i + 1}`);
  const issuedTokens = new Map();
  const latencies = [];
  const errors = [];
  const leakFindings = [];

  let promptTotal = 0;
  let promptOk = 0;
  let promptFailed = 0;
  let echoMiss = 0;
  let strictHitOk = 0;
  let strictHitMiss = 0;
  let strictLeaks = 0;
  let stateFailures = 0;
  let syncFailures = 0;
  let maxQueueDepth = 0;
  let maxBusyStreak = 0;
  let busyStreak = 0;
  let iterations = 0;
  let memoryInitial = null;
  let memoryLast = null;

  try {
    await fetchJson(baseUrl, "/api/state", { timeoutMs });
  } catch (error) {
    console.error(`runtime unavailable at ${baseUrl}: ${String(error?.message || error)}`);
    process.exit(1);
  }

  try {
    const s = await fetchJson(baseUrl, "/api/memory/stats", { timeoutMs });
    memoryInitial = s?.stats || null;
  } catch (error) {
    errors.push(`memory stats init failed: ${String(error?.message || error)}`);
  }

  for (const sessionId of sessionIds) {
    try {
      await fetchJson(baseUrl, "/api/sessions", {
        method: "POST",
        timeoutMs,
        body: {
          source: "dashboard",
          channelId: "dashboard",
          userId: "soak",
          sessionId,
        },
      });
    } catch (error) {
      errors.push(`session create failed (${sessionId}): ${String(error?.message || error)}`);
    }
  }

  async function runOne(sessionId, iteration, slot) {
    const token = `SOAK_${runId}_${iteration}_${slot}_${Math.random().toString(36).slice(2, 8)}`;
    const started = Date.now();
    promptTotal += 1;

    try {
      const promptBody = await fetchJson(baseUrl, "/api/prompt", {
        method: "POST",
        timeoutMs,
        body: {
          sessionId,
          message: buildMessage(token, sessionId),
        },
      });
      const latencyMs = Date.now() - started;
      latencies.push(latencyMs);
      promptOk += 1;

      const reply = String(promptBody?.reply || "");
      if (!reply.includes(token)) {
        echoMiss += 1;
      }
      issuedTokens.set(sessionId, token);

      const strictMine = await fetchJson(
        baseUrl,
        buildSearchRoute({
          query: token,
          sessionKey: sessionId,
          mode: "session_strict",
          limit: 10,
        }),
        { timeoutMs },
      );
      const myHits = Array.isArray(strictMine?.items) ? strictMine.items.length : 0;
      if (myHits > 0) {
        strictHitOk += 1;
      } else {
        strictHitMiss += 1;
      }

      const otherSession = sessionIds.find((id) => id !== sessionId) || "";
      if (otherSession) {
        const strictOther = await fetchJson(
          baseUrl,
          buildSearchRoute({
            query: token,
            sessionKey: otherSession,
            mode: "session_strict",
            limit: 10,
          }),
          { timeoutMs },
        );
        const otherHits = Array.isArray(strictOther?.items) ? strictOther.items.length : 0;
        if (otherHits > 0) {
          strictLeaks += 1;
          leakFindings.push({
            at: nowIso(),
            token,
            sourceSession: sessionId,
            leakedTo: otherSession,
            hits: otherHits,
          });
        }
      }
    } catch (error) {
      promptFailed += 1;
      errors.push(
        `prompt failed (session=${sessionId} iter=${iteration} slot=${slot}): ${String(
          error?.message || error,
        )}`,
      );
    }
  }

  while (Date.now() < deadline) {
    iterations += 1;
    const tickStart = Date.now();
    const jobs = [];

    for (let slot = 0; slot < parallel; slot += 1) {
      const index = (iterations + slot) % sessionIds.length;
      jobs.push(runOne(sessionIds[index], iterations, slot));
    }

    await Promise.all(jobs);

    if (iterations % syncEvery === 0) {
      try {
        await fetchJson(baseUrl, "/api/memory/sync", {
          method: "POST",
          timeoutMs,
          body: {},
        });
      } catch (error) {
        syncFailures += 1;
        errors.push(`memory sync failed (iter=${iterations}): ${String(error?.message || error)}`);
      }
    }

    try {
      const state = await fetchJson(baseUrl, "/api/state", { timeoutMs });
      const depth = extractQueueDepth(state);
      const busy = extractBusy(state);
      if (depth > maxQueueDepth) {
        maxQueueDepth = depth;
      }
      if (busy) {
        busyStreak += 1;
        if (busyStreak > maxBusyStreak) {
          maxBusyStreak = busyStreak;
        }
      } else {
        busyStreak = 0;
      }
    } catch (error) {
      stateFailures += 1;
      errors.push(`state read failed (iter=${iterations}): ${String(error?.message || error)}`);
    }

    const elapsed = Date.now() - tickStart;
    if (elapsed < intervalMs) {
      await sleep(intervalMs - elapsed);
    }
  }

  try {
    const stats = await fetchJson(baseUrl, "/api/memory/stats", { timeoutMs });
    memoryLast = stats?.stats || null;
  } catch (error) {
    errors.push(`memory stats final failed: ${String(error?.message || error)}`);
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const avgLatency = sorted.length
    ? Math.round(sorted.reduce((acc, n) => acc + n, 0) / sorted.length)
    : 0;
  const pass = promptFailed === 0 && strictLeaks === 0 && stateFailures === 0;

  const report = {
    runId,
    startedAt,
    endedAt: nowIso(),
    durationMinutes: minutes,
    baseUrl,
    config: {
      parallel,
      sessionCount,
      intervalMs,
      syncEvery,
      timeoutMs,
    },
    totals: {
      iterations,
      promptTotal,
      promptOk,
      promptFailed,
      echoMiss,
      strictHitOk,
      strictHitMiss,
      strictLeaks,
      stateFailures,
      syncFailures,
      maxQueueDepth,
      maxBusyStreak,
    },
    latencyMs: {
      avg: avgLatency,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      max: sorted.length ? sorted[sorted.length - 1] : 0,
    },
    memory: {
      initial: memoryInitial,
      final: memoryLast,
    },
    sample: {
      issuedTokens: Object.fromEntries(issuedTokens),
      leaks: leakFindings.slice(-20),
      errors: errors.slice(-50),
    },
    pass,
  };

  const here = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(here, "..");
  const outDir = path.join(projectRoot, "canvas", "soak");
  const outPath = path.join(outDir, `soak-report-${Date.now()}.json`);

  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log(JSON.stringify({ ok: pass, reportPath: outPath, report }, null, 2));
  if (!pass) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(String(error?.stack || error));
  process.exit(1);
});
