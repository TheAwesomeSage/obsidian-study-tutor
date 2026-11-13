// SymPy checking and the concept graph. No model calls. The checker's Python is run for real
// when a Python with SymPy is installed (set SYMPY_PYTHON to choose one); otherwise that one
// test is skipped and the rest use a scripted stand-in for SymPy.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as nodefs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as F from "../src/formats";
import { Store } from "../src/store";
import { Engine, looksMathematical } from "../src/engine";
import { buildTurnInput } from "../src/prompts";
import { layers, layoutGraph } from "../src/graph";
import { Claim, ClaimResult, MathBackend, PYTHON, checkReport, cleanClaims, computeBlock, extractCompute, extractVerify, plainMaths, safeExpr } from "../src/sympy";
import { CASES, CHAINS, PLAIN, UNSAFE } from "./sympy-cases";
import { MemFS } from "./memfs";

const COMPILED = `# Differentiation
subject: none

## Overview
Rules for differentiating products and compositions, and integration by parts built on them.

## Subskills

### 1. Power rule
prerequisites: none
- $\\frac{d}{dx}x^n = nx^{n-1}$

### 2. Chain rule
prerequisites: 1
- $\\frac{d}{dx}\\sin(x^2) = 2x\\cos(x^2)$

### 3. Product rule
prerequisites: 1
- $(uv)' = u'v + uv'$

### 4. Integration by parts
prerequisites: 2, 3
- $\\int u\\,dv = uv - \\int v\\,du$

=====QUESTIONS=====

### Q1
subskill: 1
type: short
question: Differentiate $x^3$.
answer: $3x^2$
explanation: Bring the power down and reduce it by one.

### Q2
subskill: 2
type: short
question: What is $\\int_0^1 x\\,dx$?
answer: $\\frac{1}{2}$
explanation: The area of a triangle.

### Q3
subskill: 3
type: open
question: Why does the product rule have two terms?
answer: Each factor changes while the other is held.
explanation: Think of the area of a growing rectangle.
`;

const PROSE = `# The Reformation
subject: none

## Overview
Causes and course of the Reformation.

## Subskills

### 1. Causes
prerequisites: none
- Indulgences and printing.

### 2. Course
prerequisites: 1
- From 1517 onwards.

=====QUESTIONS=====

### Q1
subskill: 1
type: open
question: Why did printing matter?
answer: Ideas spread faster than they could be suppressed.
explanation: Pamphlets.
`;

/** A scripted SymPy: answers each claim with whatever the test says, and records what it was asked. */
class FakeMaths implements MathBackend {
  asked: Claim[][] = [];
  constructor(public answer: (c: Claim) => ClaimResult | null) {}
  async check(claims: Claim[]): Promise<ClaimResult[]> {
    this.asked.push(claims);
    const out = claims.map((c) => this.answer(c));
    return out.some((r) => r === null) ? [] : (out as ClaimResult[]);
  }
  warm(): void {}
  status(): string {
    return "ready";
  }
}

async function setup(compiled: string, opts: { mathCheck?: boolean; maths?: MathBackend | null } = {}) {
  const fs = new MemFS();
  const store = new Store(fs, "Tutor", () => "2026-11-13");
  const settings = { claudePath: "", chatModel: "sonnet", compileModel: "sonnet", utilityModel: "haiku", effort: "low", targetLevel: 4, maxChatWords: 600, maxTopicWords: 2000, singlePassWords: 6000, smartRouting: true, hardEffort: "high", mathCheck: opts.mathCheck ?? true };
  const engine = new Engine(store, () => settings, () => "2026-11-13");
  engine.maths = opts.maths === undefined ? null : opts.maths;
  const out = F.parseCompileOutput(compiled);
  const title = F.parseTopic(out.topicBody).title;
  const dir = await store.saveCompiled({ title, fm: { subject: "none" }, topicBody: out.topicBody, questionsBody: out.questionsBody, target: 4 });
  const calls: any[] = [];
  const replies: string[] = [];
  (engine as any).call = async (o: any) => {
    calls.push(o);
    return { text: o.jsonSchema ? "" : replies.shift() ?? "ok", structured: o.jsonSchema ? { grade: "good", feedback: "Fine." } : undefined, usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 5, costUsd: 0, calls: 1 } };
  };
  return { fs, store, engine, dir, title, calls, replies, settings };
}

