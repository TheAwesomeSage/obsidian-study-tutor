// Regression tests for the gaps found in the 0.5.0 audit: how evidence is recorded and what it
// may support, how the session record survives, how the policy dispatches, and how data migrates.
// The model is stubbed throughout; nothing here costs tokens.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as F from "../src/formats";
import { Attempt, checkDue, missingFor, normaliseAttempt, recordAttempt, skillEvidence, supportedLevel } from "../src/evidence";
import { classifyChange, conceptRevisions, materialText, traceAttempt, versionObjectives } from "../src/objective-version";
import { digest } from "../src/compile-sources";
import { effectivePrereqs, parseTopicGraph, syncTopicGraph, wouldCycle } from "../src/course";
import { DEFAULT_WEIGHTS, LEARN_ACTIONS, PolicyInput, SkillInput, V1_WEIGHTS, decide, replay, scoreSkills } from "../src/policy";
import { openQuestion, readIntent, readSessionReply, sessionFor } from "../src/session";
import { Engine, applyAttempt, bestExcerpts } from "../src/engine";
import { Store } from "../src/store";
import { ToolRegistry } from "../src/tools";
import { MemFS } from "./memfs";

const CARD = (names: [string, string][], extra: Record<number, string> = {}) =>
  ["# Calculus", "", "## Overview", "Rates of change.", "", "## Subskills", "", ...names.flatMap(([name, pre], i) => [`### ${i + 1}. ${name}`, `prerequisites: ${pre}`, ...(extra[i + 1] ? [extra[i + 1]] : []), `- A key claim about ${name} ([[Calc notes]]).`, ""])].join("\n");

const BANK = `### Q1
subskill: 1
type: mcq
question: What is the limit of 1/x as x grows?
options:
- A. 1
- B. 0
answer: B
explanation: The terms shrink.

### Q2
subskill: 2
type: short
question: Differentiate $x^2$.
answer: 2x
explanation: Power rule.

### Q3
subskill: 2
type: short
question: Differentiate $x^3$.
answer: 3x^2
explanation: Power rule.

### Q4
subskill: 2
type: open
question: Why does the power rule work?
answer: From the binomial expansion of the difference quotient.
explanation: Uses the limit definition.

### Q5
subskill: 3
type: mcq
question: Which rule differentiates a composition?
options:
- A. Product rule
- B. Chain rule
answer: B
explanation: Compositions use the chain rule.
`;

const NAMES: [string, string][] = [
  ["Limits", "none"],
  ["Derivatives", "1"],
  ["Chain rule", "2"],
];

const usage = { input: 10, cacheRead: 0, cacheWrite: 0, output: 10, costUsd: 0, calls: 1 };

async function setup(opts: { today?: () => string; settings?: Record<string, unknown> } = {}) {
  const fs = new MemFS();
  let day = "2026-11-13";
  const today = opts.today ?? (() => day);
  const store = new Store(fs, "Tutor", today);
  const settings: any = { claudePath: "", chatModel: "sonnet", compileModel: "sonnet", utilityModel: "haiku", effort: "low", targetLevel: 4, maxChatWords: 600, maxTopicWords: 2000, singlePassWords: 6000, smartRouting: false, hardEffort: "high", bankQuiz: true, codePlacement: true, ...(opts.settings ?? {}) };
  const engine = new Engine(store, () => settings, today);
  const dir = await store.saveCompiled({ title: "Calculus", fm: { subject: "none" }, topicBody: CARD(NAMES), questionsBody: BANK, target: 4 });
  const calls: any[] = [];
  const replies: (string | Error | ((o: any) => string))[] = [];
  (engine as any).call = async (o: any) => {
    calls.push(o);
    const next = replies.shift();
    if (next instanceof Error) throw next;
    if (o.jsonSchema) return { text: "", structured: JSON.parse(typeof next === "function" ? next(o) : next ?? '{"grade":"good","feedback":""}'), usage };
    return { text: typeof next === "function" ? next(o) : next ?? "ok", usage };
  };
  const chatIn = (mode: F.Mode, at = new Date(2026, 10, 13, 9, 0)) => store.newChat(dir, "Calculus", mode, at);
  return { fs, store, engine, dir, calls, replies, settings, chatIn, setDay: (d: string) => (day = d) };
}

const attempt = (over: Partial<Attempt> & { id: string }): Attempt => ({
  v: 2, skill: 1, concept: "calculus/limits", questionId: `q-${over.id}`, question: `question ${over.id}`, answer: "an answer", activity: "independent-practice", mode: "auto", difficulty: null,
  result: "correct", errorType: "", note: "", confidence: null, assisted: false, assistance: [], answerExposed: false, transfer: false, seconds: null,
  timestamp: "2026-11-10T10:00:00.000Z", grading: "deterministic", verification: "verified", assumptions: "", ...over,
});

const session = (text: string) => `<session>${text}</session>`;

// ---------- evidence: what counts, and what it may support ----------

test("a retried turn is one attempt, and a same-day repeat of a question is not a second success", () => {
  let attempts = recordAttempt([], attempt({ id: "a" }));
  attempts = recordAttempt(attempts, attempt({ id: "a" }));
  assert.equal(attempts.length, 1, "the same id replaces the record");
  // The same question answered again the same day: the answer was already marked in front of the learner.
  attempts = recordAttempt(attempts, attempt({ id: "b", questionId: "q-a", timestamp: "2026-11-10T10:05:00.000Z" }));
  let e = skillEvidence(attempts, 1);
  assert.deepEqual([e.graded, e.independent, e.independentCorrect], [2, 1, 1]);
  // Wrong, shown the answer, then right a minute later: no independent success at all.
  const shown = [attempt({ id: "c", questionId: "q9", result: "incorrect" }), attempt({ id: "d", questionId: "q9", timestamp: "2026-11-10T10:01:00.000Z" })];
  e = skillEvidence(shown, 1);
  assert.deepEqual([e.independent, e.independentCorrect, e.correctAny], [1, 0, 1], "it still counts as a correct answer with the answer known");
  // The same question on a later day is delayed retrieval, and counts.
  e = skillEvidence([...shown, attempt({ id: "e", questionId: "q9", timestamp: "2026-11-12T10:00:00.000Z" })], 1);
  assert.equal(e.independentCorrect, 1);
});

test("help, a revealed answer and self-rating keep an answer out of independent evidence", () => {
  const helped = [
    attempt({ id: "1", assisted: true, assistance: ["hint: use the power rule"] }),
    attempt({ id: "2", answerExposed: true }),
    attempt({ id: "3", grading: "self", verification: "unverified", answerExposed: true }),
    attempt({ id: "4", result: "ungraded" }),
    attempt({ id: "5", verification: "disputed" }),
  ];
  const e = skillEvidence(helped, 1);
  assert.equal(e.independent, 0);
  assert.equal(e.correctAny, 2, "helped and revealed answers are correct answers, not independent ones; a self-rating is neither");
  assert.deepEqual([e.assistedCount, e.exposedCount, e.selfCount, e.ungraded, e.disputed], [1, 2, 1, 1, 1]);
  assert.equal(supportedLevel(e), 3, "two correct answers with help support 'can do with help' and no more");
  assert.equal(e.estimate, null, "no independent data, so no estimate is offered");
});

test("levels 4 and 5 need unaided work, a delayed transfer question and no recent failures; confidence changes nothing", () => {
  const base = [attempt({ id: "1", confidence: 1 }), attempt({ id: "2", confidence: 1 })];
  assert.equal(supportedLevel(skillEvidence(base, 1)), 3, "two unaided successes on one day, with full confidence, do not reach level 4");
  const same = [...base, attempt({ id: "3", transfer: true })];
  assert.equal(supportedLevel(skillEvidence(same, 1)), 3, "a transfer question on the same day is not a delayed one");
  const delayed = [...base, attempt({ id: "3", transfer: true, timestamp: "2026-11-12T10:00:00.000Z" })];
  const e = skillEvidence(delayed, 1);
  assert.equal(e.delayedTransfer, true);
  assert.equal(supportedLevel(e), 4, "three unaided successes over two days with a delayed transfer, but no teach-back or edge case");
  assert.match(missingFor(e, 5), /explanation good enough to teach from.*edge case.*3 earlier unaided answers were recorded before the kind of task was/);
  const taught = [...delayed, attempt({ id: "tb", taskType: "teach-back", timestamp: "2026-11-12T11:00:00.000Z" }), attempt({ id: "ec", taskType: "edge-case", timestamp: "2026-11-12T12:00:00.000Z" })];
  assert.equal(supportedLevel(skillEvidence(taught, 1)), 5, "with an unaided teach-back and an unaided edge case, level 5");
  const helpedTeach = [...delayed, attempt({ id: "tb", taskType: "teach-back", assisted: true, timestamp: "2026-11-12T11:00:00.000Z" }), attempt({ id: "ec", taskType: "edge-case", timestamp: "2026-11-12T12:00:00.000Z" })];
  assert.equal(supportedLevel(skillEvidence(helpedTeach, 1)), 4, "a helped teach-back does not count");
  const slipping = [...delayed, attempt({ id: "4", result: "incorrect", timestamp: "2026-11-13T10:00:00.000Z" })];
  assert.equal(supportedLevel(skillEvidence(slipping, 1)), 4, "one recent failure holds it at 4");
  const failing = [...slipping, attempt({ id: "5", result: "incorrect", timestamp: "2026-11-13T11:00:00.000Z" })];
  assert.equal(supportedLevel(skillEvidence(failing, 1)), 3, "two recent failures and level 4 is no longer supported");

  // The same history with and without stated confidence supports exactly the same level.
  const plain = delayed.map((a) => ({ ...a, confidence: null }));
  assert.equal(supportedLevel(skillEvidence(plain, 1)), supportedLevel(skillEvidence(delayed, 1)));
  // Confidence only feeds calibration, against a defined binary target.
  const cal = skillEvidence([attempt({ id: "1", confidence: 0.9 }), attempt({ id: "2", confidence: 0.9, result: "incorrect", timestamp: "2026-11-11T10:00:00.000Z" })], 1);
  assert.equal(cal.rated, 2);
  assert.ok(Math.abs(cal.brier! - 0.41) < 1e-9);
  assert.ok(Math.abs(cal.calibrationGap! - 0.4) < 1e-9, "overconfident by 40 points");
});

