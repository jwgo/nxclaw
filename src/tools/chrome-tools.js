import { Type } from "@sinclair/typebox";

function text(value) {
  return [{ type: "text", text: String(value ?? "") }];
}

const listSchema = Type.Object({});
const openSchema = Type.Object({
  url: Type.Optional(Type.String({ minLength: 1 })),
});

const navSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  url: Type.String({ minLength: 1 }),
});

const clickSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  selector: Type.String({ minLength: 1 }),
});

const typeSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  selector: Type.String({ minLength: 1 }),
  text: Type.String(),
  clear: Type.Optional(Type.Boolean()),
});

const waitSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  selector: Type.String({ minLength: 1 }),
  timeoutMs: Type.Optional(Type.Number({ minimum: 1, maximum: 120000 })),
});

const extractSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  selector: Type.String({ minLength: 1 }),
});

const evalSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  script: Type.String({ minLength: 1 }),
});

const shotSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  fileName: Type.Optional(Type.String({ minLength: 1 })),
});

const closeSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
});

const snapshotSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  includeInvisible: Type.Optional(Type.Boolean()),
  maxElements: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
});

const clickRefSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  ref: Type.Integer({ minimum: 1 }),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 120000 })),
});

const typeRefSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  ref: Type.Integer({ minimum: 1 }),
  text: Type.String(),
  clear: Type.Optional(Type.Boolean()),
  pressEnter: Type.Optional(Type.Boolean()),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 120000 })),
});

export function createChromeTools({ chromeController }) {
  return [
    {
      name: "nx_chrome_session_list",
      label: "Chrome List Sessions",
      description: "List active persistent browser sessions.",
      parameters: listSchema,
      execute: async () => {
        const sessions = chromeController.listSessions();
        const body =
          sessions.length > 0
            ? sessions.map((s) => `${s.id} | ${s.title} | ${s.url}`).join("\n")
            : "No active chrome sessions.";
        return { content: text(body), details: sessions };
      },
    },
    {
      name: "nx_chrome_session_open",
      label: "Chrome Open Session",
      description: "Open a persistent browser session.",
      parameters: openSchema,
      execute: async (_id, params) => {
        const session = await chromeController.openSession({ url: params.url || "about:blank" });
        return {
          content: text(`Chrome session opened: ${session.id}`),
          details: session,
        };
      },
    },
    {
      name: "nx_chrome_session_navigate",
      label: "Chrome Navigate",
      description: "Navigate Chrome session to URL.",
      parameters: navSchema,
      execute: async (_id, params) => {
        const result = await chromeController.navigate(params);
        return { content: text(`${result.id} -> ${result.url}`), details: result };
      },
    },
    {
      name: "nx_chrome_session_snapshot",
      label: "Chrome Snapshot",
      description:
        "Analyze page and assign numbered refs to actionable elements. Use refs with click_ref/type_ref tools.",
      parameters: snapshotSchema,
      execute: async (_id, params) => {
        const result = await chromeController.snapshot(params);
        const rows = result.elements.slice(0, 25).map((el) => {
          const label = el.text || el.ariaLabel || el.placeholder || el.href || "(no label)";
          return `ref ${el.ref} | <${el.tag}> | ${label}`;
        });
        const suffix = result.count > rows.length ? `\n... +${result.count - rows.length} more` : "";
        const body = [
          `snapshot: ${result.id}`,
          `url: ${result.url}`,
          `elements: ${result.count} (cdp-dom-nodes: ${result.domNodeCount ?? "n/a"})`,
          ...rows,
        ].join("\n");
        return { content: text(`${body}${suffix}`), details: result };
      },
    },
    {
      name: "nx_chrome_session_click_ref",
      label: "Chrome Click Ref",
      description: "Click element by snapshot ref number.",
      parameters: clickRefSchema,
      execute: async (_id, params) => {
        const result = await chromeController.clickByRef(params);
        return { content: text(`Clicked ref ${result.ref}`), details: result };
      },
    },
    {
      name: "nx_chrome_session_type_ref",
      label: "Chrome Type Ref",
      description: "Type text into element by snapshot ref number.",
      parameters: typeRefSchema,
      execute: async (_id, params) => {
        const result = await chromeController.typeByRef(params);
        return { content: text(`Typed ${result.chars} chars into ref ${result.ref}`), details: result };
      },
    },
    {
      name: "nx_chrome_session_click",
      label: "Chrome Click",
      description: "Click selector in session page.",
      parameters: clickSchema,
      execute: async (_id, params) => {
        const result = await chromeController.click(params);
        return { content: text(`Clicked ${result.clicked}`), details: result };
      },
    },
    {
      name: "nx_chrome_session_type",
      label: "Chrome Type",
      description: "Type text into selector in session page.",
      parameters: typeSchema,
      execute: async (_id, params) => {
        const result = await chromeController.type(params);
        return { content: text(`Typed ${result.chars} chars into ${result.typed}`), details: result };
      },
    },
    {
      name: "nx_chrome_session_wait",
      label: "Chrome Wait Selector",
      description: "Wait for selector to appear in session page.",
      parameters: waitSchema,
      execute: async (_id, params) => {
        const result = await chromeController.waitFor(params);
        return { content: text(`Selector found: ${result.selector}`), details: result };
      },
    },
    {
      name: "nx_chrome_session_extract",
      label: "Chrome Extract Text",
      description: "Extract text from selector.",
      parameters: extractSchema,
      execute: async (_id, params) => {
        const result = await chromeController.extractText(params);
        return { content: text(result.text || ""), details: result };
      },
    },
    {
      name: "nx_chrome_session_eval",
      label: "Chrome Evaluate",
      description: "Run JS in current page context.",
      parameters: evalSchema,
      execute: async (_id, params) => {
        const result = await chromeController.evaluate(params);
        return { content: text(result.result), details: result };
      },
    },
    {
      name: "nx_chrome_session_screenshot",
      label: "Chrome Screenshot",
      description: "Capture screenshot from session page.",
      parameters: shotSchema,
      execute: async (_id, params) => {
        const result = await chromeController.screenshot(params);
        return { content: text(`Screenshot saved: ${result.path}`), details: result };
      },
    },
    {
      name: "nx_chrome_session_close",
      label: "Chrome Close Session",
      description: "Close session page and release resources.",
      parameters: closeSchema,
      execute: async (_id, params) => {
        const result = await chromeController.closeSession(params.sessionId);
        return { content: text(`Closed ${result.id}`), details: result };
      },
    },
  ];
}
