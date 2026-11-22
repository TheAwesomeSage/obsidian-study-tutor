// One learner's journey through the features of the question-to-course work, driven through the same
// engine entry points the app calls: Ask anything, growing the question into a course, the outcome the
// course plans back from, a task in parts (code, the plotter's own marking, the grader, the assessor),
// diagnosis of a wrong answer, a bridge from another topic, the outcome check, and time to independence.
//
// It runs against whatever `engine.call` is: scripted fixtures in `npm test` (journey.test.ts), or the
// real configured provider in `npm run test:journey-live`. Each step records which of the three did
// the work: code (no model call), fixture or real. The checks are about what was recorded, so they
// hold for a real model's wording as well as a fixture's.

import { Engine } from "../src/engine";
import { Store } from "../src/store";
import { askCourseSeed } from "../src/engine-ask";
import { outcomeTask } from "../src/engine-assess";
import { installExample } from "../src/examples";
import { summariseMetrics } from "../src/metrics";
import type { CallResult } from "../src/claude";

export type Provider = "fixture" | "real";

export interface JourneyRow {
  slice: string;
  step: string;
  entry: string;
  /** Who did the work: plain code (no model call this step), scripted fixtures, or a real provider. */
  by: "code" | Provider;
  calls: number;
  /** The model each call asked for, and in brackets the one that answered when the CLI named it. */
  models: string[];
  tokens: number;
  costUsd: number;
  ok: boolean;
  detail: string;
}

/** A small topic whose one concept has the same structure as the signals course's time constant. */
export const DECAY_TOPIC = [
  "# Radioactive decay", "", "## Overview", "How an unstable sample decays, and what its half-life means.", "",
  "## Subskills", "", "### 1. Half-life and the decay constant", "prerequisites: none", "structure: first-order-decay",
  "- The number of undecayed nuclei falls as N(t) = N0 e^{−λt}: the decay rate is proportional to what is left.",
  "- The half-life is ln 2 / λ, the time for half of what is left to decay, whatever is left.", "",
].join("\n");

export const ANSWERS = {
  question: "Teach me how an RC filter responds to a step, well enough to explain a scope trace",
  predict: "0, 1, 0.63",
  derive: "V_in(s) = 1/s and H(s) = 1/(1 + s), so V(s) = 1/(s(s + 1)) = 1/s − 1/(s + 1) by partial fractions. Inverting each term:\nv(t) = 1 - exp(-t)",
  explain: "The electrolytic capacitor can be 20% above its marked value, and the source's output resistance adds to R; both lengthen the time constant. I would measure C with a meter. SymPy checked only the ideal final expression, not my derivation or whether the model fits this circuit.",
  wrong: "It reaches its final value after one time constant, so v(τ) = 1 V.",
  bridge: "The voltage still to go across the capacitor plays the part of the undecayed nuclei: both fall by the same fraction in each equal interval, so RC is like the mean life and the time to fall halfway is RC ln 2. The comparison breaks if the input stops being a fixed step.",
  outcome: "At t = 0 the output is 0 because the capacitor's voltage cannot jump; it settles at the 1 V input; at t = τ = RC it is 1 − e^{−1} ≈ 0.63 V. The initial slope is 1/τ. From V(s) = 1/(s(1 + sτ)) = 1/s − τ/(1 + sτ), v(t) = 1 − e^{−t/τ}. A real circuit is slower when C or R is above its marked value or the source adds resistance.",
};

/**
 * Runs the journey on an engine whose store is empty. `provider` names what `engine.call` is. The
 * engine's visual modules must be set (the plotter part needs them).
 */
