// Question families: the expression parser, spec checking, instances, marking and the teaching
// views built on them. Pure code, no model calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FamilySpec, Instance, checkFamily, evaluate, fade, flawedSolution, instantiate, markNumeric,
  pairedCases, parseExpr, parseFamilySpec, parseVariantId, rng, variantId,
} from "../src/families";

const KINEMATICS = {
  v: 1,
  params: { u: { min: 0, max: 30 }, a: { min: 1, max: 5, step: 0.5 }, t: { min: 1, max: 10 } },
  template: "A cyclist moving at {u} m/s speeds up at {a} m/s^2 for {t} s. What is the final speed in m/s, to 1 decimal place?",
  answer: "u + a*t",
  dp: 1,
  steps: ["Use v = u + at.", "v = {u} + {a} × {t}", "v = {=u+a*t} m/s"],
  mistakes: [
    { label: "used a minus sign", expr: "u - a*t", step: 1, says: "v = {u} − {a} × {t}" },
    { label: "forgot the starting speed", expr: "a*t", step: 2 },
  ],
  tests: [{ params: { u: 5, a: 2, t: 3 }, answer: 11 }],
};

const PERCENT = {
  params: { before: { min: 20, max: 400, step: 20 }, after: { min: 20, max: 400, step: 20 } },
  where: ["after != before"],
  template: "A price goes from £{before} to £{after}. What is the percentage change? Give a fall as a negative number.",
  answer: "(after - before) / before * 100",
  dp: 1,
  mistakes: [
    { label: "divided by the new price", expr: "(after - before) / after * 100" },
    { label: "gave the change in pounds", expr: "after - before" },
  ],
  tests: [{ params: { before: 80, after: 100 }, answer: 25 }],
};

const QUADRATIC = {
  params: { a: { min: -3, max: 3 }, b: { min: -10, max: 10 }, c: { min: -10, max: 10 } },
  where: ["b^2-4*a*c>=0", "a!=0"],
  template: "Solve {a}x^2 + {b}x + {c} = 0 and give the root from the + sign of the formula, to 2 decimal places.",
  answer: "(-b + sqrt(b^2 - 4*a*c)) / (2*a)",
  dp: 2,
  steps: ["The discriminant is {=b^2-4*a*c}.", "x = (-({b}) + sqrt({=b^2-4*a*c})) / (2 × {a})", "x = {=(-b + sqrt(b^2 - 4*a*c)) / (2*a)}"],
  mistakes: [{ label: "divided by a, not 2a", expr: "(-b + sqrt(b^2 - 4*a*c)) / a", step: 1, says: "x = (-({b}) + sqrt({=b^2-4*a*c})) / {a}" }],
  tests: [{ params: { a: 1, b: -3, c: 2 }, answer: 2 }],
};

function ok(raw: unknown): FamilySpec {
  const r = parseFamilySpec(raw);
  if ("error" in r) assert.fail(r.error);
  return r.spec;
}

function refused(raw: unknown, why: RegExp): void {
  const r = parseFamilySpec(raw);
  if (!("error" in r)) return assert.fail(`accepted ${JSON.stringify(raw)}`);
  assert.match(r.error, why);
  assert.match(r.error, /^["A-Z][^\n]*\.$/, "one plain sentence");
}

function find(spec: FamilySpec, pred: (i: Instance) => boolean): Instance {
  for (let seed = 1; seed < 500; seed++) {
    const inst = instantiate(spec, seed);
    if (inst && pred(inst)) return inst;
  }
  return assert.fail("no seed gives such an instance");
}

const fixed = (params: Record<string, number>, answer: string, extra: object = {}): FamilySpec =>
  ok({ params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, { choices: [v] }])), template: "Q", answer, ...extra });

