// The contract between code questions and the code runner. A code task's tests are data written
// at compile time (stdin and expected output, or arguments and an expected return value), never
// code: the only code ever run is the learner's own solution, inside the runner's limits
// (coderun.ts). Types only here; parsing and marking live with the code questions.
// No Obsidian imports.

export type CodeLanguage = "python" | "cpp" | "c";

/** How an actual output is compared with the expected one. "float" compares numbers within 1e-6 relative. */
export type CodeCompare = "exact" | "trim" | "tokens" | "float";

export interface CodeTestCase {
  /** A short label shown with the result, such as "empty buffer". */
  name: string;
  /** A whole program: what it reads on standard input. */
  stdin?: string;
  /** Python with an entry function: the call's arguments, as JSON values. */
  args?: unknown[];
  /** The expected standard output, or for a function the expected return value as JSON text. */
  expected: string;
  /** Not shown to the learner until the answer is marked. */
  hidden?: boolean;
  /** Default "trim": trailing whitespace on each line and at the end is ignored. */
  compare?: CodeCompare;
}

export interface CodeTask {
  language: CodeLanguage;
  /** Python only: the function to call with each test's args. Absent: a whole program reading stdin. */
  entry?: string;
  /** 1 to 30 tests. */
  tests: CodeTestCase[];
  /** Per test, in milliseconds. Default 2000, at most 10000. */
  timeLimitMs?: number;
  /** Threads or shared state: passing tests cannot show the program is free of races. */
  concurrent?: boolean;
  /** C and C++: build with sanitizers when the toolchain has them. Default true. */
  sanitizers?: boolean;
  /** Starting code shown to the learner, if any. */
  starter?: string;
}

export type CodeTestStatus = "pass" | "fail" | "error" | "timeout";

export interface CodeTestResult {
  name: string;
  hidden: boolean;
  status: CodeTestStatus;
  /** Bounded text: expected against actual for a failure, or the start of stderr for an error. */
  detail: string;
  ms: number;
}

export interface CodeRunReport {
  /** "unavailable": no runner for the language (switched off, or no compiler found). "rejected": the task or source broke a limit. */
  status: "ran" | "compile-error" | "unavailable" | "rejected";
  language: CodeLanguage;
  /** What ran it, for example "Pyodide 0.26.4 (Python 3.12)" or "g++ 13.2.0 -std=c++20 -O2 -fsanitize=address,undefined". */
  backend: string;
  /** Compiler output, bounded; or why the run was unavailable or rejected. */
  message: string;
  tests: CodeTestResult[];
  passed: number;
  total: number;
  /** C and C++: what the sanitizers said. Absent for Python. */
  sanitizer?: "clean" | "reported" | "not-available";
  /** The isolation that applied, in plain words, shown with the result. */
  limits: string;
  ms: number;
}

export interface CodeRunner {
  /** Whether this language can run here, and with what. Never throws. */
  available(language: CodeLanguage): Promise<{ ok: boolean; backend: string; why?: string }>;
  /** Runs the learner's source against the task's tests. Never throws: failures are reported. */
  run(task: CodeTask, source: string, signal?: AbortSignal): Promise<CodeRunReport>;
}
