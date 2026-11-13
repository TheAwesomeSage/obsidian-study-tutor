// Maths checking with SymPy, running inside the plugin.
//
// SymPy is a Python library, so it runs here through Pyodide (Python compiled to WebAssembly)
// in a Web Worker. Nothing needs installing: the first check downloads the Pyodide runtime and
// SymPy from the jsDelivr CDN, and the browser cache keeps them. The expressions being checked
// never leave the machine; only that download touches the network.
//
// The model and the learner both produce the strings that get parsed, and SymPy's parser
// evaluates Python. So every string passes `safeExpr` first (no attribute access, no dunders,
// no imports), the worker has no access to the vault or to Node, and a check that runs too long
// kills the worker.

export type ClaimType = "equal" | "derivative" | "integral" | "solve" | "value" | "compute";

export interface Claim {
  type: ClaimType;
  /** equal */
  a?: string;
  b?: string;
  /** derivative, integral */
  f?: string;
  var?: string;
  result?: string;
  from?: string;
  to?: string;
  /** solve */
  eq?: string;
  solutions?: string[];
  /** value, compute */
  expr?: string;
  value?: string;
  /** compute: the name later expressions in the same batch use for this result (r1, r2, …). */
  name?: string;
  /** False when the claim is expected NOT to hold, as with a learner's answer judged wrong. */
  expect?: boolean;
  /** Parse the way a person types ("2x", "xy", "e^x", "j" for the imaginary unit). */
  lenient?: boolean;
}

export interface ClaimResult {
  /** True: holds. False: does not hold. Null: SymPy could not decide. */
  ok: boolean | null;
  detail: string;
  /** compute: the result as SymPy prints it. */
  value?: string;
}

export interface MathBackend {
  check(claims: Claim[]): Promise<ClaimResult[]>;
  /** Starts loading in the background so the first real check is not slow. */
  warm(): void;
  status(): string;
}

const PYODIDE_INDEX = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";

const BANNED = /(__|\b(import|lambda|eval|exec|compile|open|globals|locals|getattr|setattr|delattr|vars|dir|input|breakpoint|help|exit|quit|print|type|object|super|classmethod|staticmethod|memoryview|bytearray|bytes|js|pyodide|os|sys|subprocess|builtins)\b)/;

/** Returns the expression if it is safe to hand to SymPy's parser, otherwise null. */
export function safeExpr(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (!t || t.length > 400) return null;
  // Letters, digits, arithmetic, brackets, commas, comparison signs. No quotes, no backslashes.
  if (!/^[A-Za-z0-9_+\-*/^%().,=<>!\[\]\s]+$/.test(t)) return null;
  // A dot is allowed only inside a number (digit after it, no name or bracket before it),
  // which rules out all attribute access.
  if (/\.(?!\d)/.test(t) || /[A-Za-z_)\]]\s*\./.test(t)) return null;
  if (BANNED.test(t)) return null;
  return t;
}

const TYPES: ClaimType[] = ["equal", "derivative", "integral", "solve", "value"];

/** Keeps only well-formed claims whose every expression is safe. At most `max` are kept. */
export function cleanClaims(raw: unknown, max = 4): Claim[] {
  if (!Array.isArray(raw)) return [];
  const out: Claim[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object" || out.length >= max) continue;
    const c = r as Record<string, unknown>;
    const type = c.type as ClaimType;
    if (!TYPES.includes(type)) continue;
    const e = (k: string) => safeExpr(c[k]);
    const claim: Claim = { type, expect: c.expect === false ? false : true, lenient: c.lenient === true };
    if (type === "equal") {
      const a = e("a"), b = e("b");
      if (!a || !b) continue;
      Object.assign(claim, { a, b });
    } else if (type === "derivative" || type === "integral") {
      const f = e("f"), v = e("var"), result = e("result");
      if (!f || !v || !result || !/^[A-Za-z_]\w*$/.test(v)) continue;
      Object.assign(claim, { f, var: v, result });
      if (type === "integral" && c.from !== undefined && c.to !== undefined) {
        const from = e("from"), to = e("to");
        if (!from || !to) continue;
        Object.assign(claim, { from, to });
      }
    } else if (type === "solve") {
      const eq = e("eq"), v = e("var");
      const sols = Array.isArray(c.solutions) ? c.solutions.map((x) => safeExpr(x)) : null;
      if (!eq || !v || !/^[A-Za-z_]\w*$/.test(v) || !sols || sols.length > 12 || sols.some((x) => !x)) continue;
      Object.assign(claim, { eq, var: v, solutions: sols as string[] });
    } else {
      const expr = e("expr"), value = e("value");
      if (!expr || !value) continue;
      Object.assign(claim, { expr, value });
    }
    out.push(claim);
  }
  return out;
}

