// Question families: one compiled question becomes unlimited fresh instances. At compile time a
// model writes a small spec as plain data (parameter ranges, conditions, a question template, the
// answer as an expression, worked steps and expected mistakes); trusted code here draws the
// numbers, computes the answer and marks replies, so a new instance costs no model call. The model
// never supplies code: every expression goes through the small parser below, which knows only
// arithmetic and a fixed list of maths functions.
// Pure functions, no Obsidian imports. Specs are treated as immutable: their parsed form is cached
// per spec object.

import { isObj } from "./jsonschema";

export const FAMILY_SPEC_VERSION = 1;
export type ParamRange = { min: number; max: number; step?: number } | { choices: number[] };
export interface FamilyMistake { label: string; expr: string; step?: number; says?: string }
export interface FamilySpec {
  v: 1;
  params: Record<string, ParamRange>;
  where?: string[];
  template: string;
  answer: string;
  dp?: number;
  steps?: string[];
  mistakes?: FamilyMistake[];
  tests?: { params: Record<string, number>; answer: number }[];
}
export interface Instance {
  seed: number;
  params: Record<string, number>;
  question: string;
  answer: number;
  answerText: string;
  steps: string[];
  mistakes: { label: string; value: number; text: string; step?: number; says?: string }[];
}

type BinOp = "+" | "-" | "*" | "/" | "^";
export type Expr =
  | { op: "num"; v: number }
  | { op: "var"; name: string }
  | { op: "neg"; a: Expr }
  | { op: BinOp; a: Expr; b: Expr }
  | { op: "call"; fn: string; args: Expr[] };

/** A problem with a spec or an expression, as one plain sentence. Never escapes this module. */
class Invalid extends Error {}
function fail(msg: string): never {
  throw new Invalid(msg);
}

// ---- Expressions