test("expressions follow the usual precedence and functions", () => {
  const cases: [string, number][] = [
    ["1+2*3", 7], ["(1+2)*3", 9], ["2^3^2", 512], ["-2^2", -4], ["2**3", 8], ["2^-1", 0.5], ["10-4-3", 3],
    ["12/3/2", 2], ["-3*-2", 6], ["2--3", 5], ["+4", 4], ["  2 *\t( 3 + 4 )  ", 14], ["−3 + 5", 2], ["1.5e3", 1500], [".5*4", 2],
    ["sqrt(16)+abs(-3)", 7], ["min(2, 5)*max(2, 5)", 10], ["ln(e)", 1], ["log10(1000)", 3], ["exp(0)", 1],
    ["sin(pi/2)", 1], ["cos(pi)", -1], ["4*atan(1)", Math.PI], ["tan(0)+asin(0)+acos(1)", 0],
    ["round(2.5)", 3], ["round(-2.5)", -3], ["floor(-1.5)", -2], ["ceil(1.2)", 2],
  ];
  for (const [src, want] of cases) {
    const got = evaluate(src, {});
    assert.ok(got !== null && Math.abs(got - want) < 1e-12, `${src} gave ${got}`);
  }
  assert.equal(evaluate("u + a*t", { u: 5, a: 2, t: 3 }), 11);
  const x = parseExpr("x^2 - 1");
  assert.ok(x);
  assert.equal(evaluate(x, { x: 3 }), 8);
  assert.equal(evaluate("x + 1", {}), null, "a missing name gives no value");
  for (const src of ["1/0", "sqrt(-1)", "ln(0)", "0^-1", "(1/0)^0", "asin(2)", "(-8)^(1/3)", "1e400"]) assert.equal(evaluate(src, {}), null, src);
});

test("anything but plain arithmetic is refused by the parser", () => {
  const bad = [
    "", "   ", "2x", "sin x", "sin(1,2)", "min(1)", "sqrt", "__proto__", "constructor", "toString", "U", "'1'", '"1"', "`1`",
    "a.b", "1..2", "eval(1)", "Function(1)", "Math.PI", "x = 3", "x => 1", "1;2", "[1]", "1+", "(1", "1)", "1,2", "a&b", "x!",
    "1" + "+1".repeat(100), "(".repeat(50) + "1" + ")".repeat(50), "-".repeat(45) + "1",
  ];
  for (const src of bad) assert.equal(parseExpr(src), null, src);
  assert.equal(evaluate("1" + "+1".repeat(99), {}), 100, "199 characters is fine");
  assert.equal(evaluate("(".repeat(30) + "1" + ")".repeat(30), {}), 1, "moderate nesting is fine");
});

test("a spec is read, normalised and checked", () => {
  const spec = ok(JSON.stringify({ ...KINEMATICS, answer: "  u + a*t  ", colour: "red", mistakes: [{ ...KINEMATICS.mistakes[0], extra: 1 }] }));
  assert.equal(spec.answer, "u + a*t");
  assert.ok(!("colour" in spec));
  assert.deepEqual(Object.keys(spec.mistakes![0]).sort(), ["expr", "label", "says", "step"]);
  assert.deepEqual(checkFamily(spec), []);
  ok(PERCENT);
  ok(QUADRATIC);
  // A step on a mistake only means something when there are steps.
  assert.equal(ok({ ...PERCENT, mistakes: [{ label: "x", expr: "after", step: 3 }] }).mistakes![0].step, undefined);
});

