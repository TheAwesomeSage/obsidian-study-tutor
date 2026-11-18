// The code runner: output comparison, task validation, the code.run tool, Python on the real
// bundled Pyodide (in a Node worker thread, as the plugin runs it in a Web Worker), and C/C++ with
// whatever compiler is on PATH. No model calls. The Python tests are skipped without
// vendor/pyodide (npm run build fetches it); the native ones without a compiler.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import type { CodeRunReport, CodeRunner, CodeTask } from "../src/codetask";
import { CODE_LIMITS, type CodeBackend, LocalCodeRunner, compareOutput, compareValue, mismatchDetail, validateCodeTask } from "../src/coderun";
import { PY_WORKER_CORE, type PyPortFactory, PythonRunner } from "../src/coderun-python";
import { NativeRunner } from "../src/coderun-native";
import { Engine, type EngineSettings } from "../src/engine";
import type { Store } from "../src/store";

// ---------- comparing outputs ----------

test("outputs are compared exactly, trimmed, by tokens or as numbers", () => {
  // Line endings never matter: a C program on Windows writes \r\n.
  assert.ok(compareOutput("a\r\nb\r\n", "a\nb\n", "exact"));
  assert.ok(!compareOutput("a \nb", "a\nb", "exact"));
  assert.ok(!compareOutput("a\nb\n", "a\nb", "exact"));
  // trim, the default: trailing spaces per line and trailing blank lines are ignored, leading ones are not.
  assert.ok(compareOutput("1 2  \n3\t\n\n\n", "1 2\n3"));
  assert.ok(!compareOutput(" 1 2", "1 2"));
  assert.ok(!compareOutput("1  2", "1 2"));
  assert.ok(!compareOutput("1\n\n2", "1\n2"));
  assert.ok(compareOutput("1  2\n\n 3", "1 2 3", "tokens"));
  assert.ok(!compareOutput("1 2", "1 2 3", "tokens"));
  // float: numbers within 1e-6 (relative above 1), words exactly.
  assert.ok(compareOutput("x = 3.1415926\n", "x = 3.14159265", "float"));
  assert.ok(compareOutput("1000000.4", "1000000", "float"));
  assert.ok(compareOutput("0.0000001", "0", "float"));
  assert.ok(!compareOutput("3.1416", "3.14159265", "float"));
  assert.ok(!compareOutput("y = 3.1415926", "x = 3.1415926", "float"));
  assert.ok(!compareOutput("1 2", "1", "float"));
  assert.ok(!compareOutput("nan", "1", "float"));
});

test("function results are compared as JSON values", () => {
  assert.ok(compareValue('{"b": 2, "a": [1, 2.0]}', '{"a":[1,2],"b":2}'));
  assert.ok(!compareValue("[1, 2]", "[2, 1]"));
  assert.ok(!compareValue('"1"', "1"));
  assert.ok(compareValue("[0.30000000000000004]", "[0.3]", "float"));
  assert.ok(!compareValue("[0.30000000000000004]", "[0.3]"));
  assert.ok(!compareValue("[1.1]", "[1]", "float"));
  // Expected text that is not JSON falls back to comparing text.
  assert.ok(compareValue('"hi"', '"hi"  '));
  assert.ok(compareValue("True", "True"));
});

test("a mismatch says where the output first differs", () => {
  assert.equal(mismatchDetail("1\n2\n4\n", "1\n2\n3\n"), 'line 3: expected "3", got "4"');
  assert.match(mismatchDetail("1\n", "1\n2\n"), /stops after 1 line; line 2 should be "2"/);
  assert.match(mismatchDetail("1\n2\n", "1\n"), /extra output after the expected 1 line: line 2 is "2"/);
  assert.match(mismatchDetail("", "5"), /no output/);
});

// ---------- validation ----------

const task = (over: Partial<CodeTask> = {}): CodeTask => ({ language: "python", tests: [{ name: "one", stdin: "1\n", expected: "1" }], ...over });