const FUNCS = new Map<string, [arity: number, f: (...a: number[]) => number]>([
  ["sqrt", [1, Math.sqrt]], ["abs", [1, Math.abs]], ["sin", [1, Math.sin]], ["cos", [1, Math.cos]],
  ["tan", [1, Math.tan]], ["asin", [1, Math.asin]], ["acos", [1, Math.acos]], ["atan", [1, Math.atan]],
  ["exp", [1, Math.exp]], ["ln", [1, Math.log]], ["log10", [1, Math.log10]], ["floor", [1, Math.floor]],
  ["ceil", [1, Math.ceil]], ["round", [1, (x) => Math.sign(x) * Math.round(Math.abs(x))]],
  ["min", [2, Math.min]], ["max", [2, Math.max]],
]);
const CONSTS = new Map([["pi", Math.PI], ["e", Math.E]]);
const BIN: Record<BinOp, (a: number, b: number) => number> = {
  "+": (a, b) => a + b, "-": (a, b) => a - b, "*": (a, b) => a * b, "/": (a, b) => a / b, "^": Math.pow,
};
const NAME = /^[a-z][a-z0-9]{0,7}$/;
const NUMBER = /(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?/y;
const IDENT = /[A-Za-z_]\w*/y;
const MAX_LEN = 200;
const MAX_DEPTH = 40;

const sticky = (re: RegExp, s: string, i: number): string | undefined => {
  re.lastIndex = i;
  return re.exec(s)?.[0];
};

/** Recursive descent. ^ is right-associative and binds tighter than unary minus, so -2^2 = -4. */
function parse(src: string): Expr | string {
  const s = src.replace(/−/g, "-");
  if (!s.trim()) return "it is empty";
  if (s.length > MAX_LEN) return `it is longer than ${MAX_LEN} characters`;
  let i = 0;
  let depth = 0;
  const skip = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  const eat = (t: string): boolean => {
    skip();
    if (!s.startsWith(t, i)) return false;
    i += t.length;
    return true;
  };
  function chain(next: () => Expr, ops: ("+" | "-" | "*" | "/")[]): Expr {
    let a = next();
    for (let op = ops.find(eat); op; op = ops.find(eat)) a = { op, a, b: next() };
    return a;
  }
  function sum(): Expr {
    return chain(product, ["+", "-"]);
  }
  function product(): Expr {
    return chain(unary, ["*", "/"]);
  }
  // Every level of nesting passes through here, so this is where depth is limited.
  function unary(): Expr {
    if (++depth > MAX_DEPTH) fail(`it is nested more than ${MAX_DEPTH} deep`);
    const x: Expr = eat("-") ? { op: "neg", a: unary() } : eat("+") ? unary() : power();
    depth--;
    return x;
  }
  function power(): Expr {
    const a = atom();
    return eat("^") || eat("**") ? { op: "^", a, b: unary() } : a;
  }
  function atom(): Expr {
    skip();
    const n = sticky(NUMBER, s, i);
    if (n) {
      i += n.length;
      return { op: "num", v: Number(n) };
    }
    const name = sticky(IDENT, s, i);
    if (name) {
      i += name.length;
      return named(name);
    }
    if (eat("(")) {
      const x = sum();
      if (!eat(")")) fail('a ")" is missing');
      return x;
    }
    return fail(i < s.length ? `unexpected ${JSON.stringify(s[i])}` : "it ends too soon");
  }
  function named(name: string): Expr {
    if (eat("(")) {
      const f = FUNCS.get(name);
      if (!f) fail(`"${clip(name)}" is not a known function`);
      const args = [sum()];
      while (eat(",")) args.push(sum());
      if (!eat(")")) fail(`a ")" is missing after ${name}(`);
      if (args.length !== f[0]) fail(`${name} takes ${f[0] === 1 ? "one argument" : "two arguments"}`);
      return { op: "call", fn: name, args };
    }
    const c = CONSTS.get(name);
    if (c !== undefined) return { op: "num", v: c };
    if (FUNCS.has(name)) fail(`${name} needs brackets, as in ${name}(x)`);
    if (!NAME.test(name)) fail(`"${clip(name)}" is not a usable name`);
    return { op: "var", name };
  }
  try {
    const x = sum();
    skip();
    return i < s.length ? `unexpected ${JSON.stringify(s[i])}` : x;
  } catch (e) {
    return e instanceof Invalid ? e.message : "it could not be read";
  }
}

export function parseExpr(src: string): Expr | null {
  const x = parse(src);
  return typeof x === "string" ? null : x;
}

const NOT_FINITE = new Invalid("not finite");

// Any non-finite step stops the whole evaluation, so (1/0)^0 is not quietly 1.
function ev(x: Expr, env: Record<string, number>): number {
  let v: number;
  switch (x.op) {
    case "num": v = x.v; break;
    case "var": v = Object.prototype.hasOwnProperty.call(env, x.name) ? env[x.name] : NaN; break;
    case "neg": v = -ev(x.a, env); break;
    case "call": v = (FUNCS.get(x.fn)?.[1] ?? (() => NaN))(...x.args.map((a) => ev(a, env))); break;
    default: v = BIN[x.op](ev(x.a, env), ev(x.b, env));
  }
  if (typeof v !== "number" || !Number.isFinite(v)) throw NOT_FINITE;
  return v;
}

function run(x: Expr, env: Record<string, number>): number | null {
  try {
    return ev(x, env);
  } catch {
    return null;
  }
}

export function evaluate(expr: Expr | string, env: Record<string, number>): number | null {
  const x = typeof expr === "string" ? parseExpr(expr) : expr;
  return x === null ? null : run(x, env);
}

function varsOf(x: Expr, out = new Set<string>()): Set<string> {
  if (x.op === "var") out.add(x.name);
  else if (x.op === "neg") varsOf(x.a, out);
  else if (x.op === "call") x.args.forEach((a) => varsOf(a, out));
  else if (x.op !== "num") varsOf(x.b, varsOf(x.a, out));
  return out;
}

// ---- Numbers

/** Half away from zero, after shaving float noise (1.005 * 100 is 100.49999999999999). +0 drops -0. */
function roundTo(x: number, dp: number): number {
  const f = 10 ** dp;
  return (Math.sign(x) * Math.round(Number((Math.abs(x) * f).toPrecision(15)))) / f + 0;
}

/** Integers in full; anything else to 6 significant figures, never rounding into the integer part. */
function short(x: number): string {
  const r = Number(x.toPrecision(15)) + 0;
  if (Number.isInteger(r)) return String(r);
  const dp = Math.min(20, Math.max(0, 5 - Math.floor(Math.log10(Math.abs(r)))));
  return String(Number(r.toFixed(dp)) + 0);
}

const fmt = (x: number, dp?: number): string => (dp === undefined ? short(x) : roundTo(x, dp).toFixed(dp));

/** Equal within `rel`, or within 1e-9 near zero. */
const close = (a: number, b: number, rel: number): boolean =>
  Math.abs(a - b) <= Math.max(rel * Math.max(Math.abs(a), Math.abs(b)), 1e-9);

/** Whether `x` marks as `target`: within half a unit of the last place with dp, else 1e-6 relative. */
const same = (dp: number | undefined, x: number, target: number): boolean =>
  dp === undefined ? close(x, target, 1e-6) : Math.abs(x - target) <= 0.5 * 10 ** -dp + 1e-9;

const size = (r: ParamRange): number =>
  "choices" in r ? r.choices.length : Math.floor((r.max - r.min) / (r.step ?? 1) + 1e-9) + 1;

// Rounded to 10 places so steps of 0.1 give 0.3, not 0.30000000000000004.
const valueAt = (r: ParamRange, k: number): number =>
  "choices" in r ? r.choices[k] : Number((r.min + k * (r.step ?? 1)).toFixed(10)) + 0;

const inRange = (r: ParamRange, v: number): boolean =>
  "choices" in r ? r.choices.some((c) => close(c, v, 1e-9)) : v >= r.min - 1e-9 && v <= r.max + 1e-9;

// ---- Compiling a spec

/** Literal text, or a value to insert: a parameter as written, or a computed value. */
type Part = string | { x: Expr; param: boolean };
interface Cond { src: string; op: string; a: Expr; b: Expr }
interface Compiled {
  template: Part[];
  answer: Expr;
  where: Cond[];
  steps: Part[][];
  mistakes: { m: FamilyMistake; x: Expr; says?: Part[] }[];
}

const CMP = /<=|>=|==|!=|<|>/g;

function compile(spec: FamilySpec): Compiled {
  const names = new Set(Object.keys(spec.params));
  const expr = (src: string, what: string): Expr => {
    const x = parse(src);
    if (typeof x === "string") fail(`${what} cannot be read: ${x}.`);
    const unknown = [...varsOf(x)].find((n) => !names.has(n));
    if (unknown) fail(`${what} uses an unknown name: ${unknown}.`);
    return x;
  };
  const condition = (src: string, what: string): Cond => {
    const s = src.replace(/≤/g, "<=").replace(/≥/g, ">=").replace(/≠/g, "!=");
    const ops = [...s.matchAll(CMP)];
    if (ops.length !== 1) fail(`${what} must be exactly one comparison, such as "a != 0".`);
    const op = ops[0][0];
    const at = ops[0].index ?? 0;
    return { src, op, a: expr(s.slice(0, at), what), b: expr(s.slice(at + op.length), what) };
  };
  // {name} inserts a parameter, {=expr} a computed value, and {{ or }} a literal brace.
  const template = (src: string, what: string): Part[] => {
    const parts: Part[] = [];
    let lit = "";
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if ((ch === "{" || ch === "}") && src[i + 1] === ch) {
        lit += ch;
        i++;
      } else if (ch === "}") fail(`${what} has a "}" without a matching "{".`);
      else if (ch !== "{") lit += ch;
      else {
        const end = src.indexOf("}", i);
        const inner = src.slice(i + 1, end < 0 ? undefined : end).trim();
        if (end < 0 || inner.includes("{")) fail(`${what} has a "{" without a matching "}".`);
        if (lit) parts.push(lit);
        lit = "";
        if (inner.startsWith("=")) parts.push({ x: expr(inner.slice(1), `${what} placeholder {${clip(inner)}}`), param: false });
        else if (names.has(inner)) parts.push({ x: { op: "var", name: inner }, param: true });
        else fail(`${what} has an unknown placeholder {${clip(inner)}}.`);
        i = end;
      }
    }
    if (lit) parts.push(lit);
    return parts;
  };
  return {
    template: template(spec.template, "The template"),
    answer: expr(spec.answer, "The answer"),
    where: (spec.where ?? []).map((w, i) => condition(w, `Condition ${i + 1}`)),
    steps: (spec.steps ?? []).map((s, i) => template(s, `Step ${i + 1}`)),
    mistakes: (spec.mistakes ?? []).map((m, i) => ({
      m,
      x: expr(m.expr, `Mistake ${i + 1}`),
      says: m.says === undefined ? undefined : template(m.says, `Mistake ${i + 1}'s text`),
    })),
  };
}

