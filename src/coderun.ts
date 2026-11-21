// The code runner: runs a learner's solution against a code task's tests (codetask.ts) and
// reports what happened. Python runs in the bundled Pyodide inside a worker (coderun-python.ts);
// C and C++ are compiled with a compiler found on this computer and run as ordinary processes
// (coderun-native.ts), which has no sandbox, so it is off unless the user switches it on.
//
// This file holds what both share: the limits, the checks a task must pass before anything runs,
// how an output is compared with the expected one, and the runner that picks a backend. The only
// code ever executed is the learner's source and the runners' own fixed harness. No Obsidian
// imports.

import type { CodeCompare, CodeLanguage, CodeRunReport, CodeRunner, CodeTask, CodeTestCase, CodeTestResult, CodeTestStatus } from "./codetask";

export const CODE_LIMITS = {
  /** The learner's source, in UTF-8 bytes. */
  sourceBytes: 64 * 1024,
  tests: 30,
  /** One test's stdin, expected text or arguments (as JSON), in bytes. */
  ioBytes: 64 * 1024,
  /** All tests' stdin, expected text and arguments together. */
  totalIoBytes: 1024 * 1024,
  /** Standard output kept per test; a program printing more is stopped. */
  outputBytes: 64 * 1024,
  /** Standard error kept per test; the rest is dropped. */
  errorBytes: 16 * 1024,
  minTimeMs: 100,
  maxTimeMs: 10000,
  defaultTimeMs: 2000,
  /** Wall time all of a run's tests may take together; later tests are reported as not run. */
  runBudgetMs: 120000,
  /** A detail line in a test result. */
  detailChars: 800,
  /** Compiler output kept in a report. */
  messageChars: 4000,
} as const;

/** The longest a whole run can take: the test budget plus compiling and starting a runtime. Used as the tool's timeout. */
export const CODE_RUN_TIMEOUT_MS = CODE_LIMITS.runBudgetMs + 150000;

const LANGUAGES: readonly CodeLanguage[] = ["python", "cpp", "c"];
const COMPARES: readonly CodeCompare[] = ["exact", "trim", "tokens", "float"];

export const isCodeLanguage = (x: unknown): x is CodeLanguage => typeof x === "string" && (LANGUAGES as readonly string[]).includes(x);

/** What people call each language. */
export const LANGUAGE_NAME: Record<CodeLanguage, string> = { python: "Python", cpp: "C++", c: "C" };

// ---------- comparing outputs ----------

const lines = (s: string): string[] => s.replace(/\r\n?/g, "\n").split("\n");
const trimmed = (s: string): string => lines(s).map((l) => l.replace(/\s+$/, "")).join("\n").replace(/\n+$/, "");
const tokens = (s: string): string[] => s.split(/\s+/).filter(Boolean);
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Two numbers within 1e-6, relative for numbers larger than 1 (the usual judge rule). */
export function closeEnough(a: number, b: number): boolean {
  if (a === b) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * Whether a program's output matches the expected text. Line endings are always normalised
 * (a C program on Windows writes \r\n). "exact": identical otherwise. "trim" (the default):
 * trailing whitespace on each line and at the end is ignored. "tokens": the same words in order,
 * however they are spaced. "float": tokens, with numbers equal within 1e-6.
 */
export function compareOutput(actual: string, expected: string, mode: CodeCompare = "trim"): boolean {
  if (mode === "exact") return lines(actual).join("\n") === lines(expected).join("\n");
  if (mode === "tokens") {
    const a = tokens(actual), e = tokens(expected);
    return a.length === e.length && a.every((t, i) => t === e[i]);
  }
  if (mode === "float") {
    const a = tokens(actual), e = tokens(expected);
    return a.length === e.length && a.every((t, i) => t === e[i] || (NUMBER.test(t) && NUMBER.test(e[i]) && closeEnough(Number(t), Number(e[i]))));
  }
  return trimmed(actual) === trimmed(expected);
}

const parseJson = (s: string): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
};

/** JSON text with object keys sorted, so key order never matters. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sameValue(a: unknown, b: unknown, float: boolean): boolean {
  if (typeof a === "number" && typeof b === "number") return float ? closeEnough(a, b) : a === b;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameValue(x, b[i], float));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], float));
  }
  return a === b;
}

/**
 * Whether a function's return value (JSON text from the harness) equals the expected JSON text.
 * Values are compared as JSON values, so spacing and key order do not matter and 1.0 equals 1.
 * "float" lets numbers differ within 1e-6. Expected text that is not JSON is compared as text.
 */
