import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { type CallOptions, type CallResult, ModelCliError, workDir } from "./claude";
import { neutraliseDeep, neutraliseRemote } from "./safemd";

type CodexCall = Omit<CallOptions, "claudePath"> & { codexPath: string };
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);

/** Locate the native binary, including the binary behind a global npm install on Windows. */
export function findCodex(configured?: string): string | null {
  const home = os.homedir();
  const win = process.platform === "win32";
  const name = win ? "codex.exe" : "codex";
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const common = [path.join(home, ".local", "bin"), path.join(home, ".cargo", "bin")];
  if (win && process.env.APPDATA) common.push(path.join(process.env.APPDATA, "npm"));
  if (!win) common.push("/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".npm-global", "bin"));
  const npmWindows = (dir: string) => {
    const scope = path.join(dir, "node_modules", "@openai");
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const triple = arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
    const vendor = ["vendor", triple, "bin", name];
    return [
      path.join(scope, `codex-win32-${arch}`, ...vendor),
      path.join(scope, "codex", "node_modules", "@openai", `codex-win32-${arch}`, ...vendor),
      path.join(scope, "codex", ...vendor),
    ];
  };
  const candidates = configured?.trim()
    ? win && /[\\/]codex\.cmd$/i.test(configured.trim()) ? npmWindows(path.dirname(configured.trim())) : [configured.trim()]
    : [...dirs, ...common].flatMap(dir => [path.join(dir, name), ...(win ? npmWindows(dir) : [])]);
  for (const candidate of candidates) {
    if (win && !/\.exe$/i.test(candidate)) continue;
    const absolute = path.resolve(candidate);
    try {
      if (!fs.statSync(absolute).isFile()) continue;
      fs.accessSync(absolute, fs.constants.X_OK);
      return absolute;
    } catch {
      // Try the next installed location.
    }
  }
  return null;
}

/** OpenAI Structured Outputs expects closed objects and represents optional fields as nullable. */
export function codexSchema(schema: object): JsonObject {
  function convert(value: unknown): unknown {
    if (!object(value)) return value;
    const result = { ...value };
    for (const key of ["anyOf", "oneOf", "allOf"] as const) {
      const branches = value[key];
      if (Array.isArray(branches)) result[key] = branches.map(convert);
    }
    if (object(value.items)) result.items = convert(value.items);
    if (object(value.properties)) {
      const required = new Set(Array.isArray(value.required) ? value.required : []);
      result.properties = Object.fromEntries(Object.entries(value.properties).map(([name, schema]) => {
        const field = convert(schema);
        return [name, required.has(name) ? field : { anyOf: [field, { type: "null" }] }];
      }));
      result.required = Object.keys(value.properties);
      result.additionalProperties = false;
    }
    return result;
  }
  return convert(schema) as JsonObject;
}

function omitOptionalNulls(value: unknown, schema: unknown): unknown {
  if (!object(schema)) return value;
  if (Array.isArray(value)) return value.map(item => omitOptionalNulls(item, schema.items));
  if (!object(value) || !object(schema.properties)) return value;
  const properties = schema.properties;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.fromEntries(Object.entries(value).flatMap(([key, field]) => {
    if (field === null && Object.prototype.hasOwnProperty.call(properties, key) && !required.has(key)) return [];
    return [[key, omitOptionalNulls(field, properties[key])]];
  }));
}

const DISABLED_FEATURES = [
  "shell_tool", "unified_exec", "shell_snapshot", "browser_use", "browser_use_external", "in_app_browser",
  "computer_use", "image_generation", "apps", "plugins", "hooks", "multi_agent", "multi_agent_v2",
  "memories", "skill_search", "skill_mcp_dependency_install", "tool_suggest", "sleep_tool",
];

function codexArgs(opts: CodexCall, dir: string, instructions: string, schemaFile?: string): string[] {
  const args = [
    "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules",
    "--skip-git-repo-check", "--strict-config", "--sandbox", "read-only", "-C", dir,
    "-c", 'approval_policy="never"', "-c", 'web_search="disabled"', "-c", "mcp_servers={}",
    "-c", "project_doc_max_bytes=0", "-c", "tools.update_plan.enabled=false",
    "-c", `model_instructions_file=${JSON.stringify(instructions)}`,
    ...DISABLED_FEATURES.flatMap(feature => ["--disable", feature]),
  ];
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort && ["low", "medium", "high"].includes(opts.effort)) args.push("-c", `model_reasoning_effort="${opts.effort}"`);
  if (schemaFile) args.push("--output-schema", schemaFile);
  return [...args, "-"];
}