test("unsafe or malformed specs are refused with a sentence that names the problem", () => {
  const k = KINEMATICS;
  refused({ ...k, answer: "u + k" }, /^The answer uses an unknown name: k\.$/);
  refused({ ...k, answer: "__proto__" }, /The answer cannot be read: "__proto__" is not a usable name/);
  refused({ ...k, answer: "constructor" }, /not a usable name/);
  refused({ ...k, answer: "'u'" }, /cannot be read: unexpected "'"/);
  refused({ ...k, answer: "u.a" }, /unexpected "\."/);
  refused({ ...k, answer: "eval(1)" }, /"eval" is not a known function/);
  refused({ ...k, answer: "u+".repeat(100) + "u" }, /The answer is longer than 200 characters/);
  refused('{"params":{"__proto__":{"min":1,"max":2}},"template":"Q","answer":"1"}', /"__proto__" cannot be a parameter name/);
  refused({ ...k, params: { constructor: { min: 1, max: 2 } } }, /"constructor" cannot be a parameter name/);
  refused({ ...k, params: { sin: { min: 1, max: 2 } } }, /cannot be a parameter name/);
  refused({ ...k, params: { e: { min: 1, max: 2 } } }, /cannot be a parameter name/);
  refused({ ...k, params: { ...k.params, u: { min: 5, max: 1 } } }, /The range for u has its min above its max/);
  refused({ ...k, params: { ...k.params, u: { min: 0, max: 5, step: 0 } } }, /The step for u must be a positive number/);
  refused({ ...k, params: { ...k.params, u: { min: 0, max: 100000 } } }, /more than 10000 values/);
  refused({ ...k, params: { ...k.params, u: { min: 0, max: 2e6, step: 1000 } } }, /between -1e6 and 1e6/);
  refused({ ...k, params: { ...k.params, u: { min: "1", max: 3 } } }, /The range for u needs a min and a max/);
  refused({ ...k, params: { ...k.params, u: { choices: [] } } }, /The choices for u must be a list of 1 to 20 numbers/);
  refused({ ...k, params: Object.fromEntries("pqrswxy".split("").map((n) => [n, { min: 1, max: 2 }])) }, /1 to 6 parameters, not 7/);
  refused({ ...k, params: {} }, /not 0/);
  refused({ ...k, template: "Speed after {k} s?" }, /The template has an unknown placeholder \{k\}\./);
  refused({ ...k, template: "Speed {u" }, /The template has a "\{" without a matching "\}"/);
  refused({ ...k, template: "Speed u}" }, /The template has a "\}" without a matching "\{"/);
  refused({ ...k, template: "Speed {=u+}" }, /The template placeholder \{=u\+\} cannot be read: it ends too soon/);
  refused({ ...k, steps: ["v = {=k*2}"], mistakes: undefined }, /Step 1 placeholder \{=k\*2\} uses an unknown name: k/);
  refused({ ...k, tests: [{ params: { u: 5, a: 2, t: 3 }, answer: 12 }] }, /^Test 1 expects 12, but the answer gives 11\.0\.$/);
  refused({ ...k, tests: [{ params: { u: 5, a: 2 }, answer: 11 }] }, /Test 1 gives no value for t/);
  refused({ ...k, tests: [{ params: { u: 5, a: 2, t: 3, k: 1 }, answer: 11 }] }, /Test 1 gives a value for k, which is not a parameter/);
  refused({ ...k, tests: [{ params: { u: 50, a: 2, t: 3 }, answer: 56 }] }, /Test 1 has u = 50, which is outside the values u can take/);
  refused({ ...QUADRATIC, tests: [{ params: { a: 1, b: 0, c: 1 }, answer: 0 }] }, /Test 1 breaks the condition "b\^2-4\*a\*c>=0"/);
  refused({ ...k, where: ["u = 3"] }, /Condition 1 must be exactly one comparison/);
  refused({ ...k, where: ["0 < u < 5"] }, /Condition 1 must be exactly one comparison/);
  refused({ ...k, where: ["u > 100"], tests: undefined }, /Only 0 of 20 seeds give a valid question/);
  refused({ ...k, answer: "3", tests: undefined }, /Every generated question has the same answer/);
  refused({ ...k, mistakes: [{ label: "same thing", expr: "a*t + u" }] }, /The mistake "same thing" gives the right answer, or none/);
  refused({ ...k, mistakes: [{ label: "x", expr: "u", step: 5 }] }, /Mistake 1's step must be a step index from 0 to 2/);
  refused({ ...k, mistakes: [{ label: "x", expr: "u" }, { label: "X", expr: "t" }] }, /Mistake 2 has the same label as an earlier mistake/);
  refused({ ...k, dp: 7 }, /The dp must be a whole number/);
  refused({ ...k, v: 2 }, /version 2, but only version 1 is supported/);
  refused({ ...k, dp: undefined, answer: "u / 3", tests: undefined }, /cannot be shown exactly, so set dp/);
  refused("{not json", /not valid JSON/);
  for (const raw of [42, null, [], "[1]"]) refused(raw, /not a JSON object/);
  const trap = { ...k, params: { u: { get min(): number { throw new Error("boom"); }, max: 3 } } };
  refused(trap, /could not be read/);
});

test("instances are the same for a seed and vary across seeds", () => {
  const spec = ok(KINEMATICS);
  const again = ok(JSON.stringify(KINEMATICS));
  for (const seed of [1, 7, 123456]) {
    assert.deepEqual(instantiate(spec, seed), instantiate(spec, seed));
    assert.deepEqual(instantiate(spec, seed), instantiate(again, seed), "a re-read spec gives the same instance");
  }
  const made = Array.from({ length: 20 }, (_, i) => instantiate(spec, i + 1)!);
  assert.ok(new Set(made.map((m) => m.question)).size >= 15, "seeds give different numbers");
  const inst = made[0];
  assert.equal(inst.seed, 1);
  assert.equal(inst.answer, inst.params.u + inst.params.a * inst.params.t);
  assert.equal(inst.question, `A cyclist moving at ${inst.params.u} m/s speeds up at ${inst.params.a} m/s^2 for ${inst.params.t} s. What is the final speed in m/s, to 1 decimal place?`);
  assert.deepEqual(inst.steps, ["Use v = u + at.", `v = ${inst.params.u} + ${inst.params.a} × ${inst.params.t}`, `v = ${inst.answerText} m/s`]);
  assert.match(inst.answerText, /^\d+\.\d$/);
  for (const m of made) assert.ok(Number.isInteger(m.params.a * 2) && m.params.u >= 0 && m.params.u <= 30, "values come from the grid");
  const r = rng(42);
  const seq = Array.from({ length: 1000 }, r);
  assert.deepEqual(seq.slice(0, 5), Array.from({ length: 5 }, rng(42)));
  assert.ok(seq.every((x) => x >= 0 && x < 1));
  assert.notEqual(rng(1)(), rng(2)());
});

test("generated instances always meet the conditions", () => {
  const spec = ok(QUADRATIC);
  let count = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const inst = instantiate(spec, seed);
    if (!inst) continue;
    count++;
    const { a, b, c } = inst.params;
    assert.ok(b * b - 4 * a * c >= 0 && a !== 0, JSON.stringify(inst.params));
    const x = evaluate(spec.answer, inst.params)!;
    assert.ok(Math.abs(a * x * x + b * x + c) < 1e-6, "the answer is a root");
    assert.ok(Math.abs(inst.answer - x) <= 0.005 + 1e-12, "the answer is the root to 2 places");
  }
  assert.ok(count > 250);
  const p = ok(PERCENT);
  for (let seed = 1; seed <= 100; seed++) {
    const inst = instantiate(p, seed)!;
    assert.notEqual(inst.params.after, inst.params.before);
  }
});