const cache = new WeakMap<FamilySpec, Compiled | string>();

function compiled(spec: FamilySpec): Compiled | string {
  let c = cache.get(spec);
  if (c === undefined) {
    try {
      c = compile(spec);
    } catch (e) {
      c = e instanceof Invalid ? e.message : "The family spec could not be read.";
    }
    cache.set(spec, c);
  }
  return c;
}

function holds(c: Cond, env: Record<string, number>): boolean {
  const a = run(c.a, env);
  const b = run(c.b, env);
  if (a === null || b === null) return false;
  // Every comparison shares the tolerance of ==, so float noise cannot break b^2-4*a*c >= 0.
  const eq = close(a, b, 1e-9);
  switch (c.op) {
    case "<": return a < b && !eq;
    case "<=": return a < b || eq;
    case ">": return a > b && !eq;
    case ">=": return a > b || eq;
    case "==": return eq;
    default: return !eq;
  }
}

function render(parts: Part[], env: Record<string, number>, dp?: number): string | null {
  let out = "";
  for (const p of parts) {
    if (typeof p === "string") {
      out += p;
      continue;
    }
    const v = run(p.x, env);
    if (v === null) return null;
    out += p.param ? short(v) : fmt(v, dp);
  }
  return out;
}

/** The instance for these parameter values, or null when they break a condition or a value fails. */
function build(c: Compiled, spec: FamilySpec, seed: number, params: Record<string, number>): Instance | null {
  const dp = spec.dp;
  if (!c.where.every((w) => holds(w, params))) return null;
  const raw = run(c.answer, params);
  if (raw === null || Math.abs(raw) > 1e9) return null;
  const answer = dp === undefined ? raw : roundTo(raw, dp);
  const question = render(c.template, params, dp);
  const steps = c.steps.map((s) => render(s, params, dp));
  if (question === null || steps.some((s) => s === null)) return null;
  const mistakes: Instance["mistakes"] = [];
  for (const { m, x, says } of c.mistakes) {
    const v = run(x, params);
    if (v === null || Math.abs(v) > 1e9) continue;
    const value = dp === undefined ? v : roundTo(v, dp);
    // A mistake that gives the right answer here cannot be told apart from a right one.
    if (same(dp, value, answer)) continue;
    const said = says && render(says, params, dp);
    if (said === null) continue;
    const out: Instance["mistakes"][number] = { label: m.label, value, text: fmt(value, dp) };
    if (m.step !== undefined) out.step = m.step;
    if (said !== undefined) out.says = said;
    mistakes.push(out);
  }
  return { seed, params, question, answer, answerText: fmt(answer, dp), steps: steps as string[], mistakes };
}