test("tasks and sources that break a limit are refused before anything runs", () => {
  assert.equal(validateCodeTask(task(), "print(1)"), null);
  assert.equal(validateCodeTask(task({ entry: "f", tests: [{ name: "a", args: [1, [2]], expected: "3" }] }), "def f(a, b): return a"), null);
  const bad: [unknown, unknown, RegExp][] = [
    [task(), "x".repeat(CODE_LIMITS.sourceBytes + 1), /longer than 64 KB/],
    [task(), "   ", /no code/],
    [task(), 42, /no code/],
    [task({ tests: [] }), "print(1)", /no tests/],
    [task({ tests: Array.from({ length: 31 }, (_, i) => ({ name: `t${i}`, expected: "" })) }), "print(1)", /31 tests/],
    [task({ timeLimitMs: 20000 }), "print(1)", /time limit/],
    [task({ timeLimitMs: 10 }), "print(1)", /time limit/],
    [task({ tests: [{ name: "big", stdin: "x".repeat(CODE_LIMITS.ioBytes + 1), expected: "" }] }), "print(1)", /stdin is larger/],
    [task({ tests: [{ name: "big", expected: "x".repeat(CODE_LIMITS.ioBytes + 1) }] }), "print(1)", /expected output is larger/],
    [task({ tests: [{ name: "a", args: [1], expected: "1" }] }), "print(1)", /names no entry/],
    [task({ entry: "f", tests: [{ name: "a", stdin: "1", expected: "1" }] }), "def f(): pass", /args, not stdin/],
    [task({ entry: "import" }), "print(1)", /plain Python function name/],
    [task({ entry: "a.b" }), "print(1)", /plain Python function name/],
    [{ language: "cpp", entry: "main", tests: [{ name: "a", expected: "" }] }, "int main(){}", /Python tasks only/],
    [{ language: "rust", tests: [{ name: "a", expected: "" }] }, "fn main(){}", /python, cpp or c/],
    [task({ tests: [{ name: "a", expected: "1", compare: "fuzzy" as never }] }), "print(1)", /compare must be/],
    [null, "print(1)", /must be an object/],
  ];
  for (const [t, s, why] of bad) assert.match(validateCodeTask(t, s) ?? "accepted", why);
  // Unknown fields are ignored for the runner and refused for the tool.
  const extra = { ...task(), id: "q1" };
  assert.equal(validateCodeTask(extra, "print(1)"), null);
  assert.match(validateCodeTask(extra, "print(1)", { strict: true }) ?? "", /unknown fields: id/);
});

class FakeBackend implements CodeBackend {
  runs = 0;
  constructor(private result: Partial<CodeRunReport> | Error = {}) {}
  async available() {
    return { ok: true, backend: "fake 1.0" };
  }
  async run(t: CodeTask): Promise<CodeRunReport> {
    this.runs++;
    if (this.result instanceof Error) throw this.result;
    return { status: "ran", language: t.language, backend: "fake 1.0", message: "", tests: [], passed: 0, total: t.tests.length, limits: "fake limits", ms: 1, ...this.result };
  }
}

test("the runner refuses, reports switched-off languages and never throws", async () => {
  const py = new FakeBackend(), native = new FakeBackend();
  const runner = new LocalCodeRunner({ settings: () => ({ python: true, native: false }), python: py, native });
  let r = await runner.run(task({ tests: [] }), "print(1)");
  assert.equal(r.status, "rejected");
  assert.match(r.message, /no tests/);
  r = await runner.run(null as unknown as CodeTask, "print(1)");
  assert.equal(r.status, "rejected");
  // C and C++ are off by default: no sandbox.
  r = await runner.run({ language: "cpp", tests: [{ name: "a", expected: "" }] }, "int main(){}");
  assert.equal(r.status, "unavailable");
  assert.match(r.message, /switched off/);
  assert.equal(native.runs, 0);
  assert.deepEqual(await runner.available("c"), { ok: false, backend: "", why: r.message });
  r = await runner.run(task(), "print(1)");
  assert.equal(r.status, "ran");
  assert.equal(py.runs, 1);
  const broken = new LocalCodeRunner({ settings: () => ({ python: true, native: true }), python: new FakeBackend(new Error("boom")), native: null });
  r = await broken.run(task(), "print(1)");
  assert.equal(r.status, "unavailable");
  assert.match(r.message, /boom/);
  r = await broken.run({ language: "c", tests: [{ name: "a", expected: "" }] }, "int main(void){return 0;}");
  assert.equal(r.status, "unavailable");
});