/** Takes the hidden <verify>[...]</verify> line out of a reply and returns its checks, cleaned. */
export function extractVerify(reply: string): { text: string; claims: Claim[] } {
  let claims: Claim[] = [];
  const text = reply
    .replace(/`{0,3}\s*<verify>([\s\S]*?)<\/verify>\s*`{0,3}/g, (_all, json: string) => {
      try {
        claims = claims.concat(cleanClaims(JSON.parse(json.trim())));
      } catch {
        /* a malformed line is dropped; the reply still stands */
      }
      return "";
    })
    .trim();
  return { text, claims: claims.slice(0, 4) };
}

const MAX_COMPUTE = 6;

/**
 * Takes the <compute>["expr", …]</compute> line out of a reply. The model sends it instead of
 * an answer when it wants SymPy to do the computing first. Results are named r1, r2, … in
 * order, starting after `already` earlier ones, and later expressions may use those names.
 */
export function extractCompute(reply: string, already = 0): { text: string; asks: Claim[] } {
  const asks: Claim[] = [];
  const text = reply
    .replace(/`{0,3}\s*<compute>([\s\S]*?)<\/compute>\s*`{0,3}/g, (_all, json: string) => {
      try {
        const raw: unknown = JSON.parse(json.trim());
        for (const item of Array.isArray(raw) ? raw : []) {
          const expr = safeExpr(typeof item === "string" ? item : (item as { expr?: unknown } | null)?.expr);
          if (expr && asks.length < MAX_COMPUTE) asks.push({ type: "compute", expr, name: `r${already + asks.length + 1}` });
        }
      } catch {
        /* a malformed line is dropped */
      }
      return "";
    })
    .trim();
  return { text, asks };
}

const KNOWN_WORDS = new Set(
  "sin cos tan sec csc cot asin acos atan sinh cosh tanh exp log ln sqrt abs pi oo det re im arg conjugate floor ceiling factorial binomial gcd lcm mod min max sum diff integrate limit alpha beta gamma delta epsilon zeta eta theta iota kappa mu nu xi rho sigma tau phi chi psi omega lambda".split(" "),
);

/**
 * Turns an answer as written in a note or typed by a learner (light LaTeX or plain text) into
 * something SymPy's lenient parser accepts. Returns null when the text is prose, not maths.
 */
export function plainMaths(input: string, opts: { allowLhs?: boolean } = {}): string | null {
  let s = input.trim().replace(/^\$+|\$+$/g, "").trim();
  if (!s || s.length > 200) return null;
  // "x = 2" and "f'(x) = 2x" are answers too: the name on the left is dropped.
  if (opts.allowLhs) s = s.replace(/^\\?[A-Za-z][\w']*(?:_\{?\w+\}?)?(?:\s*\([^()=]*\))?\s*=\s*(?!=)/, "");
  s = s.replace(/\\(left|right|,|;|!|quad|qquad| )/g, " ").replace(/\\(mathrm|text|mathbf|mathit|operatorname)\s*\{([^{}]*)\}/g, "$2");
  // Fractions and roots, innermost first.
  for (let i = 0; i < 8 && /\\(d?frac|sqrt)/.test(s); i++) {
    const before = s;
    s = s.replace(/\\d?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "(($1)/($2))").replace(/\\sqrt\s*\[([^\[\]]*)\]\s*\{([^{}]*)\}/g, "(($2)**(1/($1)))").replace(/\\sqrt\s*\{([^{}]*)\}/g, "sqrt($1)");
    if (s === before) break;
  }
  s = s
    .replace(/\\(cdot|times)/g, "*")
    .replace(/\\div/g, "/")
    .replace(/\\infty/g, "oo")
    .replace(/\\ln\b/g, "log")
    .replace(/\\([A-Za-z]+)/g, "$1")
    .replace(/\^\s*\{([^{}]*)\}/g, "**($1)")
    .replace(/_\s*\{([^{}]*)\}/g, "_$1")
    .replace(/[{}]/g, (c) => (c === "{" ? "(" : ")"))
    .replace(/[×·]/g, "*")
    .replace(/÷/g, "/")
    .replace(/−/g, "-")
    .replace(/π/g, "pi")
    .replace(/\bln\b/g, "log")
    // "lambda" is a Python keyword; SymPy spells the symbol "lamda".
    .replace(/\blambda\b/g, "lamda")
    .replace(/λ/g, "lamda")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.;,]$/, "");
  if (/[=<>]/.test(s)) return null; // equations and inequalities are left to the model
  // Two or more ordinary words means a sentence, not an expression.
  const wordsIn = (s.match(/[A-Za-z]{3,}/g) ?? []).filter((w) => !KNOWN_WORDS.has(w.toLowerCase()));
  if (wordsIn.length >= 2 || wordsIn.some((w) => w.length > 8)) return null;
  if (!/[\dA-Za-z]/.test(s)) return null;
  return safeExpr(s);
}

