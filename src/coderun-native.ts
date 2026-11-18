// C and C++ code tasks, compiled with a compiler found on this computer (g++, clang++, gcc,
// clang, or a configured path) and run as ordinary processes. There is no operating-system
// sandbox: the program runs as the user and could read or change their files and use the
// network. So this is off unless the user switches it on, and every report says plainly what
// does apply: a time limit that kills the whole process tree, capped output, a fresh temporary
// folder that is deleted afterwards, a minimal environment, and on Linux CPU-time and file-size
// limits through prlimit when it is installed.
//
// Builds use -std=c++20 (C: -std=c17) -O2 -Wall, with AddressSanitizer and UBSan when the
// toolchain has them (MinGW usually does not), and a separate ThreadSanitizer build for
// concurrent tasks where that exists. No Obsidian imports.

import { type ChildProcess, spawn } from "child_process";
import { existsSync, promises as fsp, statSync } from "fs";
import * as os from "os";
import * as path from "path";
import type { CodeLanguage, CodeRunReport, CodeTask, CodeTestResult } from "./codetask";
import { CODE_LIMITS, type CodeBackend, LANGUAGE_NAME, boundMessage, codeReport, judgeOutput, testOutcome, timeLimitOf } from "./coderun";

const WIN = process.platform === "win32";
const COMPILE_MS = 60000;
const PROBE_MS = 30000;

export interface ProcResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Printed more than allowed, so it was stopped. */
  overflow: boolean;
  /** Could not be started at all. */
  spawnError: string;
  ms: number;
}

/** Kills a process and everything it started. */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (WIN) {
    // taskkill needs the parent alive to find its children, so it goes first.
    const after = () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    };
    try {
      const k = spawn(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      k.on("exit", after);
      k.on("error", after);
    } catch {
      after();
    }
    setTimeout(after, 2000).unref?.();
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

/** Runs one process with stdin piped, output capped and a wall-clock limit. Never throws. */
export function runProcess(file: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string; timeoutMs: number; maxOut: number; maxErr: number; signal?: AbortSignal; killOnOverflow?: boolean }): Promise<ProcResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const out: Buffer[] = [], err: Buffer[] = [];
    let outLen = 0, errLen = 0, timedOut = false, overflow = false, spawnError = "", killed = false, settled = false;
    let child: ChildProcess;
    try {
      // Its own process group on Linux and macOS, so the whole tree can be killed.
      child = spawn(file, args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: !WIN });
    } catch (e) {
      resolve({ code: null, signal: null, stdout: "", stderr: "", timedOut: false, overflow: false, spawnError: (e as Error).message || "could not start", ms: 0 });
      return;
    }
    const kill = () => {
      if (killed) return;
      killed = true;
      killTree(child);
    };
    const finish = (code: number | null, sig: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", kill);
      resolve({ code, signal: sig, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), timedOut, overflow, spawnError, ms: Date.now() - started });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, o.timeoutMs);
    o.signal?.addEventListener("abort", kill);
    if (o.signal?.aborted) kill();
    child.stdout?.on("data", (b: Buffer) => {
      if (outLen + b.length > o.maxOut) {
        if (outLen < o.maxOut) out.push(b.subarray(0, o.maxOut - outLen));
        outLen = o.maxOut;
        overflow = true;
        if (o.killOnOverflow !== false) kill();
      } else {
        out.push(b);
        outLen += b.length;
      }
    });
    child.stderr?.on("data", (b: Buffer) => {
      if (errLen >= o.maxErr) return;
      const part = b.subarray(0, o.maxErr - errLen);
      err.push(part);
      errLen += part.length;
    });
    child.stdin?.on("error", () => {
      /* the program exited without reading all of its input */
    });
    child.on("error", (e) => {
      spawnError = e.message || "could not start";
      finish(null, null);
    });
    // 'close' waits for the pipes; a grandchild holding one open must not hold up the result.
    child.on("exit", (code, sig) => setTimeout(() => finish(code, sig), 1000).unref?.());
    child.on("close", (code, sig) => finish(code, sig));
    try {
      child.stdin?.end(o.stdin ?? "");
    } catch {
      /* see the error handler above */
    }
  });
}