test("a model can raise a level only one step and only as far as the evidence reaches, and lower it only on a failed answer", () => {
  const topic = F.parseTopic(CARD(NAMES));
  const s = F.newState(topic, 4);
  s.levels[1] = 3;
  assert.deepEqual(F.applyStateUpdate(s, { levels: { "1": 4 } }), [], "no evidence, no promotion");
  s.attempts = [attempt({ id: "1" }), attempt({ id: "2" }), attempt({ id: "3", transfer: true, timestamp: "2026-11-12T10:00:00.000Z" })];
  assert.deepEqual(F.applyStateUpdate(s, { levels: { "1": 5 } }), [], "two steps at once is refused even when supported");
  assert.equal(F.applyStateUpdate(s, { levels: { "1": 4 } }).length, 1);
  assert.equal(s.levels[1], 4);
  assert.equal(s.changes.length, 1, "the change is logged with its cause");
  assert.deepEqual(F.applyStateUpdate(s, { levels: { "1": 3 } }), [], "no failed answer this turn, so no demotion");
  const right = attempt({ id: "9" });
  assert.deepEqual(F.applyStateUpdate(s, { levels: { "1": 3 } }, { attempt: right }), [], "a correct answer cannot be the reason for a demotion");
  const wrong = attempt({ id: "10", result: "incorrect" });
  assert.deepEqual(F.applyStateUpdate(s, { levels: { "1": 1 } }, { attempt: wrong }), [], "one failed answer lowers a level by one, not by three");
  assert.equal(F.applyStateUpdate(s, { levels: { "1": 3 } }, { attempt: wrong }).length, 1);
  assert.equal(s.changes[1].cause, "10");
  assert.deepEqual(F.applyStateUpdate(s, { levels: { "2": 2 } }, { levels: false }), [], "with levels off nothing moves");
});

test("answers move levels by the evidence rules, and a delayed lapse lowers one", () => {
  const s = F.newState(F.parseTopic(CARD(NAMES)), 4);
  const add = (a: Attempt) => {
    s.attempts = recordAttempt(s.attempts, a);
    return applyAttempt(s, a);
  };
  add(attempt({ id: "1", assisted: true }));
  assert.equal(s.levels[1], 2, "one correct answer with help: can follow along");
  add(attempt({ id: "2", assisted: true }));
  assert.equal(s.levels[1], 3, "two correct answers with help: can do with help");
  add(attempt({ id: "3", assisted: true }));
  add(attempt({ id: "4", assisted: true }));
  assert.equal(s.levels[1], 3, "any number of helped answers stops at 3");
  add(attempt({ id: "5", timestamp: "2026-11-11T10:00:00.000Z" }));
  add(attempt({ id: "6", timestamp: "2026-11-11T11:00:00.000Z" }));
  assert.equal(s.levels[1], 3, "unaided, but no delayed transfer yet");
  add(attempt({ id: "7", transfer: true, timestamp: "2026-11-12T10:00:00.000Z" }));
  assert.equal(s.levels[1], 4);
  assert.deepEqual(add(attempt({ id: "8", result: "incorrect", assisted: true, timestamp: "2026-11-12T12:00:00.000Z" })), [], "a wrong answer while being helped is not a lapse");
  const lines = add(attempt({ id: "9", result: "incorrect", timestamp: "2026-11-14T10:00:00.000Z" }));
  assert.equal(s.levels[1], 3, "wrong, unaided, on a later day than the last success");
  assert.match(lines[0], /Limits: 4 → 3/);
  assert.match(s.changes[s.changes.length - 1].note, /later day/);
  // The recommendation notices.
  const step = F.nextStep(s, "2026-11-14", 0, {});
  assert.equal(step.title, "Revisit");
  assert.equal(step.subskill, 1);
});

test("'at target' is only said when the evidence backs the levels", () => {
  const s = F.newState(F.parseTopic(CARD([["Limits", "none"]])), 4);
  s.levels[1] = 4; // as an older version, or a hand edit, might have left it
  s.bank[1] = { right: 3, total: 3 };
  const step = F.nextStep(s, "2026-11-13", 0, {});
  assert.equal(step.title, "Confirm");
  assert.match(step.detail, /recorded at level 4, but the answers recorded so far support level 0/);
  s.attempts = [attempt({ id: "1" }), attempt({ id: "2" }), attempt({ id: "3", transfer: true, timestamp: "2026-11-12T10:00:00.000Z" })];
  assert.equal(F.nextStep(s, "2026-11-13", 0, {}).title, "At target");
  assert.equal(F.nextStep(s, "2026-12-20", 0, {}).title, "Retrieval check", "long unpractised, so it is checked again");
});

test("attempts from 0.5.0 are read with their provenance kept apart", () => {
  const old = (source: string, error = "", extra: Record<string, unknown> = {}) => normaliseAttempt({ id: "x", skill: 1, question: "q", answer: "a", timestamp: "2026-11-13T12:00:00Z", mode: "quiz", result: "correct", confidence: null, assisted: false, transfer: false, source, error, ...extra })!;
  assert.deepEqual([old("bank").grading, old("bank").verification], ["deterministic", "verified"]);
  assert.equal(old("bank", "SymPy confirms your answer equals the expected one.").grading, "symbolic");
  assert.deepEqual([old("bank", "Scaling is missing.").grading, old("bank", "Scaling is missing.").verification], ["model", "unverified"]);
  assert.deepEqual([old("self").grading, old("self").answerExposed], ["self", true]);
  assert.equal(old("model").grading, "model");
  assert.equal(normaliseAttempt({ id: 3 }), null);
  assert.equal(normaliseAttempt({ id: "x", timestamp: "t", question: "q", result: "nonsense" })!.result, "ungraded", "an unknown outcome is ungraded, never wrong");
});

// ---------- the session record ----------

test("the learner's message is read for help, reveals, skips and switches before any model is asked", () => {
  assert.equal(readIntent("2x", true), "attempt");
  assert.equal(readIntent("2x", false), "none");
  assert.equal(readIntent("hint please", true), "hint");
  assert.equal(readIntent("I don't get it", true), "hint");
  assert.equal(readIntent("just tell me the answer", true), "reveal");
  assert.equal(readIntent("skip", true), "skip");
  assert.equal(readIntent("why does that work?", true), "question");
  assert.equal(readIntent("move on", true), "switch");
  assert.equal(readIntent("", true), "none");
});

test("a finished step is only believed when nothing is left open", () => {
  const state = F.newState(F.parseTopic(CARD(NAMES)), 4);
  const chat: F.Chat = { fm: {}, summary: "", messages: [] };
  const fresh = sessionFor(chat, state, "auto");
  // The model claims the step is done but ends on a question.
  let r = readSessionReply(`Good. Now differentiate $x^3$?\n${session('{"pendingQuestion":"","helpGiven":[],"nextAction":"next","completedStep":true}')}`, fresh, { now: "t1" });
  assert.equal(r.record.completedStep, false);
  assert.equal(r.record.pendingQuestion, "Good. Now differentiate $x^3$?", "the question it ended on is the open one");
  assert.equal(r.text, "Good. Now differentiate $x^3$?");
  // A pending question in the tag always wins over completedStep.
  r = readSessionReply(`Try this.\n${session('{"pendingQuestion":"Find $f\'(x)$ for $f(x)=x^2$","helpGiven":[],"nextAction":"check","completedStep":true}')}`, fresh, { now: "t1" });
  assert.equal(r.record.completedStep, false);
  assert.equal(r.record.askedAt, "t1");
  // A missing or broken tag keeps everything and finishes nothing.
  const open = r.record;
  r = readSessionReply("Not quite. Look at the exponent.", open);
  assert.deepEqual([r.record.pendingQuestion, r.record.completedStep, r.tagged], [open.pendingQuestion, false, false]);
  r = readSessionReply(`ok ${session("{bad")}`, open);
  assert.equal(r.record.pendingQuestion, open.pendingQuestion);
  // Help is not wiped when the model merely rewords the open question...
  const helped = { ...open, helpGiven: ["hint: power rule"], answerExposed: true };
  r = readSessionReply(`Again: what is the derivative of $x^2$?\n${session('{"pendingQuestion":"What is the derivative of $x^2$?","helpGiven":["second hint"],"nextAction":"check","completedStep":false}')}`, helped, { resolved: false });
  assert.deepEqual(r.record.helpGiven, ["hint: power rule", "second hint"]);
  assert.equal(r.record.answerExposed, true);
  // ...and is reset once the step was resolved and a new question begins.
  r = readSessionReply(`Right. Next: differentiate $x^5$?\n${session('{"pendingQuestion":"Differentiate $x^5$","helpGiven":[],"nextAction":"check","completedStep":false}')}`, helped, { resolved: true });
  assert.deepEqual([r.record.helpGiven, r.record.answerExposed], [[], false]);
  // Truly finished: nothing pending, nothing asked.
  r = readSessionReply(`That is the power rule done.\n${session('{"pendingQuestion":"","helpGiven":[],"nextAction":"move to the chain rule","completedStep":true}')}`, helped, { resolved: true });
  assert.equal(r.record.completedStep, true);
  assert.equal(openQuestion("**Correct.**\n\nWhat next?\n\n*SymPy checked 1 result: it agrees.*"), "What next?", "a trailing status line is not the question");
});

test("a chat saved before session records existed resumes from the question it ended on", () => {
  const state = F.newState(F.parseTopic(CARD(NAMES)), 4);
  const chat: F.Chat = { fm: { tutor: "chat", mode: "tutor" }, summary: "", messages: [{ role: "tutor", text: "Question 2 is still open.\n\nWhat does it print, and why?" }] };
  const record = sessionFor(chat, state, "tutor");
  assert.equal(record.pendingQuestion, "What does it print, and why?");
  assert.equal(record.version, 2);
  // A 0.5.0 record (version 1) keeps its fields.
  chat.fm.session = JSON.stringify({ version: 1, pendingQuestion: "Find $x$", attempt: "", helpGiven: ["a hint"], unresolvedMisconceptions: [], nextAction: "check", completedStep: false, exactExcerpts: [], action: "guided-practice" });
  const old = sessionFor(chat, state, "auto");
  assert.deepEqual([old.pendingQuestion, old.helpGiven, old.action], ["Find $x$", ["a hint"], "guided-practice"]);
});

// ---------- the policy ----------

const skill = (over: Partial<SkillInput> & { n: number }): SkillInput => ({ name: `S${over.n}`, level: null, prerequisites: [], dependents: 0, priority: 1, taught: false, supported: 0, independent: 0, independentCorrect: 0, recentFailures: 0, lapse: false, daysSince: null, bankLeft: 0, ...over });
const input = (over: Partial<PolicyInput>): PolicyInput => ({ mode: "auto", target: 4, focus: null, skills: [], pending: false, completedStep: false, intent: "none", misconceptions: 0, minutes: 25, weights: DEFAULT_WEIGHTS, placementReady: false, external: [], checked: [], ...over });