// The Python side. One function, `run`, takes the claims as JSON and returns results as JSON.
export const PYTHON = String.raw`
import json, random
from sympy import *
from sympy.parsing.sympy_parser import parse_expr, standard_transformations, implicit_multiplication, implicit_multiplication_application, convert_xor
from tokenize import TokenError
import re as _re  # after the line above: SymPy exports a function called re

# What the model writes: every product has its *, so y(x) stays a function of x (dsolve needs that).
_STRICT = standard_transformations + (convert_xor,)
_LOOSER = standard_transformations + (convert_xor, implicit_multiplication)
_LENIENT = standard_transformations + (convert_xor, implicit_multiplication_application)
_HUMAN = {"e": E, "j": I, "ln": log}

# Matrix operations are methods in SymPy, and method calls are not allowed in what gets parsed,
# so the common ones are offered as plain functions.
_HELPERS = {
    "inv": lambda m: m.inv(),
    "eigenvals": lambda m: m.eigenvals(),
    "eigenvects": lambda m: m.eigenvects(),
    "rref": lambda m: m.rref()[0],
    "rank": lambda m: m.rank(),
    "nullspace": lambda m: m.nullspace(),
    "transpose": lambda m: m.T,
    "charpoly": lambda m, x=Symbol("lamda"): m.charpoly(x).as_expr(),
}

def _p(s, lenient=False, env=None):
    if lenient:
        return parse_expr(s, transformations=_LENIENT, local_dict=dict(_HUMAN))
    names = {**_HELPERS, **(env or {})}
    try:
        return parse_expr(s, transformations=_STRICT, local_dict=names)
    except (SyntaxError, TokenError, TypeError):
        # A product written without its * (2x, 3(x+1)) is still understood.
        return parse_expr(s, transformations=_LOOSER, local_dict=dict(names))

def _show(x, limit=120):
    t = str(x)
    return t if len(t) <= limit else t[:limit - 3] + "..."

def _decimals(s):
    # Decimal places of the least precise decimal number written in s; 0 when it has none.
    found = _re.findall(r"\d*\.(\d+)", s)
    return min(len(d) for d in found) if found else 0

def _typed_equal(a, b, sa, sb):
    # Compares what a learner typed (a) with the expected answer (b).
    if not (hasattr(a, "free_symbols") and hasattr(b, "free_symbols")):
        return _equal(a, b)
    if not a.free_symbols and not b.free_symbols:
        # Two numbers, at least one written as a decimal: equal to the digits written.
        da, db = _decimals(sa), _decimals(sb)
        if da or db:
            if not db and da < 2:
                return None, "too few decimal places to tell"
            tol = 0.5 * 10 ** (-(db or da)) * (1 + 1e-9)
            diff = abs(complex(N(a - b, 30)))
            return (diff <= tol), ("equal to the digits given" if diff <= tol else "the values differ")
    ok, why = _equal(a, b)
    if ok is False and a.free_symbols != b.free_symbols:
        # A different letter (c for C, an added constant) is a matter of judgement, not of algebra.
        return None, "the two use different symbols"
    return ok, why

def _num_equal(a, b):
    # Use the symbols of both sides: in 2x+2 against 2x+1 the difference has none left.
    syms = sorted(a.free_symbols | b.free_symbols, key=str)
    good = 0
    for _ in range(10):
        sub = {s: Rational(random.randint(2, 60), random.randint(7, 13)) + Rational(1, 17) for s in syms}
        try:
            va = complex(N(a.subs(sub), 30))
            vb = complex(N(b.subs(sub), 30))
        except Exception:
            continue
        if va != va or vb != vb:
            continue
        if abs(va - vb) > 1e-9 * (1 + abs(va) + abs(vb)):
            at = ", ".join(f"{k}={v}" for k, v in sub.items())
            return False, ("they differ" + (f" at {at}" if at else ""))
        good += 1
    if good >= 4:
        return True, "equal at every test point"
    return None, "could not be evaluated"

def _equal(a, b):
    if hasattr(a, "shape") or hasattr(b, "shape"):
        if not (hasattr(a, "shape") and hasattr(b, "shape")) or a.shape != b.shape:
            return False, "the shapes differ"
        for x, y in zip(list(a), list(b)):
            ok, why = _equal(x, y)
            if ok is not True:
                return ok, why
        return True, "equal entry by entry"
    if isinstance(a, (tuple, list, Tuple)) or isinstance(b, (tuple, list, Tuple)):
        la, lb = list(a), list(b)
        if len(la) != len(lb):
            return False, "different lengths"
        for x, y in zip(la, lb):
            ok, why = _equal(x, y)
            if ok is not True:
                return ok, why
        return True, "equal item by item"
    try:
        d = simplify(a - b)
        if d == 0:
            return True, "identical"
        if d.is_number and abs(complex(N(d, 30))) > 1e-12:
            return False, f"they differ by {_show(d)}"
    except Exception:
        pass
    return _num_equal(a, b)

def _check(c, env):
    t = c["type"]
    L = bool(c.get("lenient"))
    _q = lambda s: _p(s, False, env)
    if t == "compute":
        got = _q(c["expr"])
        if c.get("name"):
            env[c["name"]] = got
        return True, _show(got, 400)
    if t == "equal":
        if L:
            return _typed_equal(_p(c["a"], True), _p(c["b"], True), c["a"], c["b"])
        return _equal(_q(c["a"]), _q(c["b"]))
    if t == "derivative":
        got = diff(_q(c["f"]), Symbol(c["var"]))
        ok, why = _equal(got, _q(c["result"]))
        return ok, (why if ok else f"SymPy gets {_show(simplify(got))}")
    if t == "integral":
        f, x, res = _q(c["f"]), Symbol(c["var"]), _q(c["result"])
        if "from" in c and "to" in c:
            lo, hi = _q(c["from"]), _q(c["to"])
            try:
                got = integrate(f, (x, lo, hi))
                if got.has(Integral):
                    got = Integral(f, (x, lo, hi)).evalf(20)
            except Exception:
                got = Integral(f, (x, lo, hi)).evalf(20)
            ok, why = _equal(got, res)
            return ok, (why if ok else f"SymPy gets {_show(got)}")
        ok, why = _equal(diff(res, x), f)
        return ok, ("its derivative is the integrand" if ok else "its derivative is not the integrand")
    if t == "solve":
        x = Symbol(c["var"])
        eq = c["eq"]
        if "=" in eq:
            lhs, rhs = eq.split("=", 1)
            expr = _q(lhs) - _q(rhs)
        else:
            expr = _q(eq)
        given = [_q(s) for s in c["solutions"]]
        for s in given:
            ok, why = _equal(expr.subs(x, s), Integer(0))
            if ok is not True:
                return (False if ok is False else None), f"{_show(s)} does not satisfy the equation"
        try:
            found = solve(expr, x)
        except Exception:
            found = None
        if isinstance(found, list) and found and all(not f.free_symbols - expr.free_symbols for f in found):
            missing = [f for f in found if not any(_equal(f, g)[0] is True for g in given)]
            if missing:
                return False, "missing " + ", ".join(_show(m) for m in missing[:4])
            return True, "every solution fits and none is missing"
        return True, "every solution fits (SymPy could not confirm the list is complete)"
    if t == "value":
        got = complex(N(_q(c["expr"]), 30))
        want = complex(N(_q(c["value"]), 30))
        digits = len(c["value"].split(".")[1]) if "." in c["value"] else 0
        tol = max(0.6 * 10 ** (-digits), 1e-9 * (1 + abs(want))) if digits else 1e-9 * (1 + abs(want))
        ok = abs(got - want) <= tol
        return ok, ("matches" if ok else f"SymPy gets {_show(N(_q(c['expr']), 8))}")
    return None, "unknown kind of check"

def run(payload):
    out = []
    env = {}  # results of "compute" items, by name, for the later items of this batch
    for c in json.loads(payload):
        try:
            ok, why = _check(c, env)
            if c["type"] == "compute":
                out.append({"ok": True, "detail": "computed", "value": why})
            else:
                out.append({"ok": ok, "detail": why})
        except Exception as e:
            out.append({"ok": None, "detail": ("could not be computed (" if c.get("type") == "compute" else "could not be checked (") + type(e).__name__ + ")"})
    return json.dumps(out)
`;

