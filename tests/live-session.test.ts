// A representative study session against the real Claude CLI, for the 0.5.1 learning rules:
// Learn mode with a hint, a confident wrong answer and a revealed answer; a restart part-way;
// Adaptive mode with code-marked bank questions; a disputed grading and its regrade; and a
// prerequisite in another topic. It prints what was recorded and how much of each prompt was
// read from the cache. It spends usage, so it is not part of `npm test`.
// Run with `npm run test:session`.

import { Engine, EngineSettings, TurnResult } from "../src/engine";
import { Store } from "../src/store";
import { usageLine, Usage } from "../src/claude";
import { sessionFor } from "../src/session";
import { mcqLetter, parseChat } from "../src/formats";
import { MemFS } from "./memfs";

const settings: EngineSettings = { claudePath: "", chatModel: "sonnet", compileModel: "sonnet", utilityModel: "haiku", effort: "low", targetLevel: 4, maxChatWords: 4000, maxTopicWords: 2000, singlePassWords: 6000, smartRouting: true, hardEffort: "high", bankQuiz: true, codePlacement: true };

const CALCULUS = `## Overview
Differentiating polynomials and composite functions, for a first-year calculus course.

## Subskills

### 1. Power rule
prerequisites: none
- $\\frac{d}{dx} x^n = n x^{n-1}$ for any real $n$.
- Constants differentiate to 0, and the derivative of a sum is the sum of the derivatives.
misconceptions:
- The power is multiplied in but not reduced, giving $3x^3$ for $x^3$.

### 2. Chain rule
prerequisites: 1
- $\\frac{d}{dx} f(g(x)) = f'(g(x))\\,g'(x)$.
- Differentiate the outer function, keep the inside, then multiply by the derivative of the inside.
misconceptions:
- Forgetting to multiply by the derivative of the inside.

### 3. Product rule
prerequisites: 1
- $(uv)' = u'v + uv'$.
misconceptions:
- $(uv)' = u'v'$.
`;

const CALC_QUESTIONS = `### Q1
subskill: 1
type: short
question: Differentiate $x^5$.
answer: 5x^4
explanation: Bring the power down and reduce it by one.

### Q2
subskill: 1
type: mcq
question: What is the derivative of $7$?
options:
- A. 7
- B. 1
- C. 0
- D. 7x
answer: C
explanation: A constant does not change, so its rate of change is 0.

### Q3
subskill: 1
type: short
question: Differentiate $x^3 + 4x$.
answer: 3x^2 + 4
explanation: Differentiate term by term.

### Q4
subskill: 2
type: short
question: Differentiate $(2x+1)^3$.
answer: 6(2x+1)^2
explanation: Outer derivative $3(2x+1)^2$ times inner derivative 2.

### Q5
subskill: 2
type: mcq
question: Which is $\\frac{d}{dx}\\sin(x^2)$?
options:
- A. $\\cos(x^2)$
- B. $2x\\cos(x^2)$
- C. $\\cos(2x)$
- D. $2\\cos(x)$
answer: B
explanation: Multiply by the derivative of the inside, $2x$.

### Q6
subskill: 3
type: short
question: Differentiate $x\\,e^x$.
answer: e^x + x e^x
explanation: $u'v + uv'$ with $u = x$, $v = e^x$.
`;

const ALGEBRA = `## Overview
Index laws, as needed for calculus.

## Subskills

### 1. Index laws
prerequisites: none
- $a^m a^n = a^{m+n}$, $(a^m)^n = a^{mn}$, $a^{-n} = 1/a^n$, $a^{1/n} = \\sqrt[n]{a}$.
misconceptions:
- $a^m a^n = a^{mn}$.
`;

const ALG_QUESTIONS = `### Q1
subskill: 1
type: short
question: Simplify $x^2 \\cdot x^3$.
answer: x^5
explanation: Add the indices.
`;

const zero = (): Usage => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0, calls: 0 });
const add = (a: Usage, b: Usage): Usage => ({ input: a.input + b.input, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, output: a.output + b.output, costUsd: a.costUsd + b.costUsd, calls: a.calls + b.calls });
/** Share of the prompt that was read from the cache: cache reads over everything sent. */
const cacheShare = (u: Usage): string => {
  const sent = u.input + u.cacheRead + u.cacheWrite;
  return sent ? `${Math.round((100 * u.cacheRead) / sent)}% of ${sent} prompt tokens from cache` : "no prompt";
};
const turns: { label: string; usage: Usage; local: boolean }[] = [];
let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
};