test("dp rounds the answer and marking reads the learner's last number", () => {
  const speed = fixed({ d: 100, t: 7 }, "d/t", { dp: 2 });
  const inst = instantiate(speed, 1)!;
  assert.equal(inst.answer, 14.29);
  assert.equal(inst.answerText, "14.29");
  const mark = (reply: string) => markNumeric(inst, speed, reply);
  assert.equal(mark("14.29").result, "correct");
  assert.equal(mark("I think the speed is 14.2857 m/s.").result, "correct", "more decimals than asked for is fine");
  assert.equal(mark("100/7").result, "correct", "a fraction");
  assert.equal(mark("v = 14.28").result, "incorrect");
  assert.equal(mark("about 14.3").result, "incorrect");
  assert.deepEqual(mark("I'm not sure"), { result: "unreadable" });
  assert.equal(instantiate(fixed({ x: 2.5 }, "x", { dp: 0 }), 1)!.answerText, "3", "half rounds away from zero");
  assert.equal(instantiate(fixed({ x: -2.5 }, "x", { dp: 0 }), 1)!.answerText, "-3");
  assert.equal(instantiate(fixed({ x: 1.005 }, "x", { dp: 2 }), 1)!.answerText, "1.01", "float noise does not round 1.005 down");

  const exact = fixed({ k: 3, n: 4 }, "k/n");
  const e = instantiate(exact, 1)!;
  assert.equal(e.answerText, "0.75");
  for (const reply of ["3/4", "0.75", "x = 0.75.", "$\\frac{3}{4}$", "p = 0.7500001"]) assert.equal(markNumeric(e, exact, reply).result, "correct", reply);
  for (const [reply, value] of [["x = -2.5", -2.5], ["1,000", 1000], ["about 2.5e3 m", 2500], ["9.8 m/s^2", 9.8], ["(−3/4)", -0.75], ["Q1: 0.7", 0.7]] as const) {
    assert.deepEqual(markNumeric(e, exact, reply), { result: "incorrect", value }, reply);
  }
  assert.equal(instantiate(fixed({ x: 0.1 }, "x + 0.2"), 1)!.answerText, "0.3");
});