test("only safe expressions ever reach SymPy's parser", () => {
  for (const u of UNSAFE) {
    assert.equal(safeExpr(u), null, u);
    assert.deepEqual(cleanClaims([{ type: "equal", a: u, b: "1" }]), [], u);
    assert.deepEqual(extractCompute(`<compute>[${JSON.stringify(u)}]</compute>`).asks, [], u);
  }
  assert.equal(cleanClaims(CASES.map(([, c]) => c), 100).length, CASES.length, "every labelled case passes the filter");
  for (const [, batch] of CHAINS) for (const c of batch) if (c.type === "compute") assert.equal(safeExpr(c.expr), c.expr);
  assert.equal(safeExpr("x".repeat(401)), null, "over-long input is refused");
  assert.equal(cleanClaims([{ type: "compute", expr: "1+1" }]).length, 0, "a check line cannot smuggle in a computation");
});

test("answers from notes and from the keyboard become expressions, and prose does not", () => {
  for (const [input, want] of PLAIN) assert.equal(plainMaths(input), want, input);
  assert.equal(plainMaths("x = 2", { allowLhs: true }), "2");
  assert.equal(plainMaths("$f'(x) = 3x^{2}$", { allowLhs: true }), "3x**(2)");
  assert.equal(plainMaths("H(s) = \\frac{1}{s+2}", { allowLhs: true }), "((1)/(s+2))");
  assert.equal(plainMaths("x = 2 or x = 3", { allowLhs: true }), null, "two equations are left to the model");
  assert.equal(plainMaths("\\lambda^2 - 1"), "lamda^2 - 1", "lambda is a Python keyword, so SymPy's spelling is used");
  assert.equal(plainMaths("λ + 1"), "lamda + 1");
});

test("the hidden compute and check lines are read and removed", () => {
  const c = extractCompute('<compute>["integrate(x*exp(x), x)", {"expr":"solve(r1 - 3, x)"}, "open(1)", 7]</compute>');
  assert.equal(c.text, "");
  assert.deepEqual(c.asks, [
    { type: "compute", expr: "integrate(x*exp(x), x)", name: "r1" },
    { type: "compute", expr: "solve(r1 - 3, x)", name: "r2" },
  ]);
  assert.equal(extractCompute('<compute>["1+1"]</compute>', 2).asks[0].name, "r3", "a second round carries on numbering");
  assert.equal(extractCompute('<compute>["1","2","3","4","5","6","7","8"]</compute>').asks.length, 6);
  assert.deepEqual(extractCompute("<compute>not json</compute>Hello"), { text: "Hello", asks: [] });

  const v = extractVerify('Right.\n<state>{"levels":{"1":3}}</state>\n<verify>[{"type":"equal","a":"2*x","b":"diff(x**2, x)"},{"type":"equal","a":"x.__class__","b":"1"},{"type":"nonsense"}]</verify>');
  assert.equal(v.claims.length, 1);
  assert.match(v.text, /^Right\.\n<state>/);
  assert.ok(!/<verify>/.test(v.text));
});

