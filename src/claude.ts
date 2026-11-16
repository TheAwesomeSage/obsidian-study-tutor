// Runs the Claude CLI as a stateless, tool-less completion call. Node only, no Obsidian imports.
//
// Why these flags (measured on Claude Code 2.1.311, one "Reply OK" call):
//   default `claude -p`                          ~40,300 input tokens
//   --tools ""                                   ~4,300   (tool definitions gone)
//   + --system-prompt[-file]                     ~1,300   (Claude Code's own system prompt replaced)
//   + --setting-sources ""                       ~1,070   (user CLAUDE.md and settings not loaded)
// --strict-mcp-config and --disable-slash-commands keep MCP servers and skills out as well.
// Calls are stateless (--no-session-persistence); the prompt cache still hits across calls
// when the system prompt is byte-identical, so the stable part goes there.

import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";
import { neutraliseDeep, neutraliseRemote } from "./safemd";

export interface Usage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  costUsd: number;
  calls: number;
}

export const zeroUsage = (): Usage => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0, calls: 0 });

export function addUsage(a: Usage, b: Usage): Usage {
  return { input: a.input + b.input, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, output: a.output + b.output, costUsd: a.costUsd + b.costUsd, calls: a.calls + b.calls };
}

export function usageLine(u: Usage): string {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const totalIn = u.input + u.cacheRead + u.cacheWrite;
  return `${k(totalIn)} tokens in (${k(u.cacheRead)} from cache) · ${k(u.output)} out`;
}

export interface CallOptions {
  claudePath: string;
  model: string;
  system: string;
  input: string;
  effort?: string;
  jsonSchema?: object;
  /** Built-in tools to allow, such as WebSearch. Leave unset for none, which is far cheaper. */
  tools?: string[];
  timeoutMs?: number;
  /** Receives a function that kills the running process. */
  onSpawn?: (kill: () => void) => void;
}

export interface CallResult {
  text: string;
  structured?: unknown;
  usage: Usage;
}

export class ClaudeError extends Error {}

let cleaned = false;
/** Per temp folder: one made for this run alone, used when the usual one turns out to belong to someone else. */
const ownDirs = new Map<string, string>();

/**
 * Where prompt files are written. They hold the topic card, which comes from the learner's notes,
 * and on Linux the temp folder is shared by every account. So the folder and its files are
 * readable by this user only, and a folder of that name owned by another account is not used:
 * whoever made it could read the prompts, or have left one there to be sent in place of ours.
 */
export function workDir(base = os.tmpdir()): string {
  const own = ownDirs.get(base);
  if (own) return own;
  let dir = path.join(base, "study-tutor-cli");
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(dir);
    const uid = process.getuid?.();
    if (!st.isDirectory() || st.isSymbolicLink() || (uid !== undefined && st.uid !== uid)) throw new Error("not ours");
    // Created by an earlier version with the default mode. Windows has no such bits and ignores this.
    if (uid !== undefined && (st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  } catch {
    dir = fs.mkdtempSync(path.join(base, "study-tutor-cli-"));
    ownDirs.set(base, dir);
  }
  if (!cleaned) {
    // Once per run, remove prompt files left over from earlier days.
    cleaned = true;
    try {
      const cutoff = Date.now() - 24 * 3600 * 1000;
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (/^system-[0-9a-f]+\.md$/.test(f) && fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      }
    } catch {
      /* stale files are harmless */
    }
  }
  return dir;
}

/** Finds the Claude CLI binary. GUI apps often lack the shell PATH, so common install locations are checked too. */
export function findClaude(configured?: string): string | null {
  const win = process.platform === "win32";
  const home = os.homedir();
  const npmExe = (dir: string) => path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  const candidates: string[] = [];
  if (configured && configured.trim()) candidates.push(configured.trim());
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    if (win) candidates.push(path.join(dir, "claude.exe"), path.join(dir, "claude.cmd"));
    else candidates.push(path.join(dir, "claude"));
  }
  if (win) {
    candidates.push(path.join(home, ".local", "bin", "claude.exe"));
    if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, "npm", "claude.cmd"));
  } else {
    candidates.push(path.join(home, ".local", "bin", "claude"), path.join(home, ".claude", "local", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude", path.join(home, ".npm-global", "bin", "claude"));
  }
  for (let c of candidates) {
    try {
      // A .cmd shim cannot be spawned without a shell; use the real binary it points at.
      if (win && /\.cmd$/i.test(c)) c = npmExe(path.dirname(c));
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

export function callClaude(opts: CallOptions): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const dir = workDir();
    const sysFile = path.join(dir, `system-${createHash("sha1").update(opts.system).digest("hex").slice(0, 12)}.md`);
    try {
      // Written every time: a file already there is only trusted to be ours if we put it there now.
      fs.writeFileSync(sysFile, opts.system, { encoding: "utf8", mode: 0o600 });
    } catch (e) {
      reject(new ClaudeError(`Could not write the prompt file: ${(e as Error).message}`));
      return;
    }
    const tools = (opts.tools ?? []).join(",");
    const args = ["-p", "--output-format", "json", "--no-session-persistence", "--tools", tools, ...(tools ? ["--allowedTools", tools] : []), "--strict-mcp-config", "--disable-slash-commands", "--setting-sources", "", "--system-prompt-file", sysFile, "--model", opts.model];
    if (opts.effort) args.push("--effort", opts.effort);
    if (opts.jsonSchema) args.push("--json-schema", JSON.stringify(opts.jsonSchema));

    const env = { ...process.env };
    delete env.BRAVE_SEARCH_API_KEY;
    const child = spawn(opts.claudePath, args, { cwd: dir, windowsHide: true, env });
    let out = "";
    let err = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new ClaudeError("Claude took too long and was stopped.")));
    }, opts.timeoutMs ?? 180000);
    opts.onSpawn?.(() => {
      child.kill();
      finish(() => reject(new ClaudeError("Stopped.")));
    });

    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
    child.on("error", (e) => finish(() => reject(new ClaudeError(`Could not start the Claude CLI at "${opts.claudePath}": ${e.message}`))));
    child.on("close", (code) =>
      finish(() => {
        let j: Record<string, unknown>;
        try {
          j = JSON.parse(out.trim());
        } catch {
          reject(new ClaudeError((err.trim() || out.trim() || `The Claude CLI exited with code ${code}.`).slice(0, 600)));
          return;
        }
        const u = (j.usage ?? {}) as Record<string, number>;
        const usage: Usage = { input: u.input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0, costUsd: Number(j.total_cost_usd) || 0, calls: 1 };
        if (j.is_error) {
          reject(new ClaudeError(String(j.result ?? "The Claude CLI reported an error.").slice(0, 600)));
          return;
        }
        // A reply is rendered as Markdown and saved into notes, so nothing in it may load from outside the vault.
        resolve({ text: neutraliseRemote(String(j.result ?? "")), structured: neutraliseDeep(j.structured_output), usage });
      }),
    );
    child.stdin.on("error", () => {
      /* the close handler reports the real failure */
    });
    child.stdin.end(opts.input, "utf8");
  });
}