/** Source of the Web Worker. Kept as text so it ships inside main.js. */
export const WORKER_SOURCE = `
// Obsidian runs on Electron with Node switched on inside workers. Pyodide would then take
// itself to be running under Node and fail to load, and code in here could reach the file
// system. This worker needs none of Node, so every trace of it is removed before anything loads.
for (const name of ["process", "require", "module", "exports", "global", "Buffer", "__dirname", "__filename"]) {
  try { delete self[name]; } catch (e) {}
  try { if (typeof self[name] !== "undefined") self[name] = undefined; } catch (e) {}
}
const INDEX = ${JSON.stringify(PYODIDE_INDEX)};
const PYTHON = ${JSON.stringify(PYTHON)};
let run = null;
const ready = (async () => {
  // Fail closed: if Node is somehow still reachable, SymPy stays off and the model does the maths.
  if (typeof process !== "undefined" || typeof require !== "undefined") throw new Error("Node could not be removed from the worker");
  importScripts(INDEX + "pyodide.js");
  const py = await loadPyodide({ indexURL: INDEX });
  await py.loadPackage("sympy");
  py.runPython(PYTHON);
  run = py.globals.get("run");
})();
self.onmessage = async (e) => {
  try {
    await ready;
    self.postMessage({ id: e.data.id, results: JSON.parse(run(JSON.stringify(e.data.claims))) });
  } catch (err) {
    self.postMessage({ id: e.data.id, error: String(err && err.message ? err.message : err) });
  }
};
`;

