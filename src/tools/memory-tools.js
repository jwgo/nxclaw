import { Type } from "@sinclair/typebox";

function text(value) {
  return [{ type: "text", text: String(value ?? "") }];
}

const memorySearchSchema = Type.Object({
  query: Type.String({ minLength: 1 }),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
});

const memoryNoteSchema = Type.Object({
  title: Type.String({ minLength: 1 }),
  content: Type.String({ minLength: 1 }),
  tags: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 12 })),
});

const memoryCompactSchema = Type.Object({
  reason: Type.Optional(Type.String({ minLength: 1 })),
});

const soulReadSchema = Type.Object({});

const soulWriteSchema = Type.Object({
  content: Type.String({ minLength: 1 }),
  mode: Type.Optional(Type.String({ enum: ["append", "replace"] })),
  title: Type.Optional(Type.String({ minLength: 1 })),
  journal: Type.Optional(Type.Boolean()),
});

const syncSchema = Type.Object({
  force: Type.Optional(Type.Boolean()),
  reason: Type.Optional(Type.String({ minLength: 1 })),
});

const statusSchema = Type.Object({});

export function createMemoryTools({ memoryStore }) {
  return [
    {
      name: "nx_memory_search",
      label: "Memory Search",
      description: "Search long-term, recent, and soul memory entries for context.",
      parameters: memorySearchSchema,
      execute: async (_id, params) => {
        const result = await memoryStore.search(params.query, params.limit ?? 8);
        const body =
          result.length > 0
            ? result
                .map((entry) => {
                  const title = entry.title ? `[${entry.title}] ` : "";
                  return `- ${title}${String(entry.content).slice(0, 220)}`;
                })
                .join("\n")
            : "No memory matches found.";

        return { content: text(body), details: result };
      },
    },
    {
      name: "nx_memory_note",
      label: "Memory Note",
      description: "Store explicit long-term memory note.",
      parameters: memoryNoteSchema,
      execute: async (_id, params) => {
        const entry = await memoryStore.addLongTermNote({
          title: params.title,
          content: params.content,
          tags: params.tags ?? [],
          source: "agent_tool",
        });
        return {
          content: text(`Long-term note saved: ${entry?.id ?? "unknown"}`),
          details: entry,
        };
      },
    },
    {
      name: "nx_memory_compact",
      label: "Memory Compact",
      description: "Compact old raw memory into long-term summarized memory and markdown snapshots.",
      parameters: memoryCompactSchema,
      execute: async (_id, params) => {
        const compacted = await memoryStore.compact({ reason: params.reason || "agent_tool" });
        if (!compacted) {
          return { content: text("No compaction needed."), details: { changed: false } };
        }

        return {
          content: text(
            `Compacted ${compacted.compactedCount} entries. Raw remaining: ${compacted.remainingRaw}`,
          ),
          details: compacted,
        };
      },
    },
    {
      name: "nx_memory_soul_read",
      label: "Memory Soul Read",
      description: "Read persistent SOUL.md memory core.",
      parameters: soulReadSchema,
      execute: async () => {
        const soul = await memoryStore.readSoul();
        return {
          content: text(soul || "SOUL.md is empty."),
          details: { chars: soul.length },
        };
      },
    },
    {
      name: "nx_memory_soul_write",
      label: "Memory Soul Write",
      description: "Write persistent SOUL.md and optionally add a soul journal entry.",
      parameters: soulWriteSchema,
      execute: async (_id, params) => {
        const mode = params.mode === "replace" ? "replace" : "append";
        const result = await memoryStore.writeSoul({ content: params.content, mode });

        let journal = null;
        if (params.journal ?? true) {
          journal = await memoryStore.appendSoulJournal({
            title: params.title || "Soul Update",
            content: params.content,
            source: "memory-tool",
          });
        }

        return {
          content: text(`SOUL updated (mode=${mode}, changed=${result.changed})`),
          details: { result, journal },
        };
      },
    },
    {
      name: "nx_memory_sync",
      label: "Memory Sync",
      description: "Force/schedule markdown memory index sync with embedding refresh.",
      parameters: syncSchema,
      execute: async (_id, params) => {
        await memoryStore.syncKnowledgeIndex({
          force: params.force ?? false,
          reason: params.reason || "memory_tool",
        });
        const stats = memoryStore.getStats();
        return {
          content: text(
            `Memory sync complete. chunks=${stats.indexChunks} files=${stats.indexFiles} dirty=${stats.indexDirty}`,
          ),
          details: stats,
        };
      },
    },
    {
      name: "nx_memory_status",
      label: "Memory Status",
      description:
        "Read memory status: long-term files, vector index, embedding cache, and session memory.",
      parameters: statusSchema,
      execute: async () => {
        const stats = memoryStore.getStats();
        return {
          content: text(JSON.stringify(stats, null, 2)),
          details: stats,
        };
      },
    },
  ];
}
