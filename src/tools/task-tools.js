import { Type } from "@sinclair/typebox";

function text(value) {
  return [{ type: "text", text: String(value ?? "") }];
}

const runSchema = Type.Object({
  command: Type.String({ minLength: 1 }),
  cwd: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number({ minimum: 0, maximum: 3600000 })),
  dedupeRunning: Type.Optional(Type.Boolean()),
  maxRetries: Type.Optional(Type.Number({ minimum: 0, maximum: 20 })),
  retryDelayMs: Type.Optional(Type.Number({ minimum: 250, maximum: 3600000 })),
});

const startSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1 })),
  command: Type.String({ minLength: 1 }),
  cwd: Type.Optional(Type.String()),
  dedupeRunning: Type.Optional(Type.Boolean()),
  maxRetries: Type.Optional(Type.Number({ minimum: 0, maximum: 20 })),
  retryDelayMs: Type.Optional(Type.Number({ minimum: 250, maximum: 3600000 })),
});

const enqueueSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1 })),
  command: Type.String({ minLength: 1 }),
  cwd: Type.Optional(Type.String()),
  maxRetries: Type.Optional(Type.Number({ minimum: 0, maximum: 20 })),
  retryDelayMs: Type.Optional(Type.Number({ minimum: 250, maximum: 3600000 })),
});

const scheduleSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1 })),
  command: Type.String({ minLength: 1 }),
  cwd: Type.Optional(Type.String()),
  intervalMs: Type.Number({ minimum: 1000 }),
  maxRetries: Type.Optional(Type.Number({ minimum: 0, maximum: 20 })),
  retryDelayMs: Type.Optional(Type.Number({ minimum: 250, maximum: 3600000 })),
});

const listSchema = Type.Object({
  includeFinished: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
});

const stopSchema = Type.Object({
  taskId: Type.String({ minLength: 1 }),
});

const logsSchema = Type.Object({
  taskId: Type.String({ minLength: 1 }),
  lines: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
});

const healthSchema = Type.Object({});
const queueSchema = Type.Object({
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
});

export function createTaskTools({ backgroundManager }) {
  return [
    {
      name: "nx_terminal_exec",
      label: "Terminal Exec",
      description: "Run one terminal command and wait for completion.",
      parameters: runSchema,
      execute: async (_id, params) => {
        const task = await backgroundManager.runCommand({
          name: "terminal.exec",
          command: params.command,
          cwd: params.cwd || process.cwd(),
          timeoutMs: params.timeoutMs ?? 0,
          background: false,
          dedupeRunning: params.dedupeRunning ?? false,
          maxRetries: params.maxRetries ?? 0,
          retryDelayMs: params.retryDelayMs,
        });

        const log = await backgroundManager.tail(task.id, 40);
        const message = [
          `Task: ${task.id}`,
          `Status: ${task.status}`,
          `Exit code: ${task.exitCode}`,
          "Output:",
          ...log.lines,
        ].join("\n");

        return { content: text(message), details: { task, log } };
      },
    },
    {
      name: "nx_terminal_start",
      label: "Terminal Start Background",
      description: "Start a long-running command in background and track it.",
      parameters: startSchema,
      execute: async (_id, params) => {
        const task = await backgroundManager.runCommand({
          name: params.name || "terminal.background",
          command: params.command,
          cwd: params.cwd || process.cwd(),
          background: true,
          dedupeRunning: params.dedupeRunning ?? true,
          queueIfBusy: true,
          maxRetries: params.maxRetries,
          retryDelayMs: params.retryDelayMs,
        });

        return {
          content: text(`Background task started: ${task.id}`),
          details: task,
        };
      },
    },
    {
      name: "nx_terminal_enqueue",
      label: "Terminal Enqueue",
      description:
        "Queue command for managed execution with bounded parallelism and retry policy.",
      parameters: enqueueSchema,
      execute: async (_id, params) => {
        const task = await backgroundManager.enqueueCommand({
          name: params.name || "terminal.queue",
          command: params.command,
          cwd: params.cwd || process.cwd(),
          maxRetries: params.maxRetries,
          retryDelayMs: params.retryDelayMs,
        });
        return {
          content: text(`Queued task: ${task.id}`),
          details: task,
        };
      },
    },
    {
      name: "nx_terminal_schedule",
      label: "Terminal Schedule",
      description: "Schedule recurring command execution.",
      parameters: scheduleSchema,
      execute: async (_id, params) => {
        const task = await backgroundManager.scheduleCommand({
          name: params.name || "terminal.schedule",
          command: params.command,
          cwd: params.cwd || process.cwd(),
          intervalMs: params.intervalMs,
          maxRetries: params.maxRetries,
          retryDelayMs: params.retryDelayMs,
        });

        return {
          content: text(`Scheduled task created: ${task.id}`),
          details: task,
        };
      },
    },
    {
      name: "nx_terminal_list",
      label: "Terminal List Tasks",
      description: "List tracked terminal tasks.",
      parameters: listSchema,
      execute: async (_id, params) => {
        const rows = backgroundManager
          .list({ includeFinished: params.includeFinished ?? true })
          .slice(0, params.limit ?? 50);

        const view =
          rows.length > 0
            ? rows
                .map(
                  (row) =>
                    `${row.id} | ${row.type} | ${row.status} | ${row.name} | ${row.command || ""}`,
                )
                .join("\n")
            : "No tasks.";

        return { content: text(view), details: rows };
      },
    },
    {
      name: "nx_terminal_stop",
      label: "Terminal Stop",
      description: "Stop task by id.",
      parameters: stopSchema,
      execute: async (_id, params) => {
        const ok = await backgroundManager.stop(params.taskId);
        return {
          content: text(ok ? `Stopped ${params.taskId}` : `Task not found: ${params.taskId}`),
          details: { taskId: params.taskId, stopped: ok },
        };
      },
    },
    {
      name: "nx_terminal_logs",
      label: "Terminal Logs",
      description: "Read recent logs of a task.",
      parameters: logsSchema,
      execute: async (_id, params) => {
        const result = await backgroundManager.tail(params.taskId, params.lines ?? 80);
        if (!result.task) {
          return {
            content: text(`Task not found: ${params.taskId}`),
            details: result,
          };
        }

        const body = [
          `Task: ${result.task.id}`,
          `Status: ${result.task.status}`,
          "Logs:",
          ...result.lines,
        ].join("\n");

        return {
          content: text(body),
          details: result,
        };
      },
    },
    {
      name: "nx_terminal_health",
      label: "Terminal Health",
      description: "Read task manager health and runtime pressure stats.",
      parameters: healthSchema,
      execute: async () => {
        const health = backgroundManager.getHealth();
        return {
          content: text(JSON.stringify(health, null, 2)),
          details: health,
        };
      },
    },
    {
      name: "nx_terminal_queue",
      label: "Terminal Queue",
      description: "Inspect pending queued terminal tasks.",
      parameters: queueSchema,
      execute: async (_id, params) => {
        const rows = backgroundManager.getQueueSnapshot(params.limit ?? 80);
        const body =
          rows.length > 0
            ? rows
                .map(
                  (row) =>
                    `${row.taskId} | ${row.status} | attempts=${row.attempts}/${row.maxRetries} | retryAt=${row.retryAt}`,
                )
                .join("\n")
            : "Queue is empty.";
        return { content: text(body), details: rows };
      },
    },
  ];
}