export async function runJourney(engine: Engine, store: Store, provider: Provider): Promise<JourneyRow[]> {
  const rows: JourneyRow[] = [];
  const seen: { model: string; tokens: number; cost: number }[] = [];
  const inner = engine.call.bind(engine);
  engine.call = async (o, s) => {
    const r: CallResult = await inner(o, s);
    seen.push({ model: `${o.model || "default"}${r.model && r.model !== o.model ? ` (${r.model})` : ""}`, tokens: (r.usage?.input ?? 0) + (r.usage?.cacheRead ?? 0) + (r.usage?.cacheWrite ?? 0) + (r.usage?.output ?? 0), cost: r.usage?.costUsd ?? 0 });
    return r;
  };
  const step = async (slice: string, name: string, entry: string, run: () => Promise<{ ok: boolean; detail: string }>): Promise<void> => {
    const from = seen.length;
    let out: { ok: boolean; detail: string };
    try {
      out = await run();
    } catch (e) {
      out = { ok: false, detail: `threw: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
    }
    const mine = seen.slice(from);
    rows.push({ slice, step: name, entry, by: mine.length ? provider : "code", calls: mine.length, models: [...new Set(mine.map((x) => x.model))], tokens: mine.reduce((s, x) => s + x.tokens, 0), costUsd: mine.reduce((s, x) => s + x.cost, 0), ok: out.ok, detail: out.detail });
  };
  const target = engine.settings().targetLevel;
  await store.installSkills();

  // 1–2. Ask anything, then grow the question into a course.
  let askPath = "";
  await step("1", "Ask anything", "engine.startAsk, engine.askTurn", async () => {
    askPath = await engine.startAsk(ANSWERS.question);
    const r = await engine.askTurn(askPath, ANSWERS.question, {});
    const chat = await store.loadChat(askPath);
    return { ok: !!r.reply.trim() && chat.fm.mode === "ask" && (await store.listTopics()).length === 0, detail: `kind ${r.kind || "(none)"}; goal "${String(chat.fm.goal ?? "").slice(0, 60)}"; no topic made` };
  });
  let dir = "";
  await step("2", "Grow the question into a course", "askCourseSeed, installExample, engine.linkAskCourse", async () => {
    const seed = askCourseSeed(await store.loadChat(askPath));
    // The journey uses the hand-written signals course in place of compiling one: compiling is
    // covered by compiler.test.ts (fixtures) and test:compile-live (real), and spends the most.
    dir = (await installExample(store, "signals-systems", target)).dir;
    await engine.linkAskCourse(askPath, dir);
    const linked = (await store.loadChat(askPath)).fm.course;
    return { ok: !!seed.goal && linked === dir, detail: `seed goal "${seed.goal.slice(0, 60)}…"; linked to ${dir}; course installed, not compiled` };
  });
  await step("3", "Plan backwards from the outcome", "parseTopic → outcomeTask", async () => {
    const o = outcomeTask((await store.loadTopic(dir)).outcome);
    return { ok: !!o && o.criteria.length >= 3, detail: o ? `task "${o.task.slice(0, 60)}…", ${o.criteria.length} criteria` : "no outcome" };
  });

  // 6–7. The task in parts, in a Practise chat, as the learner would answer it.
  const questions = await store.loadQuestions(dir);
  const parts = questions.filter((q) => q.part?.task === "rc-step").sort((a, b) => a.part!.n - b.part!.n);
  const quiz = await store.newChat(dir, "Signals and systems", "quiz");
  const qc = await store.loadChat(quiz);
  qc.fm.card = parts[0]?.id ?? "";
  await store.saveChat(quiz, qc);
  let activityId = "";
  let settings: unknown = null;
  await step("6–7", "Part 1: predict, marked by code", "engine.study (Practise)", async () => {
    const r = await engine.study(dir, quiz, ANSWERS.predict);
    activityId = r.presentation?.activity?.id ?? "";
    settings = r.presentation?.lesson?.settings ?? null;
    return { ok: r.attempt?.result === "correct" && r.attempt.grading === "deterministic" && !!activityId, detail: `${r.attempt?.result} by ${r.attempt?.grading}; the plotter opened for part 2: ${!!activityId}` };
  });
  await step("7", "Part 2: the plotter, marked by its own code", "engine.recordActivityResult", async () => {
    const m = await engine.recordActivityResult(dir, activityId, { answer: 1, settings }, { chatPath: quiz });
    return { ok: m.attempt?.result === "correct" && m.advanced === true && m.attempt.questionId === parts[1].id, detail: `${m.attempt?.result}, counted as part 2 and helped (${m.attempt?.assisted}); chat moved on: ${m.advanced}` };
  });
  await step("6–7", "Part 3: derive, marked by the grader", "engine.study (Practise)", async () => {
    const r = await engine.study(dir, quiz, ANSWERS.derive);
    const a = r.attempt;
    return { ok: !!a && a.questionId === parts[2].id && a.result !== "ungraded" && a.grading === "model", detail: `${a?.result} by ${a?.grading}${engine.maths ? "" : "; SymPy not loaded in this run, so the final line is judged by the grader and the record says so"}` };
  });
  await step("6–7", "Part 4: explain, marked by the separate assessor", "engine.study (Practise)", async () => {
    const r = await engine.study(dir, quiz, ANSWERS.explain);
    const a = r.attempt;
    return { ok: !!a && a.questionId === parts[3].id && a.taskType === "explanation" && a.result !== "ungraded", detail: `${a?.result}; task ${a?.taskType}` };
  });

  // 5. Diagnose then teach: a wrong answer in a Master chat is diagnosed in code from the mark.
  await step("5", "Diagnose a wrong answer, then teach to its cause", "engine.study (Master) ×2", async () => {
    const st = await store.loadState(dir, target);
    st.focus = 3;
    await store.saveState(dir, st);
    const chat = await store.newChat(dir, "Signals and systems", "tutor");
    await engine.study(dir, chat, "");
    const r = await engine.study(dir, chat, ANSWERS.wrong);
    return { ok: r.attempt?.result === "incorrect" && !!r.move, detail: `marked ${r.attempt?.result ?? "(no mark)"}; next move chosen in code: ${r.move ? `${r.move.move} (${r.move.reason})` : "none"}` };
  });

  // 8. A bridge from the time constant, which the learner now holds, to radioactive decay.
  let decay = "";
  await step("8", "Bridge from another topic with the same structure", "engine.study (Adaptive) ×2", async () => {
    decay = await store.saveCompiled({ title: "Radioactive decay", fm: { subject: "none" }, topicBody: DECAY_TOPIC, questionsBody: "", target });
    // The time constant is set as held, as if the learner had reached it earlier: a bridge builds only from that.
    const st = await store.loadState(dir, target);
    st.levels[3] = 3;
    await store.saveState(dir, st);
    const chat = await store.newChat(decay, "Radioactive decay", "auto");
    const ask = await engine.study(decay, chat, "");
    if (ask.decision?.action !== "bridge") return { ok: false, detail: `no bridge was set (${ask.decision?.action ?? "no decision"})` };
    const r = await engine.study(decay, chat, ANSWERS.bridge);
    return { ok: !!r.attempt?.transferFrom && r.attempt.taskType === "transfer" && !r.attempt.assisted, detail: `asked by code; marked ${r.attempt?.result} by the assessor; from ${r.attempt?.transferFrom}; time constant seeded at level 3` };
  });

  // 4. The outcome check, marked by the assessor, logged apart.
  await step("4", "Outcome check", "engine.startAssessment, engine.study ×2", async () => {
    const path = await engine.startAssessment(dir);
    if (!path) return { ok: false, detail: "no outcome check could start" };
    await engine.study(dir, path, ANSWERS.outcome);
    const r = await engine.study(dir, path, "mark");
    const log = await store.loadAssessments(dir);
    return { ok: log.length === 1 && /Outcome check marked/.test(r.reply), detail: log[0] ? `${log[0].criteria.filter((c) => c.verdict === "met").length} of ${log[0].criteria.length} criteria met; logged apart, no level moved` : "nothing logged" };
  });

  await step("9", "Time to independence, from the records", "summariseMetrics", async () => {
    const attempts = { [dir]: (await store.loadState(dir, target)).attempts, [decay]: (await store.loadState(decay, target)).attempts };
    const s = summariseMetrics({ packages: [], attempts, assessments: await store.loadAssessments(dir) });
    return { ok: s.independence.concepts >= 2 && s.kinds.bridges === 1 && s.kinds.outcomeChecks === 1, detail: `${s.independence.concepts} concepts with answers, ${s.independence.reached} reached unaided success; ${s.kinds.bridges} bridge, ${s.kinds.outcomeChecks} outcome check` };
  });
  engine.call = inner;
  return rows;
}

/** The rows as a markdown report that says, for every step, what did the work. */
export function journeyReport(rows: JourneyRow[], provider: Provider, about: string): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const passed = rows.filter((r) => r.ok).length;
  return [
    `# Journey verification (${provider === "real" ? "real provider" : "fixtures"})`,
    "",
    about,
    "",
    `${passed} of ${rows.length} steps passed. "By" is who did the work in that step: code (no model call), fixture (a scripted reply) or real (the configured provider). A step marked fixture proves the code path, not the model's judgement.`,
    "",
    "| Slice | Step | Entry point | By | Calls | Models | Tokens | Cost (USD) | Result | Detail |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.slice} | ${esc(r.step)} | ${esc(r.entry)} | ${r.by} | ${r.calls} | ${esc(r.models.join(", ") || "-")} | ${r.tokens} | ${r.costUsd ? r.costUsd.toFixed(4) : "-"} | ${r.ok ? "pass" : "FAIL"} | ${esc(r.detail)} |`),
    "",
  ].join("\n");
}