test("a reply that matches an expected mistake is named", () => {
  const spec = ok(KINEMATICS);
  const inst = instantiate(spec, 3)!;
  const minus = inst.mistakes.find((m) => m.label === "used a minus sign")!;
  assert.equal(minus.value, Math.round((inst.params.u - inst.params.a * inst.params.t) * 10) / 10 || 0);
  assert.deepEqual(markNumeric(inst, spec, `v = ${minus.text} m/s`), { result: "incorrect", mistake: "used a minus sign", value: minus.value });
  assert.deepEqual(markNumeric(inst, spec, `v = ${inst.answerText} m/s`), { result: "correct", value: inst.answer });
  const p = ok(PERCENT);
  const pi = find(p, (i) => i.params.before !== 100 && i.params.after !== 100);
  const pounds = pi.mistakes.find((m) => m.label === "gave the change in pounds")!;
  assert.equal(markNumeric(pi, p, `The price changed by ${pounds.text}`).mistake, "gave the change in pounds");
});

test("a mistake that gives the right answer is dropped for that instance only", () => {
  const spec = ok({ ...KINEMATICS, params: { ...KINEMATICS.params, t: { choices: [0, 4] } }, tests: undefined });
  const still = find(spec, (i) => i.params.t === 0);
  assert.equal(still.answer, still.params.u);
  assert.ok(!still.mistakes.some((m) => m.label === "used a minus sign"));
  const moving = find(spec, (i) => i.params.t === 4);
  assert.ok(moving.mistakes.some((m) => m.label === "used a minus sign"));
  const p = ok(PERCENT);
  const hundred = find(p, (i) => i.params.before === 100);
  assert.deepEqual(hundred.mistakes.map((m) => m.label), ["divided by the new price"], "after - before is the percentage when the price was 100");
});

test("a faded example hides the last steps", () => {
  const inst = instantiate(ok(KINEMATICS), 2)!;
  const [s1, s2] = inst.steps;
  assert.deepEqual(fade(inst, 1), { shown: [s1, s2, "Step 3: …"], blanks: 1 });
  assert.deepEqual(fade(inst, 2), { shown: [s1, "Step 2: …", "Step 3: …"], blanks: 2 });
  assert.deepEqual(fade(inst, 99), { shown: ["Step 1: …", "Step 2: …", "Step 3: …"], blanks: 3 });
  assert.deepEqual(fade(inst, 0).blanks, 1);
  assert.deepEqual(fade(instantiate(ok(PERCENT), 1)!, 2), { shown: [], blanks: 0 });
});

test("a flawed solution goes wrong at the mistake's step and stops at its answer", () => {
  const spec = ok(KINEMATICS);
  const inst = find(spec, (i) => i.params.u > 0);
  const { u, a, t } = inst.params;
  const k = inst.mistakes.findIndex((m) => m.label === "used a minus sign");
  const wrong = inst.mistakes[k].text;
  assert.deepEqual(flawedSolution(inst, k), {
    steps: ["Use v = u + at.", `v = ${u} − ${a} × ${t}`, `So the answer is ${wrong}.`],
    wrongStep: 2,
    label: "used a minus sign",
  });
  const j = inst.mistakes.findIndex((m) => m.label === "forgot the starting speed");
  const f = flawedSolution(inst, j)!;
  assert.equal(f.wrongStep, 3);
  assert.deepEqual(f.steps, [...inst.steps, `So the answer is ${inst.mistakes[j].text}.`], "without says the step is shown as written");
  assert.equal(flawedSolution(inst, inst.mistakes.length), null);
  assert.equal(flawedSolution(inst, -1), null);
  assert.equal(flawedSolution(instantiate(ok(PERCENT), 1)!, 0), null, "no steps, no flawed solution");
  const q = ok(QUADRATIC);
  const qi = find(q, (i) => i.mistakes.length > 0);
  assert.equal(flawedSolution(qi, 0)!.steps[1], `x = (-(${qi.params.b}) + sqrt(${qi.steps[0].match(/is (.*)\.$/)![1]})) / ${qi.params.a}`);
});

