import { callClaude, findClaude, ModelCliError, type CallOptions, type CallResult } from "./claude";
import { callCodex, findCodex } from "./codex-cli";

export type ModelProvider = "claude" | "codex";
export type ModelRole = "chatModel" | "compileModel" | "utilityModel";
export type ModelRequest = Omit<CallOptions, "claudePath">;
/**
 * Which models compile a course. "main": the configured Claude Code or Codex provider does every
 * stage and Ollama is not used. "hybrid": Ollama selects evidence passages and the main provider
 * does the rest; a local selection whose reply fails its checks goes to the main provider, and the
 * compile reports it. "local": Ollama does every stage and the main provider is never called; a
 * stage the local model cannot do is a gap in the course's coverage.
 */
export type CompileStrategy = "main" | "hybrid" | "local";

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
  /** Unset in settings saved before strategies existed: "hybrid", the split used then. */
  compileStrategy?: CompileStrategy;
};

export const MODEL_PROVIDERS: Record<ModelProvider, string> = { claude: "Claude Code", codex: "Codex CLI (ChatGPT)" };
export const COMPILE_STRATEGIES: Record<CompileStrategy, string> = { main: "Main provider only", hybrid: "Hybrid: Ollama selects passages", local: "Local only: Ollama" };
export const providerFor = (settings: ModelProviderSettings): ModelProvider => settings.modelProvider === "codex" ? "codex" : "claude";
export const compileStrategyFor = (settings: ModelProviderSettings): CompileStrategy =>
  settings.compileStrategy === "main" || settings.compileStrategy === "local" ? settings.compileStrategy : "hybrid";

export function modelFor(settings: ModelProviderSettings, role: ModelRole): string {
  return providerFor(settings) === "codex" ? settings[codexFields[role]]?.trim() ?? "" : settings[role];
}

/**
 * The configured identity of a model: provider and model, with an empty model named as the CLI
 * default. Claude keeps the bare model name that earlier compile checkpoints were keyed by.
 */
const identity = (provider: ModelProvider, model: string) => provider === "codex" ? `codex:${model || "default"}` : model || "claude:default";
export const modelIdentity = (settings: ModelProviderSettings, role: ModelRole): string => identity(providerFor(settings), modelFor(settings, role));

/** The concrete model each configured identity last answered with in this session, as the CLI reported it. */
const reported = new Map<string, string>();
/** The concrete model `identity` last answered with in this session; undefined when no call reported one. */
export const reportedModel = (modelIdentity: string): string | undefined => reported.get(modelIdentity);

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
  const result = await (provider === "codex" ? callCodex({ ...request, codexPath: cli }) : callClaude({ ...request, claudePath: cli }));
  // Any call, a chat turn included, tells compilation which concrete model an alias now means.
  if (result.model) reported.set(identity(provider, request.model), result.model);
  return result;
}
