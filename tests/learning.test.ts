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
import { sealedId, splitSealed } from "../src/sealed";
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
  assert.deepEqual(t.engine.tools.list().map((x) => x.name), ["maths.equivalent", "maths.check", "maths.compute", "vault.transcript", "vault.source", "vault.passage", "course.lesson", "graph.inspect", "code.run"]);
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


test("question families: practice never uses a family kept for assessment, and a transfer check takes an unmet one first", async () => {
  const { pickQuizQuestion } = await import("../src/engine-common");
  const { questionFamilies } = await import("../src/coursepkg");
  const q = (id: string, subskill: number, family: string, task = "application"): F.Question => ({ id, subskill, type: "short", question: id, options: [], answer: "1", explanation: "", family, task });
  const bank = [q("Q1", 1, "a"), q("Q2", 1, "b"), q("Q3", 1, "c"), q("Q4", 1, "c"), q("Q5", 2, "d"), q("Q6", 2, "e", "transfer")];
  assert.deepEqual(questionFamilies(bank).filter((f) => f.reserved).map((f) => f.id), ["c", "e"], "the last of three families, and every transfer family");

  const s = F.newState(F.parseTopic(CARD(NAMES)), 4);
  const today = "2026-11-17";
  const pick = (asked: string[], purpose?: "practice" | "retrieval" | "transfer", only?: (x: F.Question) => boolean) => pickQuizQuestion(bank, s, asked, today, { purpose, only })?.id ?? null;
  const one = (x: F.Question) => x.subskill === 1;
  assert.equal(pick(["Q1", "Q2"], "practice", one), null, "practice has nothing left once only kept families remain");
  assert.equal(pick([], undefined, (x) => x.subskill === 2), "Q5", "Practise mode skips the transfer family too");
  assert.equal(pick([], "transfer", one), "Q3", "a transfer check takes the kept family first");
  assert.equal(pick(["Q1"], "retrieval", one), "Q2", "a retrieval check spends a kept family only when nothing else is left");
  assert.equal(pick(["Q1", "Q2"], "retrieval", one), "Q3");

  // Once the learner has met family c, a transfer check prefers a family still unmet.
  s.attempts.push(attempt({ id: "a1", skill: 1, questionId: "Q3", timestamp: "2026-11-16T10:00:00.000Z" }));
  s.attempts.push(attempt({ id: "a2", skill: 1, questionId: "Q1", timestamp: "2026-11-16T10:05:00.000Z" }));
  assert.equal(pick(["Q3"], "transfer", one), "Q2", "b is the only family not met yet");

  // Placement leaves the kept family alone when the subskill has another.
  const placed = F.placementQuestions([q("P1", 1, "x", "transfer"), q("P2", 1, "y")], F.newState(F.parseTopic(CARD(NAMES)), 4));
  assert.deepEqual(placed.map((x) => x.id), ["P2"]);
});

test("question families: a family kept for assessment is never a new review card or a Spaced Repetition card", () => {
  const q = (id: string, subskill: number, family: string, task = "application"): F.Question => ({ id, subskill, type: "short", question: id, options: [], answer: "1", explanation: "", family, task });
  const bank = [q("Q1", 1, "a"), q("Q2", 1, "b"), q("Q3", 1, "c"), q("Q4", 1, "d", "transfer")];
  const s = F.newState(F.parseTopic(CARD(NAMES)), 4);
  assert.deepEqual(F.reviewQueue(bank, s, "2026-11-17", 10).map((x) => x.id), ["Q1", "Q2", "Q3"]);
  s.cards["Q4"] = F.schedule(undefined, "good", "2026-11-01");
  assert.ok(F.reviewQueue(bank, s, "2026-11-17", 10).some((x) => x.id === "Q4"), "a family already met may be reviewed");
  assert.ok(!F.buildSrNote(bank, "t").includes("Q4"));
});

/** A topic whose one bank question has a generator with worked steps and a known mistake. No model call is allowed. */
async function motion() {
  const gen = { v: 1, params: { u: { min: 1, max: 9 }, a: { min: 1, max: 5 }, t: { min: 2, max: 8 } },
    template: "A cart starts at {u} m/s and speeds up at {a} m/s² for {t} s. What is its final speed in m/s?", answer: "u+a*t",
    steps: ["Use v = u + a t.", "v = {u} + {a} × {t} = {=u+a*t}."],
    mistakes: [{ label: "subtracted the change in speed", expr: "u-a*t", step: 1, says: "v = {u} − {a} × {t} = {=u-a*t}." }],
    tests: [{ params: { u: 3, a: 2, t: 4 }, answer: 11 }] };
  const bank = `### Q1\nsubskill: 1\ntype: short\ntask: application\nfamily: s1-velocity\nquestion: A cart starts at 3 m/s and speeds up at 2 m/s² for 4 s. What is its final speed in m/s?\nanswer: 11\nexplanation: v = u + at = 3 + 2·4 = 11.\ngenerator: ${JSON.stringify(gen)}\n`;
  const fs = new MemFS();
  const store = new Store(fs, "Tutor", () => "2026-11-17");
  const settings: any = { claudePath: "", chatModel: "sonnet", compileModel: "sonnet", utilityModel: "haiku", effort: "low", targetLevel: 4, maxChatWords: 600, maxTopicWords: 2000, singlePassWords: 6000, smartRouting: false, hardEffort: "high", bankQuiz: true, codePlacement: true };
  const engine = new Engine(store, () => settings, () => "2026-11-17");
  let calls = 0;
  (engine as any).call = async () => { calls++; throw new Error("no model call expected"); };
  const dir = await store.saveCompiled({ title: "Motion", fm: { subject: "none" }, topicBody: CARD(NAMES), questionsBody: bank, target: 4 });
  const questions = await store.loadQuestions(dir);
  assert.ok(questions[0].generator, "the spec passed its checks and is kept with the question");
  return { store, engine, dir, questions, fs, calls: () => calls };
}