export function compareValue(actualJson: string, expectedJson: string, mode: CodeCompare = "trim"): boolean {
  const a = parseJson(actualJson), e = parseJson(expectedJson);
  if (!a.ok || !e.ok) return compareOutput(actualJson, expectedJson, mode);
  return sameValue(a.value, e.value, mode === "float");
}

const clip =(s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`);
const quote = (s: string): string => JSON.stringify(clip(s, 120));

/** Says where an output first differs from the expected one, briefly. */
export function mismatchDetail(actual: string, expected: string): string {
  const a = lines(actual), e = lines(expected);
  while (a.length > 1 && a[a.length - 1].trim() === "") a.pop();
  while (e.length > 1 && e[e.length - 1].trim() === "") e.pop();
  if (!actual.trim()) return `no output; expected ${quote(e.join("\n"))}`;
  const plural = (n: number) => `${n} line${n === 1 ? "" : "s"}`;
  for (let i = 0; i < Math.max(a.length, e.length); i++) {
    const got = (a[i] ?? "").replace(/\s+$/, ""), want = (e[i] ?? "").replace(/\s+$/, "");
    if (got === want) continue;
    if (i >= a.length) return `the output stops after ${plural(a.length)}; line ${i + 1} should be ${quote(want)}`;
    if (i >= e.length) return `extra output after the expected ${plural(e.length)}: line ${i + 1} is ${quote(got)}`;
    return `line ${i + 1}: expected ${quote(want)}, got ${quote(got)}`;
  }
  return "the output differs only in spacing or line endings";
}

/** The result of one test whose run finished normally: pass or fail, by the test's comparison. */
export function judgeOutput(t: CodeTestCase, index: number, actual: string, ms: number, asValue = false): CodeTestResult {
  const mode = t.compare ?? "trim";
  const ok = asValue ? compareValue(actual, t.expected, mode) : compareOutput(actual, t.expected, mode);
  return { ...testHead(t, index), status: ok ? "pass" : "fail", detail: ok ? "" : asValue ? clip(`expected ${clip(t.expected.trim(), 200)}, got ${clip(actual, 200)}`, CODE_LIMITS.detailChars) : mismatchDetail(actual, t.expected), ms };
}

/** A test's name and visibility as a result shows them. */
export function testHead(t: CodeTestCase, index: number): { name: string; hidden: boolean } {
  return { name: clip(t.name.trim(), 120) || `test ${index + 1}`, hidden: t.hidden === true };
}

/** A result that is not a pass or a fail: an error, a timeout or a test that never ran. */
export function testOutcome(t: CodeTestCase, index: number, status: CodeTestStatus, detail: string, ms: number): CodeTestResult {
  return { ...testHead(t, index), status, detail: boundDetail(detail), ms };
}

/** Field names an object has beyond the allowed ones, up to five, comma-separated; "" when none. */
const unknownKeys = (o: Record<string, unknown>, allowed: ReadonlySet<string>): string => Object.keys(o).filter((k) => !allowed.has(k)).slice(0, 5).join(", ");

export const boundDetail =(s: string): string => clip(s.trim(), CODE_LIMITS.detailChars);
export const boundMessage = (s: string): string => clip(s.trim(), CODE_LIMITS.messageChars);

/** The time limit a task asks for, or the default. */
export const timeLimitOf = (task: CodeTask): number => Math.round(task.timeLimitMs ?? CODE_LIMITS.defaultTimeMs);

/** A whole report, with the pass count and timing filled in. */
export function codeReport(task: Pick<CodeTask, "language"> & { tests?: unknown }, started: number, r: Partial<CodeRunReport> & Pick<CodeRunReport, "status">): CodeRunReport {
  const tests = r.tests ?? [];
  return {
    language: task.language,
    backend: "",
    message: "",
    limits: "",
    ...r,
    tests,
    passed: tests.filter((t) => t.status === "pass").length,
    total: Array.isArray(task.tests) ? task.tests.length : tests.length,
    ms: Date.now() - started,
  };
}

// ---------- validation ----------

const bytes = (s: string): number => new TextEncoder().encode(s).length;
const PY_KEYWORDS = new Set("False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(" "));
const TASK_KEYS = new Set(["language", "entry", "tests", "timeLimitMs", "concurrent", "sanitizers", "starter"]);
const TEST_KEYS = new Set(["name", "stdin", "args", "expected", "hidden", "compare"]);

/**
 * Says what is wrong with a task and source, or null when they can run. Checks every limit in
 * CODE_LIMITS and the shape in codetask.ts. With `strict`, unknown fields are refused too (the
 * tool input); otherwise they are ignored.
 */
export function validateCodeTask(task: unknown, source: unknown, opts: { strict?: boolean } = {}): string | null {
  if (!task || typeof task !== "object" || Array.isArray(task)) return "the task must be an object";
  const t = task as Record<string, unknown>;
  const taskExtra = opts.strict ? unknownKeys(t, TASK_KEYS) : "";
  if (taskExtra) return `the task has unknown fields: ${taskExtra}`;
  if (!isCodeLanguage(t.language)) return "the language must be python, cpp or c";
  if (typeof source !== "string" || !source.trim()) return "there is no code to run";
  if (bytes(source) > CODE_LIMITS.sourceBytes) return `the code is longer than ${CODE_LIMITS.sourceBytes / 1024} KB`;
  if (source.includes("\0")) return "the code contains a null character";
  if (t.entry !== undefined) {
    if (t.language !== "python") return "an entry function is for Python tasks only; C and C++ tasks are whole programs";
    if (typeof t.entry !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(t.entry) || PY_KEYWORDS.has(t.entry)) return "the entry must be a plain Python function name";
  }
  if (t.timeLimitMs !== undefined && (typeof t.timeLimitMs !== "number" || !Number.isFinite(t.timeLimitMs) || t.timeLimitMs < CODE_LIMITS.minTimeMs || t.timeLimitMs > CODE_LIMITS.maxTimeMs)) return `the time limit must be between ${CODE_LIMITS.minTimeMs} and ${CODE_LIMITS.maxTimeMs} ms`;
  for (const k of ["concurrent", "sanitizers"] as const) if (t[k] !== undefined && typeof t[k] !== "boolean") return `${k} must be true or false`;
  if (t.starter !== undefined && (typeof t.starter !== "string" || bytes(t.starter) > CODE_LIMITS.sourceBytes)) return "the starter code must be text of at most 64 KB";
  if (!Array.isArray(t.tests) || !t.tests.length) return "the task has no tests";
  if (t.tests.length > CODE_LIMITS.tests) return `the task has ${t.tests.length} tests; at most ${CODE_LIMITS.tests} are allowed`;
  let total = 0;
  for (const [i, raw] of t.tests.entries()) {
    const at = `test ${i + 1}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return `${at} must be an object`;
    const c = raw as Record<string, unknown>;
    const testExtra = opts.strict ? unknownKeys(c, TEST_KEYS) : "";
    if (testExtra) return `${at} has unknown fields: ${testExtra}`;
    if (typeof c.name !== "string" || c.name.length > 200) return `${at} needs a name of at most 200 characters`;
    if (typeof c.expected !== "string") return `${at} needs the expected output as text`;
    if (c.hidden !== undefined && typeof c.hidden !== "boolean") return `${at}: hidden must be true or false`;
    if (c.compare !== undefined && !(COMPARES as readonly unknown[]).includes(c.compare)) return `${at}: compare must be exact, trim, tokens or float`;
    const expectedBytes = bytes(c.expected);
    let size = expectedBytes;
    if (t.entry !== undefined) {
      if (c.stdin !== undefined) return `${at} calls a function, so it takes args, not stdin`;
      if (c.args !== undefined && !Array.isArray(c.args)) return `${at}: args must be a list`;
      let json: string | undefined;
      try {
        json = JSON.stringify(c.args ?? []);
      } catch {
        json = undefined;
      }
      if (json === undefined) return `${at}: args must be JSON values`;
      if (bytes(json) > CODE_LIMITS.ioBytes) return `${at}: the args are larger than 64 KB`;
      size += bytes(json);
    } else {
      if (c.args !== undefined) return `${at} has args, but the task names no entry function`;
      if (c.stdin !== undefined && typeof c.stdin !== "string") return `${at}: stdin must be text`;
      const inBytes = typeof c.stdin === "string" ? bytes(c.stdin) : 0;
      if (inBytes > CODE_LIMITS.ioBytes) return `${at}: stdin is larger than 64 KB`;
      size += inBytes;
    }
    if (expectedBytes > CODE_LIMITS.ioBytes) return `${at}: the expected output is larger than 64 KB`;
    total += size;
    if (total > CODE_LIMITS.totalIoBytes) return "the tests' inputs and expected outputs are larger than 1 MB together";
  }
  return null;
}

