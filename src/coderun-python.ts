// Python code tasks, run in the Pyodide the plugin ships (the same files SymPy uses, without the
// SymPy wheels), inside a Web Worker of their own: never a subprocess, never the network.
//
// Each run gets a fresh worker. Once Pyodide has loaded, the worker's network functions are
// removed (fetch, XMLHttpRequest, WebSocket, EventSource, importScripts and the rest), code can no
// longer be made from strings, and on the Python side the bridges to JavaScript (`js`,
// `pyodide.ffi`, `pyodide.http`, `_pyodide_core`, ...) are taken out of sys.modules, refused by a
// meta path finder and by an audit hook, which Python cannot remove. A test that runs past its
// time limit takes the worker with it; the next test starts a new one.
//
// The expected outputs never enter the worker: the harness hands back what the program printed
// (or, for a function, its return value as JSON) and the comparison happens out here. No
// Obsidian imports.

import type { CodeRunReport, CodeTask, CodeTestResult, CodeTraceStep } from "./codetask";
import { CODE_LIMITS, type CodeBackend, boundDetail, boundMessage, codeReport, judgeOutput, testOutcome, timeLimitOf } from "./coderun";
import { type BundleFiles, PYODIDE_WORKER_PRELUDE } from "./sympy";

/** The trusted Python side. `_make_runner()` locks the interpreter down and returns `run(request_json) -> result_json`. */
export const PY_HARNESS = String.raw`
def _make_runner():
    import sys, io, json, traceback, linecache, builtins, itertools
    take = itertools.islice

    BRIDGES = {"js", "pyodide", "pyodide_js", "_pyodide", "_pyodide_core", "micropip", "pyodide_http"}

    def bridged(name):
        return isinstance(name, str) and name.split(".")[0] in BRIDGES

    class NoBridge:
        # First on sys.meta_path: Python's ways into JavaScript cannot be imported again.
        @staticmethod
        def find_spec(name, path=None, target=None):
            if bridged(name):
                raise ImportError(name + " is not available in the code runner (no JavaScript, no network)", name=name)
            return None

        @staticmethod
        def invalidate_caches():
            pass

    for finder in list(sys.meta_path):
        if type(finder).__name__ == "JsFinder":
            sys.meta_path.remove(finder)
    sys.meta_path.insert(0, NoBridge)
    for name in list(sys.modules):
        if bridged(name):
            del sys.modules[name]
    # Pyodide's own __main__ holds some of them too.
    main = sys.modules.get("__main__")
    for name in list(vars(main)) if main is not None else []:
        if bridged(name):
            delattr(main, name)

    def audit(event, args):
        # An audit hook cannot be removed, so this still holds if the finder above is.
        if event == "import" and args and bridged(args[0]):
            raise ImportError(str(args[0]) + " is not available in the code runner")
        if event in ("gc.get_objects", "gc.get_referrers", "gc.get_referents"):
            raise RuntimeError(event + " is not available in the code runner")

    sys.addaudithook(audit)

    class OutputLimit(BaseException):
        pass

    class Sink(io.RawIOBase):
        def __init__(self, limit, strict):
            super().__init__()
            self.data = bytearray()
            self.limit = limit
            self.strict = strict
            self.over = False

        def writable(self):
            return True

        def write(self, b):
            b = bytes(b)
            room = self.limit - len(self.data)
            if len(b) > room:
                if room > 0:
                    self.data += b[:room]
                self.over = True
                if self.strict:
                    raise OutputLimit()
                return len(b)
            self.data += b
            return len(b)

        def text(self):
            return self.data.decode("utf-8", "replace")

    def stream(sink):
        return io.TextIOWrapper(sink, encoding="utf-8", errors="replace", newline="\n", write_through=True)

    def trace(e):
        te = traceback.TracebackException.from_exception(e)
        te.stack = traceback.StackSummary.from_list([f for f in te.stack if f.filename == "<solution>"])
        lines = "".join(te.format(chain=False)).rstrip().splitlines()
        return "\n".join(lines[-8:])

    def plain(o):
        if isinstance(o, (set, frozenset)):
            try:
                return sorted(o)
            except TypeError:
                return list(o)
        raise TypeError("the function returned a " + type(o).__name__ + ", which has no JSON form")

    def run(request):
        req = json.loads(request)
        source = req["source"]
        mode = req["mode"]
        linecache.cache["<solution>"] = (len(source), None, source.splitlines(True), "<solution>")
        out, err = Sink(req["maxOut"], True), Sink(req["maxErr"], False)
        res = {"status": "ok"}
        events = []
        def show_value(value, depth=0):
            if type(value) in (str, int, float, bool, type(None)):
                return repr(value)[:160]
            if depth < 2 and type(value) in (list, tuple):
                return "[" + ", ".join(display(v, depth+1) for v in value[:12]) + (", ..." if len(value)>12 else "") + "]"
            if depth < 2 and type(value) is dict:
                return "{" + ", ".join(display(k, depth+1)+": "+display(v, depth+1) for k,v in take(value.items(), 12)) + "}"
            return "<" + type(value).__name__[:40] + ">"
        def display(value, depth=0):
            try:
                return show_value(value, depth)
            except BaseException:
                return "<value not displayable>"
        def observe(frame, event, arg):
            if len(events) >= 120:
                sys.settrace(None)
                return None
            if frame.f_code.co_filename == "<solution>" and event in ("line", "return", "exception") and len(events) < 120:
                named = ((k,v) for k,v in frame.f_locals.items() if type(k) is str and not k.startswith("__"))
                variables = [{"name": k[:80], "value": display(v)} for k,v in take(named, 20)]
                if event == "return":
                    variables.append({"name": "return", "value": display(arg)})
                events.append({"line": frame.f_lineno, "event": event, "function": frame.f_code.co_name[:80], "variables": variables, "output": out.text()[-2000:]})
            return observe
        saved = (sys.stdin, sys.stdout, sys.stderr)
        sys.stdin = io.TextIOWrapper(io.BytesIO(req.get("stdin", "").encode("utf-8")), encoding="utf-8")
        sys.stdout, sys.stderr = stream(out), stream(err)
        try:
            try:
                code = compile(source, "<solution>", "exec", dont_inherit=True)
            except (SyntaxError, ValueError) as e:
                code = None
                res = {"status": "syntax", "detail": trace(e)}
            if code is not None and mode != "check":
                try:
                    ns = {"__name__": "__main__" if mode == "program" else "solution", "__builtins__": builtins}
                    if req.get("inspect"):
                        sys.settrace(observe)
                    exec(code, ns)
                    if mode == "function":
                        fn = ns.get(req["entry"])
                        if not callable(fn):
                            res = {"status": "nofunc", "detail": "there is no function called " + req["entry"]}
                        else:
                            value = fn(*json.loads(req["args"]))
                            try:
                                res["value"] = json.dumps(value, sort_keys=True, allow_nan=False, ensure_ascii=False, default=plain)
                            except (TypeError, ValueError) as e:
                                res = {"status": "value", "detail": str(e)}
                except SystemExit as e:
                    c = e.code
                    if isinstance(c, bool) or not (c is None or c == 0):
                        if not isinstance(c, int):
                            err.write((str(c) + "\n").encode("utf-8", "replace"))
                        res = {"status": "exit", "detail": "exited with status " + str(c if isinstance(c, int) else 1)}
                except OutputLimit:
                    res = {"status": "output"}
                except BaseException as e:
                    res = {"status": "exception", "detail": trace(e)}
        finally:
            sys.settrace(None)
            for s in (sys.stdout, sys.stderr):
                try:
                    s.flush()
                except BaseException:
                    pass
            sys.stdin, sys.stdout, sys.stderr = saved
        if out.over:
            res = {"status": "output"}
        res["stdout"] = out.text()
        res["stderr"] = err.text()
        if req.get("inspect"):
            res["trace"] = events
        return json.dumps(res)

    return run

_make_runner()
`;