test("paired cases differ in one parameter and in the answer", () => {
  for (const raw of [KINEMATICS, PERCENT, QUADRATIC]) {
    const spec = ok(raw);
    for (let seed = 1; seed <= 20; seed++) {
      const pair = pairedCases(spec, seed);
      assert.ok(pair, `seed ${seed}`);
      const [x, y] = pair;
      const changed = Object.keys(x.params).filter((n) => x.params[n] !== y.params[n]);
      assert.equal(changed.length, 1);
      assert.notEqual(x.answerText, y.answerText);
      assert.deepEqual(x, instantiate(spec, seed));
      assert.deepEqual(pairedCases(spec, seed), pair, "the same seed gives the same pair");
    }
  }
  const q = ok(QUADRATIC);
  for (let seed = 1; seed <= 20; seed++) {
    const [, y] = pairedCases(q, seed)!;
    assert.ok(y.params.b ** 2 - 4 * y.params.a * y.params.c >= 0 && y.params.a !== 0, "the changed case still meets the conditions");
  }
  assert.equal(pairedCases(fixed({ x: 2 }, "x"), 1), null, "nothing can change");
});

test("literal braces, choices and computed values in templates", () => {
  const spec = fixed({ u: 5 }, "u/2", { template: "Find $\\frac{{{u}}}{{2}}$, which is {=u/2}." });
  assert.equal(instantiate(spec, 1)!.question, "Find $\\frac{5}{2}$, which is 2.5.");
  const neg = fixed({ c: -3 }, "c", { template: "x + {c} = 0" });
  assert.equal(instantiate(neg, 1)!.question, "x + -3 = 0");
});

test("variant ids carry the question and the seed", () => {
  assert.equal(variantId("Q3", 17), "Q3~17");
  assert.deepEqual(parseVariantId(variantId("Q3", 17)), { base: "Q3", seed: 17 });
  assert.deepEqual(parseVariantId("a~b~5"), { base: "a~b", seed: 5 });
  assert.deepEqual(parseVariantId(variantId("Q1", 2 ** 31 - 1)), { base: "Q1", seed: 2 ** 31 - 1 });
  for (const id of ["Q3", "Q3~", "~5", "Q3~0", "Q3~-1", "Q3~1.5", "Q3~07", "Q3~2147483648", "Q3~5x"]) assert.equal(parseVariantId(id), null, id);
});

test("task ids: one reader for questions, new numbers, repair tasks and faded examples", async () => {
  const { parseTaskId, taskId, baseQuestionId } = await import("../src/families");
  assert.deepEqual(parseTaskId("Q3"), { base: "Q3", seed: null, kind: "question", k: 0 });
  for (const [kind, k] of [["variant", 0], ["fix", 1], ["fade", 2]] as const) {
    const id = taskId("Q3", 17, kind, k);
    assert.deepEqual(parseTaskId(id), { base: "Q3", seed: 17, kind, k });
    assert.equal(baseQuestionId(id), "Q3");
  }
  assert.equal(taskId("Q3", 17), "Q3~17");
  for (const bad of ["Q3#fix0", "Q3~0", "Q3~17#fix", "Q3~17#mend1", "Q3~17#fix0#fade1", ""]) assert.equal(parseTaskId(bad), null, bad);
  assert.equal(baseQuestionId("q-tutor-7"), "q-tutor-7", "any other id is itself");
});