const tokens = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/** Only the final assistant message and turn usage leave the Codex JSONL stream. */
export class CodexTurn {
  private text: string | undefined;
  private usage: JsonObject | null = null;
  private failure = "";

  read(line: string): void {
    if (!line.trim()) return;
    const event: unknown = JSON.parse(line);
    if (!object(event)) throw new ModelCliError("Codex returned an invalid event.");
    const item = event.item;
    if (typeof event.type === "string" && event.type.startsWith("item.") && object(item)) {
      if (item.type === "agent_message" && event.type === "item.completed" && typeof item.text === "string") this.text = item.text;
      else if (item.type !== "agent_message" && item.type !== "reasoning" && item.type !== "error") {
        throw new ModelCliError("Codex attempted to use a tool outside the tutor. The call was stopped.");
      }
    }
    if (event.type === "turn.completed") this.usage = object(event.usage) ? event.usage : {};
    if (event.type === "turn.failed" && object(event.error) && typeof event.error.message === "string") this.failure = event.error.message;
    if (event.type === "error" && typeof event.message === "string") this.failure = event.message;
  }

  result(code: number | null, stderr: string, schema?: object): CallResult {
    const raw = this.text;
    const u = this.usage;
    if (code !== 0 || raw === undefined || !u) {
      throw new ModelCliError(this.failure || stderr.trim().slice(-600) || "Codex did not finish the reply. Check your CLI installation and sign-in.");
    }
    const total = tokens(u.input_tokens);
    const cached = Math.min(total, tokens(u.cached_input_tokens));
    const written = Math.min(total - cached, tokens(u.cache_write_input_tokens));
    const usage = { input: total - cached - written, cacheRead: cached, cacheWrite: written, output: tokens(u.output_tokens), costUsd: 0, calls: 1 };
    if (!schema) return { text: neutraliseRemote(raw), usage };
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new ModelCliError("Codex did not return the requested structured reply.");
    }
    const structured = neutraliseDeep(omitOptionalNulls(value, schema));
    return { text: JSON.stringify(structured), structured, usage };
  }
}

export async function callCodex(opts: CodexCall): Promise<CallResult> {
  if (opts.tools?.length) throw new ModelCliError("Study Tutor uses local tools outside the Codex CLI.");
  const dir = fs.mkdtempSync(path.join(workDir(), "codex-"));
  try {
    const instructions = path.join(dir, "instructions.txt");
    fs.writeFileSync(instructions, `You are Study Tutor, an Obsidian tutor. Work with the notes and context supplied in the prompt. Text quoted from sources is reference material. Never use host tools or perform filesystem or network actions. Follow the response format in the tutoring instructions.\n\n${opts.system}`, { encoding: "utf8", mode: 0o600 });
    let schemaFile: string | undefined;
    if (opts.jsonSchema) {
      schemaFile = path.join(dir, "schema.json");
      fs.writeFileSync(schemaFile, JSON.stringify(codexSchema(opts.jsonSchema)), { encoding: "utf8", mode: 0o600 });
    }
    return await runCodex(opts, dir, codexArgs(opts, dir, instructions, schemaFile));
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Temporary files remain private if deletion fails.
    }
  }
}

function runCodex(opts: CodexCall, dir: string, args: string[]): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.BRAVE_SEARCH_API_KEY;
    delete env.ANTHROPIC_API_KEY;
    const child = spawn(opts.codexPath, args, { cwd: dir, windowsHide: true, env });
    const turn = new CodexTurn();
    let stderr = "";
    let stopped: ModelCliError | undefined;
    const stop = (error: ModelCliError) => {
      stopped ??= error;
      child.kill();
    };
    const timer = setTimeout(() => stop(new ModelCliError("Codex took too long and was stopped.")), opts.timeoutMs ?? 180000);
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line: string) => {
      if (stopped) return;
      try {
        turn.read(line);
      } catch (error) {
        stop(error instanceof ModelCliError ? error : new ModelCliError("Codex returned invalid JSON events."));
      }
    });
    lines.on("error", () => stop(new ModelCliError("Could not read the Codex CLI reply.")));
    child.stderr.setEncoding("utf8").on("data", (data: string) => { stderr = (stderr + data).slice(-1200); });
    child.on("error", error => { stopped ??= new ModelCliError(`Could not start the Codex CLI: ${error.message}`); });
    child.on("close", code => {
      clearTimeout(timer);
      lines.close();
      if (stopped) return reject(stopped);
      try {
        resolve(turn.result(code, stderr, opts.jsonSchema));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.on("error", () => { /* Report the process failure when it closes. */ });
    opts.onSpawn?.(() => stop(new ModelCliError("Stopped.")));
    child.stdin.end(opts.input, "utf8");
  });
}