/**
 * The worker side, shared by the plugin's Web Worker and the Node tests' worker thread. Given a
 * loaded Pyodide and a way to post to the host, it locks the worker down and returns the message
 * handler. Plain JavaScript, kept as text.
 */
export const PY_WORKER_CORE = String.raw`
function codeRunnerCore(py, post) {
  const python = py.runPython("import sys\nsys.version.split()[0]");
  // The harness lives in a namespace of its own, so its functions' globals lead nowhere.
  const run = py.runPython(${JSON.stringify(PY_HARNESS)}, { globals: py.toPy({}) });
  let input = "";
  py.setStdin({ stdin: () => { const s = input; input = ""; return s || null; } });
  const scope = globalThis;
  const own = Object.prototype.hasOwnProperty;
  const strip = (name) => {
    for (let o = scope; o; o = Object.getPrototypeOf(o)) {
      try { if (own.call(o, name)) delete o[name]; } catch (e) {}
    }
    try { Object.defineProperty(scope, name, { value: undefined, writable: false, configurable: false }); } catch (e) {}
  };
  // No network, no other workers or storage, and no way to post to the host but the one below.
  for (const name of ["fetch", "fetchLater", "XMLHttpRequest", "WebSocket", "WebSocketStream", "WebTransport", "EventSource", "importScripts", "Worker", "SharedWorker", "BroadcastChannel", "caches", "indexedDB", "postMessage"]) strip(name);
  // No code from strings, so a dynamic import() cannot be written at run time either.
  const refuse = () => { throw new EvalError("running code from strings is switched off in the code runner"); };
  for (const proto of [Function.prototype, Object.getPrototypeOf(async function () {}), Object.getPrototypeOf(function* () {}), Object.getPrototypeOf(async function* () {})]) {
    const fake = function () { refuse(); };
    fake.prototype = proto;
    try { Object.defineProperty(proto, "constructor", { value: fake, writable: false, configurable: false }); } catch (e) {}
  }
  try { Object.defineProperty(scope, "Function", { value: Function.prototype.constructor, writable: false, configurable: false }); } catch (e) {}
  try { Object.defineProperty(scope, "eval", { value: function () { refuse(); }, writable: false, configurable: false }); } catch (e) {}
  for (const name of ["setTimeout", "setInterval"]) {
    const real = scope[name];
    if (typeof real !== "function") continue;
    try { Object.defineProperty(scope, name, { value: function (fn, ...rest) { if (typeof fn !== "function") refuse(); return real.call(scope, fn, ...rest); }, writable: false, configurable: false }); } catch (e) {}
  }
  post({ type: "ready", version: String(py.version), python: String(python) });
  return (m) => {
    if (!m || m.type !== "run" || typeof m.id !== "number") return;
    let json;
    try {
      input = typeof m.req.stdin === "string" ? m.req.stdin : "";
      json = String(run(JSON.stringify(m.req)));
    } catch (err) {
      post({ type: "result", id: m.id, fatal: String((err && err.message) || err).slice(0, 500) });
      return;
    }
    post({ type: "result", id: m.id, json });
  };
}
`;