test("question families: code asks new numbers, sets a repair task after a known mistake, then checks the fix without help", async () => {
  const { taskOf } = await import("../src/bankvariants");
  const { store, engine, dir, questions, calls } = await motion();
  const chat = await store.newChat(dir, "Motion", "quiz", new Date(2026, 10, 17, 9, 0));
  const card = async () => F.fmStr((await store.loadChat(chat)).fm, "card");
  const answerOf = async () => taskOf(questions, await card())!.inst!;

  let r = await engine.quizTurn(dir, chat, "");
  assert.equal(await card(), "Q1", "the question as compiled comes first");
  r = await engine.quizTurn(dir, chat, "11");
  assert.match(r.reply, /\*\*Correct\.\*\*/);
  assert.equal(await card(), "Q1~1", "met once, it comes back with new numbers");

  const first = await answerOf();
  r = await engine.quizTurn(dir, chat, String(first.params.u - first.params.a * first.params.t));
  assert.match(r.reply, /\*\*Incorrect\.\*\* Your answer is what this mistake gives: subtracted the change in speed\./);
  assert.equal(r.attempt?.errorType, "subtracted the change in speed");
  assert.equal(await card(), "Q1~1#fix0", "a worked solution with that mistake comes next");
  assert.match(r.reply, /one mistake in it/);

  const cardsNow = async () => (await store.loadState(dir, 4)).cards;
  const mistakeCard = "Q1#m-subtracted-the-change-in-speed";
  const lapsed = await cardsNow();
  assert.ok(lapsed[mistakeCard], "the known mistake starts a card of its own");
  assert.equal(lapsed[mistakeCard].lapses, 1, "scheduled as a miss");
  r = await engine.quizTurn(dir, chat, `step 2, answer ${first.answerText}, it should be a plus`);
  assert.match(r.reply, /\*\*Correct\.\*\*/);
  assert.equal(r.attempt?.assisted, true, "the repair is helped work");
  assert.deepEqual(await cardsNow(), lapsed, "helped work moves no card: the solution was in view");
  assert.equal(r.attempt?.taskType, "error-finding");
  assert.equal(await card(), "Q1~2", "then new numbers check the fix");

  const second = await answerOf();
  r = await engine.quizTurn(dir, chat, second.answerText);
  assert.match(r.reply, /\*\*Correct\.\*\*/);
  assert.equal(r.attempt?.assisted, false);
  assert.equal(r.attempt?.family, "s1-velocity", "same family: practice, not transfer");
  assert.equal(calls(), 0, "no model call anywhere");

  const st = await store.loadState(dir, 4);
  assert.deepEqual(Object.keys(st.cards).sort(), ["Q1", mistakeCard], "new numbers share the question's card; the mistake has its own");
  assert.ok(st.cards.Q1.reps > lapsed.Q1.reps, "an unaided right answer on new numbers advances the question's card");
  assert.ok(st.cards[mistakeCard].reps > lapsed[mistakeCard].reps && st.cards[mistakeCard].due > lapsed[mistakeCard].due, "and the fresh check moves the mistake's card out");
  const e = skillEvidence(st.attempts, 1);
  assert.equal(e.independentCorrect, 1, "new numbers for one question count as one question");
  assert.equal(e.delayedTransfer, false);
});

test("question families: in Adaptive mode, guided practice is a faded worked example on new numbers, marked by code as helped work", async () => {
  const { store, engine, dir, calls } = await motion();
  const st = await store.loadState(dir, 4);
  st.levels[1] = 2;
  st.taught[1] = "2026-11-16";
  st.focus = 1;
  await store.saveState(dir, st);
  const chat = await store.newChat(dir, "Motion", "auto", new Date(2026, 10, 17, 9, 0));
  const r = await engine.study(dir, chat, "");
  assert.deepEqual([r.decision!.action, r.decision!.local, r.local], ["guided-practice", "bank", true]);
  assert.match(r.reply, /A worked solution with its last step left for you:\n\n1\. Use v = u \+ a t\.\n2\. Step 2: …/);
  const card = F.fmStr((await store.loadChat(chat)).fm, "card");
  assert.equal(card, "Q1~1#fade1");
  const { taskOf } = await import("../src/bankvariants");
  const inst = taskOf(await store.loadQuestions(dir), card)!.inst!;
  const a = await engine.study(dir, chat, inst.answerText);
  assert.match(a.reply, /\*\*Correct\.\*\*/);
  assert.deepEqual([a.attempt!.assisted, a.attempt!.grading, a.attempt!.verification], [true, "deterministic", "verified"]);
  assert.match(a.attempt!.assistance.join(" "), /faded worked example/);
  assert.equal(calls(), 0);
});

test("question families: a due mistake card sets a fresh check, and a known mistake card never counts as a flashcard to review", async () => {
  const { store, engine, dir, questions, calls, fs } = await motion();
  const { taskOf } = await import("../src/bankvariants");
  const chat = await store.newChat(dir, "Motion", "quiz", new Date(2026, 10, 17, 9, 0));
  const card = async (c = chat) => F.fmStr((await store.loadChat(c)).fm, "card");
  await engine.quizTurn(dir, chat, "");
  await engine.quizTurn(dir, chat, "11");
  const first = taskOf(questions, await card())!.inst!;
  await engine.quizTurn(dir, chat, String(first.params.u - first.params.a * first.params.t));
  const st = await store.loadState(dir, 4);
  const mistakeCard = "Q1#m-subtracted-the-change-in-speed";
  assert.ok(st.cards[mistakeCard]);
  assert.equal(F.dueCount(st, "2099-01-01"), 1, "only the question's card is a flashcard to review");
  assert.equal(F.reviewCards(st).length, 1);
  // Due and in a chat of its own: the check comes first, on numbers not used before, with no model call.
  st.cards[mistakeCard] = { ...st.cards[mistakeCard], due: "2026-11-17" };
  await store.saveState(dir, st);
  const fresh = await store.newChat(dir, "Motion", "quiz", new Date(2026, 10, 17, 10, 0));
  await engine.quizTurn(dir, fresh, "");
  assert.match(await card(fresh), /^Q1~[2-9]$/, "new numbers, not the seeds already used");
  assert.equal(calls(), 0);
  // Not due, or the question already asked in this chat: no check is set.
  const { dueMistake } = await import("../src/bankvariants");
  assert.equal(dueMistake(questions, { ...st, cards: { ...st.cards, [mistakeCard]: { ...st.cards[mistakeCard], due: "2026-12-30" } } }, "2026-11-17", []), null);
  assert.equal(dueMistake(questions, st, "2026-11-17", ["Q1~7"]), null, "this chat has met the question already");
  assert.match(dueMistake(questions, st, "2026-11-17", [])!.reason, /subtracted the change in speed/);
  // The cards of known mistakes go with their questions through a refresh that keeps them.
  const raw = fs.files.get(`${dir}/questions.md`) as string;
  const questionsBody = raw.slice(raw.indexOf("### Q1"));
  await store.saveCompiled({ title: "Motion", fm: { subject: "none" }, topicBody: CARD(NAMES), questionsBody, target: 4, existingDir: dir, keepCards: ["Q1"] });
  assert.ok((await store.loadState(dir, 4)).cards[mistakeCard], "kept with Q1");
  await store.saveCompiled({ title: "Motion", fm: { subject: "none" }, topicBody: CARD(NAMES), questionsBody, target: 4, existingDir: dir });
  assert.ok(!(await store.loadState(dir, 4)).cards[mistakeCard], "a new bank starts its schedule again");
});

