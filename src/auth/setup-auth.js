import { loginGeminiCli, loginOpenAICodex } from "@mariozechner/pi-ai";
import { askText } from "../utils/prompt.js";

const SUPPORTED = new Set(["google-gemini-cli", "openai-codex", "anthropic"]);

export function getSupportedProviders() {
  return [...SUPPORTED];
}

export async function setupAuth({ provider, authStorage }) {
  if (!SUPPORTED.has(provider)) {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  if (provider === "anthropic") {
    const key =
      process.env.ANTHROPIC_API_KEY?.trim() ||
      (await askText("Enter ANTHROPIC_API_KEY:"));

    if (!key) {
      throw new Error("Anthropic API key is required");
    }

    authStorage.set("anthropic", {
      type: "api_key",
      key,
    });

    return { provider, mode: "api_key" };
  }

  if (provider === "google-gemini-cli") {
    const creds = await loginGeminiCli(
      (info) => {
        console.log(`Open this URL for Gemini CLI OAuth:\n${info.url}`);
        if (info.instructions) {
          console.log(info.instructions);
        }
      },
      (msg) => {
        process.stdout.write(`${msg}\n`);
      },
      async () => {
        return await askText("Paste redirect URL/code if browser callback did not complete:");
      },
    );

    authStorage.set("google-gemini-cli", {
      type: "oauth",
      ...creds,
    });

    return { provider, mode: "oauth" };
  }

  const creds = await loginOpenAICodex({
    onAuth: (info) => {
      console.log(`Open this URL for OpenAI Codex OAuth:\n${info.url}`);
      if (info.instructions) {
        console.log(info.instructions);
      }
    },
    onPrompt: async (prompt) => {
      return await askText(prompt.message || "Paste OpenAI OAuth redirect/code:");
    },
    onProgress: (msg) => {
      process.stdout.write(`${msg}\n`);
    },
    onManualCodeInput: async () => {
      return await askText("Paste redirect URL/code if browser callback did not complete:");
    },
  });

  authStorage.set("openai-codex", {
    type: "oauth",
    ...creds,
  });

  return { provider, mode: "oauth" };
}

export async function readAuthStatus(authStorage) {
  return {
    "google-gemini-cli": authStorage.hasAuth("google-gemini-cli"),
    "openai-codex": authStorage.hasAuth("openai-codex"),
    anthropic: authStorage.hasAuth("anthropic"),
  };
}