// ---- Instances

/** mulberry32: small, fast, and the same numbers on every machine. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function instantiate(spec: FamilySpec, seed: number): Instance | null {
  const c = compiled(spec);
  if (typeof c === "string") return null;
  const rand = rng(seed);
  for (let tries = 0; tries < 60; tries++) {
    const params: Record<string, number> = {};
    for (const [name, r] of Object.entries(spec.params)) params[name] = valueAt(r, Math.floor(rand() * size(r)));
    const inst = build(c, spec, seed, params);
    if (inst) return inst;
  }
  return null;
}

/**
 * Two instances that differ in one parameter only, with different answers: a contrasting pair.
 * Both carry `seed`, since pairedCases(spec, seed) makes the same pair again.
 */
export function pairedCases(spec: FamilySpec, seed: number): [Instance, Instance] | null {
  const c = compiled(spec);
  const base = instantiate(spec, seed);
  const varying = Object.keys(spec.params).filter((n) => size(spec.params[n]) > 1);
  if (typeof c === "string" || !base || !varying.length) return null;
  const rand = rng(seed ^ 0x5bd1e995);
  for (let tries = 0; tries < 40; tries++) {
    const name = varying[Math.floor(rand() * varying.length)];
    const r = spec.params[name];
    const v = valueAt(r, Math.floor(rand() * size(r)));
    if (v === base.params[name]) continue;
    const other = build(c, spec, seed, { ...base.params, [name]: v });
    if (other && !same(spec.dp, other.answer, base.answer)) return [base, other];
  }
  return null;
}