test("the policy finishes an open step, checks prerequisites before assuming, and dispatches local work in Adaptive mode", () => {
  const skills = [skill({ n: 1, level: 3, supported: 3 }), skill({ n: 2, level: 2, supported: 2, prerequisites: [1] })];
  // An open step comes first, whatever the ranking says.
  assert.equal(decide(input({ skills, focus: 2, pending: true, intent: "attempt" })).action, "check");
  assert.equal(decide(input({ skills, focus: 2, pending: true, intent: "hint" })).action, "hint");
  assert.equal(decide(input({ skills, focus: 2, pending: true, intent: "none" })).action, "continue");
  const reveal = decide(input({ skills, focus: 2, pending: true, intent: "reveal" }));
  assert.equal(reveal.action, "worked-example");
  assert.match(reveal.constraint, /only after an attempt or an explicit skip/);
  // Unless the learner asks to move on.
  assert.notEqual(decide(input({ skills, focus: 2, pending: true, intent: "switch" })).action, "continue");

  // An unchecked prerequisite is diagnosed, not assumed weak; a known weak one is taught.
  const unknown = decide(input({ skills: [skill({ n: 1, level: null }), skill({ n: 2, level: 2, supported: 2, prerequisites: [1] })], focus: 2 }));
  assert.deepEqual([unknown.action, unknown.focus], ["diagnose-prerequisite", 1]);
  const weak = decide(input({ skills: [skill({ n: 1, level: 1, supported: 1 }), skill({ n: 2, level: 2, supported: 2, prerequisites: [1] })], focus: 2 }));
  assert.deepEqual([weak.action, weak.focus], ["explain", 1]);
  // A prerequisite in another topic is checked once per chat.
  const outside = { skill: 2, name: "Complex numbers", topic: "Algebra", level: null };
  const first = decide(input({ skills, focus: 2, external: [outside] }));
  assert.deepEqual([first.action, first.focus], ["diagnose-prerequisite", 2]);
  assert.match(first.reason, /Complex numbers from Algebra, where your level is not known/);
  assert.equal(decide(input({ skills, focus: 2, external: [outside], checked: [2] })).action, "guided-practice");

  // The ladder, and the local paths.
  assert.deepEqual([decide(input({ skills: [skill({ n: 1 })], placementReady: true })).local], ["placement"]);
  assert.equal(decide(input({ skills: [skill({ n: 1 })] })).action, "diagnose");
  assert.equal(decide(input({ skills: [skill({ n: 1, level: 1, supported: 1 })] })).action, "explain");
  assert.equal(decide(input({ skills: [skill({ n: 1, level: 1, supported: 1, taught: true })] })).action, "worked-example");
  const practice = decide(input({ skills: [skill({ n: 1, level: 3, supported: 3, bankLeft: 2 })] }));
  assert.deepEqual([practice.action, practice.local], ["independent-practice", "bank"]);
  assert.equal(decide(input({ skills: [skill({ n: 1, level: 3, supported: 3, bankLeft: 0 })] })).local, null, "no bank question left: the model sets one");
  assert.equal(decide(input({ skills: [skill({ n: 1, level: 3, supported: 3, independent: 2, independentCorrect: 2 })] })).action, "transfer");
  assert.equal(decide(input({ skills: [skill({ n: 1, level: 3, supported: 3, lapse: true, recentFailures: 1 })] })).action, "diagnose-error");
  assert.equal(decide(input({ skills: [skill({ n: 1, level: 4, supported: 4, independent: 3, independentCorrect: 3, daysSince: 30 })] })).action, "retrieval");
  // Explicit modes never get a local path from the policy.
  assert.equal(decide(input({ mode: "teach", skills: [skill({ n: 1, level: 3, supported: 3, bankLeft: 2 })] })).local, null);
});

test("Learn mode teaches, keeps examples available, and only suggests unaided practice", () => {
  for (const s of [skill({ n: 1 }), skill({ n: 1, level: 1, supported: 1 }), skill({ n: 1, level: 2, supported: 2 }), skill({ n: 1, level: 3, supported: 3, bankLeft: 3 }), skill({ n: 1, level: 3, supported: 3, independentCorrect: 2, independent: 2 }), skill({ n: 1, level: 3, supported: 3, lapse: true }), skill({ n: 1, level: 4, supported: 4, daysSince: 40 })]) {
    const d = decide(input({ mode: "teach", skills: [s] }));
    assert.ok(LEARN_ACTIONS.includes(d.action), `${d.action} is a teaching action`);
    assert.equal(d.local, null);
  }
  assert.equal(decide(input({ mode: "teach", skills: [skill({ n: 1 })] })).action, "explain", "a new idea is explained, not examined");
  const ready = decide(input({ mode: "teach", skills: [skill({ n: 1, level: 3, supported: 3 })] }));
  assert.deepEqual([ready.action, ready.suggestIndependent], ["guided-practice", true]);
  assert.match(ready.constraint, /Learn mode stays within/);
  assert.equal(decide(input({ mode: "teach", skills: [skill({ n: 1, level: 3, supported: 3, lapse: true })] })).action, "re-explain", "after errors Learn changes the explanation");
  assert.equal(decide(input({ mode: "teach", focus: 1, skills: [skill({ n: 1, level: 2, supported: 2 })], pending: true, intent: "reveal" })).action, "worked-example");
});

test("weights rank what to study and are replayable against logged cases; they cannot touch a level", () => {
  const skills = [skill({ n: 1, level: 2, supported: 2, dependents: 2 }), skill({ n: 2, level: 2, supported: 2, prerequisites: [1], priority: 5 }), skill({ n: 3, level: 2, supported: 2, prerequisites: [1], recentFailures: 3, lapse: true })];
  const base = input({ skills, completedStep: true });
  assert.equal(scoreSkills(base)[0].n, 3, "recent errors lead by default");
  assert.equal(scoreSkills({ ...base, weights: { ...V1_WEIGHTS, exam: 3 } })[0].n, 2, "with only priority weighted, the high-priority concept leads");
  assert.equal(scoreSkills({ ...base, weights: { ...V1_WEIGHTS, exam: 0, prerequisite: 3 } })[0].n, 1, "with prerequisite importance weighted, the foundation leads");
  const short = scoreSkills(input({ skills: [skill({ n: 1, level: 1, supported: 1 }), skill({ n: 2, level: 3, supported: 3, bankLeft: 4 })], minutes: 10 }));
  assert.equal(short[0].n, 2, "with ten minutes, quick practice beats a new lesson");

  const d = decide(base);
  const cases = [{ t: "2026-11-13T10:00:00Z", topic: "Calculus", input: base, decision: { version: d.version, action: d.action, focus: d.focus, local: d.local } }];
  assert.deepEqual(replay(cases, DEFAULT_WEIGHTS), { total: 1, same: 1, changed: [] });
  const other = replay(cases, { ...V1_WEIGHTS, exam: 3 });
  assert.equal(other.changed.length, 1);
  assert.match(other.changed[0].was, /diagnose-error on S3/);

  // Extreme weights and a maximal priority change the ranking and nothing else.
  const s = F.newState(F.parseTopic(CARD(NAMES)), 4);
  s.levels[1] = 3;
  s.priorities = { 1: 5 };
  assert.deepEqual(F.applyStateUpdate(s, { levels: { "1": 4 } }), []);
  assert.equal(s.levels[1], 3);
});

// ---------- engine paths ----------

test("Adaptive mode places a new learner with code, practises from the bank, and calls the model only for teaching", async () => {
  const t = await setup();
  const chat = await t.chatIn("auto");
  let r = await t.engine.study(t.dir, chat, "");
  assert.equal(r.local, true);
  assert.match(r.reply, /\*\*Placement\*\* · 3 quick questions/);
  assert.equal(t.calls.length, 0, "placement in Adaptive mode uses no model");
  r = await t.engine.study(t.dir, chat, "B", { confidence: 0.8 });
  assert.deepEqual([r.attempt!.result, r.attempt!.grading, r.attempt!.verification, r.attempt!.activity, r.attempt!.confidence], ["correct", "deterministic", "verified", "placement", 0.8]);
  r = await t.engine.study(t.dir, chat, "2x");
  r = await t.engine.study(t.dir, chat, "skip");
  assert.match(r.reply, /Placement done/);
  assert.equal(t.calls.length, 0);
  let state = await t.store.loadState(t.dir, 4);
  assert.deepEqual(state.levels, { 1: 2, 2: 2, 3: 0 });
  assert.deepEqual(state.changes.map((c) => c.cause), ["placement", "placement", "placement"]);
  assert.equal(state.attempts.length, 3, "placement answers are evidence too");
  assert.equal(state.attempts[2].result, "skipped");

  // Chain rule is at 0: the policy teaches it, which needs the model.
  t.replies.push(`The chain rule handles compositions. Worked example: ... Your turn: differentiate $\\sin(x^2)$?\n${session('{"pendingQuestion":"Differentiate $\\\\sin(x^2)$","helpGiven":[],"nextAction":"check the answer","completedStep":false}')}`);
  r = await t.engine.study(t.dir, chat, "");
  assert.equal(t.calls.length, 1);
  assert.deepEqual([r.decision!.action, r.decision!.focus], ["explain", 3]);
  assert.match(t.calls[0].input, /Instructional action: explain\./);
  state = await t.store.loadState(t.dir, 4);
  assert.equal(state.levels[3], 1, "a delivered lesson is exposure: level 1 and no more");
  assert.equal(state.changes[state.changes.length - 1].cause, "lesson");

  // An answer straight after the worked example is assisted, even if the model says otherwise.
  t.replies.push(`Correct.\n<attempt>{"skill":3,"result":"correct","assisted":false,"transfer":true,"error_type":"","error":"","difficulty":2}</attempt>\n${session('{"pendingQuestion":"","helpGiven":[],"nextAction":"practise","completedStep":true}')}`);
  r = await t.engine.study(t.dir, chat, "2x cos(x^2)", { confidence: 1 });
  assert.equal(r.decision!.action, "check");
  assert.deepEqual([r.attempt!.assisted, r.attempt!.transfer, r.attempt!.grading, r.attempt!.verification, r.attempt!.difficulty], [true, false, "model", "unverified", 2]);
  assert.match(r.attempt!.assistance.join(" "), /straight after an explanation/);
  state = await t.store.loadState(t.dir, 4);
  assert.equal(state.levels[3], 2, "one helped success: level 2, whatever the confidence");
});