async function main() {
  const fs = new MemFS();
  let store = new Store(fs, "Tutor");
  let engine = new Engine(store, () => settings);
  await store.installSkills();

  const calc = await store.saveCompiled({ title: "Differentiation", fm: { source: "spec", subject: "maths", kind: "spec", goal: "first-year calculus" }, topicBody: CALCULUS, questionsBody: CALC_QUESTIONS, target: 4 });
  const alg = await store.saveCompiled({ title: "Algebra", fm: { source: "spec", subject: "maths", kind: "spec", goal: "first-year calculus" }, topicBody: ALGEBRA, questionsBody: ALG_QUESTIONS, target: 4 });
  const course = await store.loadCourse();
  const id = (suffix: string) => [...course.concepts.keys()].find((k) => k.endsWith(suffix))!;
  await store.addRelation({ from: id("/power-rule"), to: id("/index-laws"), type: "requires", status: "reviewed", source: "live session" });
  console.log(`Topics: ${calc}, ${alg}; Power rule requires ${id("/index-laws")}`);

  const run = async (label: string, chatPath: string, message: string, confidence: number | null = null): Promise<TurnResult> => {
    const r = await engine.study(calc, chatPath, message, { confidence });
    turns.push({ label, usage: r.usage, local: !!r.local });
    console.log(`\n> ${label}\n  YOU: ${message || "(start)"}${confidence !== null ? ` [confidence ${Math.round(confidence * 100)}%]` : ""}`);
    console.log(`  TUTOR: ${r.reply.replace(/\s+/g, " ").slice(0, 260)}${r.reply.length > 260 ? "…" : ""}`);
    if (r.decision) console.log(`  policy: ${r.decision.action}${r.decision.focus !== null ? ` on ${r.decision.focus}` : ""} (${r.decision.reason.slice(0, 140)})`);
    if (r.attempt) console.log(`  attempt: ${r.attempt.result} · grading ${r.attempt.grading} · ${r.attempt.verification} · assisted ${r.attempt.assisted} · exposed ${r.attempt.answerExposed} · confidence ${r.attempt.confidence ?? "none"} · error ${r.attempt.errorType || "-"}`);
    if (r.changes.length) console.log(`  changes: ${r.changes.join("; ")}`);
    console.log(`  ${r.local ? "no model call" : `${usageLine(r.usage)} · ${cacheShare(r.usage)} · $${r.usage.costUsd.toFixed(4)}`}`);
    return r;
  };
  const record = async (chatPath: string) => sessionFor(parseChat(await fs.read(chatPath)), await store.loadState(calc, 4), "teach");

  // ----- 1. Learn mode -----
  console.log("\n=== 1. Learn mode: lesson, hint, confident wrong answer, reveal ===");
  let learn = await store.newChat(calc, "Differentiation", "teach");
  const l1 = await run("Learn opens", learn, "");
  check(!l1.attempt, "opening a lesson records no attempt");
  let rec = await record(learn);
  console.log(`  pending question: ${rec.pendingQuestion.replace(/\s+/g, " ").slice(0, 160) || "(none)"}`);
  check(!!rec.pendingQuestion, "the lesson leaves a question open");

  await run("Hint", learn, "Can I have a hint?");
  rec = await record(learn);
  check(rec.helpGiven.length > 0, `help is recorded for the open question (${rec.helpGiven.length} item(s))`);

  const wrong = await run("Confident wrong answer", learn, "I'm sure it's 3x^3, you just multiply by the power.", 0.9);
  const levelAfterWrong = (await store.loadState(calc, 4)).levels;
  check(!!wrong.attempt, "the answer is recorded as an attempt");
  if (wrong.attempt) {
    check(wrong.attempt.confidence === 0.9, "the stated confidence is stored with the attempt");
    check(wrong.attempt.assisted, "the attempt is marked as helped, because a hint was given first");
  }
  console.log(`  levels after wrong answer: ${JSON.stringify(levelAfterWrong)}`);

  await run("Reveal", learn, "Just tell me the answer");
  rec = await record(learn);
  console.log(`  answer exposed: ${rec.answerExposed}; pending: ${rec.pendingQuestion.replace(/\s+/g, " ").slice(0, 100) || "(none)"}`);

  // ----- 2. Restart -----
  console.log("\n=== 2. Restart: a fresh engine over the same files ===");
  const beforeRestart = await record(learn);
  store = new Store(fs, "Tutor");
  engine = new Engine(store, () => settings);
  const afterRestart = await record(learn);
  check(afterRestart.pendingQuestion === beforeRestart.pendingQuestion, "the open question survives the restart unchanged");
  check(JSON.stringify(afterRestart.helpGiven) === JSON.stringify(beforeRestart.helpGiven), "help given survives the restart");
  const resumed = await run("Answer after restart", learn, "It's 3x^2: bring the 3 down and take one off the power.", 0.6);
  if (resumed.attempt) console.log(`  independent? assisted ${resumed.attempt.assisted}, exposed ${resumed.attempt.answerExposed}`);

  // ----- 3. Adaptive -----
  console.log("\n=== 3. Adaptive: the guide picks, bank answers marked by code ===");
  const auto = await store.newChat(calc, "Differentiation", "auto", new Date(Date.now() + 60000));
  let a = await run("Adaptive opens", auto, "");
  const bank = await store.loadQuestions(calc);
  const cardOf = async () => {
    const card = (await fs.read(auto)).match(/^card: (\S+)$/m)?.[1];
    return bank.find((x) => x.id === card);
  };
  if (!(await cardOf()) && a.decision?.action === "diagnose-prerequisite") {
    // The opening check is on Algebra's index laws: its answer must be filed there, not here.
    const before = (await store.loadState(calc, 4)).attempts.length;
    a = await run("Skip the prerequisite check", auto, "I don't know");
    check((await store.loadState(calc, 4)).attempts.length === before, "the prerequisite check's answer is not recorded against Differentiation");
    check(!!a.attempt && a.attempt.concept === id("/index-laws"), `it is recorded against ${a.attempt?.concept || "nothing"}`);
    if (!(await cardOf())) a = await run("Adaptive continues", auto, "");
  }
  for (let i = 0; i < 4; i++) {
    const q = await cardOf();
    if (!q) break;
    // Two right, then a wrong one with high confidence, then right again.
    const right = i !== 2;
    const answer = q.type === "mcq" ? (right ? mcqLetter(q.answer) : mcqLetter(q.answer) === "A" ? "B" : "A") : right ? q.answer : "x^5";
    a = await run(`Adaptive answer ${i + 1} (${q.id}, ${right ? "right" : "wrong"})`, auto, answer, right ? 0.7 : 0.95);
    if (a.attempt) check(a.attempt.grading === "deterministic" || a.attempt.grading === "symbolic" || a.attempt.grading === "numeric", `bank answer marked by code (${a.attempt.grading})`);
  }

  // ----- 4. Dispute -----
  console.log("\n=== 4. Dispute a model-marked answer, then regrade ===");
  const state = await store.loadState(calc, 4);
  const disputable = [...state.attempts].reverse().find((x) => x.grading === "model");
  if (disputable) {
    const d = await engine.dispute(calc, disputable.id, learn);
    const after = (await store.loadState(calc, 4)).attempts.find((x) => x.id === disputable.id)!;
    check(after.verification === "disputed", `the attempt is held as disputed (${d.changes.join("; ") || "no level change"})`);
    if (/^Q\d+$/.test(disputable.questionId)) {
      const g = await engine.regrade(calc, disputable.id);
      turns.push({ label: "Regrade", usage: g.usage, local: false });
      console.log(`  regrade: ${g.attempt.result} · ${g.attempt.verification} · ${g.changes.join("; ") || "no level change"} · ${usageLine(g.usage)}`);
    } else {
      // Marked in conversation: the tutor looks again on the next message, and adds no new mark.
      const before = (await store.loadState(calc, 4)).attempts.length;
      const again = await run("Tutor looks again at the disputed mark", learn, "I think my last answer was marked wrongly, can you check it again?");
      check((await store.loadState(calc, 4)).attempts.length === before && !again.attempt, "the re-check records no new attempt");
      check(!(await record(learn)).disputed, "the dispute is cleared once the tutor has looked again");
    }
  } else console.log("  no model-marked attempt to dispute in this run");

  // ----- 5. Cross-topic prerequisite -----
  console.log("\n=== 5. A weak prerequisite in another topic ===");
  const ext = await store.externalPrereqs(calc, 4);
  console.log(`  external prerequisites: ${ext.map((e) => JSON.stringify(e)).join(" ") || "none"}`);
  check(ext.length > 0, "Algebra's index laws are known as a prerequisite of the power rule");
  const advice = await engine.advise(calc, 1);
  console.log(`  advice for Power rule: ${advice.action} — ${advice.reason}`);

  // ----- what was kept -----
  console.log("\n=== Evidence kept ===");
  const final = await store.loadState(calc, 4);
  for (const x of final.attempts) console.log(`  ${x.timestamp.slice(11, 19)} skill ${x.skill} ${x.result} · ${x.grading}/${x.verification} · assisted ${x.assisted} · exposed ${x.answerExposed} · conf ${x.confidence ?? "-"} · ${x.activity}`);
  for (const c of final.changes) console.log(`  level change: skill ${c.skill} ${c.from} → ${c.to} (${c.cause})`);
  const sessionsDir = (await fs.list(`${calc}/sessions`).catch(() => ({ files: [] as string[] }))).files;
  console.log(`  session notes: ${sessionsDir.join(", ") || "none"}`);

  console.log("\n=== Usage ===");
  let model = zero();
  for (const t of turns) if (!t.local) model = add(model, t.usage);
  const local = turns.filter((t) => t.local).length;
  console.log(`  ${turns.length} turns, ${local} answered by plain code with no model call`);
  console.log(`  model turns: ${usageLine(model)} · ${cacheShare(model)} · $${model.costUsd.toFixed(4)}`);
  const warm = turns.filter((t) => !t.local).slice(1);
  let warmU = zero();
  for (const t of warm) warmU = add(warmU, t.usage);
  console.log(`  after the first model turn: ${cacheShare(warmU)}`);
  console.log(failures ? `\nSESSION TEST: ${failures} check(s) failed` : "\nSESSION TEST PASSED");
  if (failures) process.exit(1);
}

main().catch((e) => {
  console.error("SESSION TEST FAILED:", e);
  process.exit(1);
});