test("question families: a contrasting pair follows the faded examples, is marked by code as helped work, and moves no card", async () => {
  const { taskOf, pairedFor, markTask, followUp, mistakeUpdates } = await import("../src/bankvariants");
  const { parseTaskId } = await import("../src/families");
  const { store, engine, dir, questions, calls } = await motion();
  const base = questions[0];
  const s0 = F.newState(F.parseTopic(CARD(NAMES)), 4);
  const q = pairedFor(base, s0, [])!;
  assert.match(q.id, /^Q1~1#pair0$/);
  assert.deepEqual(parseTaskId(q.id), { base: "Q1", seed: 1, kind: "pair", k: 0 });
  assert.match(q.question, /Case 1, worked:[\s\S]*Answer: \d+[\s\S]*Case 2 is the same question with one value changed \(\w+ goes from \d+ to \d+\)/);
  const task = taskOf(questions, q.id)!;
  assert.equal(task.kind, "pair");
  assert.equal(task.question.id, q.id, "rebuilt from its seed");
  assert.equal(markTask(task, task.inst!.answerText)?.grade, "good", "Case 2's answer is the one marked");
  assert.equal(markTask(task, "-999")?.grade, "again");
  assert.equal(followUp(task, { result: "incorrect", errorType: "subtracted the change in speed" } as any, s0, []), null, "no repair on a pair: its ids name the first case");
  assert.deepEqual(mistakeUpdates(task, { result: "correct", errorType: "", assisted: true, answerExposed: false }, s0), [], "helped work moves no mistake card");
  // At most two answered right per question.
  const done = (id: string) => ({ ...(F.newState(F.parseTopic(CARD(NAMES)), 4)), attempts: [id, "Q1~2#pair0"].map((qid, i) => attempt({ id: `p${i}`, skill: 1, questionId: qid, result: "correct" })) });
  assert.equal(pairedFor(base, done("Q1~1#pair0"), []), null);

  // In Adaptive mode, once the faded example has been answered, guided practice is a pair.
  const st = await store.loadState(dir, 4);
  st.levels[1] = 2;
  st.taught[1] = "2026-11-16";
  st.focus = 1;
  await store.saveState(dir, st);
  const chat = await store.newChat(dir, "Motion", "auto", new Date(2026, 10, 17, 9, 0));
  const cardOf = async () => F.fmStr((await store.loadChat(chat)).fm, "card");
  await engine.study(dir, chat, "");
  assert.equal(await cardOf(), "Q1~1#fade1");
  await engine.study(dir, chat, taskOf(questions, "Q1~1#fade1")!.inst!.answerText);
  // The learner stays at the same level, so guided practice comes up again, and the faded examples have run out.
  const again = await store.loadState(dir, 4);
  for (const n of Object.keys(again.names).map(Number)) again.levels[n] = n === 1 ? 2 : 4;
  again.focus = 1;
  await store.saveState(dir, again);
  const second = await store.newChat(dir, "Motion", "auto", new Date(2026, 10, 17, 9, 30));
  const paired = await engine.study(dir, second, "");
  assert.deepEqual([paired.decision?.action, paired.decision?.local], ["guided-practice", "bank"]);
  const card = F.fmStr((await store.loadChat(second)).fm, "card");
  assert.equal(card, "Q1~2#pair0");
  const before = (await store.loadState(dir, 4)).cards;
  const a = await engine.study(dir, second, taskOf(questions, card)!.inst!.answerText);
  assert.match(a.reply, /\*\*Correct\.\*\*/);
  assert.deepEqual([a.attempt!.assisted, a.attempt!.grading], [true, "deterministic"]);
  assert.match(a.attempt!.assistance.join(" "), /contrasting pair/);
  assert.deepEqual((await store.loadState(dir, 4)).cards, before, "helped work moves no card");
  assert.equal(calls(), 0);
});

// ---------- coverage of a subskill's ideas, and building on the last question ----------

const IDEAS_CARD = [
  "# Maths", "", "## Overview", "Calculus.", "", "## Objectives",
  "- O1: Differentiate polynomials with the power rule (Spec 1.1)",
  "- O2: Integrate polynomials with the reverse power rule (Spec 1.2)",
  "", "## Subskills", "",
  "### 1. Calculus basics", "prerequisites: none", "objectives: O1, O2",
  "- Differentiate polynomials with the power rule ([[Notes]]).",
  "- Integrate polynomials with the reverse power rule ([[Notes]]).",
  "worked example:", "d/dx x^3 = 3x^2.", "",
].join("\n");
const IDEAS_BANK = [
  ["Q1", "Differentiate x^3 at x = 2 with the power rule: what is the value of the derivative?", "12"],
  ["Q2", "Differentiate x^4 at x = 1 with the power rule: what is the value of the derivative?", "4"],
  ["Q3", "Integrate 2x from 0 to 3 with the reverse power rule: what is the value?", "9"],
  ["Q4", "Integrate 3x^2 from 0 to 2 with the reverse power rule: what is the value?", "8"],
].map(([id, q, a]) => `### ${id}\nsubskill: 1\ntype: short\ntask: application\nfamily: ${id.toLowerCase()}\nquestion: ${q}\nanswer: ${a}\nexplanation: Worked by the rule.\n`).join("\n");

async function ideas() {
  const fs = new MemFS();
  const store = new Store(fs, "Tutor", () => "2026-11-17");
  const settings: any = { claudePath: "", chatModel: "sonnet", compileModel: "sonnet", utilityModel: "haiku", effort: "low", targetLevel: 4, maxChatWords: 600, maxTopicWords: 2000, singlePassWords: 6000, smartRouting: false, hardEffort: "high", bankQuiz: true, codePlacement: false };
  const engine = new Engine(store, () => settings, () => "2026-11-17");
  let calls = 0;
  (engine as any).call = async () => { calls++; throw new Error("no model call expected"); };
  const dir = await store.saveCompiled({ title: "Maths", fm: { subject: "none" }, topicBody: IDEAS_CARD, questionsBody: IDEAS_BANK, target: 4 });
  return { store, engine, dir, calls: () => calls };
}

test("coverage: a subskill's ideas, which idea a question tests, and what counts as secured", async () => {
  const { ideasOf, ideaOf, coverageOf, coverageSummary } = await import("../src/coverage");
  const topic = F.parseTopic(IDEAS_CARD);
  const list = ideasOf(topic, 1);
  assert.deepEqual(list.map((i) => i.id), ["O1", "O2"], "two objectives: those are the ideas");
  assert.equal(ideasOf(F.parseTopic(CARD(NAMES)), 2).length, 1, "one claim: one idea");
  const claims = ideasOf(F.parseTopic(IDEAS_CARD.replace("objectives: O1, O2\n", "")), 1);
  assert.deepEqual(claims.map((i) => i.id), ["c1", "c2"], "no objectives: one idea per claim, none from the worked example");
  const qs = F.parseQuestions(IDEAS_BANK);
  assert.deepEqual(qs.map((q) => ideaOf(q, list)), ["O1", "O1", "O2", "O2"]);
  assert.equal(ideaOf({ question: "What is a limit?" }, list), null, "nothing shared: no guess");

  const at = (id: string, questionId: string, over: Record<string, unknown> = {}) => attempt({ id, skill: 1, questionId, question: qs.find((q) => q.id === questionId.replace(/~\d+$/, ""))!.question, ...over });
  const state = F.newState(topic, 4);
  state.attempts = [at("a1", "Q1"), at("a2", "Q2", { assisted: true }), at("a3", "Q3", { result: "incorrect" })];
  let status = coverageOf(topic, qs, state, 1);
  assert.deepEqual(status.map((i) => [i.id, i.asked, i.unaidedCorrect, i.secured]), [["O1", 2, 1, false], ["O2", 1, 0, false]], "helped and wrong answers are asked but not secured");
  state.attempts.push(at("a4", "Q2~2"));
  status = coverageOf(topic, qs, state, 1);
  assert.deepEqual([status[0].unaidedCorrect, status[0].secured, status[1].secured], [2, true, false]);
  const sum = coverageSummary(status);
  assert.deepEqual([sum.total, sum.asked, sum.secured, sum.unasked.length], [2, 2, 1, 0]);
});

test("build on the last question when the mark, confidence or time say the idea is shaky; otherwise move to an idea not yet asked", async () => {
  const { nextMove, MAX_BUILDS } = await import("../src/coverage");
  const idea = (secured = false) => ({ id: "O1", text: "t", asked: 1, unaidedCorrect: secured ? 2 : 1, secured, questions: ["Q1"] });
  const right = { result: "correct" as const, confidence: null, assisted: false, answerExposed: false, seconds: 20 };
  const move = (over: Record<string, unknown>, i: Record<string, unknown> = {}) => nextMove({ attempt: { ...right, ...over } as any, idea: idea(), typicalSeconds: 20, buildsInARow: 0, ...i });
  assert.equal(move({}).kind, "advance", "right, no signal of doubt");
  assert.equal(move({ confidence: 0.9 }).kind, "advance", "right and sure");
  assert.equal(move({ confidence: 0.3 }).kind, "build-on", "right but unsure: see that it holds");
  assert.match(move({ confidence: 0.3 }).reason, /weren't sure/);
  assert.equal(move({ confidence: 0.3 }, { idea: idea(true) }).kind, "advance", "an idea already secured twice is not asked again for a wobble");
  assert.equal(move({ seconds: 70 }).kind, "build-on", "right but much slower than usual, and not sure");
  assert.equal(move({ seconds: 70, confidence: 0.9 }).kind, "advance", "slow but sure: no");
  assert.equal(move({ seconds: 70 }, { typicalSeconds: null }).kind, "advance", "no usual time known: time says nothing");
  assert.equal(move({ result: "incorrect", confidence: 0.9 }).kind, "build-on");
  assert.match(move({ result: "incorrect", confidence: 0.9 }).reason, /sure and it didn't hold/);
  assert.match(move({ result: "incorrect", confidence: 0.2 }).reason, /smaller step/);
  assert.equal(move({ result: "partial" }).kind, "build-on");
  assert.equal(move({ assisted: true }).kind, "build-on", "a helped right answer is asked again without help");
  assert.equal(move({ answerExposed: true, result: "incorrect" }).kind, "build-on");
  assert.equal(move({ result: "skipped" }).kind, "advance");
  assert.equal(move({ result: "incorrect" }, { buildsInARow: MAX_BUILDS }).kind, "advance", "two follow-ups at most");
  assert.equal(nextMove({ attempt: right as any, idea: null, typicalSeconds: null, buildsInARow: 0 }).kind, "advance", "no idea to build on");
});

test("a bank quiz builds on the last question when you were unsure, moves to a new idea when you were sure, and says which", async () => {
  let calls = () => 0;
  const run = async (answers: [string, number][]) => {
    const { store, engine, dir, calls: used } = await ideas();
    calls = used;
    const chat = await store.newChat(dir, "Maths", "quiz", new Date(2026, 10, 17, 9, 0));
    const seen: { card: string; reply: string }[] = [];
    let r = await engine.quizTurn(dir, chat, "");
    seen.push({ card: F.fmStr((await store.loadChat(chat)).fm, "card"), reply: r.reply });
    for (const [text, confidence] of answers) {
      r = await engine.quizTurn(dir, chat, text, { confidence });
      seen.push({ card: F.fmStr((await store.loadChat(chat)).fm, "card").replace(/~\d+$/, ""), reply: r.reply });
    }
    return seen;
  };
  // Wrong and unsure on the first differentiation question: the next is the other differentiation question.
  let seen = await run([["7", 0.2]]);
  assert.equal(seen[0].card, "Q1");
  assert.equal(seen[1].card, "Q2", "same idea, from another question");
  assert.match(seen[1].reply, /Builds on the last question \(Differentiate polynomials with the power rule\)\. You weren't sure, so a smaller step on the same idea\./);
  // Right and sure: on to the integration idea, which has not been asked.
  seen = await run([["12", 0.9]]);
  assert.equal(seen[1].card, "Q3", "a new idea");
  assert.match(seen[1].reply, /A new idea: Integrate polynomials with the reverse power rule\./);
  // Right but unsure: the same idea once more.
  seen = await run([["12", 0.3]]);
  assert.equal(seen[1].card, "Q2");
  assert.match(seen[1].reply, /Right, but you weren't sure/);
  // Wrong again on the last question of an idea: nothing left on it, so on to the other idea, and it says so.
  seen = await run([["7", 0.2], ["7", 0.2]]);
  assert.equal(seen[2].card, "Q3");
  assert.match(seen[2].reply, /No other question on that idea is left, so on to a new one\./);
  assert.equal(calls(), 0, "no model call anywhere");
});

// ---------- exam metadata on objectives, BKT in shadow, and the measurement summary ----------

const EXAM_CARD = (fm = "") => [
  ...(fm ? ["---", fm, "---"] : []),
  "# Calculus", "", "## Overview", "Rates of change.", "", "## Objectives",
  "- O1: Derive the power rule (Spec 2.1) (weight 8%, paper 2, command: derive, 6 marks, 8 min)",
  "- O2: Apply the chain rule {weight 12, explain, marks 4-6}",
  "- O3: Sketch a gradient function (weight lots, paper two-ish, 3 marks)",
  "- O4: Find f(x) (Spec 3.4)",
  "- O5: State the limit (weight banana)",
  "- O6: Integrate (derive)",
  "Exam date: 2027-05-01",
  "", "## Subskills", "",
  "### 1. Power rule", "prerequisites: none", "objectives: O1, O3", "- A claim ([[Calc notes]]).", "",
  "### 2. Chain rule", "prerequisites: 1", "objectives: O2", "- A claim.", "",
  "### 3. Composites", "prerequisites: 1", "objectives: O2, O4", "- A claim.", "",
].join("\n");

test("exam metadata: a trailing group on an objective line is read when it reads cleanly, and ignored when it does not", async () => {
  const { readObjectiveLine, examDay } = await import("../src/objective-meta");
  const t = F.parseTopic(EXAM_CARD("exam: 2027-06-12"));
  const by = Object.fromEntries((t.objectives ?? []).map((o) => [o.id, o]));
  assert.equal(t.examDate, "2027-06-12", "the properties win over an Exam: line");
  assert.equal(F.parseTopic(EXAM_CARD()).examDate, "2027-05-01", "without one, the Exam: line under Objectives gives the date");
  // Valid: every field, beside a separate source group.
  assert.deepEqual([by.O1.text, by.O1.source], ["Derive the power rule", "Spec 2.1"]);
  assert.deepEqual(by.O1.exam, { weight: 0.08, paper: "Paper 2", commands: ["derive"], marks: 6, minutes: 8 });
  // Braces, a bare percentage, a bare command word beside a keyed field, a range of marks.
  assert.deepEqual([by.O2.text, by.O2.source, by.O2.exam], ["Apply the chain rule", "", { weight: 0.12, commands: ["explain"], marks: 5 }]);
  // Partial: what reads cleanly is kept, the rest is ignored and reported.
  assert.deepEqual(by.O3.exam, { marks: 3 });
  assert.deepEqual(readObjectiveLine("Sketch a gradient function (weight lots, paper two-ish, 3 marks)").ignored, ["weight lots", "paper two-ish"]);
  // Malformed only, or no metadata: the line is read exactly as before, the group being the source.
  assert.deepEqual([by.O4.text, by.O4.source, by.O4.exam], ["Find f(x)", "Spec 3.4", undefined]);
  assert.deepEqual([by.O5.source, by.O5.exam], ["weight banana", undefined]);
  assert.deepEqual([by.O6.source, by.O6.exam], ["derive", undefined], "a bare command word alone stays a source");
  assert.equal(t.objectives!.length, 6, "the Exam: line is not an objective");
  // Metadata before the source, a mixed group, an objective date, bad values.
  assert.deepEqual(readObjectiveLine("Prove it (8% of marks; exam 2027-06-03) (Spec 1)"), { text: "Prove it", source: "Spec 1", exam: { weight: 0.08, date: "2027-06-03" }, ignored: [] });
  assert.deepEqual(readObjectiveLine("Prove it (Spec 1; time 5 minutes)"), { text: "Prove it", source: "Spec 1", exam: { minutes: 5 }, ignored: [] });
  assert.equal(readObjectiveLine("Prove it (weight 140%)").exam, null, "a weight over 100% is not a weight");
  assert.deepEqual([examDay("2027-02-30"), examDay("2027/6/3"), examDay("June 3")], [null, "2027-06-03", null]);

  // The course package keeps it, from the card or from the specification wording of a staged compile.
  const { buildPackage, withStagedCoverage } = await import("../src/coursepkg");
  const pkg = buildPackage({ topic: t, questions: [], concepts: {}, sources: {}, previous: null, at: "2026-11-18T00:00:00.000Z", mode: "notes", research: false });
  assert.deepEqual(pkg.objectives.find((o) => o.id === "O1")!.exam, by.O1.exam);
  assert.equal(pkg.objectives.find((o) => o.id === "O4")!.exam, undefined);
  assert.equal(pkg.examDate, "2027-06-12");
  const staged: any = { status: "complete", inventory: [{ id: "O1", text: "Derive the power rule", references: ["p1"], search: "" }, { id: "O9", text: "Compare rates (weight 5%, compare)", references: ["p2"], search: "" }], sourceRevisions: [], lessons: [], availability: [], issues: [], metrics: {} };
  const sp = withStagedCoverage(pkg, staged);
  assert.deepEqual(sp.objectives.map((o) => [o.id, o.text, o.exam]), [["O1", "Derive the power rule", by.O1.exam], ["O9", "Compare rates", { weight: 0.05, commands: ["compare"] }]]);
});

test("exam metadata: weight and the exam date scale priority within fixed bounds, say why, and add timed practice", async () => {
  const P = await import("../src/policy");
  type Signal = import("../src/policy").ExamSignal;
  const sig = (over: Partial<Signal>): Signal => ({ weight: null, daysToExam: null, minutes: null, marks: null, paper: "", commands: [], ...over });
  // From the card: weight split over the subskills that teach an objective; the nearest date counts.
  const signals = P.examSignals(F.parseTopic(EXAM_CARD("exam: 2027-06-12")), "2027-06-02");
  assert.deepEqual(signals[1], { weight: 0.08, daysToExam: 10, minutes: 8, marks: 6, paper: "Paper 2", commands: ["derive"] });
  assert.deepEqual([signals[2].weight, signals[3].weight], [0.06, 0.06], "O2's 12% is shared by the two subskills that teach it");

  const two = (a: Partial<SkillInput>, b: Partial<SkillInput>) => input({ completedStep: true, skills: [skill({ n: 1, level: 2, supported: 2, ...a }), skill({ n: 2, level: 2, supported: 2, ...b })] });
  const plain = scoreSkills(two({}, {}));
  assert.equal(plain[0].score, plain[1].score);
  assert.equal("exam" in plain[0], false, "no metadata, no exam field: decisions without it are unchanged");
  const light = sig({ weight: 0.02 }), heavy = sig({ weight: 0.2 });
  const s = scoreSkills(two({ exam: light }, { exam: heavy }));
  const s1 = s.find((x) => x.n === 1)!, s2 = s.find((x) => x.n === 2)!;
  assert.deepEqual([s2.exam!.factor, s1.exam!.factor], [P.EXAM_FACTOR_MAX, P.EXAM_FACTOR_MIN], "nearly twice the average share is capped; a fifth of it is floored");
  assert.deepEqual([s2.parts.exam, s1.parts.exam], [0.125, -0.062]);
  assert.ok(s2.score > s1.score);
  const d = decide(two({ exam: light }, { exam: heavy }));
  assert.equal(d.focus, 2);
  assert.match(d.reason, /Exam weighting: it carries 20% of the marks, 1\.8× this topic's average, so its priority is scaled ×1\.50, the most exam metadata can add \(1 → 1\.5\)\./);
  // Bounded whatever the inputs: a huge share on exam day, and a priority already at its maximum.
  const extreme = scoreSkills(two({ exam: sig({ weight: 0.001 }) }, { exam: sig({ weight: 1, daysToExam: 0 }), priority: 5 })).find((x) => x.n === 2)!;
  assert.deepEqual([extreme.exam!.factor, extreme.exam!.priority, extreme.parts.exam], [1.5, 5, 1]);
  // The date alone: up to +25% within 60 days, nothing outside them or after the exam.
  const near = (days: number) => scoreSkills(input({ skills: [skill({ n: 1, level: 2, supported: 2, exam: sig({ daysToExam: days }) })] }))[0].exam!;
  assert.deepEqual([0, 30, 60, 90, -3].map((x) => near(x).factor), [1.25, 1.125, 1, 1, 1]);
  assert.equal(near(90).note, "", "no effect, nothing to explain");
  assert.match(near(90).about, /exam in 90 days/);
  // A single weighted subskill has nothing to be compared with, so weight alone changes nothing.
  assert.equal(scoreSkills(input({ skills: [skill({ n: 1, level: 2, supported: 2, exam: heavy })] }))[0].exam!.factor, 1);

  // Timed practice: unaided practice, minutes the time available holds, exam not past or far off.
  const practise = (exam: Signal, minutes = 25) => decide(input({ minutes, skills: [skill({ n: 1, level: 3, supported: 3, bankLeft: 2, exam })] }));
  const timed = practise(sig({ minutes: 8, marks: 6, commands: ["derive"], paper: "Paper 2", daysToExam: 10 }));
  assert.deepEqual([timed.action, timed.timed], ["independent-practice", 8]);
  assert.match(timed.reason, /Exam practice: allow about 8 minutes, as in the exam \(6 marks, derive, Paper 2\)\.$/);
  assert.equal(practise(sig({ minutes: 30 })).timed, undefined, "more minutes than the learner has");
  assert.equal(practise(sig({ minutes: 8, daysToExam: 90 })).timed, undefined, "the exam is too far off");
  assert.equal(practise(sig({ minutes: 8, daysToExam: -1 })).timed, undefined, "the exam has passed");
  assert.equal(decide(input({ skills: [skill({ n: 1, level: 1, supported: 1, exam: sig({ minutes: 8 }) })] })).timed, undefined, "a lesson is not timed");
  assert.equal(decide(input({ mode: "teach", skills: [skill({ n: 1, level: 3, supported: 3, exam: sig({ minutes: 8 }) })] })).timed, undefined, "Learn mode is not timed");
  // Deterministic: the same input gives the same decision.
  assert.deepEqual(decide(two({ exam: light }, { exam: heavy })), d);
});

test("exam metadata reaches the policy from a compiled card, and BKT rides along in shadow", async () => {
  const { store, engine, dir } = await setup();
  const body = EXAM_CARD().replace("Exam date: 2027-05-01", "Exam: 2026-11-23").replace("(weight 8%,", "(weight 18%,");
  await store.saveCompiled({ title: "Calculus", fm: { subject: "none" }, topicBody: body, questionsBody: BANK, target: 4, existingDir: dir });
  const topic = await store.loadTopic(dir);
  const state = await store.loadState(dir, 4);
  state.attempts.push(attempt({ id: "x1", skill: 1, concept: state.concepts[1] ?? "", questionId: "Q1", timestamp: "2026-11-12T10:00:00.000Z" }));
  const chat: F.Chat = { fm: {}, summary: "", messages: [] };
  const pin = (engine as any).policyInput({ mode: "auto", state, pre: await store.prereqs(dir, topic), chat, session: sessionFor(chat, state, "auto"), intent: "none", questions: await store.loadQuestions(dir), external: [], topic }) as PolicyInput;
  assert.deepEqual(pin.skills[0].exam, { weight: 0.18, daysToExam: 10, minutes: 8, marks: 6, paper: "Paper 2", commands: ["derive"] });
  // Q1 is a two-option multiple-choice question, so the guess is 1/2.
  const after = (0.3 * 0.9) / (0.3 * 0.9 + 0.7 * 0.5);
  const known = after + (1 - after) * 0.15;
  assert.deepEqual(pin.skills[0].shadow, { pKnown: Math.round(known * 1000) / 1000, pCorrect: Math.round((known * 0.9 + (1 - known) * 0.2) * 1000) / 1000, observations: 1 });
  assert.equal(pin.skills[1].shadow, undefined, "no observation, no shadow value");
  await store.saveState(dir, state);
  const advice = await engine.advise(dir, 1);
  assert.ok(advice.scores.find((x) => x.n === 1)!.exam!.factor > 1);
});

test("BKT in shadow: the update matches hand-computed values, with the multiple-choice guess floor", async () => {
  const B = await import("../src/bkt");
  const params = { pInit: 0.5, pLearn: 0.1, pSlip: 0.1, pGuess: 0.2 };
  const seq = [attempt({ id: "a", timestamp: "2026-11-10T10:00:00.000Z" }), attempt({ id: "b", result: "incorrect", timestamp: "2026-11-11T10:00:00.000Z" })];
  const t = B.bktTrace(seq, 1, { params });
  const close = (x: number, y: number) => assert.ok(Math.abs(x - y) < 1e-12, `${x} vs ${y}`);
  // Correct: P(c) = 0.5·0.9 + 0.5·0.2 = 0.55; posterior 0.45/0.55 = 9/11; with learning 9/11 + 2/11·0.1 = 46/55.
  close(t.steps[0].pCorrect, 0.55);
  close(t.steps[0].after, 46 / 55);
  // Incorrect: P(c) = 46/55·0.9 + 9/55·0.2 = 43.2/55; posterior 4.6/(4.6 + 7.2) = 23/59; with learning 26.6/59.
  close(t.steps[1].pCorrect, 43.2 / 55);
  close(t.steps[1].after, 26.6 / 59);
  close(t.pKnown, 26.6 / 59);
  close(t.pCorrect, (26.6 / 59) * 0.9 + (32.4 / 59) * 0.2);
  assert.deepEqual(t.steps.map((s) => s.estimate), [0.5, 2 / 3], "the existing estimate before each answer: (correct + 1) / (n + 2)");
  // A four-option question raises the guess to 1/4; a ten-option one leaves it at pGuess.
  close(B.bktTrace(seq, 1, { params, options: { "q-a": 4 } }).steps[0].pCorrect, 0.5 * 0.9 + 0.5 * 0.25);
  close(B.bktTrace(seq, 1, { params, options: { "q-a": 10 } }).steps[0].pCorrect, 0.55);
  assert.deepEqual(B.mcqOptions(F.parseQuestions(BANK)), { Q1: 2, Q5: 2 });
  assert.match(B.shadowLine(t), /^BKT \(shadow, not used for decisions\): P\(known\) 0\.45 after 2 unaided answers$/);
  assert.equal(B.shadowLine(B.bktTrace([], 1)), "BKT (shadow, not used for decisions): P(known) 0.30, the starting value: no unaided answers yet");
});

test("BKT in shadow: helped, exposed, self-rated, inconclusive, disputed and repeated attempts are not observations", async () => {
  const B = await import("../src/bkt");
  const base = [attempt({ id: "a", timestamp: "2026-11-10T10:00:00.000Z" }), attempt({ id: "b", result: "incorrect", timestamp: "2026-11-11T10:00:00.000Z" })];
  const noise = [
    attempt({ id: "h", assisted: true, assistance: ["hint"], timestamp: "2026-11-10T11:00:00.000Z" }),
    attempt({ id: "x", answerExposed: true, timestamp: "2026-11-10T12:00:00.000Z" }),
    attempt({ id: "s", grading: "self", verification: "unverified", timestamp: "2026-11-10T13:00:00.000Z" }),
    attempt({ id: "i", mark: { v: 1, proposed: "correct", rules: [], conclusive: false } as any, timestamp: "2026-11-10T14:00:00.000Z" }),
    attempt({ id: "d", verification: "disputed", timestamp: "2026-11-10T15:00:00.000Z" }),
    attempt({ id: "u", result: "ungraded", timestamp: "2026-11-10T16:00:00.000Z" }),
    attempt({ id: "r", questionId: "q-a", timestamp: "2026-11-10T17:00:00.000Z" }),
    attempt({ id: "o", skill: 2, timestamp: "2026-11-10T18:00:00.000Z" }),
  ];
  const clean = B.bktTrace(base, 1);
  const noisy = B.bktTrace([...noise, ...base], 1);
  assert.deepEqual(noisy.steps.map((s) => s.attempt), ["a", "b"]);
  assert.deepEqual([noisy.pKnown, noisy.pCorrect], [clean.pKnown, clean.pCorrect]);
  assert.equal(noisy.skipped, 7, "every attempt on the subskill that is not an observation is counted as skipped");
  assert.equal(noisy.steps.length, skillEvidence([...noise, ...base], 1).independent, "the observations are exactly skillEvidence's independent data points");
});

test("BKT in shadow never changes a decision, and replay re-scores it over a decision log", async () => {
  const skills = [skill({ n: 1, level: 2, supported: 2 }), skill({ n: 2, level: 3, supported: 3, bankLeft: 2, recentFailures: 1 })];
  const base = input({ skills, completedStep: true });
  const d = decide(base);
  for (const v of [0, 0.5, 1]) {
    const shadowed = { ...base, skills: base.skills.map((k) => ({ ...k, shadow: { pKnown: v, pCorrect: 1 - v, observations: 40 } })) };
    assert.deepEqual(decide(shadowed), d, `shadow ${v} changes nothing`);
    assert.deepEqual(scoreSkills(shadowed), scoreSkills(base));
  }
  const logged = { ...base, skills: base.skills.map((k) => ({ ...k, shadow: { pKnown: 0.9, pCorrect: 0.85, observations: 3 } })) };
  const cases = [{ t: "2026-11-12T09:00:00.000Z", topic: "Calculus", input: logged, decision: { version: d.version, action: d.action, focus: d.focus, local: d.local } }];
  const history = [attempt({ id: "a", skill: d.focus!, timestamp: "2026-11-10T10:00:00.000Z" }), attempt({ id: "b", skill: d.focus!, result: "incorrect", timestamp: "2026-11-13T10:00:00.000Z" })];
  const r = replay(cases, DEFAULT_WEIGHTS, { attempts: { Calculus: history } });
  assert.deepEqual([r.total, r.same, r.changed], [1, 1, []]);
  assert.equal(r.shadow!.unaffected, true);
  assert.deepEqual([r.shadow!.cases[0].focus, r.shadow!.cases[0].observations], [d.focus, 1], "only attempts before the logged decision count");
  assert.equal(r.shadow!.comparison.n, 2);
  assert.deepEqual(Object.keys(replay(cases, DEFAULT_WEIGHTS)), ["total", "same", "changed"], "without attempts, replay is as before");
});

test("BKT in shadow: Brier scores against the existing estimate and the learner's confidence on a fixture history", async () => {
  const B = await import("../src/bkt");
  const params = { pInit: 0.5, pLearn: 0.1, pSlip: 0.1, pGuess: 0.2 };
  const history = [
    attempt({ id: "a", confidence: 0.8, timestamp: "2026-11-10T10:00:00.000Z" }),
    attempt({ id: "b", result: "incorrect", confidence: 0.6, timestamp: "2026-11-11T10:00:00.000Z" }),
    attempt({ id: "h", assisted: true, timestamp: "2026-11-11T11:00:00.000Z" }),
    attempt({ id: "c", timestamp: "2026-11-12T10:00:00.000Z" }),
  ];
  const c = B.brierComparison([B.bktTrace(history, 1, { params })]);
  const l3 = 26.6 / 59;
  const p = [0.55, 43.2 / 55, l3 * 0.9 + (1 - l3) * 0.2];
  const close = (x: number | null, y: number) => assert.ok(x !== null && Math.abs(x - y) < 1e-12, `${x} vs ${y}`);
  assert.deepEqual([c.n, c.rated], [3, 2]);
  close(c.bkt, ((p[0] - 1) ** 2 + p[1] ** 2 + (p[2] - 1) ** 2) / 3);
  close(c.estimate, ((0.5 - 1) ** 2 + (2 / 3) ** 2 + (0.5 - 1) ** 2) / 3);
  close(c.bktRated, ((p[0] - 1) ** 2 + p[1] ** 2) / 2);
  close(c.estimateRated, ((0.5 - 1) ** 2 + (2 / 3) ** 2) / 2);
  close(c.confidence, 0.2);
  close(c.confidence, skillEvidence(history, 1).brier!);
  assert.match(B.comparisonLine(c), /^Brier over 3 unaided answers \(lower is better\): BKT 0\.35, existing estimate 0\.31; on the 2 with your confidence: BKT 0\.41, estimate 0\.35, your confidence 0\.20; fewer than 20 answers, too few to tell them apart$/);
  assert.equal(B.comparisonLine(B.brierComparison([])), "No unaided answers to score BKT against yet");
});

test("the measurement summary reads saved records without a model, and says call counts are not savings", async () => {
  const M = await import("../src/metrics");
  const line = (r: object) => JSON.stringify(r);
  const evidence = ["---", "tutor: evidence", "---", "", "```jsonl", line({ kind: "attempt", ...attempt({ id: "a", seconds: 20 }) }), line({ kind: "change", t: "x" }), "{not json", line({ kind: "attempt", ...attempt({ id: "b", grading: "model", verification: "unverified", seconds: 40, timestamp: "2026-11-11T10:00:00.000Z" }) }), line({ kind: "attempt", ...attempt({ id: "c", assisted: true, seconds: 60, timestamp: "2026-11-11T11:00:00.000Z" }) }), "```"].join("\n");
  const attempts = M.attemptsFromText(evidence);
  assert.deepEqual(attempts.map((a) => a.id), ["a", "b", "c"]);
  const pkg = M.packageFromText('head\n\n```json\n{"format":"study-tutor-course","topic":"Calculus","staged":{"metrics":{"localCalls":2,"cacheHits":3,"elapsedMs":1000,"generators":4,"generatorsRejected":1,"laterCounter":5,"escalated":""}}}\n```\n')!;
  const s = M.summariseMetrics({
    packages: [pkg, { topic: "old" }],
    attempts: { Calculus: attempts },
    activities: [{ status: "ready", localCalls: 2, repairs: 1, claudeCalls: 0, firstPassValid: false, timing: { wallMs: 900, localMs: 800, loadMs: 100, promptTokens: 50, evalTokens: 20 } }],
    decisions: [{ decision: { version: 4, local: "bank" } }, { decision: { version: 3, local: null } }],
  });
  assert.deepEqual(s.compile.totals, { localCalls: 2, cacheHits: 3, generators: 4, generatorsRejected: 1, laterCounter: 5 }, "every numeric counter is summed, new ones included");
  assert.deepEqual([s.compile.packages, s.compile.staged, s.compile.elapsedMs.median], [2, 1, 1000]);
  assert.deepEqual([s.attempts.markedByCode, s.attempts.markedByModel, s.attempts.assisted, s.attempts.independent, s.attempts.seconds.median], [2, 1, 1, 2, 40]);
  assert.deepEqual([s.activities.localCalls, s.activities.repairs, s.activities.firstPassValid, s.activities.firstPassKnown], [2, 1, 0, 1]);
  assert.deepEqual([s.decisions.bank, s.decisions.model, s.decisions.byVersion], [1, 1, { "3": 1, "4": 1 }]);
  assert.equal(s.shadow.n, 2);
  const report = M.metricsReport(s);
  assert.ok(report.includes(M.CALL_COUNT_CAVEAT));
  assert.match(report, /Token use and cost per study turn: shown in Details for the current sitting only, not saved\./);
});

test("model-led turns are told which ideas are not yet asked, and whether to build on the last answer", async () => {
  const { store, engine, dir } = await ideas();
  const seen: string[] = [];
  (engine as any).call = async (o: any) => { seen.push(o.input); return { text: "Which comes first?", usage }; };
  const st = await store.loadState(dir, 4);
  st.focus = 1;
  await store.saveState(dir, st);
  const chat = await store.newChat(dir, "Maths", "teach", new Date(2026, 10, 17, 9, 0));
  await engine.turn(dir, chat, "");
  assert.match(seen[0], /# Coverage of Calculus basics\nEvery idea below must be asked at least once[\s\S]*- O1: Differentiate polynomials with the power rule — not asked yet\n- O2: Integrate polynomials with the reverse power rule — not asked yet\nChoose the next question on an idea not yet asked\./);
  // A wrong answer given with low confidence: the brief says to stay on that idea.
  const q1 = F.parseQuestions(IDEAS_BANK)[0];
  const again = await store.loadState(dir, 4);
  again.attempts.push(attempt({ id: "w1", skill: 1, questionId: "Q1", question: q1.question, result: "incorrect", confidence: 0.2 }));
  await store.saveState(dir, again);
  await engine.turn(dir, chat, "go on");
  assert.match(seen[1], /- O1: .* — asked 1, not secured/);
  assert.match(seen[1], /Build on the last question: stay on O1[\s\S]*You weren't sure, so a smaller step on the same idea\./);
});

test("cold probes: a probe family is split out of the bank, and a near-copy of practice is dropped", () => {
  const sec = (id: string, sub: number, task: string, q: string) =>
    `### ${id}\nsubskill: ${sub}\ntype: short\ntask: ${task}\nquestion: ${q}\nanswer: 1\n\n`;
  const body =
    "Intro\n\n" +
    sec("Q1", 1, "application", "Find the slope of the line through two points.") +
    sec("Q2", 1, "probe", "Why does a wider base make a pyramid more stable?") +
    sec("Q3", 2, "application", "A ball is thrown up at 5 m/s. How high does it rise?") +
    sec("Q4", 2, "probe", "A ball is thrown up at 8 m/s. How high does it rise?");
  const r = splitSealed(body);
  assert.deepEqual(F.parseQuestions(r.bank).map((x) => x.id), ["Q1", "Q3"]);
  assert.equal(r.sealed.length, 1);
  assert.match(r.sealed[0].id, /^P[0-9a-f]{10}$/);
  assert.equal(r.sealed[0].subskill, 1);
  assert.equal(r.dropped, 1);
  assert.equal(F.parseQuestions(r.sealed[0].section)[0].task, "probe");
  assert.equal(sealedId("x"), sealedId("x"));
  assert.equal(F.parseQuestions("### P1\nsubskill: 1\ntype: short\ntask: probe\nconcept: c-abc\nquestion: x\nanswer: 1\n")[0].concept, "c-abc");
  const plain = sec("Q1", 1, "application", "Find the slope.");
  const none = splitSealed(plain);
  assert.deepEqual({ sealed: none.sealed, dropped: none.dropped }, { sealed: [], dropped: 0 });
  assert.equal(none.bank, plain);
});

test("cold probes: a probe is sealed under any heading the question parser accepts, with CRLF too", () => {
  const body = "### Q1\nsubskill: 1\ntype: short\ntask: application\nquestion: Find the slope.\nanswer: 1\n\n#### **Q5**\nsubskill: 1\ntype: short\ntask: probe\nquestion: Why is a wider base more stable?\nanswer: 1\n";
  for (const text of [body, body.replace(/\n/g, "\r\n")]) {
    const r = splitSealed(text);
    assert.deepEqual(F.parseQuestions(r.bank).map((x) => x.id), ["Q1"]);
    assert.equal(r.sealed.length, 1);
    assert.match(r.sealed[0].section, /^### P[0-9a-f]{10}\r?\n/);
    assert.equal(F.parseQuestions(r.sealed[0].section)[0].task, "probe");
  }
});

const sealedSec = (id: string, sub: number, task: string, q: string) =>
  `### ${id}\nsubskill: ${sub}\ntype: short\ntask: ${task}\nquestion: ${q}\nanswer: 1\n\n`;

test("cold probes: questions.md never holds a sealed question, so no bank reader, review or flashcard export can show it", async () => {
  const probe = "Why does a wider base make a pyramid more stable?";
  const body =
    sealedSec("Q1", 1, "application", "Find the slope of the line through two points.") +
    sealedSec("Q2", 1, "probe", probe) +
    sealedSec("Q3", 2, "application", "A ball is thrown up at 5 m/s. How high does it rise?") +
    sealedSec("Q4", 2, "probe", "A ball is thrown up at 8 m/s. How high does it rise?");
  const store = new Store(new MemFS(), "Tutor");
  const dir = await store.saveCompiled({ title: "Calculus", fm: { subject: "none" }, topicBody: CARD(NAMES), questionsBody: body, target: 4 });
  const bank = await store.loadQuestions(dir);
  assert.ok(bank.every((x) => x.task !== "probe"));
  assert.deepEqual(bank.map((x) => x.id), ["Q1", "Q3"]);
  const sealed = await store.loadSealed(dir);
  assert.equal(sealed.length, 1);
  assert.equal(sealed[0].concept, (await store.loadState(dir, 4)).concepts[1]);
  assert.equal(sealed[0].subskill, 1);
  const fs = (store as any).fs as MemFS;
  assert.ok(!(await fs.read(`${dir}/questions.md`)).includes(probe));
  assert.ok((await fs.read(`${dir}/sealed.md`)).includes(probe));
  assert.ok(!F.buildSrNote(bank, "t").includes(probe));
  const state = await store.loadState(dir, 4);
  assert.ok(!JSON.stringify(F.reviewQueue(bank, state, "2026-11-21", 50)).includes(probe));
});

test("cold probes: a recompile keeps sealed questions with their concept, a new probe replaces the old one, and a retired concept loses its own", async () => {
  const names: [string, string][] = [["Slopes", "none"], ["Projectiles", "none"], ["Stability", "none"]];
  const one = (sub: number, probe: string) => sealedSec(`Q${sub}`, sub, "application", `Practice item number ${sub} about something else entirely.`) + sealedSec(`Q${sub + 10}`, sub, "probe", probe);
  const p1 = "Why does a wider base make a pyramid more stable?";
  const p2 = "How would a bridge engineer decide where to put the supports?";
  const p3 = "Explain why a spinning top stays upright for a while.";
  const store = new Store(new MemFS(), "Tutor");
  const fs = (store as any).fs as MemFS;
  const dir = await store.saveCompiled({ title: "Calculus", fm: { subject: "none" }, topicBody: CARD(names), questionsBody: one(1, p1) + one(2, p2) + one(3, p3), target: 4 });
  const first = await store.loadSealed(dir);
  assert.equal(first.length, 3);
  const st1 = await store.loadState(dir, 4);
  const [c1, c2, c3] = [1, 2, 3].map((n) => st1.concepts[n]);
  const id = (c: string) => first.find((x) => x.concept === c)!.id;
  const oldC2 = id(c2);
  const p1b = "What makes a tall narrow tower topple in a strong wind?";
  // Swap the first two subskills, give only the old subskill 1 a new probe, and drop the third subskill.
  const swapped: [string, string][] = [["Projectiles", "none"], ["Slopes", "none"]];
  await store.saveCompiled({
    title: "Calculus", fm: { subject: "none" }, topicBody: CARD(swapped), target: 4, existingDir: dir,
    questionsBody: sealedSec("Q1", 1, "application", "Practice item number 1 about something else entirely.") + sealedSec("Q2", 2, "application", "Practice item number 2 about something else entirely.") + sealedSec("Q12", 2, "probe", p1b),
  });
  const after = await store.loadSealed(dir);
  const st2 = await store.loadState(dir, 4);
  assert.equal(st2.concepts[1], c2);
  assert.equal(st2.concepts[2], c1);
  const ofC2 = after.filter((x) => x.concept === c2);
  assert.deepEqual(ofC2.map((x) => [x.id, x.subskill]), [[oldC2, 1]]);
  const ofC1 = after.filter((x) => x.concept === c1);
  assert.equal(ofC1.length, 1);
  assert.notEqual(ofC1[0].id, id(c1));
  assert.equal(ofC1[0].subskill, 2);
  assert.equal(after.filter((x) => x.concept === c3).length, 0);
  assert.equal(after.length, 2);
  assert.ok(!(await fs.read(`${dir}/sealed.md`)).includes(p3));
  // A topic saved without probes has none, and no file is made for it.
  const plain = await store.saveCompiled({ title: "Plain", fm: {}, topicBody: CARD([["Slopes", "none"]]).replace("# Calculus", "# Plain"), questionsBody: sealedSec("Q1", 1, "application", "Find it."), target: 4 });
  assert.deepEqual(await store.loadSealed(plain), []);
  assert.ok(!(await fs.exists(`${plain}/sealed.md`)));
  // Retiring every concept empties the file instead of leaving old questions behind.
  await store.saveCompiled({ title: "Calculus", fm: { subject: "none" }, topicBody: CARD([["Brand new", "none"]]), target: 4, existingDir: dir, questionsBody: sealedSec("Q1", 1, "application", "Find it.") });
  assert.deepEqual(await store.loadSealed(dir), []);
});