/** Source of the plugin's code-runner worker: Node removed, Pyodide loaded from the bundle in memory, then locked down. */
export const PY_WORKER_SOURCE = `
${PYODIDE_WORKER_PRELUDE}
${PY_WORKER_CORE}
const postToHost = self.postMessage.bind(self);
let handle = null;
self.onmessage = async (e) => {
  const m = e.data;
  if (m && m.type === "init") {
    try {
      if (typeof process !== "undefined" || typeof require !== "undefined") throw new Error("Node could not be removed from the worker");
      if (!m.files) throw new Error("the bundled Python runtime is missing");
      const release = serveBundle(m.files, "not part of the bundled Python runtime: ");
      importScripts(LOCAL + "pyodide.js");
      const py = await loadPyodide({ indexURL: LOCAL, stdout: () => {}, stderr: () => {} });
      release();
      handle = codeRunnerCore(py, postToHost);
    } catch (err) {
      postToHost({ type: "failed", error: String((err && err.message) || err).slice(0, 300) });
    }
    return;
  }
  if (handle) handle(m);
};
`;

/** A started worker, as the runner sees it: the plugin's Web Worker, or a worker thread in tests. */
export interface PyPort {
  post(message: unknown, transfer?: Transferable[]): void;
  listen(onMessage: (data: unknown) => void, onError: (why: string) => void): void;
  terminate(): void;
}

