import { callClaude, findClaude, ModelCliError, type CallOptions, type CallResult } from "./claude";
import { callCodex, findCodex } from "./codex-cli";

export type ModelProvider = "claude" | "codex";
export type ModelRole = "chatModel" | "compileModel" | "utilityModel";
export type ModelRequest = Omit<CallOptions, "claudePath">;

const codexFields = {
  chatModel: "codexChatModel", compileModel: "codexCompileModel", utilityModel: "codexUtilityModel",
} as const;

export type ModelProviderSettings = Record<ModelRole, string> & {
  modelProvider?: ModelProvider;
  claudePath: string;
  codexPath?: string;
  codexChatModel?: string;
  codexCompileModel?: string;
  codexUtilityModel?: string;
};

export const MODEL_PROVIDERS: Record<ModelProvider, string> = { claude: "Claude Code", codex: "Codex CLI (ChatGPT)" };
export const providerFor = (settings: ModelProviderSettings): ModelProvider => settings.modelProvider === "codex" ? "codex" : "claude";

export function modelFor(settings: ModelProviderSettings, role: ModelRole): string {
  return providerFor(settings) === "codex" ? settings[codexFields[role]]?.trim() ?? "" : settings[role];
}

export function modelCliPath(settings: ModelProviderSettings): string | null {
  return providerFor(settings) === "codex" ? findCodex(settings.codexPath) : findClaude(settings.claudePath);
}

export async function callModel(settings: ModelProviderSettings, request: ModelRequest): Promise<CallResult> {
  const cli = modelCliPath(settings);
  const provider = providerFor(settings);
  if (!cli) {
    throw new ModelCliError(provider === "codex"
      ? "Codex CLI not found. Install it or set its path in Study Tutor settings."
      : "Claude Code CLI not found. Install it or set its path in Study Tutor settings.");
  }
  return provider === "codex" ? callCodex({ ...request, codexPath: cli }) : callClaude({ ...request, claudePath: cli });
}