// ---------- the runner ----------

/** One family of languages behind the runner: Python, or C and C++. Tasks reach it already validated. */
export interface CodeBackend {
  available(language: CodeLanguage): Promise<{ ok: boolean; backend: string; why?: string }>;
  run(task: CodeTask, source: string, signal?: AbortSignal): Promise<CodeRunReport>;
  /** Forgets what was detected, so the next use looks again. */
  reset?(): void;
  dispose?(): void;
}

export interface CodeRunnerSettings {
  /** Python in the bundled Pyodide. Sandboxed WebAssembly, so on by default. */
  python: boolean;
  /** C and C++ with a local compiler. No sandbox, so off by default. */
  native: boolean;
}

/** The runner the plugin uses: validation, the on/off settings, then Python or the native compiler. */
export class LocalCodeRunner implements CodeRunner {
  constructor(private opts: { settings: () => CodeRunnerSettings; python: CodeBackend | null; native: CodeBackend | null }) {}

  private pick(language: CodeLanguage): { backend: CodeBackend | null; off: string } {
    const s = this.opts.settings();
    if (language === "python") return { backend: this.opts.python, off: s.python ? "" : "Running Python is switched off in Study Tutor's settings." };
    return { backend: this.opts.native, off: s.native ? "" : "Running C and C++ is switched off in Study Tutor's settings (it runs the program with no sandbox)." };
  }