// ---- Checking and reading a spec

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const clip = (s: string): string => (s.length > 40 ? s.slice(0, 40) + "…" : s);
const bounded = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= 1e6;
const whole = (x: unknown, lo: number, hi: number): x is number => typeof x === "number" && Number.isInteger(x) && x >= lo && x <= hi;

function testProblem(c: Compiled, spec: FamilySpec, t: { params: Record<string, number>; answer: number }, n: number): string | null {
  for (const [name, r] of Object.entries(spec.params)) {
    const v = own(t.params, name) ? t.params[name] : undefined;
    if (typeof v !== "number" || !Number.isFinite(v)) return `Test ${n} gives no value for ${name}.`;
    if (!inRange(r, v)) return `Test ${n} has ${name} = ${short(v)}, which is outside the values ${name} can take.`;
  }
  const broken = c.where.find((w) => !holds(w, t.params));
  if (broken) return `Test ${n} breaks the condition "${clip(broken.src)}".`;
  const got = run(c.answer, t.params);
  if (got === null) return `Test ${n} gives no finite answer.`;
  const shown = spec.dp === undefined ? got : roundTo(got, spec.dp);
  return same(spec.dp, shown, t.answer) ? null : `Test ${n} expects ${short(t.answer)}, but the answer gives ${fmt(shown, spec.dp)}.`;
}

/** Problems with a spec, as plain sentences; empty when it is fit to make questions from. */
export function checkFamily(spec: FamilySpec): string[] {
  const c = compiled(spec);
  if (typeof c === "string") return [c];
  const problems = (spec.tests ?? []).map((t, i) => testProblem(c, spec, t, i + 1)).filter((p): p is string => p !== null);
  const made = Array.from({ length: 20 }, (_, k) => instantiate(spec, k + 1)).filter((x): x is Instance => x !== null);
  if (made.length < 3) {
    problems.push(`Only ${made.length} of 20 seeds give a valid question; widen the ranges or loosen the conditions.`);
    return problems;
  }
  const fixed = Object.values(spec.params).every((r) => size(r) === 1);
  if (!fixed && new Set(made.map((m) => m.answerText)).size < 2) problems.push("Every generated question has the same answer, so the family does not vary.");
  // Without dp an answer is marked as exact, so the answer shown must be exact too: 1/3 needs dp.
  const inexact = made.find((m) => spec.dp === undefined && !close(Number(m.answerText), m.answer, 1e-9));
  if (inexact) problems.push(`Answers such as ${inexact.answerText} cannot be shown exactly, so set dp to the decimal places to give.`);
  for (const m of spec.mistakes ?? []) {
    if (!made.some((x) => x.mistakes.some((k) => k.label === m.label))) problems.push(`The mistake "${clip(m.label)}" gives the right answer, or none, in every generated question.`);
  }
  return problems;
}