test("the report says what SymPy computed, checked and disputed", () => {
  const eq: Claim = { type: "equal", a: "2*x", b: "diff(x**2, x)", expect: true };
  const yes: ClaimResult = { ok: true, detail: "identical" };
  const no: ClaimResult = { ok: false, detail: "they differ by x" };
  assert.equal(checkReport([eq], [yes]).line, "*SymPy checked 1 result: it agrees.*");
  assert.equal(checkReport([eq, eq], [yes, yes], { computed: 2 }).line, "*SymPy computed 2 results for this reply and checked 2 results: all agree.*");
  assert.equal(checkReport([], [], { computed: 1 }).line, "*SymPy computed 1 result for this reply.*");
  assert.match(checkReport([eq], [yes], { corrected: true }).line, /after it caught an error in a first draft/);
  const bad = checkReport([eq], [no]);
  assert.equal(bad.disagreed, true);
  assert.match(bad.line, /^\*\*SymPy disagrees\*\* with this result: `2\*x = diff\(x\*\*2, x\)` \(they differ by x\)/);
  assert.match(bad.findings[0], /SymPy DISAGREES/);
  // The tutor said "wrong" and SymPy finds the two equal: that is a disagreement too.
  assert.equal(checkReport([{ ...eq, expect: false }], [yes]).disagreed, true);
  assert.equal(checkReport([{ ...eq, expect: false }], [no]).disagreed, false);
  assert.deepEqual(checkReport([eq], []), { line: "", disagreed: false, findings: [] }, "no results means SymPy was unavailable: say nothing");
  assert.equal(checkReport([eq], [{ ok: null, detail: "could not be evaluated" }]).line, "");
  assert.match(computeBlock([{ type: "compute", expr: "1+1", name: "r1" }], []), /not available/);
  assert.equal(computeBlock([{ type: "compute", expr: "1+1", name: "r1" }], [{ ok: true, detail: "computed", value: "2" }]), "r1 = 1+1  →  2");
});

// ---------- the real thing, when this machine has it ----------