test("the code.run tool validates its input strictly and reports a run that did not happen as a failure", async () => {
  const engine = new Engine({} as unknown as Store, () => ({}) as EngineSettings);
  const seen: CodeTask[] = [];
  const fake: CodeRunner = {
    available: async () => ({ ok: true, backend: "fake" }),
    run: async (t) => {
      seen.push(t);
      return { status: t.tests[0].name === "off" ? "unavailable" : "ran", language: t.language, backend: "fake", message: "switched off", tests: [{ name: "one", hidden: false, status: "pass", detail: "", ms: 1 }], passed: 1, total: 1, limits: "fake limits", ms: 1 };
    },
  };
  let r = await engine.tools.run<CodeRunReport>("code.run", { language: "python", source: "print(1)", task: task() });
  assert.equal(r.ok, false);
  assert.match(r.error, /No code runner/);
  (engine as unknown as { codeRunner: CodeRunner }).codeRunner = fake;
  r = await engine.tools.run("code.run", { language: "python", source: "print(1)", task: task(), extra: 1 });
  assert.match(r.error, /unknown fields: extra/);
  r = await engine.tools.run("code.run", { language: "cpp", source: "print(1)", task: task() });
  assert.match(r.error, /must match/);
  r = await engine.tools.run("code.run", { language: "python", source: "print(1)", task: { ...task(), secret: true } });
  assert.match(r.error, /unknown fields: secret/);
  r = await engine.tools.run("code.run", { language: "python", source: "print(1)", task: task({ tests: [{ name: "one", expected: "1", hidden: "no" as never }] }) });
  assert.match(r.error, /hidden must be/);
  const input = task();
  r = await engine.tools.run("code.run", { language: "python", source: "print(1)", task: input });
  assert.equal(r.ok, true);
  assert.equal(r.output?.passed, 1);
  assert.ok(r.assumptions.includes("fake limits"));
  assert.notEqual(seen[seen.length - 1], input, "the tool runs a copy of the task");
  r = await engine.tools.run("code.run", { language: "python", source: "print(1)", task: task({ tests: [{ name: "off", expected: "" }] }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /switched off/);
});

// ---------- Python on the real bundled Pyodide ----------

const BUNDLE = path.resolve("vendor/pyodide");
const bundled = existsSync(path.join(BUNDLE, "bundle.json"));

/** Worker threads running the same worker core as the plugin's Web Worker, with Pyodide loaded from vendor/pyodide. */
function nodePorts(): PyPortFactory {
  const source = `
const { parentPort, workerData } = require("node:worker_threads");
const { loadPyodide } = require(workerData.pyodide);
${PY_WORKER_CORE}
loadPyodide({ indexURL: workerData.dir, packageCacheDir: workerData.dir, lockFileURL: workerData.lock, stdout: () => {}, stderr: () => {} })
  .then((py) => { const handle = codeRunnerCore(py, (m) => parentPort.postMessage(m)); parentPort.on("message", handle); })
  .catch((e) => parentPort.postMessage({ type: "failed", error: String((e && e.message) || e) }));
`;
  return async () => {
    const w = new Worker(source, { eval: true, workerData: { pyodide: require.resolve("pyodide"), dir: BUNDLE + path.sep, lock: path.join(BUNDLE, "pyodide-lock.json") } });
    return {
      post: (m) => w.postMessage(m),
      listen: (onMessage, onError) => {
        w.on("message", onMessage);
        w.on("error", (e) => onError(e.message));
        w.on("exit", (code) => onError(`the worker exited (${code})`));
      },
      terminate: () => void w.terminate(),
    };
  };
}

const python = () => new LocalCodeRunner({ settings: () => ({ python: true, native: false }), python: new PythonRunner(bundled ? nodePorts() : null, "Pyodide 0.26.4 (Python 3.12)"), native: null });
const noPyodide = bundled ? false : "no bundled Pyodide (run node scripts/vendor-pyodide.mjs)";
const byName = (r: CodeRunReport) => Object.fromEntries(r.tests.map((t) => [t.name, t]));

const PROGRAM = `import sys
cmd = sys.stdin.readline().strip()
if cmd == "loop":
    while True:
        pass
elif cmd == "boom":
    print(10 // 0)
elif cmd == "flood":
    while True:
        print("x" * 1000)
elif cmd == "exit":
    sys.exit(3)
else:
    n = int(cmd)
    print(n * n)
    print(input(), file=sys.stderr)
`;

test("Python programs: pass, fail, an exception, a timeout, too much output and an exit status", { skip: noPyodide, timeout: 120000 }, async () => {
  const r = await python().run(
    {
      language: "python",
      timeLimitMs: 1500,
      tests: [
        { name: "square", stdin: "4\nyes\n", expected: "16" },
        { name: "wrong", stdin: "5\nyes\n", expected: "24", hidden: true },
        { name: "boom", stdin: "boom", expected: "" },
        { name: "loop", stdin: "loop", expected: "" },
        { name: "after", stdin: "3\nyes\n", expected: "9\n" },
        { name: "flood", stdin: "flood", expected: "" },
        { name: "exit", stdin: "exit", expected: "" },
      ],
    },
    PROGRAM,
  );
  assert.equal(r.status, "ran", r.message);
  assert.match(r.backend, /^Pyodide 0\.26\.4 \(Python 3\.12\)$/);
  assert.match(r.limits, /no access to your vault/);
  assert.equal(r.sanitizer, undefined);
  const t = byName(r);
  assert.equal(t.square.status, "pass", t.square.detail);
  assert.equal(t.wrong.status, "fail");
  assert.equal(t.wrong.hidden, true);
  assert.match(t.wrong.detail, /line 1: expected "24", got "25"/);
  assert.equal(t.boom.status, "error");
  assert.match(t.boom.detail, /File "<solution>", line 7/);
  assert.match(t.boom.detail, /ZeroDivisionError/);
  assert.doesNotMatch(t.boom.detail, /_make_runner|exec\(code/, "the harness's own frames are hidden");
  assert.equal(t.loop.status, "timeout");
  assert.ok(t.loop.ms >= 1400 && t.loop.ms < 5000, `stopped near the limit, not after loading: ${t.loop.ms} ms`);
  assert.equal(t.after.status, "pass", `a fresh worker runs the next test: ${t.after.detail}`);
  assert.equal(t.flood.status, "error");
  assert.match(t.flood.detail, /more than 64 KB/);
  assert.equal(t.exit.status, "error");
  assert.match(t.exit.detail, /exited with status 3/);
  assert.equal(r.passed, 2);
  assert.equal(r.total, 7);
});

test("Python functions: the harness calls the entry with JSON arguments and compares the result", { skip: noPyodide, timeout: 60000 }, async () => {
  const source = "def mean(xs):\n    return sum(xs) / len(xs)\n\ndef stats(xs):\n    return {'max': max(xs), 'seen': set(xs)}\n\nif __name__ == '__main__':\n    input()\n";
  const r = await python().run(
    {
      language: "python",
      entry: "mean",
      tests: [
        { name: "four", args: [[1, 2, 3, 4]], expected: "2.5" },
        { name: "off", args: [[1, 2]], expected: "1.4" },
        { name: "empty", args: [[]], expected: "0" },
        { name: "float", args: [[0.1, 0.2]], expected: "0.15000000001", compare: "float" },
        { name: "arity", args: [[1], 2], expected: "1" },
      ],
    },
    source,
  );
  assert.equal(r.status, "ran", r.message);
  const t = byName(r);
  assert.equal(t.four.status, "pass", t.four.detail);
  assert.equal(t.off.status, "fail");
  assert.match(t.off.detail, /expected 1\.4, got 1\.5/);
  assert.equal(t.empty.status, "error");
  assert.match(t.empty.detail, /ZeroDivisionError/);
  assert.equal(t.float.status, "pass", t.float.detail);
  assert.equal(t.arity.status, "error");
  assert.match(t.arity.detail, /TypeError/);
  // Sets become sorted lists; key order does not matter.
  const s = await python().run({ language: "python", entry: "stats", tests: [{ name: "stats", args: [[3, 1, 3]], expected: '{"seen": [1, 3], "max": 3}' }] }, source);
  assert.equal(s.tests[0].status, "pass", s.tests[0].detail);
  const missing = await python().run({ language: "python", entry: "median", tests: [{ name: "none", args: [], expected: "1" }] }, source);
  assert.match(missing.tests[0].detail, /no function called median/);
});

test("Python with a syntax error is a compile error, and nothing runs", { skip: noPyodide, timeout: 60000 }, async () => {
  const r = await python().run(task(), "print('a')\nx = = 1\n");
  assert.equal(r.status, "compile-error");
  assert.match(r.message, /line 2/);
  assert.match(r.message, /SyntaxError/);
  assert.equal(r.tests.length, 0);
  assert.equal(r.total, 1);
});

test("Python cannot reach the network or JavaScript", { skip: noPyodide, timeout: 60000 }, async () => {
  const attempts: [string, string][] = [
    ["import js", "import js\njs.fetch('http://example.com')"],
    ["pyodide.http", "from pyodide.http import pyfetch"],
    ["pyodide.ffi", "import pyodide.ffi"],
    ["pyodide_js", "import pyodide_js"],
    ["_pyodide_core", "import _pyodide_core"],
    ["finder removed", "sys.meta_path[:] = [f for f in sys.meta_path if type(f).__name__ != 'NoBridge']\nimport js"],
    ["importlib", "import importlib\nimportlib.import_module('js')"],
    ["urllib", "import urllib.request\nurllib.request.urlopen('http://example.com', timeout=2)"],
    ["socket", "import socket\nsocket.create_connection(('example.com', 80), timeout=2)"],
    ["gc", "import gc\ngc.get_objects()"],
    ["builtin core", "import _imp, importlib.machinery\ncore = _imp.create_builtin(importlib.machinery.ModuleSpec('_pyodide_core', None))\ng = core.to_js({}).constructor.constructor('return globalThis')()\ng.fetch('http://example.com')"],
    // Python's barrier is best effort: Pyodide's own objects are still reachable through function
    // globals. Every JavaScript object found that way must lead nowhere either.
    ["globals", [
      "seen, todo, tried = set(), [object], 0",
      "while todo:",
      "    cls = todo.pop()",
      "    if id(cls) in seen: continue",
      "    seen.add(id(cls))",
      "    try: todo.extend(type.__subclasses__(cls))",
      "    except Exception: pass",
      "    for v in list(vars(cls).values()):",
      "        for x in list((getattr(getattr(v, '__func__', v), '__globals__', None) or {}).values()):",
      "            if not type(x).__name__.startswith('Js'): continue",
      "            tried += 1",
      "            for get in (lambda: x.fetch, lambda: x.constructor.constructor('return globalThis')().fetch, lambda: x.globalThis.fetch):",
      "                try:",
      "                    f = get()",
      "                except BaseException:",
      "                    continue",
      "                if f is not None:",
      "                    f('http://example.com')",
      "                    return",
      "raise RuntimeError(f'nothing usable in {tried} JavaScript objects')",
    ].join("\n")],
  ];
  const source = `import sys\nreport = []\n${attempts
    .map(([label, code], i) => `def attempt${i}():\n${code.split("\n").map((l) => `    ${l}`).join("\n")}\ntry:\n    attempt${i}()\n    report.append(${JSON.stringify(label)} + ": reached")\nexcept BaseException as e:\n    report.append(${JSON.stringify(label)} + ": blocked")\n`)
    .join("")}print("\\n".join(report))\n`;
  const r = await python().run({ language: "python", tests: [{ name: "offline", expected: attempts.map(([label]) => `${label}: blocked`).join("\n") }], timeLimitMs: 8000 }, source);
  assert.equal(r.status, "ran", r.message);
  assert.equal(r.tests[0].status, "pass", r.tests[0].detail);
  assert.match(r.limits, /network functions are removed/);
});

// ---------- C and C++ with a local compiler ----------

const nativeProbe = new NativeRunner();
const compilerSkip = async (language: "cpp" | "c") => ((await nativeProbe.toolchain(language)) ? false : `no ${language === "c" ? "C" : "C++"} compiler on PATH (${language === "c" ? "gcc, clang" : "g++, clang++"})`);
const native = () => new LocalCodeRunner({ settings: () => ({ python: false, native: true }), python: null, native: new NativeRunner() });

const SUM = `#include <iostream>
#include <vector>
int main() {
  long long a, b;
  if (!(std::cin >> a >> b)) return 2;
  if (a == 7) { volatile unsigned long spin = 0; for (;;) spin++; }
  if (a == 9) { std::vector<int> v(3); return v.at(5); }
  std::cout << a + b << "\\n";
}
`;

test("C++: compile errors, passes, failures, crashes and timeouts", { timeout: 180000 }, async (ctx) => {
  const skip = await compilerSkip("cpp");
  if (skip) return ctx.skip(skip);
  const runner = native();
  const avail = await runner.available("cpp");
  assert.ok(avail.ok, avail.why);
  const bad = await runner.run({ language: "cpp", tests: [{ name: "a", expected: "" }] }, "int main() { return missing_name; }\n");
  assert.equal(bad.status, "compile-error");
  assert.match(bad.message, /main\.cpp:1/);
  assert.match(bad.message, /missing_name/);
  assert.doesNotMatch(bad.message, /study-tutor-run-/, "the temporary folder is not shown");
  const r = await runner.run(
    {
      language: "cpp",
      timeLimitMs: 1000,
      tests: [
        { name: "sum", stdin: "2 3\n", expected: "5" },
        { name: "wrong", stdin: "1 1", expected: "3" },
        { name: "spin", stdin: "7 0", expected: "" },
        { name: "throws", stdin: "9 0", expected: "" },
        { name: "no input", expected: "" },
        { name: "after", stdin: "40 2", expected: "42" },
      ],
    },
    SUM,
  );
  assert.equal(r.status, "ran", r.message);
  assert.match(r.backend, /-std=c\+\+20 -O2/);
  assert.match(r.limits, /no sandbox/);
  const t = byName(r);
  assert.equal(t.sum.status, "pass", t.sum.detail);
  assert.equal(t.wrong.status, "fail");
  assert.match(t.wrong.detail, /expected "3", got "2"/);
  assert.equal(t.spin.status, "timeout");
  assert.ok(t.spin.ms < 6000, `the process tree was killed promptly: ${t.spin.ms} ms`);
  assert.equal(t.throws.status, "error");
  assert.equal(t["no input"].status, "error");
  assert.match(t["no input"].detail, /exited with status 2/);
  assert.equal(t.after.status, "pass", t.after.detail);
  assert.equal(r.sanitizer, /-fsanitize=address/.test(r.backend) ? "clean" : "not-available");
  if (r.sanitizer === "not-available") console.log(`# sanitizers are not available with ${r.backend}`);
});

test("C: a whole program, and the sanitizers when the toolchain has them", { timeout: 180000 }, async (ctx) => {
  const skip = await compilerSkip("c");
  if (skip) return ctx.skip(skip);
  const runner = native();
  const ok = await runner.run({ language: "c", tests: [{ name: "add", stdin: "20 22", expected: "42" }] }, "#include <stdio.h>\n#include <math.h>\nint main(void) { double a, b; if (scanf(\"%lf %lf\", &a, &b) != 2) return 1; printf(\"%.0f\\n\", sqrt((a + b) * (a + b))); return 0; }\n");
  assert.equal(ok.status, "ran", ok.message);
  assert.match(ok.backend, /-std=c17/);
  assert.equal(ok.tests[0].status, "pass", ok.tests[0].detail);
  // A heap overflow: a sanitizer reports it where they exist. The runner stops at the first error, and
  // newer gcc lets UBSan's object-size check see this store (a 16-byte malloc, index 8) before
  // AddressSanitizer does, so either tool's report is the expected outcome.
  const overflow = await runner.run({ language: "c", tests: [{ name: "overflow", stdin: "8", expected: "0" }] }, "#include <stdio.h>\n#include <stdlib.h>\nint main(void) { int n; if (scanf(\"%d\", &n) != 1) return 1; volatile int *p = malloc(4 * sizeof *p); p[n] = 1; printf(\"%d\\n\", p[n] - 1); free((void *)p); return 0; }\n");
  assert.equal(overflow.status, "ran", overflow.message);
  if (/-fsanitize=address/.test(overflow.backend)) {
    assert.equal(overflow.sanitizer, "reported");
    assert.equal(overflow.tests[0].status, "error");
    assert.match(overflow.tests[0].detail, /AddressSanitizer|runtime error: store to address/);
    assert.match(overflow.message, /Sanitizer report/);
  } else {
    assert.equal(overflow.sanitizer, "not-available");
    assert.match(overflow.message, /no AddressSanitizer/);
    console.log(`# no AddressSanitizer with ${overflow.backend}: the overflow went unchecked`);
  }
});

test("C++ concurrent tasks are race-checked only with ThreadSanitizer", { timeout: 180000 }, async (ctx) => {
  const skip = await compilerSkip("cpp");
  if (skip) return ctx.skip(skip);
  const racy = "#include <iostream>\n#include <thread>\nint counter = 0;\nint main() { auto work = [] { for (int i = 0; i < 100000; i++) counter++; }; std::thread a(work), b(work); a.join(); b.join(); std::cout << \"done\\n\"; }\n";
  const r = await native().run({ language: "cpp", concurrent: true, tests: [{ name: "race", expected: "done" }], timeLimitMs: 5000 }, racy);
  assert.equal(r.status, "ran", r.message);
  assert.equal(r.tests[0].status, "pass", r.tests[0].detail);
  assert.match(r.limits, /cannot show a program is free of races/);
  if (/-fsanitize=thread/.test(r.backend)) {
    assert.equal(r.sanitizer, "reported");
    assert.match(r.message, /ThreadSanitizer/);
  } else {
    // ASan alone says nothing about races, so the run is never "clean".
    assert.equal(r.sanitizer, "not-available");
    console.log(`# no ThreadSanitizer with ${r.backend}`);
  }
});