function text(x: unknown, what: string, max: number): string {
  if (typeof x !== "string") fail(`${what} must be text.`);
  const t = x.trim();
  if (!t) fail(`${what} is empty.`);
  if (t.length > max) fail(`${what} is longer than ${max} characters.`);
  return t;
}

function list(x: unknown, key: string, max: number): unknown[] {
  if (x == null) return [];
  if (!Array.isArray(x)) fail(`"${key}" must be a list.`);
  if (x.length > max) fail(`"${key}" has ${x.length} entries, but at most ${max} are allowed.`);
  return x;
}

function range(r: unknown, name: string): ParamRange {
  if (isObj(r) && r.choices != null) {
    const c = r.choices;
    if (!Array.isArray(c) || c.length < 1 || c.length > 20 || !c.every(bounded)) fail(`The choices for ${name} must be a list of 1 to 20 numbers between -1e6 and 1e6.`);
    return { choices: c.slice() };
  }
  if (!isObj(r) || !bounded(r.min) || !bounded(r.max)) fail(`The range for ${name} needs a min and a max between -1e6 and 1e6, or a list of choices.`);
  if (r.min > r.max) fail(`The range for ${name} has its min above its max.`);
  const step = r.step ?? 1;
  if (typeof step !== "number" || !Number.isFinite(step) || step <= 0) fail(`The step for ${name} must be a positive number.`);
  const out: ParamRange = r.step == null ? { min: r.min, max: r.max } : { min: r.min, max: r.max, step };
  if (size(out) > 10000) fail(`The range for ${name} has more than 10000 values; use a bigger step.`);
  return out;
}

function paramsOf(raw: unknown): Record<string, ParamRange> {
  if (!isObj(raw)) fail(`"params" must be an object giving each parameter's range.`);
  const names = Object.keys(raw);
  if (names.length < 1 || names.length > 6) fail(`A family needs 1 to 6 parameters, not ${names.length}.`);
  const out: Record<string, ParamRange> = {};
  for (const name of names) {
    if (!NAME.test(name) || FUNCS.has(name) || CONSTS.has(name)) {
      fail(`"${clip(name)}" cannot be a parameter name: use up to 8 lowercase letters and digits, starting with a letter, that are not a function or constant.`);
    }
    out[name] = range(raw[name], name);
  }
  return out;
}

function json(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return fail("The family spec is not valid JSON.");
  }
}