/** Finds a program on PATH, as the shell would. */
export function which(name: string, envPath = process.env.PATH ?? process.env.Path ?? ""): string | null {
  const exts = WIN && !path.extname(name) ? [".exe", ".com", ""] : [""];
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir.replace(/^"|"$/g, ""), name + ext);
      try {
        if (statSync(full).isFile()) return full;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

export interface Toolchain {
  /** Full path of the compiler driver. */
  path: string;
  /** Its name, such as "g++" or "clang". */
  name: string;
  /** Its version, such as "13.2.0". */
  version: string;
  clang: boolean;
  /** A C driver (gcc, clang, cc): C++ then needs -lstdc++ to link. */
  cDriver: boolean;
}

/** Asks a compiler for its version. Null when it is not one, or does not start. */
export async function inspectCompiler(file: string): Promise<Toolchain | null> {
  const r = await runProcess(file, ["--version"], { cwd: os.tmpdir(), env: process.env, timeoutMs: 15000, maxOut: 8192, maxErr: 8192 });
  if (r.code !== 0 || r.spawnError) return null;
  const first = (r.stdout || r.stderr).split(/\r?\n/)[0] ?? "";
  const versions = first.match(/\d+\.\d+(?:\.\d+)?/g);
  const name = path.basename(file).replace(/\.exe$/i, "");
  const clang = /clang/i.test(r.stdout) || /clang/i.test(name);
  if (!/gcc|g\+\+|clang|free software foundation|llvm/i.test(r.stdout + r.stderr)) return null;
  return { path: file, name, version: versions ? versions[versions.length - 1] : "", clang, cDriver: !/\+\+/.test(name) };
}

/** The compilers tried for a language, in order, after any configured path. */
export const COMPILERS: Record<"cpp" | "c", string[]> = { cpp: ["g++", "clang++", "c++"], c: ["gcc", "clang", "cc"] };

interface Probe {
  /** -fsanitize=address,undefined builds and runs. */
  asan: boolean;
  /** -fsanitize=thread builds and runs. */
  tsan: boolean;
}

const SANITIZER_LINE = /(ERROR|WARNING): (Address|Leak|Thread|Memory|UndefinedBehavior)Sanitizer|runtime error:|SUMMARY: \w+Sanitizer/;

function describeExit(r: ProcResult): string {
  if (r.signal) {
    const names: Record<string, string> = { SIGSEGV: "a segmentation fault (an invalid memory access)", SIGABRT: "an abort", SIGFPE: "an arithmetic error such as dividing by zero", SIGILL: "an illegal instruction", SIGBUS: "a bus error", SIGKILL: "being killed", SIGXCPU: "running out of CPU time" };
    return `crashed with ${names[r.signal] ?? r.signal}`;
  }
  const code = r.code ?? -1;
  const win: Record<number, string> = { 0xc0000005: "an access violation (an invalid memory access)", 0xc00000fd: "a stack overflow", 0xc0000094: "an integer division by zero", 0xc000001d: "an illegal instruction", 0xc0000409: "a failed check (abort or stack buffer overrun)", 0xc0000135: "a missing DLL" };
  const u = code >>> 0;
  if (WIN && win[u]) return `crashed with ${win[u]}`;
  return `exited with status ${code}`;
}

/** C and C++ tasks: whole programs, compiled with a local compiler and run with no sandbox. */
export class NativeRunner implements CodeBackend {
  private found = new Map<string, Promise<Toolchain | null>>();
  private probes = new Map<string, Promise<Probe>>();
  private prlimit: string | null | undefined;

  /** `compilerPath` is the configured compiler, or "" to search PATH. */
  constructor(private compilerPath: () => string = () => "") {}

  reset(): void {
    this.found.clear();
    this.probes.clear();
    this.prlimit = undefined;
  }

  /** The compiler for a language: the configured one when it works, otherwise the first on PATH. */
  toolchain(language: "cpp" | "c"): Promise<Toolchain | null> {
    const configured = this.compilerPath().trim().replace(/^"|"$/g, "");
    const key = `${language}|${configured}`;
    let p = this.found.get(key);
    if (!p) {
      p = (async () => {
        const candidates = [...(configured ? [path.isAbsolute(configured) ? configured : which(configured) ?? configured] : []), ...COMPILERS[language].map((n) => which(n)).filter((x): x is string => !!x)];
        for (const c of [...new Set(candidates)]) {
          const tc = await inspectCompiler(c);
          if (tc) return tc;
        }
        return null;
      })();
      this.found.set(key, p);
    }
    return p;
  }

  async available(language: CodeLanguage): Promise<{ ok: boolean; backend: string; why?: string }> {
    if (language === "python") return { ok: false, backend: "", why: "Python is not run by the native runner." };
    const tc = await this.toolchain(language);
    if (!tc) {
      const configured = this.compilerPath().trim();
      return { ok: false, backend: "", why: configured ? `The compiler set in settings (${configured}) did not answer, and no ${COMPILERS[language].join(", ")} was found on PATH.` : `No ${LANGUAGE_NAME[language]} compiler was found on PATH (${COMPILERS[language].join(", ")}). Install one, or set its full path in Study Tutor's settings.` };
    }
    return { ok: true, backend: `${tc.name} ${tc.version} (${tc.path})` };
  }

  /** The environment programs run in: the compiler's folder (for its runtime libraries) and the system, nothing else. */
  private env(tc: Toolchain, dir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    if (WIN) {
      const root = process.env.SystemRoot || "C:\\Windows";
      return { PATH: [path.dirname(tc.path), path.join(root, "System32"), root].join(";"), SystemRoot: root, TEMP: dir, TMP: dir, ...extra };
    }
    return { PATH: [path.dirname(tc.path), "/usr/bin", "/bin"].join(":"), HOME: dir, TMPDIR: dir, LANG: "C.UTF-8", ...extra };
  }

  private compileArgs(tc: Toolchain, language: "cpp" | "c", src: string, exe: string, sanitize: string[], concurrent: boolean): string[] {
    return [
      "-x", language === "c" ? "c" : "c++", src, "-x", "none",
      language === "c" ? "-std=c17" : "-std=c++20", "-O2", "-Wall", "-fdiagnostics-color=never",
      ...sanitize,
      ...(sanitize.length ? ["-fno-omit-frame-pointer", "-g"] : []),
      ...(!WIN || concurrent ? ["-pthread"] : []),
      "-o", exe,
      ...(language === "cpp" && tc.cDriver ? ["-lstdc++"] : []),
      ...(!WIN ? ["-lm"] : []),
    ];
  }

  /** Which sanitizers build and run with this compiler. Tried once, with a tiny program. */
  private probe(tc: Toolchain): Promise<Probe> {
    let p = this.probes.get(tc.path);
    if (!p) {
      p = (async () => {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "study-tutor-probe-"));
        try {
          await fsp.writeFile(path.join(dir, "probe.c"), "#include <stdio.h>\nint main(void) { puts(\"ok\"); return 0; }\n");
          const tries = async (flag: string): Promise<boolean> => {
            const exe = path.join(dir, `probe-${flag}${WIN ? ".exe" : ""}`);
            const c = await runProcess(tc.path, ["-x", "c", "probe.c", "-x", "none", `-fsanitize=${flag}`, "-o", exe], { cwd: dir, env: { ...process.env, TMP: dir, TEMP: dir, TMPDIR: dir }, timeoutMs: PROBE_MS, maxOut: 16384, maxErr: 16384 });
            if (c.code !== 0 || !existsSync(exe)) return false;
            const r = await runProcess(exe, [], { cwd: dir, env: this.env(tc, dir, SANITIZER_ENV), timeoutMs: PROBE_MS, maxOut: 1024, maxErr: 16384 });
            return r.code === 0 && r.stdout.trim() === "ok";
          };
          const asan = await tries("address,undefined");
          // ThreadSanitizer exists for Linux and macOS, never Windows.
          const tsan = WIN ? false : await tries("thread");
          return { asan, tsan };
        } catch {
          return { asan: false, tsan: false };
        } finally {
          await removeDir(dir);
        }
      })();
      this.probes.set(tc.path, p);
    }
    return p;
  }

  /** prlimit, on Linux, when installed: CPU time, file size and (without sanitizers) memory. */
  private limiter(): string | null {
    if (this.prlimit === undefined) this.prlimit = process.platform === "linux" ? ["/usr/bin/prlimit", "/bin/prlimit"].find((p) => existsSync(p)) ?? null : null;
    return this.prlimit;
  }

  limits(task: CodeTask, prlimit: boolean): string {
    return [
      "Runs as you, with no sandbox: the program could read or change your files and use the network, and there is no file-system or network isolation.",
      `What applies: ${timeLimitOf(task) / 1000} s per test (the whole process tree is killed), ${CODE_LIMITS.outputBytes / 1024} KB of output, a fresh temporary folder deleted afterwards, and a minimal environment${prlimit ? "; on this system also CPU-time, file-size and memory limits (prlimit)" : ""}.`,
      ...(task.concurrent ? ["Passing tests cannot show a program is free of races."] : []),
    ].join(" ");
  }

  async run(task: CodeTask, source: string, signal?: AbortSignal): Promise<CodeRunReport> {
    const started = Date.now();
    const language = task.language === "c" ? "c" : "cpp";
    const tc = await this.toolchain(language);
    const limiter = this.limiter();
    const report = (r: Partial<CodeRunReport> & Pick<CodeRunReport, "status">) => codeReport(task, started, { limits: this.limits(task, !!limiter), ...r });
    if (!tc) return report({ status: "unavailable", message: (await this.available(language)).why ?? "No compiler was found." });
    const wantSan = task.sanitizers !== false;
    const probe = wantSan ? await this.probe(tc) : { asan: false, tsan: false };
    const std = language === "c" ? "-std=c17" : "-std=c++20";
    let backend = `${tc.name} ${tc.version} ${std} -O2${probe.asan ? " -fsanitize=address,undefined" : ""}`;
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "study-tutor-run-"));
    const clean = (s: string) => s.split(dir + path.sep).join("").split(dir.replace(/\\/g, "/") + "/").join("").split(dir).join(".");
    try {
      const src = language === "c" ? "main.c" : "main.cpp";
      const exe = path.join(dir, `main${WIN ? ".exe" : ""}`);
      await fsp.writeFile(path.join(dir, src), source, "utf8");
      const compileEnv = { ...process.env, TMP: dir, TEMP: dir, TMPDIR: dir };
      const compile = (out: string, sanitize: string[]) => runProcess(tc.path, this.compileArgs(tc, language, src, out, sanitize, !!task.concurrent), { cwd: dir, env: compileEnv, timeoutMs: COMPILE_MS, maxOut: 32768, maxErr: 32768, signal, killOnOverflow: false });
      const built = await compile(exe, probe.asan ? ["-fsanitize=address,undefined"] : []);
      if (signal?.aborted) return report({ status: "unavailable", backend, message: "The run was cancelled." });
      const said = clean(`${built.stderr}${built.stdout}`).trim();
      if (built.timedOut) return report({ status: "compile-error", backend, message: `The compiler took longer than ${COMPILE_MS / 1000} s.` });
      if (built.spawnError) return report({ status: "unavailable", backend, message: `The compiler could not start: ${built.spawnError}` });
      if (built.code !== 0 || !existsSync(exe)) return report({ status: "compile-error", backend, message: boundMessage(said || "The compiler failed without saying why.") });
      let tsanExe = "";
      if (task.concurrent && probe.tsan) {
        const t = path.join(dir, "main-tsan");
        if ((await compile(t, ["-fsanitize=thread"])).code === 0 && existsSync(t)) {
          tsanExe = t;
          // The exact race-check build, which marking looks for.
          backend += `; race check: ${tc.name} ${tc.version} ${std} -O2 -fsanitize=thread`;
        }
      }
      const limitMs = timeLimitOf(task);
      const runEnv = this.env(tc, dir, probe.asan || tsanExe ? SANITIZER_ENV : {});
      const launch = (file: string, stdin: string, timeoutMs: number, sanitized: boolean) => {
        const secs = Math.ceil(timeoutMs / 1000) + 1;
        const args = limiter ? [`--cpu=${secs}`, `--fsize=${16 * 1024 * 1024}`, "--core=0", ...(sanitized ? [] : [`--as=${2 * 1024 * 1024 * 1024}`]), "--", file] : [];
        return runProcess(limiter ?? file, args, { cwd: dir, env: runEnv, stdin, timeoutMs, maxOut: CODE_LIMITS.outputBytes, maxErr: CODE_LIMITS.errorBytes, signal });
      };
      const tests: CodeTestResult[] = [];
      const reports: string[] = [];
      let used = 0;
      for (const [i, t] of task.tests.entries()) {
        if (signal?.aborted) break;
        if (used >= CODE_LIMITS.runBudgetMs) {
          tests.push(testOutcome(t, i, "timeout", "not run: the run's total time was used up", 0));
          continue;
        }
        const r = await launch(exe, t.stdin ?? "", Math.min(limitMs, CODE_LIMITS.runBudgetMs - used), probe.asan);
        used += r.ms;
        if (signal?.aborted) break;
        const stderr = clean(r.stderr).trim();
        const found = stderr.split(/\r?\n/).findIndex((l) => SANITIZER_LINE.test(l));
        if (found >= 0) reports.push(stderr.split(/\r?\n/).slice(found, found + 6).join("\n"));
        const why = found >= 0 ? stderr.split(/\r?\n/).slice(found).join("\n") : stderr;
        if (r.spawnError) tests.push(testOutcome(t, i, "error", `could not start: ${r.spawnError}`, r.ms));
        else if (r.timedOut) tests.push(testOutcome(t, i, "timeout", `stopped after ${limitMs / 1000} s`, r.ms));
        else if (r.overflow) tests.push(testOutcome(t, i, "error", `stopped: printed more than ${CODE_LIMITS.outputBytes / 1024} KB`, r.ms));
        else if (r.code !== 0 || r.signal) tests.push(testOutcome(t, i, "error", `${describeExit(r)}${why ? `\n${why}` : ""}`, r.ms));
        else tests.push(judgeOutput(t, i, r.stdout, r.ms));
      }
      // The race detector: the same tests again, looking only at what ThreadSanitizer says. It
      // counts as a race check only when every test ran to the end under it.
      let raceChecked = 0;
      if (tsanExe && !signal?.aborted) {
        for (const t of task.tests) {
          if (used >= CODE_LIMITS.runBudgetMs || signal?.aborted) break;
          const r = await launch(tsanExe, t.stdin ?? "", Math.min(limitMs * 3, 15000, CODE_LIMITS.runBudgetMs - used), true);
          used += r.ms;
          const lines = clean(r.stderr).split(/\r?\n/);
          const at = lines.findIndex((l) => /ThreadSanitizer/.test(l));
          if (at >= 0) {
            reports.push(lines.slice(at, at + 6).join("\n"));
            break;
          }
          if (!r.timedOut && !r.spawnError && !r.overflow) raceChecked++;
        }
      }
      if (signal?.aborted) return report({ status: "unavailable", backend, message: "The run was cancelled.", tests });
      // A concurrent task is "clean" only when ThreadSanitizer saw every test; ASan alone says nothing about races.
      const checked = task.concurrent ? !!tsanExe && raceChecked === task.tests.length : probe.asan;
      const sanitizer = reports.length ? "reported" : checked ? "clean" : "not-available";
      const notes = [
        ...(said ? [`Compiler warnings:\n${said}`] : []),
        ...(reports.length ? [`Sanitizer report:\n${reports[0]}`] : []),
        ...(wantSan && !probe.asan ? ["This compiler has no AddressSanitizer or UBSan, so memory errors and undefined behaviour are not checked."] : []),
        ...(task.concurrent && wantSan && !tsanExe ? ["No ThreadSanitizer here, so data races are not checked."] : []),
        ...(task.concurrent && tsanExe && !reports.length && raceChecked < task.tests.length ? ["ThreadSanitizer did not finish every test, so the race check is incomplete."] : []),
      ];
      return report({ status: "ran", backend, tests, sanitizer, message: boundMessage(notes.join("\n\n")) });
    } catch (e) {
      return report({ status: "unavailable", backend, message: `The native runner failed: ${(e as Error)?.message || String(e)}` });
    } finally {
      await removeDir(dir);
    }
  }
}

/** Sanitizers: stop at the first error, no leak checking (not available everywhere), short reports. */
const SANITIZER_ENV: Record<string, string> = {
  ASAN_OPTIONS: "detect_leaks=0:abort_on_error=0:halt_on_error=1",
  UBSAN_OPTIONS: "halt_on_error=1:print_stacktrace=0",
  TSAN_OPTIONS: "halt_on_error=0:second_deadlock_stack=0",
};

async function removeDir(dir: string): Promise<void> {
  // A killed program can hold its file open for a moment on Windows.
  await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