const FIRST_LOAD_MS = 180000;
const CHECK_MS = 25000;

/** Runs checks in a Pyodide worker. The worker is created on first use and replaced if it hangs. */
export class SympyWorker implements MathBackend {
  private worker: Worker | null = null;
  private loaded = false;
  private failed = "";
  private nextId = 1;
  private waiting = new Map<number, { resolve: (r: ClaimResult[]) => void; timer: number }>();

  status(): string {
    if (this.failed) return `unavailable: ${this.failed}`;
    if (this.loaded) return "ready";
    return this.worker ? "loading" : "not loaded yet";
  }

  warm(): void {
    if (!this.worker && !this.failed) void this.check([{ type: "equal", a: "1", b: "1" }]);
  }

  private start(): Worker | null {
    if (this.worker) return this.worker;
    try {
      const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
      const w = new Worker(url);
      w.onmessage = (e: MessageEvent) => {
        const p = this.waiting.get(e.data.id);
        if (!p) return;
        this.waiting.delete(e.data.id);
        window.clearTimeout(p.timer);
        if (e.data.error) {
          // A failure before anything has worked means the runtime could not be loaded at all.
          if (!this.loaded) this.fail(e.data.error);
          p.resolve([]);
        } else {
          this.loaded = true;
          p.resolve(e.data.results as ClaimResult[]);
        }
      };
      w.onerror = (e: ErrorEvent) => this.fail(e.message || "the worker could not start");
      this.worker = w;
      return w;
    } catch (e) {
      this.fail((e as Error).message || "workers are not available");
      return null;
    }
  }

  private fail(reason: string): void {
    this.failed = reason.slice(0, 200);
    this.stop();
  }

  private stop(): void {
    this.worker?.terminate();
    this.worker = null;
    this.loaded = false;
    for (const p of this.waiting.values()) {
      window.clearTimeout(p.timer);
      p.resolve([]);
    }
    this.waiting.clear();
  }

