import { Type } from "@sinclair/typebox";

function text(value) {
  return [{ type: "text", text: String(value ?? "") }];
}

const addSchema = Type.Object({
  title: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String()),
  priority: Type.Optional(Type.Number({ minimum: 1, maximum: 5 })),
});

const listSchema = Type.Object({
  status: Type.Optional(
    Type.Union([
      Type.Literal("pending"),
      Type.Literal("in_progress"),
      Type.Literal("blocked"),
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("cancelled"),
    ]),
  ),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
});

const updateSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("in_progress"),
    Type.Literal("blocked"),
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("cancelled"),
  ]),
  notes: Type.Optional(Type.String()),
});

export function createObjectiveTools({ objectiveQueue }) {
  return [
    {
      name: "nx_objective_add",
      label: "Objective Add",
      description: "Add a new objective to the autonomous queue.",
      parameters: addSchema,
      execute: async (_id, params) => {
        const objective = await objectiveQueue.add({
          title: params.title,
          description: params.description || "",
          priority: params.priority ?? 3,
          source: "agent_tool",
        });
        return { content: text(`Objective added: ${objective.id}`), details: objective };
      },
    },
    {
      name: "nx_objective_list",
      label: "Objective List",
      description: "List queued objectives.",
      parameters: listSchema,
      execute: async (_id, params) => {
        const rows = objectiveQueue.list({ status: params.status }).slice(0, params.limit ?? 20);
        const summary =
          rows.length > 0
            ? rows.map((row) => `${row.id} | ${row.status} | P${row.priority} | ${row.title}`).join("\n")
            : "No objectives.";
        return { content: text(summary), details: rows };
      },
    },
    {
      name: "nx_objective_update",
      label: "Objective Update",
      description: "Update objective status and notes.",
      parameters: updateSchema,
      execute: async (_id, params) => {
        const next = await objectiveQueue.update({
          id: params.id,
          status: params.status,
          notes: params.notes || "",
        });
        return {
          content: text(`Objective ${next.id} updated: ${next.status}`),
          details: next,
        };
      },
    },
  ];
}