function findPython(): string | null {
  for (const cmd of [process.env.SYMPY_PYTHON, "python", "python3"]) {
    if (!cmd) continue;
    try {
      if (spawnSync(cmd, ["-c", "import sympy"], { stdio: "ignore", timeout: 60000 }).status === 0) return cmd;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

const python = findPython();

/** Runs batches through the same Python source the worker runs, in one process. */
function runPython(batches: Claim[][]): ClaimResult[][] {
  const file = path.join(os.tmpdir(), `study-tutor-sympy-${process.pid}.py`);
  nodefs.writeFileSync(file, `${PYTHON}\nimport sys\nprint(json.dumps([json.loads(run(json.dumps(b))) for b in json.loads(sys.stdin.read())]))\n`, "utf8");
  try {
    const r = spawnSync(python!, [file], { input: JSON.stringify(batches), encoding: "utf8", timeout: 240000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split(/\r?\n/).pop()!);
  } finally {
    nodefs.unlinkSync(file);
  }
}

test("SymPy itself gives the labelled outcome for every check and every chain", { skip: python ? false : "no Python with SymPy on this machine" }, () => {
  const [single, ...chains] = runPython([cleanClaims(CASES.map(([, c]) => c), 100), ...CHAINS.map(([, batch]) => batch)]);
  CASES.forEach(([name, , want], i) => assert.equal(single[i].ok, want, `${name}: ${single[i].detail}`));
  CHAINS.forEach(([name, , want], b) => {
    want.forEach((w, i) => {
      const got = chains[b][i];
      if (typeof w === "string") assert.equal(got.value, w, `${name}, step ${i + 1}`);
      else assert.equal(got.ok, w, `${name}, step ${i + 1}: ${got.detail}`);
    });
  });
});

// ---------- the engine, with a scripted SymPy ----------

test("a typed answer in another form is marked by SymPy with no model call", async () => {
  const maths = new FakeMaths((c) => ({ ok: c.a === "3*x^2", detail: "" }));
  const { store, engine, dir, title, calls } = await setup(COMPILED, { maths });
  const chat = await store.newChat(dir, title, "quiz", new Date(2026, 10, 13, 9, 0));
  let r = await engine.quizTurn(dir, chat, "");
  assert.match(r.reply, /Differentiate \$x\^3\$/);
  r = await engine.quizTurn(dir, chat, "3*x^2");
  assert.match(r.reply, /\*\*Correct\.\*\* SymPy confirms your answer equals the expected one\./);
  assert.deepEqual(maths.asked[0], [{ type: "equal", a: "3*x^2", b: "3x^2", lenient: true }]);
  assert.equal(calls.length, 0, "no model call for an answer SymPy can decide");
  assert.equal(r.local, true);

  // SymPy says the next one is wrong: still no model call, and the answer is shown.
  r = await engine.quizTurn(dir, chat, "x = 2");
  assert.deepEqual(maths.asked[1], [{ type: "equal", a: "2", b: "((1)/(2))", lenient: true }], "the name on the left is dropped");
  assert.match(r.reply, /\*\*Incorrect\.\*\* SymPy finds your answer is not equal/);
  assert.equal(calls.length, 0);
});

test("when SymPy cannot decide, is unavailable or is switched off, the model grades as before", async () => {
  for (const variant of ["undecided", "unavailable", "off", "absent"] as const) {
    const maths = new FakeMaths(() => (variant === "unavailable" ? null : { ok: null, detail: "the two use different symbols" }));
    const { store, engine, dir, title, calls } = await setup(COMPILED, { maths: variant === "absent" ? null : maths, mathCheck: variant !== "off" });
    const chat = await store.newChat(dir, title, "quiz", new Date(2026, 10, 13, 9, 0));
    await engine.quizTurn(dir, chat, "");
    const r = await engine.quizTurn(dir, chat, "3*x^2 + c");
    assert.equal(calls.length, 1, `${variant}: one grading call`);
    assert.ok(calls[0].jsonSchema, variant);
    assert.match(r.reply, /\*\*Correct\.\*\* Fine\./, variant);
    assert.equal(maths.asked.length, variant === "off" || variant === "absent" ? 0 : 1, variant);
  }
});

test("the tutor hands a computation to SymPy and answers from the result", async () => {
  const maths = new FakeMaths((c) => (c.type === "compute" ? { ok: true, detail: "computed", value: c.name === "r1" ? "(x - 1)*exp(x)" : "E" } : { ok: true, detail: "its derivative is the integrand" }));
  const { store, engine, dir, title, calls, replies } = await setup(COMPILED, { maths });
  const chat = await store.newChat(dir, title, "expert", new Date(2026, 10, 13, 9, 0));
  replies.push(
    '<compute>["integrate(x*exp(x), x)"]</compute>',
    '<compute>["r1.subs(x, 2)", "limit(r1/exp(x), x, 2)*E"]</compute>',
    'The antiderivative is $(x-1)e^x$, which is $e^2$ at $x=2$.\n<verify>[{"type":"integral","f":"x*exp(x)","var":"x","result":"(x-1)*exp(x)"}]</verify>',
  );
  const r = await engine.turn(dir, chat, "How do I integrate x e^x, and what is the antiderivative at 2 after that step by parts?");
  assert.equal(calls.length, 3, "one call per compute round, then the answer");
  assert.match(calls[0].system, /# Mode: Subject expert[\s\S]*# SymPy/);
  assert.ok(calls.every((c) => c.system === calls[0].system), "the system prompt is identical in every round, so it is cached");
  assert.match(calls[1].input, /# SymPy results[\s\S]*r1 = integrate\(x\*exp\(x\), x\) {2}→ {2}\(x - 1\)\*exp\(x\)[\s\S]*Ask for more computation only if/);
  // "r1.subs(…)" is a method call and is refused; the other request of round two is kept as r2.
  assert.match(calls[2].input, /r1 = integrate[\s\S]*r2 = limit\(r1\/exp\(x\), x, 2\)\*E {2}→ {2}E[\s\S]*Do not ask for more computation\./);
  assert.deepEqual(maths.asked[1].map((c) => c.name), ["r1", "r2"], "earlier requests are re-run so later ones can use their names");
  assert.match(r.reply, /^The antiderivative is[\s\S]*\*SymPy computed 2 results for this reply and checked 1 result: it agrees\.\*$/);
  assert.ok(!/<compute>|<verify>/.test(r.reply));
  assert.deepEqual(r.maths, { computed: 2, checked: 1, disputed: false, corrected: false });
  assert.equal(r.usage.calls, 3, "usage adds up every call of the turn");
  assert.match((await store.loadChat(chat)).messages[1].text, /SymPy computed 2 results/, "the outcome is saved with the message");
});

test("a draft SymPy disputes is rewritten before the learner sees it", async () => {
  // SymPy: 2x cos(x) is not the derivative of sin(x^2).
  const maths = new FakeMaths(() => ({ ok: false, detail: "they differ at x=41/9" }));
  const { store, engine, dir, title, calls, replies } = await setup(COMPILED, { maths });
  const chat = await store.newChat(dir, title, "tutor", new Date(2026, 10, 13, 9, 0));
  const claim = '{"type":"equal","a":"2*x*cos(x)","b":"diff(sin(x**2), x)"';
  replies.push(`Correct, well done.\n<state>{"levels":{"2":3}}</state>\n<verify>[${claim}}]</verify>`, `Not quite. What is the inner function, and where does it appear in your answer?\n<verify>[${claim},"expect":false}]</verify>`);
  const r = await engine.turn(dir, chat, "2x cos(x)");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].effort, "low", "a bare expression is checked by SymPy, so the first pass does not think hard");
  assert.equal(r.route?.route, "standard");
  assert.equal(calls[1].effort, "high", "the rewrite does");
  assert.match(calls[1].input, /# SymPy check of your draft[\s\S]*<draft>\nCorrect, well done\.\n<\/draft>[\s\S]*SymPy DISAGREES \(they differ at x=41\/9\)/);
  assert.match(r.reply, /^Not quite\.[\s\S]*\*SymPy checked 1 result: it agrees \(after it caught an error in a first draft, which was rewritten\)\.\*$/);
  assert.equal(r.state.levels[2], null, "the level the wrong draft wanted to raise is not raised");
  assert.deepEqual(r.maths, { computed: 0, checked: 1, disputed: false, corrected: true });

  // If the rewrite is disputed as well, the learner is warned and no level moves.
  replies.push(`Correct.\n<state>{"levels":{"2":3}}</state>\n<verify>[${claim}}]</verify>`, `Yes, correct.\n<state>{"levels":{"2":4}}</state>\n<verify>[${claim}}]</verify>`);
  const r2 = await engine.turn(dir, chat, "2x cos(x)");
  assert.match(r2.reply, /^Yes, correct\.\n\n\*\*SymPy disagrees\*\* with this result/);
  assert.equal(r2.state.levels[2], null);
  assert.equal(r2.maths?.disputed, true);
  assert.equal(calls.length, 4, "one rewrite per turn, never a loop");
});

test("maths checking stays out of the way where it does not apply", async () => {
  // A topic without notation never gets the SymPy rules, and its hidden lines are ignored.
  const maths = new FakeMaths(() => ({ ok: false, detail: "" }));
  const prose = await setup(PROSE, { maths });
  const chat = await prose.store.newChat(prose.dir, prose.title, "expert", new Date(2026, 10, 13, 9, 0));
  prose.replies.push('Printing spread ideas.\n<verify>[{"type":"equal","a":"1","b":"2"}]</verify>');
  let r = await prose.engine.turn(prose.dir, chat, "Why did printing matter so much to the reformers?");
  assert.ok(!/# SymPy/.test(prose.calls[0].system));
  assert.equal(r.reply, "Printing spread ideas.");
  assert.equal(r.maths, undefined);
  assert.equal(maths.asked.length, 0);
  assert.equal(looksMathematical(F.parseCompileOutput(PROSE).topicBody), false);
  assert.equal(looksMathematical(F.parseCompileOutput(COMPILED).topicBody), true);

  // Switched off: a maths answer keeps the extra thinking it had before, and nothing is added to the prompt.
  const off = await setup(COMPILED, { maths, mathCheck: false });
  const chat2 = await off.store.newChat(off.dir, off.title, "tutor", new Date(2026, 10, 13, 9, 0));
  r = await off.engine.turn(off.dir, chat2, "2x cos(x^2)");
  assert.equal(off.calls[0].effort, "high");
  assert.ok(!/# SymPy/.test(off.calls[0].system));

  // On, but the answer is an argument in words with maths in it: still the extra thinking.
  const on = await setup(COMPILED, { maths: new FakeMaths(() => ({ ok: true, detail: "" })) });
  const chat3 = await on.store.newChat(on.dir, on.title, "tutor", new Date(2026, 10, 13, 9, 0));
  await on.engine.turn(on.dir, chat3, "because d/dx of x^2 = 2x, so you multiply by that");
  assert.equal(on.calls[0].effort, "high");

  // SymPy unavailable in the middle of a compute request: the model is told, and the turn still ends.
  const down = await setup(COMPILED, { maths: new FakeMaths(() => null) });
  const chat4 = await down.store.newChat(down.dir, down.title, "expert", new Date(2026, 10, 13, 9, 0));
  down.replies.push('<compute>["integrate(x, x)"]</compute>', "It is $x^2/2$.");
  r = await down.engine.turn(down.dir, chat4, "Please integrate x for me, I keep getting it wrong somehow?");
  assert.match(down.calls[1].input, /SymPy was not available/);
  assert.equal(r.reply, "It is $x^2/2$.");
});

// ---------- the concept graph ----------

test("subskills are layered by what they depend on, and loops do not hang", () => {
  assert.deepEqual(layers({ 1: [], 2: [1], 3: [1], 4: [2, 3] }), { 1: 0, 2: 1, 3: 1, 4: 2 });
  assert.deepEqual(layers({ 1: [], 2: [1], 3: [1, 2] }), { 1: 0, 2: 1, 3: 2 }, "depth follows the longest chain");
  const loop = layers({ 1: [2], 2: [1], 3: [] });
  assert.deepEqual(Object.keys(loop).sort(), ["1", "2", "3"]);
});

test("the graph puts prerequisites above, keeps boxes apart and marks gaps", () => {
  const topic = F.parseTopic(F.parseCompileOutput(COMPILED).topicBody);
  assert.deepEqual(F.prereqMap(topic), { 1: [], 2: [1], 3: [1], 4: [2, 3] });
  const s = F.newState(topic, 4);
  s.levels = { 1: 4, 2: 1, 3: 3, 4: 2 };
  s.focus = 2;
  for (const width of [240, 340, 520, 760]) {
    const g = layoutGraph(topic, s, { width });
    const at = Object.fromEntries(g.nodes.map((n) => [n.n, n]));
    assert.equal(g.nodes.length, 4);
    assert.ok(at[1].y < at[2].y && at[2].y === at[3].y && at[3].y < at[4].y, "three rows, prerequisites first");
    for (const n of g.nodes) assert.ok(n.x >= 0 && n.x + n.w <= g.width && n.y + n.h <= g.height, `box ${n.n} is inside a ${width}px graph`);
    assert.ok(at[2].x + at[2].w <= at[3].x || at[3].x + at[3].w <= at[2].x, "boxes in a row do not overlap");
    assert.equal(g.edges.length, 4);
    assert.ok(g.edges.every((e) => /^M[\d.]+ [\d.]+ C/.test(e.d)));
  }
  const g = layoutGraph(topic, s);
  const at = Object.fromEntries(g.nodes.map((n) => [n.n, n]));
  assert.deepEqual(g.edges.filter((e) => e.lagging).map((e) => [e.from, e.to]), [[2, 4]], "chain rule (1) is behind integration by parts (2)");
  assert.deepEqual(at[4].blockedBy, [2]);
  assert.equal(at[4].locked, false, "already started, so not locked");
  assert.equal(at[1].atTarget, true);
  assert.equal(at[2].focus, true);
  assert.deepEqual(at[1].unlocks, [2, 3]);

  // Nothing placed yet: everything past the first row waits for what it builds on.
  const fresh = layoutGraph(topic, F.newState(topic, 4));
  assert.deepEqual(fresh.nodes.map((n) => n.locked), [false, true, true, true]);
  assert.equal(fresh.edges.filter((e) => e.lagging).length, 0);

  // A long name is wrapped to three lines at most; six boxes in one layer wrap onto two rows.
  const wide = F.parseTopic(["# T", "", "## Subskills", "", "### 1. Root", "prerequisites: none", ...[2, 3, 4, 5, 6, 7].flatMap((n) => ["", `### ${n}. A subskill with a very long descriptive name that cannot fit on one line number ${n}`, "prerequisites: 1"])].join("\n"));
  const w = layoutGraph(wide, F.newState(wide, 4), { width: 340 });
  assert.ok(w.nodes.every((n) => n.lines.length <= 3 && n.x + n.w <= w.width));
  assert.equal(new Set(w.nodes.filter((n) => n.layer === 1).map((n) => n.y)).size, 2);
  assert.match(w.nodes[1].lines[2], /…$/);
});

test("the next step starts from the foundation, and the tutor is told about gaps", () => {
  const topic = F.parseTopic(F.parseCompileOutput(COMPILED).topicBody);
  const pre = F.prereqMap(topic);
  const s = F.newState(topic, 4);
  const day = "2026-11-13";
  let step = F.nextStep(s, day, undefined, pre);
  assert.deepEqual([step.action, step.subskill], ["teach", 1]);

  // A card numbered out of order: 1 needs 3, which is not learned yet.
  const odd = { 1: [3], 2: [], 3: [] };
  const o = F.newState(F.parseTopic("# T\n\n### 1. Later\n\n### 2. Other\n\n### 3. Base\n"), 4);
  step = F.nextStep(o, day, undefined, odd);
  assert.deepEqual([step.action, step.subskill, step.detail], ["teach", 3, "Start with a lesson on Base."]);
  o.levels = { 1: 1, 2: 2, 3: 1 };
  step = F.nextStep(o, day, undefined, odd);
  assert.equal(step.detail, "Take a lesson on Base first: Later builds on it.");
  assert.equal(F.nextStep(o, day).detail, "Take a lesson on Later.", "without the prerequisites the old order is kept");
  o.levels = { 1: 2, 2: 3, 3: 2 };
  o.bank = { 1: { right: 2, total: 2 }, 2: { right: 2, total: 2 }, 3: { right: 2, total: 2 } };
  step = F.nextStep(o, day, undefined, odd);
  assert.deepEqual([step.action, step.subskill], ["tutor", 3]);
  assert.match(step.detail, /Work with the tutor on Base \(level 2 of 4\) first: Later builds on it\./);
  assert.equal(F.foundationFor(o, { 1: [3], 3: [1] }, 1, 3), 3, "a loop of prerequisites ends");

  assert.deepEqual([F.stepFor(s, 2).action, F.stepFor({ ...s, levels: { ...s.levels, 2: 3 } }, 2).action], ["teach", "tutor"]);

  s.levels = { 1: 4, 2: 1, 3: 3, 4: 2 };
  const gaps = F.prereqGaps(s, pre);
  assert.deepEqual(gaps, ["2 (Chain rule, level 1) is behind 4 (Integration by parts, level 2), which builds on it"]);
  const input = buildTurnInput({ state: s, today: day, chat: { fm: {}, summary: "", messages: [] }, gaps });
  assert.match(input, /prerequisite gaps: 2 \(Chain rule, level 1\) is behind 4/);
  assert.ok(!/prerequisite gaps/.test(buildTurnInput({ state: s, today: day, chat: { fm: {}, summary: "", messages: [] }, gaps: [] })));
});