  /** Shuts the worker down, for when the plugin is switched off. */
  dispose(): void {
    this.stop();
  }

  /** Forgets an earlier failure, so the next check tries to load again. */
  reset(): void {
    this.failed = "";
  }

  /** Resolves to one result per claim, or to an empty list when SymPy is unavailable or timed out. */
  check(claims: Claim[]): Promise<ClaimResult[]> {
    if (!claims.length || this.failed) return Promise.resolve([]);
    const w = this.start();
    if (!w) return Promise.resolve([]);
    return new Promise((resolve) => {
      const id = this.nextId++;
      const timer = window.setTimeout(
        () => {
          // A check that never returns (some simplifications do not terminate) takes the worker with it.
          const slowLoad = !this.loaded;
          this.stop();
          if (slowLoad) this.failed = "SymPy took too long to download";
          resolve([]);
        },
        this.loaded ? CHECK_MS : FIRST_LOAD_MS,
      );
      this.waiting.set(id, { resolve, timer });
      w.postMessage({ id, claims });
    });
  }
}

export interface CheckReport {
  /** One line for the learner, and for the tutor on its next turn. Empty when there is nothing to say. */
  line: string;
  disagreed: boolean;
  /** One line per check with its outcome, for sending back to the model. */
  findings: string[];
}

/** Says how the checks came out, and how many results SymPy computed for the reply. */
export function checkReport(claims: Claim[], results: ClaimResult[], opts: { computed?: number; corrected?: boolean } = {}): CheckReport {
  const computed = opts.computed ?? 0;
  const did = computed ? `computed ${computed} result${computed === 1 ? "" : "s"} for this reply` : "";
  if (!claims.length || results.length !== claims.length) return { line: did ? `*SymPy ${did}.*` : "", disagreed: false, findings: [] };
  const describe = (c: Claim): string => {
    if (c.type === "equal") return `${c.a} ${c.expect === false ? "≠" : "="} ${c.b}`;
    if (c.type === "derivative") return `d/d${c.var} of ${c.f} = ${c.result}`;
    if (c.type === "integral") return `integral of ${c.f} d${c.var}${c.from !== undefined ? ` from ${c.from} to ${c.to}` : ""} = ${c.result}`;
    if (c.type === "solve") return `${c.eq} has solutions ${(c.solutions ?? []).join(", ")}`;
    return `${c.expr} ≈ ${c.value}`;
  };
  const bad: string[] = [];
  const findings: string[] = [];
  let agreed = 0;
  let undecided = 0;
  claims.forEach((c, i) => {
    const r = results[i];
    if (r.ok === null) {
      undecided++;
      findings.push(`- ${describe(c)}: SymPy could not decide (${r.detail}).`);
    } else if (r.ok === (c.expect !== false)) {
      agreed++;
      findings.push(`- ${describe(c)}: SymPy agrees.`);
    } else {
      const why = c.expect === false ? "SymPy finds them equal" : r.detail;
      bad.push(`\`${describe(c)}\` (${why})`);
      findings.push(`- ${describe(c)}: SymPy DISAGREES (${why}).`);
    }
  });
  if (bad.length) return { line: `**SymPy disagrees** with ${bad.length === 1 ? "this result" : "these results"}: ${bad.join("; ")}. Treat that step with care.`, disagreed: true, findings };
  if (!agreed) return { line: did ? `*SymPy ${did}.*` : "", disagreed: false, findings };
  const checked = `checked ${agreed} result${agreed === 1 ? "" : "s"}: ${agreed === 1 ? "it agrees" : "all agree"}`;
  const tail = `${undecided ? `; ${undecided} could not be checked` : ""}${opts.corrected ? " (after it caught an error in a first draft, which was rewritten)" : ""}`;
  return { line: `*SymPy ${did ? `${did} and ` : ""}${checked}${tail}.*`, disagreed: false, findings };
}

/** The results of a compute request, as the model is shown them. */
export function computeBlock(asks: Claim[], results: ClaimResult[]): string {
  if (results.length !== asks.length) return "SymPy was not available, so nothing was computed. Work the results out yourself, carefully, and say they are unchecked.";
  return asks.map((a, i) => `${a.name} = ${a.expr}  →  ${results[i].ok ? results[i].value ?? "" : results[i].detail}`).join("\n");
}