/** Starts a worker, or says why it cannot. */
export type PyPortFactory = () => Promise<PyPort | string>;

/** Workers for the plugin: Web Workers given the bundled runtime's files (moved, not copied). */
export function browserPyPorts(readBundle: () => Promise<BundleFiles | null>): PyPortFactory {
  let url = "";
  return async () => {
    let files: BundleFiles | null;
    try {
      files = await readBundle();
    } catch (e) {
      return (e as Error).message || "the bundled Python runtime could not be read";
    }
    if (!files) return "the bundled Python runtime was not found (the plugin's pyodide folder); reinstall the whole release folder";
    let w: Worker;
    try {
      url ||= URL.createObjectURL(new Blob([PY_WORKER_SOURCE], { type: "text/javascript" }));
      w = new Worker(url);
    } catch (e) {
      return (e as Error).message || "workers are not available";
    }
    w.postMessage({ type: "init", files }, Object.values(files));
    return {
      post: (m, transfer) => w.postMessage(m, transfer ?? []),
      listen: (onMessage, onError) => {
        w.onmessage = (e: MessageEvent) => onMessage(e.data);
        w.onerror = (e: ErrorEvent) => onError(e.message || "the worker stopped");
      },
      terminate: () => w.terminate(),
    };
  };
}

type Reply = { kind: "done"; data: Record<string, unknown> } | { kind: "timeout" } | { kind: "fatal"; why: string };

const LOAD_MS = 60000;
const CHECK_MS = 15000;

/** One worker for one run (or until a test times out). */
class PySession {
  private next = 1;
  private pending = new Map<number, (r: Reply) => void>();
  dead = "";
  version = "";
  python = "";
  readonly ready: Promise<string | null>;

  constructor(private port: PyPort) {
    let settle: (why: string | null) => void = () => {};
    this.ready = new Promise((resolve) => (settle = resolve));
    const timer = setTimeout(() => {
      settle("Python took too long to start");
      this.kill("Python took too long to start");
    }, LOAD_MS);
    port.listen(
      (data) => {
        // The worker is not trusted to be well behaved: every field is checked.
        const m = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
        if (!m) return;
        if (m.type === "ready") {
          clearTimeout(timer);
          this.version = typeof m.version === "string" ? m.version.slice(0, 20) : "";
          this.python = typeof m.python === "string" ? m.python.slice(0, 20) : "";
          settle(null);
        } else if (m.type === "failed") {
          clearTimeout(timer);
          const why = String(m.error ?? "Python could not start").slice(0, 300);
          settle(why);
          this.kill(why);
        } else if (m.type === "result" && typeof m.id === "number") {
          const done = this.pending.get(m.id);
          if (!done) return;
          this.pending.delete(m.id);
          if (typeof m.json !== "string") return done({ kind: "fatal", why: String(m.fatal ?? "the worker sent no result").slice(0, 500) });
          try {
            const parsed: unknown = JSON.parse(m.json);
            done(parsed && typeof parsed === "object" ? { kind: "done", data: parsed as Record<string, unknown> } : { kind: "fatal", why: "the worker sent a malformed result" });
          } catch {
            done({ kind: "fatal", why: "the worker sent a malformed result" });
          }
        }
      },
      (why) => {
        clearTimeout(timer);
        settle(why || "the worker stopped");
        this.kill(why || "the worker stopped");
      },
    );
  }