/** The spec's shape: types, lengths and counts. Expressions are checked when it is compiled. */
function normalise(raw: unknown): FamilySpec {
  const o = typeof raw === "string" ? json(raw) : raw;
  if (!isObj(o)) fail("The family spec is not a JSON object.");
  if (o.v != null && o.v !== FAMILY_SPEC_VERSION) fail(`The family spec is version ${clip(String(o.v))}, but only version ${FAMILY_SPEC_VERSION} is supported.`);
  const params = paramsOf(o.params);
  const template = text(o.template, "The template", 900);
  const answer = text(o.answer, "The answer", MAX_LEN);
  const where = list(o.where, "where", 6).map((w, i) => text(w, `Condition ${i + 1}`, MAX_LEN));
  const dp = o.dp ?? undefined;
  if (dp !== undefined && !whole(dp, 0, 6)) fail("The dp must be a whole number of decimal places from 0 to 6.");
  const steps = list(o.steps, "steps", 8).map((s, i) => text(s, `Step ${i + 1}`, 300));
  const labels = new Set<string>();
  const mistakes = list(o.mistakes, "mistakes", 4).map((m, i): FamilyMistake => {
    const what = `Mistake ${i + 1}`;
    if (!isObj(m)) fail(`${what} must be an object with a label and an expr.`);
    const label = text(m.label, `${what}'s label`, 80);
    if (labels.has(label.toLowerCase())) fail(`${what} has the same label as an earlier mistake.`);
    labels.add(label.toLowerCase());
    const out: FamilyMistake = { label, expr: text(m.expr, `${what}'s expr`, MAX_LEN) };
    // A step only means something when there are steps to point into.
    if (m.step != null && steps.length) {
      if (!whole(m.step, 0, steps.length - 1)) fail(`${what}'s step must be a step index from 0 to ${steps.length - 1}.`);
      out.step = m.step;
    }
    if (m.says != null) out.says = text(m.says, `${what}'s says`, 300);
    return out;
  });
  const tests = list(o.tests, "tests", 4).map((t, i) => {
    if (!isObj(t) || !isObj(t.params) || typeof t.answer !== "number" || !Number.isFinite(t.answer)) fail(`Test ${i + 1} must have params and a numeric answer.`);
    const values: Record<string, number> = {};
    for (const [k, v] of Object.entries(t.params)) {
      if (!own(params, k)) fail(`Test ${i + 1} gives a value for ${clip(k)}, which is not a parameter.`);
      if (typeof v !== "number" || !Number.isFinite(v)) fail(`Test ${i + 1} gives ${k} a value that is not a number.`);
      values[k] = v;
    }
    return { params: values, answer: t.answer };
  });
  return {
    v: FAMILY_SPEC_VERSION,
    params,
    ...(where.length ? { where } : {}),
    template,
    answer,
    ...(dp === undefined ? {} : { dp }),
    ...(steps.length ? { steps } : {}),
    ...(mistakes.length ? { mistakes } : {}),
    ...(tests.length ? { tests } : {}),
  };
}

/**
 * Spec texts already read, so a question file loaded on every turn checks each spec once (and its
 * compiled expressions are reused). Specs are immutable, so sharing one object is safe.
 */
const READ_SPECS = new Map<string, { spec: FamilySpec } | { error: string }>();

/** Reads a spec as a model wrote it (object or JSON text). Never throws. */
export function parseFamilySpec(raw: unknown): { spec: FamilySpec } | { error: string } {
  const known = typeof raw === "string" ? READ_SPECS.get(raw) : undefined;
  if (known) return known;
  let out: { spec: FamilySpec } | { error: string };
  try {
    const spec = normalise(raw);
    const problems = checkFamily(spec);
    out = problems.length ? { error: problems[0] } : { spec };
  } catch (e) {
    out = { error: e instanceof Invalid ? e.message : "The family spec could not be read." };
  }
  if (typeof raw === "string") {
    if (READ_SPECS.size >= 500) READ_SPECS.clear();
    READ_SPECS.set(raw, out);
  }
  return out;
}

// ---- Marking and teaching

// A number not glued to a word ("q1", "s2"), optionally written as a fraction a/b.
const READ = /(?<![\w.])([-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?))?/g;

/** The learner's final number: the last one in the reply. */
function lastNumber(reply: string): number | null {
  const s = reply
    .replace(/−/g, "-")
    .replace(/\\[dt]?frac\s*\{\s*([-+]?[\d.]+)\s*\}\s*\{\s*([\d.]+)\s*\}/g, "$1/$2")
    .replace(/([A-Za-z])\s*\^\s*\{?[-+]?\d+\}?/g, "$1") // a unit's power, as in m/s^2, is not the answer
    .replace(/(?<!\d)\d{1,3}(?:,\d{3})+(?!\d)/g, (m) => m.replace(/,/g, ""));
  const all = [...s.matchAll(READ)];
  const m = all[all.length - 1];
  if (!m) return null;
  const v = Number(m[1]) / (m[2] === undefined ? 1 : Number(m[2]));
  return Number.isFinite(v) ? v : null;
}

export function markNumeric(
  inst: Instance,
  spec: FamilySpec,
  reply: string,
): { result: "correct" | "incorrect" | "unreadable"; mistake?: string; value?: number } {
  const value = lastNumber(reply);
  if (value === null) return { result: "unreadable" };
  if (same(spec.dp, value, inst.answer)) return { result: "correct", value };
  const m = inst.mistakes.find((k) => same(spec.dp, value, k.value));
  return m ? { result: "incorrect", mistake: m.label, value } : { result: "incorrect", value };
}