  async available(language: CodeLanguage): Promise<{ ok: boolean; backend: string; why?: string }> {
    try {
      if (!isCodeLanguage(language)) return { ok: false, backend: "", why: "Unknown language." };
      const { backend, off } = this.pick(language);
      if (off) return { ok: false, backend: "", why: off };
      if (!backend) return { ok: false, backend: "", why: `No ${LANGUAGE_NAME[language]} runner is installed here.` };
      return await backend.available(language);
    } catch (e) {
      return { ok: false, backend: "", why: (e as Error)?.message || String(e) };
    }
  }

  async run(task: CodeTask, source: string, signal?: AbortSignal): Promise<CodeRunReport> {
    const started = Date.now();
    const language = isCodeLanguage((task as { language?: unknown } | null)?.language) ? task.language : "python";
    try {
      const bad = validateCodeTask(task, source);
      if (bad) return codeReport({ language, tests: (task as { tests?: unknown } | null)?.tests }, started, { status: "rejected", message: `Not run: ${bad}.` });
      const a = await this.available(task.language);
      if (!a.ok) return codeReport(task, started, { status: "unavailable", backend: a.backend, message: a.why ?? "Unavailable." });
      if (signal?.aborted) return codeReport(task, started, { status: "unavailable", backend: a.backend, message: "The run was cancelled." });
      return await this.pick(task.language).backend!.run(task, source, signal);
    } catch (e) {
      return codeReport({ language, tests: [] }, started, { status: "unavailable", message: `The runner failed: ${(e as Error)?.message || String(e)}` });
    }
  }

  /**
   * Runs a tiny program in each runner that is switched on and says, one line each, what was
   * found and whether it works. For the settings screen.
   */
  async check(): Promise<string[]> {
    this.opts.python?.reset?.();
    this.opts.native?.reset?.();
    const out: string[] = [];
    const tryOne = async (language: CodeLanguage, source: string, label: string) => {
      const a = await this.available(language);
      if (!a.ok) return `${label}: ${a.why ?? "unavailable"}`;
      const task: CodeTask = { language, tests: [{ name: "check", stdin: "21\n", expected: "42" }], timeLimitMs: 5000 };
      const r = await this.run(task, source);
      const secs = (r.ms / 1000).toFixed(1);
      if (r.status === "ran" && r.passed === 1) return `${label}: works, ${r.backend} (${secs} s)${r.sanitizer === "not-available" ? "; this compiler has no sanitizers" : ""}.`;
      return `${label}: found ${r.backend || a.backend}, but a test program did not run: ${r.message || r.tests[0]?.detail || r.status}`;
    };
    out.push(await tryOne("python", "n = int(input())\nprint(n * 2)\n", "Python"));
    out.push(await tryOne("cpp", "#include <iostream>\nint main() { int n; std::cin >> n; std::cout << n * 2 << '\\n'; }\n", "C++"));
    if (this.opts.settings().native) out.push(await tryOne("c", "#include <stdio.h>\nint main(void) { int n; if (scanf(\"%d\", &n) != 1) return 1; printf(\"%d\\n\", n * 2); return 0; }\n", "C"));
    return out;
  }

  dispose(): void {
    this.opts.python?.dispose?.();
    this.opts.native?.dispose?.();
  }
}