  call(req: Record<string, unknown>, timeoutMs: number): Promise<Reply> {
    if (this.dead) return Promise.resolve({ kind: "fatal", why: this.dead });
    return new Promise((resolve) => {
      const id = this.next++;
      const timer = setTimeout(() => {
        // A test that runs too long takes the worker with it.
        this.pending.delete(id);
        this.kill("timed out");
        resolve({ kind: "timeout" });
      }, timeoutMs);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.port.post({ type: "run", id, req });
    });
  }

  kill(why: string): void {
    if (this.dead) return;
    this.dead = why;
    try {
      this.port.terminate();
    } catch {
      /* already gone */
    }
    for (const done of this.pending.values()) done({ kind: "fatal", why });
    this.pending.clear();
  }
}

const str = (x: unknown): string => (typeof x === "string" ? x : "");

/** Treat even the isolated worker's trace as untrusted, bounded data. */
export function readCodeTrace(value: unknown, lines: number): CodeTraceStep[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 120).flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return [];
    const x = item as Record<string, unknown>;
    if (!Number.isInteger(x.line) || Number(x.line) < 1 || Number(x.line) > lines || !["line", "return", "exception"].includes(str(x.event))) return [];
    const variables = Array.isArray(x.variables) ? x.variables.slice(0, 21).flatMap((v: unknown) => {
      if (!v || typeof v !== "object") return [];
      const p = v as Record<string, unknown>;
      return typeof p.name === "string" && typeof p.value === "string" ? [{ name: p.name.slice(0, 80), value: p.value.slice(0, 400) }] : [];
    }) : [];
    return [{ line: Number(x.line), event: str(x.event), function: str(x.function).slice(0, 80), variables, output: str(x.output).slice(-2000) }];
  });
}

/** Python tasks: whole programs reading stdin, or an entry function called with each test's args. */
export class PythonRunner implements CodeBackend {
  private seen = "";

  /** `ports` is null when the bundled runtime is not installed. `label` names it, from its bundle.json. */
  constructor(private ports: PyPortFactory | null, private label = "Pyodide (bundled)") {}

  private backend(): string {
    return this.seen || this.label;
  }

  async available(): Promise<{ ok: boolean; backend: string; why?: string }> {
    return this.ports ? { ok: true, backend: this.backend() } : { ok: false, backend: "", why: "The bundled Python (the plugin's pyodide folder) was not found; reinstall the whole release folder." };
  }

  limits(task: CodeTask): string {
    const secs = timeLimitOf(task) / 1000;
    return [
      "Python (Pyodide, WebAssembly) in a separate worker with no access to your vault, your files or Node; nothing is downloaded.",
      "The worker's network functions are removed and Python's bridge to JavaScript is blocked. That keeps ordinary code offline, but it is not a hardened sandbox against code written to break out.",
      `Limits: ${secs} s per test, ${CODE_LIMITS.outputBytes / 1024} KB of output.`,
      ...(task.concurrent ? ["Threads cannot start in Pyodide, and passing tests cannot show a program is free of races."] : []),
    ].join(" ");
  }