/** A faded worked example: the last `hidden` steps are left for the learner. */
export function fade(inst: Instance, hidden: number): { shown: string[]; blanks: number } {
  const n = inst.steps.length;
  if (!n) return { shown: [], blanks: 0 };
  const h = Math.min(n, Math.max(1, Math.floor(hidden) || 1));
  return { shown: inst.steps.map((s, i) => (i < n - h ? s : `Step ${i + 1}: …`)), blanks: h };
}

/** A worked solution that goes wrong with one expected mistake and stops at the answer it gives. */
export function flawedSolution(inst: Instance, mistake: number): { steps: string[]; wrongStep: number; label: string } | null {
  const m = inst.mistakes[mistake];
  if (!inst.steps.length || !m || m.step === undefined || m.step >= inst.steps.length) return null;
  return {
    steps: [...inst.steps.slice(0, m.step), m.says ?? inst.steps[m.step], `So the answer is ${m.text}.`],
    wrongStep: m.step + 1,
    label: m.label,
  };
}

export const variantId = (questionId: string, seed: number): string => `${questionId}~${seed}`;

export function parseVariantId(id: string): { base: string; seed: number } | null {
  const m = /^(.+)~([1-9]\d{0,9})$/.exec(id);
  const seed = m ? Number(m[2]) : 0;
  return m && seed < 2 ** 31 ? { base: m[1], seed } : null;
}

/** What a task id asks: the question as written, new numbers, a repair task or a faded worked example. */
export type TaskKind = "question" | "variant" | "fix" | "fade" | "pair";

/** A task id read back: the question it comes from, the seed (null for the question as written), the kind and its index. */
export interface TaskRef {
  base: string;
  seed: number | null;
  kind: TaskKind;
  k: number;
}

/** The one reader of task ids: "Q3", "Q3~17", "Q3~17#fix0", "Q3~17#fade2" or "Q3~17#pair0". Null for anything else. */
export function parseTaskId(id: string): TaskRef | null {
  const [vid, suffix, ...rest] = id.split("#");
  if (rest.length) return null;
  if (!vid.includes("~")) return suffix === undefined && vid ? { base: vid, seed: null, kind: "question", k: 0 } : null;
  const v = parseVariantId(vid);
  const m = suffix === undefined ? null : /^(fix|fade|pair)(\d)$/.exec(suffix);
  if (!v || (suffix !== undefined && !m)) return null;
  return { base: v.base, seed: v.seed, kind: m ? (m[1] as TaskKind) : "variant", k: m ? Number(m[2]) : 0 };
}

/** The id of a task on new numbers, the inverse of parseTaskId. */
export const taskId = (base: string, seed: number, kind: "variant" | "fix" | "fade" | "pair" = "variant", k = 0): string => (kind === "variant" ? variantId(base, seed) : `${variantId(base, seed)}#${kind}${k}`);

/**
 * The card of a known mistake on a question: "Q3#m-sign-error". It is scheduled like any card but
 * is not a question and not a task id (parseTaskId reads it as null), so nothing asks it as written.
 */
export const mistakeSlug = (label: string): string => label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "mistake";
export const mistakeCardId = (base: string, label: string): string => `${base}#m-${mistakeSlug(label)}`;
/** The question and mistake slug a mistake card id names, or null for any other id. */
export const parseMistakeCard = (id: string): { base: string; slug: string } | null => {
  const m = /^(Q\d+)#m-([a-z0-9-]+)$/.exec(id);
  return m ? { base: m[1], slug: m[2] } : null;
};
export const isMistakeCard = (id: string): boolean => parseMistakeCard(id) !== null;

/** The question a task id comes from: "Q3~17#fix0" and "Q3~17" both come from Q3. Any other id is itself. */
export const baseQuestionId = (id: string): string => (id.includes("~") ? parseTaskId(id)?.base ?? id : id);
