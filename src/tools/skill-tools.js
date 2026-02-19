import { Type } from "@sinclair/typebox";

function text(value) {
  return [{ type: "text", text: String(value ?? "") }];
}

const emptySchema = Type.Object({});

const installSchema = Type.Object({
  source: Type.String({ minLength: 1 }),
  id: Type.Optional(Type.String({ minLength: 1 })),
  enable: Type.Optional(Type.Boolean()),
});

const skillIdSchema = Type.Object({
  skillId: Type.String({ minLength: 1 }),
});

const readSchema = Type.Object({
  skillId: Type.String({ minLength: 1 }),
  maxChars: Type.Optional(Type.Number({ minimum: 200, maximum: 12000 })),
});

export function createSkillTools({ skillManager }) {
  return [
    {
      name: "nx_skill_catalog",
      label: "Skill Catalog",
      description: "List available local/catalog skills for one-click install.",
      parameters: emptySchema,
      execute: async () => {
        const items = await skillManager.refreshCatalog();
        const lines =
          items.length > 0
            ? items.map((item) => `${item.id} | ${item.name} | installed=${item.installed}`).join("\n")
            : "No skill catalog entries found.";
        return { content: text(lines), details: items };
      },
    },
    {
      name: "nx_skill_list",
      label: "Skill List",
      description: "List installed skills and enabled state.",
      parameters: emptySchema,
      execute: async () => {
        await skillManager.init();
        const items = skillManager.listInstalled();
        const lines =
          items.length > 0
            ? items
                .map(
                  (item) =>
                    `${item.id} | ${item.enabled ? "enabled" : "disabled"} | ${item.name || ""}`,
                )
                .join("\n")
            : "No installed skills.";
        return { content: text(lines), details: items };
      },
    },
    {
      name: "nx_skill_install",
      label: "Skill Install",
      description:
        "Install skill from catalog id, local path, or GitHub source (owner/repo[/subpath]).",
      parameters: installSchema,
      execute: async (_id, params) => {
        const installed = await skillManager.installSkill({
          source: params.source,
          id: params.id || "",
          enable: params.enable,
        });
        return {
          content: text(`Installed skill: ${installed.id} (enabled=${installed.enabled})`),
          details: installed,
        };
      },
    },
    {
      name: "nx_skill_enable",
      label: "Skill Enable",
      description: "Enable installed skill.",
      parameters: skillIdSchema,
      execute: async (_id, params) => {
        const item = await skillManager.setSkillEnabled(params.skillId, true);
        return {
          content: text(`Enabled skill: ${item.id}`),
          details: item,
        };
      },
    },
    {
      name: "nx_skill_disable",
      label: "Skill Disable",
      description: "Disable installed skill.",
      parameters: skillIdSchema,
      execute: async (_id, params) => {
        const item = await skillManager.setSkillEnabled(params.skillId, false);
        return {
          content: text(`Disabled skill: ${item.id}`),
          details: item,
        };
      },
    },
    {
      name: "nx_skill_show",
      label: "Skill Show",
      description: "Read SKILL.md content of installed skill.",
      parameters: readSchema,
      execute: async (_id, params) => {
        const item = await skillManager.readSkill(params.skillId, params.maxChars ?? 3000);
        if (!item) {
          return {
            content: text(`Skill not found: ${params.skillId}`),
            details: { skillId: params.skillId, found: false },
          };
        }
        return {
          content: text(item.content || ""),
          details: item,
        };
      },
    },
  ];
}