test("in Adaptive mode unaided practice comes from the bank and is marked by code", async () => {
  const t = await setup();
  const state = await t.store.loadState(t.dir, 4);
  state.levels = { 1: 4, 2: 3, 3: 2 };
  state.attempts = [1, 2, 3].map((i) => attempt({ id: `p${i}`, transfer: i === 3, timestamp: `2026-11-0${i}T10:00:00.000Z` }));
  state.focus = 2;
  await t.store.saveState(t.dir, state);
  const chat = await t.chatIn("auto");
  let r = await t.engine.study(t.dir, chat, "");
  assert.equal(r.local, true);
  assert.deepEqual([r.decision!.action, r.decision!.local, r.decision!.focus], ["independent-practice", "bank", 2]);
  assert.match(r.reply, /Differentiate \$x\^2\$/);
  let saved = await t.store.loadChat(chat);
  assert.equal(JSON.parse(String(saved.fm.session)).pendingQuestion.includes("Differentiate"), true, "the open bank question is in the session record");

  r = await t.engine.study(t.dir, chat, "2x", { confidence: 0.6 });
  assert.equal(t.calls.length, 0);
  assert.deepEqual([r.attempt!.result, r.attempt!.grading, r.attempt!.activity, r.attempt!.assisted, r.attempt!.confidence], ["correct", "deterministic", "independent-practice", false, 0.6]);
  assert.match(r.reply, /^\*\*Correct\.\*\*[\s\S]*Differentiate \$x\^3\$/, "the policy still wants unaided practice, so the next bank question follows");
  r = await t.engine.study(t.dir, chat, "3x^2");
  // The run has its two unaided successes. Limits, a foundation at level 4, last succeeded
  // unaided on 2026-11-03, so its 7-day delayed check fell due on 2026-11-10 and comes next.
  assert.deepEqual([r.decision!.action, r.decision!.focus, r.decision!.local], ["retrieval", 1, "bank"]);
  assert.match(r.decision!.reason, /delayed check on Limits is due \(from 2026-11-10\)/);
  assert.match(r.reply, /What is the limit of 1\/x/);
  r = await t.engine.study(t.dir, chat, "B");
  assert.deepEqual([r.attempt!.result, r.attempt!.activity, r.attempt!.taskType], ["correct", "retrieval", "recall"]);
  assert.match(r.reply, /Press \*\*Continue\*\*/, "the check is done and moves the next one out, so the guide moves to what needs work most, which the bank cannot do");
  assert.deepEqual([r.decision!.action, r.decision!.focus, r.decision!.local], ["guided-practice", 3, null]);
  saved = await t.store.loadChat(chat);
  assert.equal(saved.fm.await_continue, "yes");
  assert.equal(saved.fm.card, "");
  const after = await t.store.loadState(t.dir, 4);
  assert.equal(skillEvidence(after.attempts, 2).independentCorrect, 2);
  assert.equal(after.levels[2], 3, "no delayed transfer yet, so still 3");
  assert.equal(t.calls.length, 0);
});