  async run(task: CodeTask, source: string, signal?: AbortSignal): Promise<CodeRunReport> {
    const started = Date.now();
    const limitMs = timeLimitOf(task);
    const live: { s: PySession | null } = { s: null };
    const onAbort = () => live.s?.kill("cancelled");
    signal?.addEventListener("abort", onAbort);
    const report = (r: Partial<CodeRunReport> & Pick<CodeRunReport, "status">) => codeReport(task, started, { backend: this.backend(), limits: this.limits(task), ...r });
    const open = async (): Promise<PySession | string> => {
      if (!this.ports) return "the bundled Python runtime is not installed";
      const port = await this.ports();
      if (typeof port === "string") return port;
      const s = new PySession(port);
      live.s = s;
      if (signal?.aborted) s.kill("cancelled");
      const why = await s.ready;
      if (why) return why;
      if (s.version) this.seen = `Pyodide ${s.version} (Python ${s.python.split(".").slice(0, 2).join(".")})`;
      return s;
    };
    const base = { maxOut: CODE_LIMITS.outputBytes, maxErr: CODE_LIMITS.errorBytes, source, inspect: task.inspect === true };
    try {
      let s: PySession | string = await open();
      if (signal?.aborted) return report({ status: "unavailable", message: "The run was cancelled." });
      if (typeof s === "string") return report({ status: "unavailable", message: `Python could not start: ${s}.` });
      const check = await s.call({ ...base, mode: "check" }, CHECK_MS);
      if (check.kind !== "done") return report({ status: "unavailable", message: signal?.aborted ? "The run was cancelled." : "Python stopped while reading the code." });
      if (check.data.status === "syntax") return report({ status: "compile-error", message: boundMessage(str(check.data.detail) || "The code is not valid Python.") });
      const tests: CodeTestResult[] = [];
      let used = 0;
      for (const [i, t] of task.tests.entries()) {
        if (signal?.aborted) break;
        if (used >= CODE_LIMITS.runBudgetMs) {
          tests.push(testOutcome(t, i, "timeout", "not run: the run's total time was used up", 0));
          continue;
        }
        if (typeof s === "string" || s.dead) {
          s = await open();
          if (typeof s === "string") {
            tests.push(testOutcome(t, i, "error", `Python could not restart: ${s}`, 0));
            continue;
          }
        }
        const req = task.entry !== undefined ? { ...base, mode: "function", entry: task.entry, args: JSON.stringify(t.args ?? []) } : { ...base, mode: "program", stdin: t.stdin ?? "" };
        const t0 = Date.now();
        const r = await s.call(req, Math.min(limitMs, CODE_LIMITS.runBudgetMs - used));
        const ms = Date.now() - t0;
        used += ms;
        if (signal?.aborted) break;
        const judged = this.judge(task, i, r, ms, limitMs);
        if (task.inspect && !t.hidden && r.kind === "done") {
          judged.stdout = str(r.data.stdout).slice(0, CODE_LIMITS.outputBytes);
          judged.trace = readCodeTrace(r.data.trace, source.split(/\r?\n/).length);
        }
        tests.push(judged);
      }
      if (signal?.aborted) return report({ status: "unavailable", message: "The run was cancelled.", tests });
      return report({ status: "ran", tests });
    } catch (e) {
      return report({ status: "unavailable", message: `The Python runner failed: ${(e as Error)?.message || String(e)}` });
    } finally {
      signal?.removeEventListener("abort", onAbort);
      live.s?.kill("finished");
    }
  }

  private judge(task: CodeTask, i: number, r: Reply, ms: number, limitMs: number): CodeTestResult {
    const t = task.tests[i];
    if (r.kind === "timeout") return testOutcome(t, i, "timeout", `stopped after ${limitMs / 1000} s`, ms);
    if (r.kind === "fatal") return testOutcome(t, i, "error", `Python stopped: ${r.why}`, ms);
    const d = r.data;
    const stderr = str(d.stderr).trim();
    switch (d.status) {
      case "ok":
        return task.entry !== undefined ? judgeOutput(t, i, str(d.value), ms, true) : judgeOutput(t, i, str(d.stdout), ms);
      case "output":
        return testOutcome(t, i, "error", `stopped: printed more than ${CODE_LIMITS.outputBytes / 1024} KB`, ms);
      case "exit":
        return testOutcome(t, i, "error", `${str(d.detail)}${stderr ? `\n${stderr}` : ""}`, ms);
      default:
        return testOutcome(t, i, "error", boundDetail(str(d.detail) || "the code failed"), ms);
    }
  }
}