test("a pending question, the confidence given and the help record survive errors, restarts and mode changes", async () => {
  const t = await setup();
  const state = await t.store.loadState(t.dir, 4);
  state.levels = { 1: 3, 2: 2, 3: 2 };
  state.focus = 2;
  await t.store.saveState(t.dir, state);
  const chat = await t.chatIn("auto");
  t.replies.push(`Differentiate $x^4$?\n${session('{"pendingQuestion":"Differentiate $x^4$","helpGiven":[],"nextAction":"check","completedStep":false}')}`);
  await t.engine.study(t.dir, chat, "");
  // A hint is asked for, then the answer fails to send.
  t.replies.push(`Bring the exponent down.\n${session('{"pendingQuestion":"Differentiate $x^4$","helpGiven":["Bring the exponent down."],"nextAction":"check","completedStep":false}')}`);
  let r = await t.engine.study(t.dir, chat, "hint");
  assert.equal(r.decision!.action, "hint");
  t.replies.push(new Error("usage limit reached"));
  await assert.rejects(t.engine.study(t.dir, chat, "4x^3", { confidence: 0.7 }), /usage limit/);

  // "Restart": everything is read back from the vault by a fresh engine and store.
  const store2 = new Store(t.fs, "Tutor", () => "2026-11-13");
  const engine2 = new Engine(store2, () => t.settings, () => "2026-11-13");
  let saved = await store2.loadChat(chat);
  assert.equal(saved.messages[saved.messages.length - 1].text, "4x^3", "the learner's answer was saved before the call");
  assert.equal(saved.fm.pending_confidence, 0.7, "and so was the confidence");
  const record = sessionFor(saved, await store2.loadState(t.dir, 4), "auto");
  assert.equal(record.pendingQuestion, "Differentiate $x^4$");
  assert.ok(record.helpGiven.some((h) => /Bring the exponent down/.test(h)));
  assert.match(await t.fs.read(chat.replace("/chats/", "/sessions/")), /## Pending question\n\n> Differentiate \$x\^4\$/, "the readable mirror has it too");

  // The learner switches to Master mode and retries: same question, same confidence, help remembered.
  saved.fm.mode = "tutor";
  await store2.saveChat(chat, saved);
  const calls: any[] = [];
  (engine2 as any).call = async (o: any) => (calls.push(o), { text: `Correct.\n<attempt>{"skill":2,"result":"correct","assisted":false,"transfer":false,"error_type":"","error":""}</attempt>\n${session('{"pendingQuestion":"","helpGiven":[],"nextAction":"next","completedStep":true}')}`, usage });
  r = await engine2.study(t.dir, chat, "");
  assert.match(calls[0].system, /# Mode: Socratic tutor/);
  assert.match(calls[0].input, /"pendingQuestion":"Differentiate \$x\^4\$"/);
  assert.deepEqual([r.attempt!.confidence, r.attempt!.assisted, r.attempt!.question], [0.7, true, "Differentiate $x^4$"]);
  assert.equal(r.attempt!.id, `${chat}:4`, "the retry has the id of the failed turn's message, so it cannot be recorded twice");
  saved = await store2.loadChat(chat);
  assert.equal(saved.fm.pending_confidence, "", "confidence is cleared once the answer has been marked");
});

test("confidence, time, error type and how the mark was verified are recorded", async () => {
  const t = await setup({ settings: { mathCheck: true } });
  t.engine.maths = { check: async (claims: any[]) => claims.map(() => ({ ok: true, detail: "identical" })), warm() {}, status: () => "ready" };
  // A card with enough notation to switch maths checking on.
  await t.store.saveCompiled({ title: "Calculus", fm: { subject: "none" }, topicBody: CARD(NAMES, { 2: "- $f'(x)$, $\\frac{d}{dx}x^n = nx^{n-1}$, $\\int x\\,dx$" }), questionsBody: BANK, target: 4, existingDir: t.dir });
  const state = await t.store.loadState(t.dir, 4);
  state.levels = { 1: 3, 2: 3, 3: 2 };
  state.focus = 2;
  await t.store.saveState(t.dir, state);
  const chat = await t.chatIn("tutor");
  const c = await t.store.loadChat(chat);
  c.messages.push({ role: "tutor", text: "Differentiate $x^2 \\sin x$?" });
  c.fm.session = JSON.stringify({ version: 2, pendingQuestion: "Differentiate $x^2 \\sin x$", questionId: "q7", askedAt: new Date(Date.now() - 90000).toISOString(), action: "independent-practice", helpGiven: [] });
  await t.store.saveChat(chat, c);
  t.replies.push(`Not quite: the product rule has two terms.\n<attempt>{"skill":2,"result":"incorrect","assisted":false,"transfer":false,"error_type":"procedural","error":"dropped the second product-rule term","difficulty":3}</attempt>\n<verify>[{"type":"derivative","f":"x**2*sin(x)","var":"x","result":"2*x*sin(x) + x**2*cos(x)"}]</verify>\n${session('{"pendingQuestion":"","helpGiven":[],"nextAction":"retry","completedStep":true}')}`);
  const r = await t.engine.study(t.dir, chat, "2x sin x", { confidence: 0.9 });
  const a = r.attempt!;
  assert.deepEqual([a.result, a.errorType, a.note, a.confidence, a.difficulty, a.questionId], ["incorrect", "procedural", "dropped the second product-rule term", 0.9, 3, "q7"]);
  assert.ok(a.seconds !== null && a.seconds >= 89 && a.seconds <= 95, `time to answer was recorded (${a.seconds}s)`);
  assert.deepEqual([a.grading, a.verification], ["model", "unverified"], "the model marked it; SymPy confirmed the results the reply states, which does not verify the mark");
  assert.match(a.assumptions, /SymPy recomputed/);
  assert.equal(a.concept, "calculus/derivatives");
  assert.ok(r.tools!.some((x) => x.tool === "maths.check" && x.ok && x.kind === "step-validation"));
  assert.equal(skillEvidence((await t.store.loadState(t.dir, 4)).attempts, 2).errors.procedural, 1);
});

test("a failed tool or a failed grading is never recorded as a wrong answer", async () => {
  // Placement with SymPy switched on but broken: the short answer in another form cannot be checked.
  const t = await setup({ settings: { mathCheck: true } });
  t.engine.maths = {
    check: async () => {
      throw new Error("worker crashed");
    },
    warm() {},
    status: () => "ready",
  };
  const chat = await t.chatIn("tutor");
  await t.engine.study(t.dir, chat, "");
  await t.engine.study(t.dir, chat, "B");
  let r = await t.engine.study(t.dir, chat, "x + x");
  assert.match(r.reply, /Could not be checked automatically/);
  assert.equal(r.attempt!.result, "ungraded");
  assert.ok(r.tools!.some((x) => x.tool === "maths.equivalent" && !x.ok && /worker crashed/.test(x.error)), "the failure is on record");
  r = await t.engine.study(t.dir, chat, "A");
  const state = await t.store.loadState(t.dir, 4);
  assert.deepEqual(state.levels, { 1: 2, 2: null, 3: 1 }, "the unchecked subskill is left unplaced, not marked down");
  assert.deepEqual(state.bank[2], { right: 0, total: 0 });

  // A quiz answer SymPy cannot decide goes to the grading call; an unreadable grade records nothing.
  const q = await setup({ settings: { mathCheck: true } });
  q.engine.maths = { check: async (claims: any[]) => claims.map(() => ({ ok: null, detail: "could not be evaluated" })), warm() {}, status: () => "ready" };
  const quiz = await q.chatIn("quiz");
  await q.engine.study(q.dir, quiz, "");
  await q.engine.study(q.dir, quiz, "B");
  q.replies.push('{"grade":"maybe"}');
  await assert.rejects(q.engine.study(q.dir, quiz, "x + x"), /could not be graded\. It remains ungraded/);
  let s = await q.store.loadState(q.dir, 4);
  assert.equal(s.attempts.filter((a) => a.questionId === "Q2").length, 0);
  assert.equal((await q.store.loadChat(quiz)).fm.card, "Q2", "the question stays open for a retry");
  // The retry grades it, as a model judgement.
  q.replies.push('{"grade":"good","feedback":"Equivalent to 2x."}');
  r = await q.engine.study(q.dir, quiz, "");
  assert.deepEqual([r.attempt!.result, r.attempt!.grading, r.attempt!.verification], ["correct", "model", "unverified"]);
  s = await q.store.loadState(q.dir, 4);
  assert.deepEqual(s.bank[2], { right: 1, total: 1 });

  // A mark the model wrote unreadably is an ungraded attempt.
  const m = await setup();
  const st = await m.store.loadState(m.dir, 4);
  st.levels = { 1: 3, 2: 3, 3: 3 };
  st.focus = 2;
  await m.store.saveState(m.dir, st);
  const chat3 = await m.chatIn("tutor");
  const c3 = await m.store.loadChat(chat3);
  c3.messages.push({ role: "tutor", text: "Differentiate $x^5$?" });
  await m.store.saveChat(chat3, c3);
  m.replies.push("Hmm.\n<attempt>{not json}</attempt>");
  r = await m.engine.study(m.dir, chat3, "5x^4");
  assert.equal(r.attempt!.result, "ungraded");
  assert.equal((await m.store.loadState(m.dir, 4)).levels[2], 3);
});

test("SymPy verdicts are labelled as symbolic or numeric evidence, with what they assumed", async () => {
  const t = await setup({ settings: { mathCheck: true } });
  let detail = "identical";
  t.engine.maths = { check: async (claims: any[]) => claims.map(() => ({ ok: true, detail })), warm() {}, status: () => "ready" };
  const quiz = await t.chatIn("quiz");
  await t.engine.study(t.dir, quiz, "");
  await t.engine.study(t.dir, quiz, "B");
  let r = await t.engine.study(t.dir, quiz, "x + x");
  assert.deepEqual([r.attempt!.grading, r.attempt!.verification], ["symbolic", "verified"]);
  assert.match(r.attempt!.assumptions, /simplifying the difference/);
  detail = "equal at every test point";
  await t.engine.study(t.dir, quiz, "B"); // the weakest subskill's multiple-choice question comes next
  r = await t.engine.study(t.dir, quiz, "x^2 + 2x^2");
  assert.equal(r.attempt!.grading, "numeric");
  assert.match(r.attempt!.assumptions, /not a proof/);
  assert.equal(t.calls.length, 0);
  assert.deepEqual(t.engine.tools.log.map((x) => x.kind), ["symbolic-equivalence", "numeric-check"]);
});

test("an interrupted quiz turn that is retried does not count the answer twice", async () => {
  const t = await setup();
  const quiz = await t.chatIn("quiz");
  await t.engine.study(t.dir, quiz, "");
  // The state is saved, then the chat save fails: the app was closed between the two writes.
  const write = t.fs.write.bind(t.fs);
  let failed = false;
  t.fs.write = async (path: string, data: string) => {
    if (!failed && path === quiz && /\*\*Correct\.\*\*/.test(data)) {
      failed = true;
      throw new Error("disk went away");
    }
    return write(path, data);
  };
  await assert.rejects(t.engine.study(t.dir, quiz, "B"), /disk went away/);
  let state = await t.store.loadState(t.dir, 4);
  assert.deepEqual([state.attempts.length, state.bank[1]], [1, { right: 1, total: 1 }]);
  const before = { ...state.cards["Q1"] };
  // Retry: the learner's "B" is the last message, so the same turn runs again.
  const r = await t.engine.study(t.dir, quiz, "");
  assert.match(r.reply, /^\*\*Correct\.\*\*/);
  state = await t.store.loadState(t.dir, 4);
  assert.deepEqual([state.attempts.length, state.bank[1]], [1, { right: 1, total: 1 }], "one attempt, one count");
  assert.deepEqual(state.cards["Q1"], before, "and the card was scheduled once");
  assert.equal((await t.store.loadChat(quiz)).fm.total, 1);
});

test("a long chat is summarised only at a finished step, and unfinished work keeps its transcript", async () => {
  const t = await setup({ settings: { maxChatWords: 40 } });
  const state = await t.store.loadState(t.dir, 4);
  state.levels = { 1: 3, 2: 2, 3: 2 };
  state.focus = 2;
  await t.store.saveState(t.dir, state);
  const chat = await t.chatIn("tutor");
  const long = "This is a long step in a proof that the learner is half way through. ".repeat(6);
  t.replies.push(`${long}\n\nSo what is the next line?`, `${long}\n\nAnd the line after that?\n${session('{"pendingQuestion":"","helpGiven":[],"nextAction":"go on","completedStep":true}')}`);
  await t.engine.study(t.dir, chat, "");
  let r = await t.engine.study(t.dir, chat, "I expand the bracket first");
  r = await t.engine.study(t.dir, chat, "then collect terms");
  assert.equal(r.rotatedTo, undefined, "the tutor is still asking, so nothing is summarised away");
  assert.equal(t.calls.length, 3);

  // The step finishes. The summary is written by the cheap model, and the exact items are appended by code.
  t.replies.push(`Yes, that completes the proof.\n${session('{"pendingQuestion":"","helpGiven":[],"nextAction":"start the chain rule","completedStep":true}')}`, "The learner proved the power rule for n=2 by expanding the bracket and collecting terms.");
  r = await t.engine.study(t.dir, chat, "so the limit is 2x");
  assert.ok(r.rotatedTo, "a finished step in a long chat starts a new part");
  assert.equal(t.calls[4].model, "haiku");
  assert.equal(r.rotationUsage!.calls, 1);
  const part2 = await t.store.loadChat(r.rotatedTo!);
  assert.match(part2.summary, /proved the power rule[\s\S]*\*\*Carried over exactly\*\*\n- Next action: start the chain rule/);
  assert.deepEqual(part2.messages.map((m) => m.text), ["so the limit is 2x", "Yes, that completes the proof."]);
  assert.equal((await t.store.earlierParts(r.rotatedTo!)).length, 1, "the full transcript is still one link away");

  // The learner points back at the earlier part: the exact exchange is retrieved for the model.
  t.replies.push("We expanded the bracket.");
  await t.engine.study(t.dir, r.rotatedTo!, "what did we do earlier with the bracket?");
  assert.match(t.calls[5].input, /# Retrieved from earlier in this chat \(exact quotes\)\nLEARNER: I expand the bracket first/);

  // If the summary cannot be written, the chat stays whole.
  const u = await setup({ settings: { maxChatWords: 40 } });
  const chat2 = await u.chatIn("tutor");
  u.replies.push(`${long}\n${session('{"pendingQuestion":"","helpGiven":[],"nextAction":"n","completedStep":true}')}`, `${long}\n${session('{"pendingQuestion":"","helpGiven":[],"nextAction":"n","completedStep":true}')}`, `Done.\n${session('{"pendingQuestion":"","helpGiven":[],"nextAction":"n","completedStep":true}')}`, new Error("summary failed"));
  await u.engine.study(u.dir, chat2, "");
  await u.engine.study(u.dir, chat2, "one");
  const kept = await u.engine.study(u.dir, chat2, "two");
  assert.equal(kept.rotatedTo, undefined);
  assert.equal((await u.store.loadChat(chat2)).messages.length, 5);
});

test("a disputed mark stops counting and its level change is undone; a regrade replaces it", async () => {
  const t = await setup();
  const quiz = await t.chatIn("quiz");
  await t.engine.study(t.dir, quiz, "");
  await t.engine.study(t.dir, quiz, "B");
  await t.engine.study(t.dir, quiz, "2x");
  await t.engine.study(t.dir, quiz, "B"); // Q5, on the weakest subskill, is asked before Q3
  await t.engine.study(t.dir, quiz, "3x^2");
  // Q4 is open-ended and goes to the grading call, which marks it wrong.
  t.replies.push('{"grade":"again","feedback":"Does not mention the limit."}');
  let r = await t.engine.study(t.dir, quiz, "because of the binomial expansion of the difference quotient");
  const id = r.attempt!.id;
  assert.equal(r.attempt!.result, "incorrect");
  let state = await t.store.loadState(t.dir, 4);
  assert.equal(skillEvidence(state.attempts, 2).errors.unclassified, 1);

  const d = await t.engine.dispute(t.dir, id, quiz);
  state = d.state;
  assert.equal(state.attempts.find((a) => a.id === id)!.verification, "disputed");
  const e = skillEvidence(state.attempts, 2);
  assert.deepEqual([e.disputed, e.errors.unclassified ?? 0, e.recentFailures], [1, 0, 0], "it no longer counts either way");
  assert.equal(JSON.parse(String((await t.store.loadChat(quiz)).fm.session)).disputed, id, "the tutor will be told to look again");

  t.replies.push('{"grade":"good","feedback":"The expansion is the reason; the limit is implied."}');
  const g = await t.engine.regrade(t.dir, id);
  assert.equal(t.calls[t.calls.length - 1].model, "sonnet", "the second opinion comes from the stronger model");
  assert.deepEqual([g.attempt.result, g.attempt.verification], ["correct", "unverified"]);
  assert.match(g.attempt.note, /^Regraded after a dispute/);
  await assert.rejects(t.engine.regrade(t.dir, "nope"), /no longer on record/);

  // A dispute undoes the level change the attempt caused.
  const u = await setup();
  const s = await u.store.loadState(u.dir, 4);
  s.levels = { 1: 4, 2: 3, 3: 3 };
  s.attempts = [attempt({ id: "ok1" }), attempt({ id: "ok2" }), attempt({ id: "ok3", transfer: true, timestamp: "2026-11-11T10:00:00.000Z" })];
  const lapse = attempt({ id: "bad", result: "incorrect", timestamp: "2026-11-13T10:00:00.000Z" });
  s.attempts = recordAttempt(s.attempts, lapse);
  applyAttempt(s, lapse);
  assert.equal(s.levels[1], 3);
  await u.store.saveState(u.dir, s);
  const undone = await u.engine.dispute(u.dir, "bad");
  assert.equal(undone.state.levels[1], 4);
  assert.match(undone.changes[0], /Limits: 3 → 4/);
  assert.equal(undone.state.changes[undone.state.changes.length - 1].cause, "dispute");
});

// ---------- the course graph, and migration ----------

test("concept ids survive renumbering and renaming, and typed relations are kept apart from prerequisites", () => {
  const card = CARD(NAMES, { 3: "relations: contrasts_with 2; derived_from 1; supports 2" });
  const first = syncTopicGraph("Calculus", F.parseTopic(card), null);
  assert.deepEqual(first.graph.concepts.map((c) => c.id), ["calculus/limits", "calculus/derivatives", "calculus/chain-rule"]);
  assert.deepEqual(first.graph.concepts[0].sources, ["[[Calc notes]]"], "source references are kept");
  assert.deepEqual(first.graph.edges.map((e) => `${e.from.split("/")[1]} ${e.type} ${e.to.split("/")[1]} (${e.status})`), ["derivatives requires limits (inferred)", "chain-rule requires derivatives (inferred)", "chain-rule contrasts_with derivatives (inferred)", "chain-rule derived_from limits (inferred)", "chain-rule supports derivatives (inferred)"]);
  assert.deepEqual(effectivePrereqs(first.graph), { 1: [], 2: [1], 3: [2] }, "only `requires` orders study");

  // The learner reviews one edge, rejects another and adds a cross-topic one.
  const g = first.graph;
  g.edges[0].status = "reviewed";
  g.edges[1].status = "rejected";
  g.edges.push({ from: "calculus/limits", to: "algebra/inequalities", type: "requires", status: "reviewed", source: "learner" });
  assert.deepEqual(effectivePrereqs(g)[3], [], "a rejected prerequisite no longer constrains ordering");

  // Recompile: a new subskill is put first, one is renamed, one is dropped.
  const again = syncTopicGraph("Calculus", F.parseTopic(CARD([["Functions", "none"], ["Limits", "1"], ["The chain rule", "2"]])), parseTopicGraph("```json\n" + JSON.stringify(g) + "\n```"));
  const byName = Object.fromEntries(again.graph.concepts.map((c) => [c.name, c]));
  assert.equal(byName["Limits"].id, "calculus/limits");
  assert.equal(byName["Limits"].n, 2);
  assert.equal(byName["The chain rule"].id, "calculus/chain-rule", "a renamed subskill keeps its id");
  assert.equal(byName["Functions"].id, "calculus/functions");
  assert.equal(byName["Derivatives"].retired, true, "a dropped concept is retired, not deleted");
  assert.deepEqual(again.remap, { 1: 2, 3: 3 });
  assert.ok(again.graph.edges.some((e) => e.to === "algebra/inequalities" && e.source === "learner"), "the learner's cross-topic edge survives");
  assert.equal(again.graph.edges.find((e) => e.from === "calculus/chain-rule" && e.type === "requires")?.to, "calculus/limits");

  const clean = syncTopicGraph("Calculus", F.parseTopic(card), null).graph;
  assert.equal(wouldCycle(clean.edges, "calculus/limits", "calculus/chain-rule"), true, "limits cannot require what rests on it");
  assert.equal(wouldCycle(g.edges, "calculus/limits", "calculus/chain-rule"), false, "with the middle prerequisite rejected there is no loop to close");
});

test("recompiling carries evidence, priorities and cross-topic relations to the renumbered subskills", async () => {
  const t = await setup();
  const algebra = await t.store.saveCompiled({ title: "Algebra", fm: {}, topicBody: CARD([["Inequalities", "none"], ["Factorising", "none"]]).replace("# Calculus", "# Algebra"), questionsBody: BANK, target: 4 });
  await t.store.loadState(algebra, 4);
  // Calculus/Limits requires Algebra/Factorising, and Algebra/Inequalities requires nothing of Calculus.
  await t.store.addRelation({ from: "calculus/limits", to: "algebra/factorising", type: "requires" });
  await assert.rejects(t.store.addRelation({ from: "algebra/factorising", to: "calculus/chain-rule", type: "requires" }), /circular/, "a loop through another topic is refused");
  await t.store.addRelation({ from: "algebra/factorising", to: "calculus/chain-rule", type: "supports" });

  const state = await t.store.loadState(t.dir, 4);
  state.levels = { 1: 3, 2: 2, 3: 1 };
  state.priorities = { 1: 4 };
  state.taught = { 3: "2026-11-01" };
  state.focus = 1;
  state.attempts = [attempt({ id: "a1", skill: 1, concept: "calculus/limits" }), attempt({ id: "a2", skill: 2, concept: "calculus/derivatives" })];
  F.setLevel(state, 2, 3, "a2", "test");
  await t.store.saveState(t.dir, state);
  assert.match(await t.store.linkedContext(t.dir, state), /External prerequisite \[\[Tutor\/Topics\/Algebra\/topic\]\]: Factorising, level unknown/);

  // Algebra is recompiled with its subskills in the other order.
  await t.store.saveCompiled({ title: "Algebra", fm: {}, topicBody: CARD([["Factorising", "none"], ["Inequalities", "none"]]).replace("# Calculus", "# Algebra"), questionsBody: BANK, target: 4, existingDir: algebra });
  const ext = await t.store.externalPrereqs(t.dir, 4);
  assert.deepEqual(ext.map((e) => [e.skill, e.name, e.n]), [[1, "Factorising", 1]], "the link follows the concept to its new number");

  // Calculus is recompiled: Limits moves to 2, Derivatives is dropped, Chain rule stays 3.
  await t.store.saveCompiled({ title: "Calculus", fm: { subject: "none" }, topicBody: CARD([["Functions", "none"], ["Limits", "1"], ["Chain rule", "2"]]), questionsBody: BANK, target: 4, existingDir: t.dir });
  const after = await t.store.loadState(t.dir, 4);
  assert.deepEqual(after.levels, { 1: null, 2: 3, 3: 1 });
  assert.deepEqual(after.priorities, { 2: 4 });
  assert.deepEqual(after.taught, { 3: "2026-11-01" });
  assert.equal(after.focus, 2);
  assert.deepEqual(after.attempts.map((a) => [a.id, a.skill, a.concept]), [["a1", 2, "calculus/limits"], ["a2", 0, "calculus/derivatives"]], "evidence for a dropped concept is kept, under no current subskill");
  assert.equal(after.changes.length, 1, "the history of level changes is kept");
  assert.deepEqual((await t.store.externalPrereqs(t.dir, 4)).map((e) => [e.skill, e.name]), [[2, "Factorising"]]);
  const course = await t.store.loadCourse();
  assert.ok(course.edges.some((e) => e.from === "algebra/factorising" && e.to === "calculus/chain-rule" && e.type === "supports"));
  assert.ok(!course.concepts.has("calculus/derivatives"), "a retired concept is not drawn");
});

test("an answer to a prerequisite check in another topic is recorded there, keeps its purpose through a hint, and can be disputed", async () => {
  // Found in a live session: the answer to an index-law check was filed as a failure on the
  // calculus concept in focus, and the hint turn in between relabelled it as guided practice.
  const t = await setup();
  const algebra = await t.store.saveCompiled({ title: "Algebra", fm: {}, topicBody: CARD([["Index laws", "none"]]).replace("# Calculus", "# Algebra"), questionsBody: "", target: 4 });
  await t.store.addRelation({ from: "calculus/limits", to: "algebra/index-laws", type: "requires" });
  const chat = await t.chatIn("teach");

  t.replies.push(`Quick check first: what is $x^2 \\cdot x^3$?\n${session('{"pendingQuestion":"What is $x^2 \\\\cdot x^3$?","helpGiven":[],"nextAction":"check","completedStep":false}')}`);
  const r1 = await t.engine.study(t.dir, chat, "");
  assert.equal(r1.decision?.action, "diagnose-prerequisite");
  assert.equal(r1.decision?.focus, 1);
  assert.equal(r1.decision?.assesses, "algebra/index-laws");

  t.replies.push(`Add the powers.\n${session('{"pendingQuestion":"What is $x^2 \\\\cdot x^3$?","helpGiven":["Add the powers."],"nextAction":"check","completedStep":false}')}`);
  await t.engine.study(t.dir, chat, "hint please");

  // The model tags the answer against the calculus concept; code files it where it belongs.
  t.replies.push(`Not quite.\n<attempt>{"skill":1,"result":"incorrect","assisted":true,"transfer":false,"error_type":"prerequisite","error":"multiplied the indices"}</attempt>\n${session('{"pendingQuestion":"","helpGiven":[],"nextAction":"re-explain","completedStep":true}')}`);
  const r3 = await t.engine.study(t.dir, chat, "x^6", { confidence: 0.8 });
  assert.equal(r3.attempt?.concept, "algebra/index-laws");
  assert.equal(r3.attempt?.activity, "diagnosis", "the question keeps the purpose it was asked for, through the hint");
  assert.equal(r3.attempt?.assisted, true);
  const calc = await t.store.loadState(t.dir, 4);
  assert.equal(calc.attempts.length, 0, "nothing is recorded against Limits");
  assert.equal(calc.levels[1] ?? null, null, "Limits is not placed by an answer about index laws");
  const alg = await t.store.loadState(algebra, 4);
  assert.deepEqual(alg.attempts.map((a) => [a.skill, a.result, a.confidence]), [[1, "incorrect", 0.8]]);

  // Disputing it from the calculus chat finds it in Algebra and hands back the calculus state.
  const d = await t.engine.dispute(t.dir, r3.attempt!.id, chat);
  assert.equal(d.attempt.verification, "disputed");
  assert.equal(d.state.topic, "Calculus");
  assert.equal((await t.store.loadState(algebra, 4)).attempts[0].verification, "disputed");
  await assert.rejects(t.engine.regrade(t.dir, r3.attempt!.id), /marked in conversation/);
});

test("after a revealed prerequisite check, the follow-up is filed where the tutor's mark says, and the worked example teaches nothing about the focus", async () => {
  // Also found live: the worked example shown for an index-law check marked the calculus concept
  // as taught, and the question after it could be on either concept. Code cannot tell which, so
  // the mark names an external prerequisite when it tested one; otherwise the focus is assumed.
  // Each case starts from a fresh vault, so the prerequisite is still unchecked.
  const reveal = async (followUp: string, tagExtra: string, answer: string) => {
    const t = await setup();
    const algebra = await t.store.saveCompiled({ title: "Algebra", fm: {}, topicBody: CARD([["Index laws", "none"]]).replace("# Calculus", "# Algebra"), questionsBody: "", target: 4 });
    await t.store.addRelation({ from: "calculus/limits", to: "algebra/index-laws", type: "requires" });
    const chat = await t.chatIn("teach");
    t.replies.push(`Quick check first: what is $x^2 \\cdot x^3$?\n${session('{"pendingQuestion":"What is $x^2 \\\\cdot x^3$?","helpGiven":[],"nextAction":"check","completedStep":false}')}`);
    const r1 = await t.engine.study(t.dir, chat, "");
    assert.equal(r1.decision?.action, "diagnose-prerequisite");
    t.replies.push(`Worked example: $x^4 \\cdot x = x^5$, because the indices add. Now you: ${followUp}?\n${session(JSON.stringify({ pendingQuestion: followUp, helpGiven: [], answerExposed: true, nextAction: "check", completedStep: false }))}`);
    const r2 = await t.engine.study(t.dir, chat, "just tell me the answer");
    assert.equal(r2.decision?.action, "worked-example");
    t.replies.push(`Marked.\n<attempt>{"skill":1,"result":"correct","assisted":true,"transfer":false,"error_type":"","error":""${tagExtra}}</attempt>\n${session('{"pendingQuestion":"","helpGiven":[],"nextAction":"go on","completedStep":true}')}`);
    const r = await t.engine.study(t.dir, chat, answer);
    return { r, calc: await t.store.loadState(t.dir, 4), alg: await t.store.loadState(algebra, 4) };
  };

  const a = await reveal("what is $x^3 \\cdot x^3$", ',"external":"Index laws"', "x^6");
  assert.equal(a.r.attempt?.concept, "algebra/index-laws", "the tutor's mark names the prerequisite it tested");
  assert.equal(a.calc.attempts.length, 0, "nothing is recorded against Limits");
  assert.equal(a.calc.levels[1] ?? null, null, "a worked example on index laws is not a lesson on Limits");
  assert.ok(!(1 in a.calc.taught));
  assert.deepEqual(a.alg.attempts.map((x) => [x.result, x.assisted]), [["correct", true]]);

  const b = await reveal("what is the limit of $1/x^2$ as $x$ grows", "", "0");
  assert.equal(b.r.attempt?.concept, "calculus/limits", "a follow-up the mark does not tie to a prerequisite counts for the focus");
  assert.equal(b.alg.attempts.length, 0);

  const c = await reveal("what is $x^4 \\cdot x^4$", ',"external":"Factorising"', "x^8");
  assert.equal(c.r.attempt?.concept, "calculus/limits", "a named prerequisite this concept does not have is ignored");
});

test("a 0.5.0 state file migrates: attempts move to evidence.md, links move to the course graph, nothing is lost", async () => {
  const t = await setup();
  const algebra = await t.store.saveCompiled({ title: "Algebra", fm: {}, topicBody: CARD([["Inequalities", "none"], ["Factorising", "none"]]).replace("# Calculus", "# Algebra"), questionsBody: BANK, target: 4 });
  const legacyAttempts = [
    { id: "c:2", skill: 2, question: "Differentiate x^2", answer: "2x", timestamp: "2026-11-12T10:00:00.000Z", mode: "quiz", result: "correct", confidence: 0.75, assisted: false, transfer: false, source: "bank", error: "" },
    { id: "review:Q1:1", skill: 1, question: "Limit?", answer: "Self-rated review", timestamp: "2026-11-12T11:00:00.000Z", mode: "review", result: "correct", confidence: null, assisted: true, transfer: false, source: "self", error: "" },
  ];
  const fm = ["---", "tutor: state", "topic: Calculus", "progress: 25", "due: 0", "target: 4", "focus: 2", "new_date: 2026-11-12", "new_count: 1", "updated: 2026-11-12", `evidence: ${JSON.stringify(JSON.stringify(legacyAttempts))}`, `links: ${JSON.stringify(JSON.stringify([{ skill: 1, topic: algebra, prerequisite: 2 }]))}`, `priorities: ${JSON.stringify(JSON.stringify({ 2: 3 }))}`, "---"];
  const body = ["## Skill map", "", "| # | Subskill | Level | Bank |", "| --- | --- | --- | --- |", "| 1 | Limits | 3 | 2/2 |", "| 2 | Derivatives | 2 | 1/1 |", "| 3 | Chain rule | - | 0/0 |", "", "## Misconceptions", "", "- thinks the derivative of a product is the product of derivatives", "", "## Review schedule", "", "| Card | Due | Interval | Ease | Reps | Lapses |", "| --- | --- | --- | --- | --- | --- |", "| Q1 | 2026-11-15 | 3 | 2.5 | 2 | 0 |", ""];
  t.fs.files.set(`${t.dir}/state.md`, [...fm, ...body].join("\n"));
  t.fs.files.delete(`${t.dir}/evidence.md`);

  const state = await t.store.loadState(t.dir, 4);
  assert.deepEqual(state.levels, { 1: 3, 2: 2, 3: null }, "levels are untouched");
  assert.deepEqual(state.misconceptions, ["thinks the derivative of a product is the product of derivatives"]);
  assert.deepEqual(state.cards["Q1"], { due: "2026-11-15", interval: 3, ease: 2.5, reps: 2, lapses: 0 }, "review history is untouched");
  assert.deepEqual(state.priorities, { 2: 3 });
  assert.deepEqual(state.attempts.map((a) => [a.id, a.v, a.grading, a.concept, a.confidence]), [["c:2", 2, "deterministic", "calculus/derivatives", 0.75], ["review:Q1:1", 2, "self", "calculus/limits", null]]);
  assert.equal(state.links, undefined);
  const evidence = await t.fs.read(`${t.dir}/evidence.md`);
  assert.equal(evidence.split("\n").filter((l) => l.startsWith("{")).length, 2);
  const stateFile = await t.fs.read(`${t.dir}/state.md`);
  assert.ok(!/^evidence:/m.test(stateFile) && !/^links:/m.test(stateFile), "the state file no longer carries them");
  assert.deepEqual((await t.store.externalPrereqs(t.dir, 4)).map((e) => [e.skill, e.name, e.topic]), [[1, "Factorising", "Algebra"]]);
  const graph = parseTopicGraph(await t.fs.read(`${t.dir}/graph.md`))!;
  assert.ok(graph.edges.some((e) => e.to === "algebra/factorising" && e.status === "reviewed" && e.source === "learner"));
  // Loading again changes nothing and doubles nothing.
  const again = await t.store.loadState(t.dir, 4);
  assert.equal(again.attempts.length, 2);
  assert.equal(await t.fs.read(`${t.dir}/evidence.md`), evidence);

  // A link whose topic is missing is kept for later, not dropped.
  t.fs.files.set(`${t.dir}/state.md`, [...fm.map((l) => (l.startsWith("links:") ? `links: ${JSON.stringify(JSON.stringify([{ skill: 1, topic: "Tutor/Topics/Gone", prerequisite: 1 }]))}` : l)), ...body].join("\n"));
  assert.deepEqual((await t.store.loadState(t.dir, 4)).links, [{ skill: 1, topic: "Tutor/Topics/Gone", prerequisite: 1 }]);
});

// ---------- tools ----------

test("tools validate input, time out, cancel and report failures as results", async () => {
  const reg = new ToolRegistry();
  reg.register<{ ms: number }, string>({
    name: "wait",
    description: "waits",
    kind: "inspection",
    timeoutMs: 40,
    validate: (raw: any) => (raw && typeof raw.ms === "number" ? { ms: raw.ms } : "ms must be a number"),
    run: (i) => new Promise((resolve, reject) => setTimeout(() => (i.ms === 1 ? reject(new Error("boom")) : resolve({ output: "done", assumptions: ["nothing"] })), i.ms)),
  });
  assert.deepEqual([(await reg.run("nope", {})).error], ["Unknown tool: nope."]);
  const bad = await reg.run("wait", { ms: "x" });
  assert.deepEqual([bad.ok, bad.error], [false, "Invalid input: ms must be a number"]);
  const ok = await reg.run<string>("wait", { ms: 5 });
  assert.deepEqual([ok.ok, ok.output, ok.assumptions, ok.kind], [true, "done", ["nothing"], "inspection"]);
  const slow = await reg.run("wait", { ms: 500 });
  assert.deepEqual([slow.ok, slow.timedOut], [false, true]);
  const err = await reg.run("wait", { ms: 1 });
  assert.deepEqual([err.ok, err.error], [false, "boom"]);
  const ctl = new AbortController();
  const pending = reg.run("wait", { ms: 30 }, { signal: ctl.signal, timeoutMs: 1000 });
  ctl.abort();
  const stopped = await pending;
  assert.deepEqual([stopped.ok, stopped.cancelled], [false, true]);
  assert.equal(reg.log.length, 6, "every call is on record, failures included");

  // The engine's own tools.
  const t = await setup();
  assert.deepEqual(t.engine.tools.list().map((x) => x.name), ["maths.equivalent", "maths.check", "maths.compute", "vault.transcript", "vault.source", "vault.passage", "course.lesson", "graph.inspect"]);
  const state = await t.store.loadState(t.dir, 4);
  state.levels = { 1: 1, 2: 3, 3: null };
  await t.store.saveState(t.dir, state);
  const g = await t.engine.tools.run<any>("graph.inspect", { dir: t.dir, skill: 2 });
  assert.deepEqual([g.output.prerequisites, g.output.dependents, g.output.weak], [["Limits (level 1)"], ["Chain rule (level unset)"], ["Limits (level 1)"]]);
  assert.equal((await t.engine.tools.run("maths.equivalent", { expected: "2*x", given: "x+x" })).ok, false, "with no SymPy the tool fails; it does not answer");
  assert.deepEqual(bestExcerpts(["the chain rule composes functions", "limits of sequences", "apply the chain rule to sin(x^2)"], "how do I use the chain rule?", 50), ["the chain rule composes functions", "apply the chain rule to sin(x^2)"]);
});

test("source excerpts are sent only when a step needs them, quoted exactly", async () => {
  const t = await setup();
  t.engine.readNote = async (name) => (name === "Calc notes" ? "Unrelated paragraph about the history of the calculus and who invented it.\n\nThe derivative of $x^n$ is $nx^{n-1}$, which my lecturer calls the power rule for derivatives.\n\nShopping list." : null);
  const state = await t.store.loadState(t.dir, 4);
  state.levels = { 1: 3, 2: 1, 3: null };
  state.focus = 2;
  await t.store.saveState(t.dir, state);
  const chat = await t.chatIn("teach");
  t.replies.push(`Lesson.\n${session('{"pendingQuestion":"Differentiate $x^7$","helpGiven":[],"nextAction":"check","completedStep":false}')}`, "Checked.");
  const r = await t.engine.study(t.dir, chat, "");
  assert.equal(r.decision!.action, "explain");
  assert.match(t.calls[0].input, /# From the course sources \(exact quotes\)\n\[\[Calc notes\]\]: The derivative of \$x\^n\$ is \$nx\^\{n-1\}\$/);
  assert.ok(!/Shopping list/.test(t.calls[0].input));
  // Checking an answer needs no source excerpt.
  await t.engine.study(t.dir, chat, "7x^6");
  assert.ok(!/From the course sources/.test(t.calls[1].input));
  assert.deepEqual(JSON.parse(String((await t.store.loadChat(chat)).fm.session)).sources, ["[[Calc notes]]"]);
});


test("synoptic links preserve their learning purpose, reject reversed duplicates, and never order study", async () => {
  const store = new Store(new MemFS(), "Tutor");
  const dir = await store.saveCompiled({ title: "Connections", fm: {}, topicBody: CARD(NAMES), questionsBody: BANK, target: 4 });
  const graph = await store.loadGraph(dir);
  const [a, b] = graph.concepts;
  const edge = { from: a.id, to: b.id, type: "synoptic" as const, status: "inferred" as const, source: "model suggestion", rationale: "Use limits to justify a derivative.", challenge: "Derive the derivative of x squared from its difference quotient." };
  await store.addRelation(edge);
  assert.deepEqual((await store.loadGraph(dir)).edges.find(e => e.type === "synoptic"), edge);
  await assert.rejects(store.addRelation({ ...edge, from: b.id, to: a.id }), /already exists/);
  await store.setRelationStatus(edge, "rejected");
  assert.equal((await store.loadGraph(dir)).edges.find(e => e.type === "synoptic")?.status, "rejected");
  await assert.rejects(store.addRelation(edge), /already exists/);
  await store.setRelationStatus(edge, "reviewed");
  assert.equal((await store.loadGraph(dir)).edges.find(e => e.type === "synoptic")?.status, "reviewed");
  await assert.rejects(store.addRelation({ ...edge, to: graph.concepts[2].id, rationale: "" }), /explanation/);
});

test("tool validation and synchronous failures return structured errors and timeouts signal cancellation", async () => {
  const tools = new ToolRegistry();
  tools.register({ name: "bad-validator", description: "test", kind: "inspection", timeoutMs: 20, validate: () => { throw new Error("bad"); }, run: async () => ({ output: null }) });
  assert.equal((await tools.run("bad-validator", {})).ok, false);
  let aborted = false;
  tools.register({ name: "slow", description: "test", kind: "inspection", timeoutMs: 5, validate: () => ({}), run: async (_, ctx) => new Promise<{ output: null }>(resolve => { ctx.signal?.addEventListener("abort", () => { aborted = true; resolve({ output: null }); }); }) });
  assert.equal((await tools.run("slow", {})).timedOut, true);
  assert.equal(aborted, true);
});


test("legacy questions remain open when a reassurance follows the question mark", async () => {
  const question = 'What does this print, and why? If unsure, say "I do not know".';
  assert.equal(openQuestion(question), question);
  const t = await setup();
  const path = await t.chatIn("tutor");
  const chat = await t.store.loadChat(path);
  chat.messages = [{ role: "tutor", text: question }, { role: "you", text: "5" }];
  chat.fm.session = JSON.stringify({ version: 1, pendingQuestion: "", completedStep: false });
  const state = await t.store.loadState(t.dir, 4);
  assert.equal(sessionFor(chat, state, "tutor").pendingQuestion, question);
  chat.fm.session = JSON.stringify({ version: 1, pendingQuestion: "", completedStep: true });
  assert.equal(sessionFor(chat, state, "tutor").pendingQuestion, "", "a completed legacy step stays closed");
  chat.fm.session = JSON.stringify({ version: 2, pendingQuestion: "", completedStep: false });
  assert.equal(sessionFor(chat, state, "tutor").pendingQuestion, "", "current explicit records remain authoritative");
});

test("synoptic proposals validate target IDs, stay unreviewed and leave mastery unchanged", async () => {
  const t = await setup();
  const [a, b] = (await t.store.loadGraph(t.dir)).concepts;
  const before = await t.store.loadState(t.dir, 4);
  t.replies.push(JSON.stringify({ target: "invented/concept", rationale: "A connection", challenge: "A joint problem" }));
  await assert.rejects(t.engine.suggestSynoptic(a.id), /No valid/);
  assert.equal((await t.store.loadGraph(t.dir)).edges.filter(e => e.type === "synoptic").length, 0);
  t.replies.push(JSON.stringify({ target: b.id, rationale: "Limits define derivatives.", challenge: "Use the limit definition to differentiate x squared." }));
  const result = await t.engine.suggestSynoptic(a.id);
  assert.equal(result.edge.status, "inferred");
  assert.equal(result.edge.source, "model suggestion");
  assert.deepEqual((await t.store.loadState(t.dir, 4)).levels, before.levels);
  assert.deepEqual((await t.store.loadState(t.dir, 4)).attempts, before.attempts);
  t.replies.push(o => {
    assert.ok(!JSON.parse(o.input).candidates.some((c: { id: string }) => c.id === b.id), "existing pairs are not proposed again");
    return JSON.stringify({ target: "", rationale: "", challenge: "" });
  });
  await assert.rejects(t.engine.suggestSynoptic(a.id), /No valid/);
});

// ---------- objective versions: editorial edits keep mastery, material changes ask for a recheck ----------

test("objective versions: editorial edits are told apart from material changes, conservatively", () => {
  const cls = (a: string, b: string) => classifyChange(materialText([a]), materialText([b])).change;
  // Editorial: formatting, case, spacing, punctuation, links, a typo, a filler word.
  assert.equal(cls("The chain rule differentiates compositions.", "The **chain rule**  differentiates\ncompositions"), "same");
  assert.equal(cls("See [[Calc notes|notes]] for $x^n$.", "See Calc notes for x^n"), "same");
  assert.equal(cls("Differentiate a composition of functions", "Diferentiate a composition of functions"), "editorial");
  assert.equal(cls("Find the derivative of a product", "Find derivative of a product"), "editorial");
  // Material: numbers, negation, connectives, conditions, a different word, a different order.
  const material: [string, string][] = [
    ["valid for n > 1", "valid for n > 2"],
    ["the series converges", "the series does not converge"],
    ["compute the derivative", "compute and interpret the derivative"],
    ["valid for continuous f", "valid for differentiable f"],
    ["a stack is last in first out", "a queue is last in first out"],
    ["a implies b", "b implies a"],
    ["state the rule", "state the rule unless f is constant"],
  ];
  for (const [a, b] of material) assert.equal(cls(a, b), "material", `${a} → ${b}`);
  assert.match(classifyChange(materialText(["valid for n > 1"]), materialText(["valid for n > 2"])).why, /"1" became "2"/);
});

test("objective versions: ids that move keep their version; new, changed or uncomparable objectives are dated", () => {
  const cur = (id: string, text: string, subskills = [1]) => {
    const material = materialText([text]);
    return { id, subskills, sources: ["p1"], material, fingerprint: digest(material) };
  };
  const first = versionObjectives({ previous: null, current: [cur("O1a", "Derive the power rule"), cur("O1b", "Apply the chain rule", [2])], at: "2026-11-01T00:00:00.000Z", previousText: () => null });
  assert.deepEqual(first.map((v) => [v.id, v.v, v.materialAt]), [["O1a", 1, undefined], ["O1b", 1, undefined]], "a first compile sets the baseline and dates nothing");
  const texts = new Map([[first[0].fingerprint, materialText(["Derive the power rule"])], [first[1].fingerprint, materialText(["Apply the chain rule"])]]);
  const next = versionObjectives({
    previous: first,
    // O1a's passage moved, so its id changed; its text gained a typo fix. O1b gained a condition. O1c is new.
    current: [cur("O1z", "Derive the powr rule"), cur("O1b", "Apply the chain rule to differentiable functions", [2]), cur("O1c", "Use implicit differentiation", [3])],
    at: "2026-11-05T00:00:00.000Z",
    previousText: (fp) => texts.get(fp) ?? null,
  });
  assert.deepEqual(next.map((v) => [v.id, v.v, v.materialAt ?? null, v.aliases ?? []]), [
    ["O1z", 1, null, ["O1a"]],
    ["O1b", 2, "2026-11-05T00:00:00.000Z", []],
    ["O1c", 1, "2026-11-05T00:00:00.000Z", []],
  ]);
  assert.match(next[1].why!, /added "to differentiable functions"/);
  // Without the earlier text there is nothing to compare: the change counts as material.
  const blind = versionObjectives({ previous: first, current: [cur("O1a", "Derive the power rule for integers")], at: "2026-11-06T00:00:00.000Z", previousText: () => null });
  assert.deepEqual([blind[0].v, blind[0].why], [2, "the earlier text is not available to compare"]);
  assert.deepEqual(conceptRevisions(next)[2], { refs: ["O1b@2"], at: "2026-11-05T00:00:00.000Z", why: 'O1b changed: added "to differentiable functions"' });
});

test("objective versions: a material change asks for one focused recheck; an editorial edit keeps everything", async () => {
  const t = await setup();
  const today = new Date().toISOString().slice(0, 10);
  t.setDay(today);
  const req = (text: string) => ({ mode: "notes" as const, material: [{ name: "Calc notes", text }], research: false });
  let pkg = await t.engine.writePackage(t.dir, req("The derivitive of x^n is n x^(n-1) for every real n."), null);
  assert.deepEqual(pkg.versions!.map((v) => [v.id, v.v, v.materialAt ?? null]), [["S1", 1, null], ["S2", 1, null], ["S3", 1, null]]);
  let st = await t.store.loadState(t.dir, 4);
  assert.deepEqual([st.objectiveRefs, st.revisions], [{ 1: ["S1@1"], 2: ["S2@1"], 3: ["S3@1"] }, {}]);
  // Unaided successes on subskill 2 recorded against version 1, on two days, one a transfer.
  st.attempts.push(
    attempt({ id: "v1", skill: 2, concept: st.concepts[2], questionId: "Q2", objectives: ["S2@1"], timestamp: "2026-11-10T10:00:00.000Z" }),
    attempt({ id: "v2", skill: 2, concept: st.concepts[2], questionId: "Q3", objectives: ["S2@1"], timestamp: "2026-11-11T10:00:00.000Z", transfer: true, taskType: "transfer" }),
  );
  st.levels[1] = 4; // the prerequisite is in place, so the check on subskill 2 is what remains
  st.levels[2] = 4;
  await t.store.saveState(t.dir, st);
  const before = F.mastery(await t.store.loadState(t.dir, 4), 2);

  // Editorial: a typo fixed, emphasis, maths delimiters and a line break.
  pkg = await t.engine.writePackage(t.dir, req("The **derivative** of $x^n$ is n x^(n-1)\nfor every real n"), pkg);
  assert.deepEqual(pkg.versions!.map((v) => [v.v, v.materialAt ?? null]), [[1, null], [1, null], [1, null]]);
  st = await t.store.loadState(t.dir, 4);
  let m = F.mastery(st, 2);
  assert.deepEqual([m.level, m.supported, m.evidence.recheck, m.evidence.nextCheck], [4, before.supported, null, before.evidence.nextCheck], "nothing about the evidence moved");

  // Material: the source is corrected with an exception.
  pkg = await t.engine.writePackage(t.dir, req("The derivative of x^n is n x^(n-1) for every real n except n = 0."), pkg);
  assert.deepEqual(pkg.versions!.map((v) => v.v), [2, 2, 2]);
  st = await t.store.loadState(t.dir, 4);
  assert.deepEqual(st.objectiveRefs?.[2], ["S2@2"]);
  assert.match(st.revisions?.[2]?.why ?? "", /^S2 changed: .*"except n = 0"/);
  m = F.mastery(st, 2);
  assert.equal(m.level, 4, "the level is not reset");
  assert.equal(m.supported, before.supported, "earlier evidence still counts");
  assert.equal(m.evidence.recheck?.why, st.revisions?.[2]?.why);
  assert.ok(checkDue(m.evidence, today), "the recheck is due now");
  // The policy asks for it, and says why.
  const input = (t.engine as any).policyInput({ mode: "auto", state: st, pre: await t.store.prereqs(t.dir, await t.store.loadTopic(t.dir)), chat: await t.store.loadChat(await t.chatIn("auto")), session: sessionFor(await t.store.loadChat(await t.chatIn("auto")), st, "auto"), intent: "none", questions: await t.store.loadQuestions(t.dir), external: [] });
  const sk = input.skills.find((k: SkillInput) => k.n === 2);
  assert.deepEqual([sk.checkDue, typeof sk.recheck], [true, "string"]);
  const d = decide({ ...input, focus: 2 });
  assert.equal(d.action, "retrieval");
  assert.match(d.reason, /The course changed what Derivatives asks for/);
  // Source → objective → question → attempt.
  assert.deepEqual(traceAttempt(pkg, st.attempts.find((a) => a.id === "v1")!), [{ id: "S2", assessed: 1, current: 2, sources: ["[[Calc notes]]"], questions: pkg.objectives.find((o) => o.id === "S2")!.questions }]);

  // One unaided answer on the new version settles it, whatever else is on record.
  st.attempts.push(attempt({ id: "v3", skill: 2, concept: st.concepts[2], questionId: "Q2", ...F.objectiveStamp(st, 2), timestamp: new Date().toISOString() }));
  assert.equal(F.mastery(st, 2).evidence.recheck, null);
  // Attempts from before versions were recorded are dated instead: one before the change does not count as current.
  const legacy = skillEvidence([attempt({ id: "old", skill: 2, timestamp: "2026-11-10T10:00:00.000Z" })], 2, { at: "2026-11-12T00:00:00.000Z", why: "S2 changed" });
  assert.equal(legacy.recheck?.since, "2026-11-12T00:00:00.000Z");
  assert.equal(legacy.nextCheck, "2026-11-11", "the earlier of the normal check and the change day");
});

