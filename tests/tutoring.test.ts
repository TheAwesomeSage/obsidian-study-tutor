// Tutoring and assessment: focused retrieval, evidence-backed misconceptions, Master-mode moves,
// outcome kept apart from reasoning, lesson depth, and narrow requests for linked material.
// The model is stubbed throughout (no Claude, no Ollama, no web); nothing here costs tokens.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as F from "../src/formats";
import { Attempt, normaliseAttempt } from "../src/evidence";
import { CourseEdge } from "../src/course";
import { Engine } from "../src/engine";
import { Store } from "../src/store";
import { MemFS } from "./memfs";
import { readSessionReply, sessionFor } from "../src/session";
import { NoteSourceStore, RetrievalConcept, SourcePassage, SourceStore, extractPassageAsk, notePassages, renderContext, renderRetrieval, retrieve } from "../src/retrieval";
import { Misconception, activeDescriptions, applyObservation, fromLegacy, isActive, misconceptionLine, onConcept, parseMisconception, recompute, reconcile } from "../src/misconceptions";
import { afterMark, chooseMove, moveBrief, moveLine } from "../src/tutormove";
import { finalExpression, normaliseReasoning, parseReasoning, reasoningLines, resultConflict, rubricDimensions, withCheck } from "../src/reasoning";
import { markLine, normaliseMark } from "../src/grading";
import { skillEvidence } from "../src/evidence";
import { fallbackMaterial, lessonDepth, missingEvidence } from "../src/lessondepth";
import { CourseExpander, ExpansionRequest, ExpansionResult, expansionLine, expansionNote, expansionRequest, inCourse, readResult } from "../src/expansion";
import { Claim, ClaimResult, MathBackend } from "../src/sympy";
import type { CodeRunReport, CodeRunner, CodeTask, CodeTestStatus } from "../src/codetask";
import { markCodeRun, notRun, parseCodeTask } from "../src/codequestions";
import { gradingLabel } from "../src/evidence";
import { compileCourse } from "../src/compiler";

// ---------- fixtures ----------

const CARD = (names: [string, string][]) =>
  ["# Calculus", "", "## Overview", "Rates of change.", "", "## Subskills", "", ...names.flatMap(([name, pre], i) => [`### ${i + 1}. ${name}`, `prerequisites: ${pre}`, `- A key claim about ${name} ([[Calc notes]]).`, ...(i === 1 ? ["misconceptions:", "- multiplies by the exponent but does not lower it"] : []), ""])].join("\n");

const BANK = `### Q1
subskill: 1
type: open
question: Simplify 16/64, showing your method.
answer: 16/64 = 1/4 (divide numerator and denominator by 16)
rubric: final answer 1/4; justifies each step by a valid rule; states that the divisor is nonzero

### Q2
subskill: 2
type: open
question: Evaluate the integral of 3x^2 from 0 to 2, showing your working.
answer: [x^3] from 0 to 2 = 8 - 0 = 8
rubric: uses the antiderivative x^3; evaluates at both limits; final answer 8

### Q3
subskill: 2
type: open
question: Explain what the derivative measures.
answer: The instantaneous rate of change of a function.

### Q4
subskill: 1
type: mcq
question: What is the limit of 1/x as x grows?
options:
- A. 1
- B. 0
answer: B
explanation: The terms shrink.

### Q5
subskill: 2
type: short
question: Differentiate $x^2$.
answer: 2x
`;

const NAMES: [string, string][] = [
  ["Limits", "none"],
  ["Derivatives", "1"],
  ["Chain rule", "2"],
];

const usage = { input: 10, cacheRead: 0, cacheWrite: 0, output: 10, costUsd: 0, calls: 1 };
const tick = () => new Promise((r) => setTimeout(r, 4));

class FakeMaths implements MathBackend {
  asked: Claim[][] = [];
  async check(claims: Claim[]): Promise<ClaimResult[]> {
    this.asked.push(claims);
    const n = (s = "") => s.replace(/\s+/g, "").replace(/^\(+|\)+$/g, "");
    return claims.map((c) => ({ ok: c.type === "equal" ? n(c.a) === n(c.b) : null, detail: "simplified the difference" }));
  }
  warm(): void {}
  status(): string {
    return "ready";
  }
}

async function setup(opts: { maths?: boolean } = {}) {
  const fs = new MemFS();
  const today = () => "2026-11-15";
  const store = new Store(fs, "Tutor", today);
  const settings: any = { claudePath: "", chatModel: "sonnet", compileModel: "sonnet", utilityModel: "haiku", effort: "low", targetLevel: 4, maxChatWords: 6000, maxTopicWords: 2000, singlePassWords: 6000, smartRouting: false, hardEffort: "high", bankQuiz: true, codePlacement: true, mathCheck: !!opts.maths };
  const engine = new Engine(store, () => settings, today);
  const maths = new FakeMaths();
  if (opts.maths) engine.maths = maths;
  const dir = await store.saveCompiled({ title: "Calculus", fm: { subject: "none" }, topicBody: CARD(NAMES), questionsBody: BANK, target: 4 });
  const calls: any[] = [];
  const replies: (string | ((o: any) => string))[] = [];
  (engine as any).call = async (o: any) => {
    calls.push(o);
    const next = replies.shift();
    const text = typeof next === "function" ? next(o) : next;
    if (o.jsonSchema) return { text: "", structured: JSON.parse(text ?? '{"grade":"good","feedback":""}'), usage };
    return { text: text ?? "ok", usage };
  };
  const state = await store.loadState(dir, 4);
  state.levels = { 1: 2, 2: 2, 3: null };
  state.focus = 2;
  await store.saveState(dir, state);
  const chatIn = async (mode: F.Mode) => store.newChat(dir, "Calculus", mode, new Date(2026, 10, 15, 9, calls.length));
  return { fs, store, engine, dir, calls, replies, settings, chatIn, maths, concept: state.concepts[2], limits: state.concepts[1] };
}

const session = (o: Record<string, unknown>) => `<session>${JSON.stringify({ helpGiven: [], answerExposed: false, nextAction: "check", completedStep: false, sources: [], ...o })}</session>`;
const tag = (o: Record<string, unknown>) => `<attempt>${JSON.stringify({ skill: 2, assisted: false, transfer: false, difficulty: 2, ...o })}</attempt>`;

const attempt = (over: Partial<Attempt> & { id: string }): Attempt => ({
  v: 2, skill: 2, concept: "calc/derivatives", questionId: `q-${over.id}`, question: `question ${over.id}`, answer: "an answer", activity: "guided-practice", mode: "tutor", difficulty: null,
  result: "incorrect", errorType: "conceptual", note: "", confidence: null, assisted: false, assistance: [], answerExposed: false, transfer: false, seconds: null,
  timestamp: "2026-11-10T10:00:00.000Z", grading: "model", verification: "unverified", assumptions: "", ...over,
});

// ---------- 1. focused retrieval ----------

class MapStore implements SourceStore {
  constructor(private notes: Record<string, string>) {}
  async passagesOf(source: string): Promise<SourcePassage[]> {
    const name = source.replace(/^\[\[|\]\]$/g, "");
    return this.notes[name] ? notePassages(name, this.notes[name]) : [];
  }
  passage(id: string, around: number) {
    return new NoteSourceStore(async (n) => this.notes[n] ?? null).passage(id, around);
  }
}

const NOTES = {
  "Deriv notes": "# Derivatives\n\n## Power rule\n\nThe power rule says the derivative of x^n is n x^(n-1), so the exponent is lowered by one and the old exponent becomes the coefficient.\n\nA worked case of the power rule: the derivative of x^3 is 3x^2 because the exponent drops from three to two.\n\n## History\n\nNewton and Leibniz argued about who found the calculus first, for decades.",
  "Dup notes": "The power rule says the derivative of x^n is n x^(n-1), so the exponent is lowered by one and the old exponent becomes the coefficient.",
  "Chain notes": "# Chain rule\n\nThe chain rule differentiates a composition: the derivative of f(g(x)) is f'(g(x)) times g'(x), applied with the power rule inside.",
  "Limit notes": "# Limits\n\nA limit describes the value a function approaches, and the derivative is defined as a limit of difference quotients.",
};

const focus: RetrievalConcept = { id: "calc/derivatives", name: "Derivatives", sources: ["[[Deriv notes]]", "[[Dup notes]]"], section: "The derivative is a rate of change.", topic: "T/Calc" };
const edge = (to: string, type: CourseEdge["type"], status: CourseEdge["status"]): CourseEdge => ({ from: "calc/derivatives", to, type, status, source: "test" } as CourseEdge);

test("retrieval: focus sources first, ranked deterministically, deduplicated, capped, with headings and citations", async () => {
  const store = new MapStore(NOTES);
  const p = { query: "why is the exponent lowered in the power rule", focus, neighbours: [], maxWords: 40 };
  const r = await retrieve(store, p);
  assert.deepEqual(r.passages.map((x) => [x.tier, x.sourceId, x.heading]), [["focus", "Deriv notes", "Derivatives > Power rule"], ["focus", "Deriv notes", "Derivatives > Power rule"]]);
  assert.ok(!r.passages.some((x) => x.sourceId === "Dup notes"), "the same text cited twice is sent once");
  assert.ok(r.words <= 40 && r.passages[1].truncated && r.passages[1].excerpt.endsWith(" …"), "the word cap holds, cutting at a word boundary");
  assert.ok(!r.passages.some((x) => /Newton/.test(x.excerpt)), "a passage sharing no word with the question is left out");
  assert.deepEqual(await retrieve(store, p), r, "the same input gives the same result");
  const text = renderRetrieval(r);
  assert.match(text, /^\[\[Deriv notes#Power rule\]\]: The power rule says .* \{ref: Deriv notes@[0-9a-f]{8}#0\}/);
  assert.equal(r.gap, null);
});

test("retrieval: one typed link at most, confirmed cross-topic links first, rejected links never followed", async () => {
  const store = new MapStore(NOTES);
  const chain: RetrievalConcept = { id: "calc/chain", name: "Chain rule", sources: ["[[Chain notes]]"], topic: "T/Calc" };
  const limits: RetrievalConcept = { id: "other/limits", name: "Limits", sources: ["[[Limit notes]]"], topic: "T/Analysis" };
  const q = "how does the power rule relate to the chain rule and to limits";
  // An inferred link inside the topic loses to a reviewed one into another topic.
  let r = await retrieve(store, { query: q, focus, neighbours: [{ edge: edge("calc/chain", "supports", "inferred"), concept: chain }, { edge: edge("other/limits", "requires", "reviewed"), concept: limits }], maxWords: 200 });
  assert.deepEqual(r.via && [r.via.other, r.via.status, r.via.crossTopic], ["other/limits", "reviewed", true]);
  assert.equal(r.passages.filter((x) => x.tier === "neighbour").length, 1, "one slot is kept for the linked concept");
  assert.ok(r.passages.every((x) => x.tier !== "neighbour" || x.concept === "other/limits"), "only one link is followed");
  assert.equal(r.passages[0].tier, "focus", "the focus comes first");
  // A rejected link is never followed, even when the question names its concept.
  r = await retrieve(store, { query: q, focus, neighbours: [{ edge: edge("other/limits", "requires", "rejected"), concept: limits }, { edge: edge("calc/chain", "supports", "inferred"), concept: chain }], maxWords: 200 });
  assert.equal(r.via?.other, "calc/chain");
  r = await retrieve(store, { query: q, focus, neighbours: [{ edge: edge("other/limits", "requires", "rejected"), concept: limits }], maxWords: 200 });
  assert.equal(r.via, null);
  assert.ok(r.passages.every((x) => x.tier === "focus"));
  // A question that names no neighbour follows none.
  r = await retrieve(store, { query: "why is the exponent lowered in the power rule", focus, neighbours: [{ edge: edge("calc/chain", "supports", "reviewed"), concept: chain }] });
  assert.equal(r.via, null);
});

test("retrieval: thin or missing evidence is reported, and the card section stands in only when nothing matches", async () => {
  const store = new MapStore(NOTES);
  let r = await retrieve(store, { query: "power rule", focus: { ...focus, sources: [] }, neighbours: [] });
  assert.deepEqual([r.gap?.reason, r.fallback, r.passages[0]?.tier], ["the course cites no source for it", true, "card"]);
  assert.match(renderRetrieval(r), /^\[topic card: Derivatives\]: The derivative is a rate of change\.$/);
  r = await retrieve(store, { query: "power rule", focus: { ...focus, sources: ["[[Missing note]]"] }, neighbours: [] });
  assert.equal(r.gap?.reason, "its sources could not be read");
  r = await retrieve(store, { query: "integration by parts", focus, neighbours: [] });
  assert.equal(r.gap?.reason, "no passage in its sources matches this question");
  r = await retrieve(store, { query: "Leibniz", focus, neighbours: [] });
  assert.match(r.gap?.reason ?? "", /^only \d+ words of its sources match/);
  assert.equal(r.fallback, false, "a thin match is quoted and flagged, not replaced by the card");
  r = await retrieve(null, { query: "power rule", focus, neighbours: [] });
  assert.equal(r.gap?.reason, "its sources could not be read");
});

test("retrieval: a passage is looked up by reference, with its neighbours, and not after its source changed", async () => {
  const notes: Record<string, string> = { ...NOTES };
  const store = new MapStore(notes);
  const all = await store.passagesOf("[[Deriv notes]]");
  const c = await store.passage(all[1].id, 1);
  assert.deepEqual([c?.passage.id, c?.before.map((p) => p.id), c?.after.map((p) => p.id)], [all[1].id, [all[0].id], [all[2].id]]);
  const shown = renderContext(c, all[1].id);
  assert.match(shown, /^\(before\) \[\[Deriv notes#Power rule\]\]: The power rule says/);
  assert.match(shown, /\(after\) \[\[Deriv notes#History\]\]: Newton/);
  assert.equal((await store.passage(all[1].id, 9))?.before.length, 1, "neighbours are capped");
  notes["Deriv notes"] += "\n\nA new paragraph added after the quote was taken, long enough to count.";
  assert.equal(await store.passage(all[1].id, 1), null, "a new revision does not answer for the old one");
  assert.match(renderContext(null, all[1].id), /not available/);
  assert.deepEqual(extractPassageAsk(`<passage>{"ids":["a@1#0","b@2#1","c@3#2"],"around":5}</passage>`), { text: "", ids: ["a@1#0", "b@2#1"], around: 2 });
});

test("retrieval in a turn: the model may ask once for a passage's surroundings, and gets them before it replies", async () => {
  const t = await setup();
  t.engine.readNote = async (name) => (name === "Calc notes" ? NOTES["Deriv notes"] : null);
  const ids = notePassages("Calc notes", NOTES["Deriv notes"]).map((p) => p.id);
  const chat = await t.chatIn("expert");
  t.replies.push(`<passage>{"ids":["${ids[1]}","unquoted@1234#0"],"around":1}</passage>`, "The exponent drops by one: see the worked case.");
  const r = await t.engine.turn(t.dir, chat, "Why is the exponent lowered in the power rule?");
  assert.equal(t.calls.length, 2);
  assert.match(t.calls[0].input, /# From the course sources \(exact quotes\)\n\[\[Calc notes#Power rule\]\]: The power rule says/);
  assert.match(t.calls[0].input, /reply with only <passage>/);
  assert.match(t.calls[1].input, /# Passages you asked for \(exact quotes\)\n\(before\) \[\[Calc notes#Power rule\]\]/);
  assert.match(t.calls[1].input, /Do not ask for more passages\./);
  assert.match(t.calls[1].input, /unquoted@1234#0}: not quoted in this turn/);
  assert.equal(r.reply, "The exponent drops by one: see the worked case.");
  // "Why" asks for depth, so the lesson is looked up too.
  assert.deepEqual(r.tools?.map((x) => x.tool), ["vault.source", "course.lesson", "vault.passage"]);
});

// ---------- 2. misconceptions as evidence-backed state ----------

const M = "calc/derivatives#keeps-the-exponent";
const rec = (over: Partial<Misconception> = {}): Misconception => ({ id: M, concept: "calc/derivatives", description: "keeps the exponent", status: "suspected", evidence: [], discriminating: [], corrections: [], opened: "2026-11-10T00:00:00.000Z", updated: "2026-11-10T00:00:00.000Z", history: [], ...over });

test("misconceptions: a classified wrong answer opens a suspicion; a discriminating answer or a repeat confirms it", () => {
  const a1 = attempt({ id: "a1", timestamp: "2026-11-10T10:00:00.000Z" });
  let r = applyObservation([], { attempt: a1, pattern: { description: "keeps the exponent" } }, [a1]);
  assert.deepEqual(r.list.map((m) => [m.id, m.status, m.evidence]), [[M, "suspected", ["a1"]]]);
  assert.deepEqual(r.changes, ["misconception suspected: keeps the exponent"]);
  // The same question again is not a second piece of evidence.
  const a2 = attempt({ id: "a2", questionId: "q-a1", timestamp: "2026-11-10T10:05:00.000Z" });
  r = applyObservation(r.list, { attempt: a2, pattern: { id: M, description: "keeps the exponent" } }, [a1, a2]);
  assert.equal(r.list[0].status, "suspected");
  // A different question showing it confirms it.
  const a3 = attempt({ id: "a3", timestamp: "2026-11-10T10:10:00.000Z" });
  const confirmed = applyObservation(r.list, { attempt: a3, pattern: { description: "Keeps the exponent" } }, [a1, a2, a3]);
  assert.equal(confirmed.list[0].status, "confirmed");
  assert.equal(confirmed.list[0].history.at(-1)?.cause, "repeated");
  // So does the answer to a question set to tell it apart.
  const d = attempt({ id: "d", timestamp: "2026-11-10T10:10:00.000Z" });
  const disc = applyObservation(r.list, { attempt: d, pattern: { id: M, description: "keeps the exponent" }, discriminates: M }, [a1, a2, d]);
  assert.deepEqual([disc.list[0].status, disc.list[0].history.at(-1)?.cause, disc.list[0].discriminating], ["confirmed", "discriminating-answer", ["d"]]);
});

test("misconceptions: ambiguous evidence neither confirms nor clears, and help never resolves", () => {
  const a1 = attempt({ id: "a1" });
  const base = [rec({ evidence: ["a1"] })];
  // Wrong in another way on the discriminating question: a note, no change.
  const w = attempt({ id: "w", timestamp: "2026-11-11T10:00:00.000Z" });
  let r = applyObservation(base, { attempt: w, pattern: null, discriminates: M }, [a1, w]);
  assert.equal(r.list[0].status, "suspected");
  assert.match(r.notes[0], /neither confirms nor clears it/);
  // Right with help: a note, still open.
  const h = attempt({ id: "h", result: "correct", assisted: true, timestamp: "2026-11-11T11:00:00.000Z" });
  r = applyObservation(base, { attempt: h, targets: M }, [a1, h]);
  assert.equal(r.list[0].status, "suspected");
  assert.match(r.notes[0], /with help/);
  // An ungraded answer says nothing at all.
  const u = attempt({ id: "u", result: "ungraded", timestamp: "2026-11-11T12:00:00.000Z" });
  assert.deepEqual(applyObservation(base, { attempt: u, pattern: { description: "keeps the exponent" } }, [a1, u]).list, base);
  // A correct answer not aimed at it does not resolve it.
  const c = attempt({ id: "c", result: "correct", timestamp: "2026-11-11T13:00:00.000Z" });
  assert.equal(applyObservation(base, { attempt: c }, [a1, c]).list[0].status, "suspected");
  // Aimed at it, unaided, after the evidence: resolved.
  r = applyObservation(base, { attempt: c, targets: M }, [a1, c]);
  assert.deepEqual([r.list[0].status, r.list[0].corrections], ["resolved", ["c"]]);
  assert.ok(!isActive(r.list[0], [a1, c]));
  // Shown again after resolution: a relapse, back to suspected.
  const again = attempt({ id: "again", timestamp: "2026-11-12T10:00:00.000Z" });
  const relapse = applyObservation(r.list, { attempt: again, pattern: { id: M, description: "keeps the exponent" } }, [a1, c, again]);
  assert.deepEqual([relapse.list[0].status, relapse.list[0].history.at(-1)?.cause], ["suspected", "relapse"]);
});

test("misconceptions: disputed or invalidated attempts downgrade or withdraw a status, and keep the history", () => {
  const a1 = attempt({ id: "a1", timestamp: "2026-11-10T10:00:00.000Z" });
  const a2 = attempt({ id: "a2", timestamp: "2026-11-10T11:00:00.000Z" });
  let r = applyObservation([], { attempt: a1, pattern: { description: "keeps the exponent" } }, [a1]);
  r = applyObservation(r.list, { attempt: a2, pattern: { id: M, description: "keeps the exponent" } }, [a1, a2]);
  assert.equal(r.list[0].status, "confirmed");
  // One supporting answer disputed: back to suspected.
  const disputed2 = { ...a2, verification: "disputed" as const };
  let re = recompute(r.list, [a1, disputed2], "2026-11-12T00:00:00.000Z");
  assert.deepEqual([re.list[0].status, re.list[0].history.at(-1)?.cause], ["suspected", "evidence-withdrawn"]);
  assert.equal(re.list[0].evidence.length, 2, "evidence ids are kept; only what counts changes");
  // All of it disputed: set aside, no longer active, still on record.
  re = recompute(re.list, [{ ...a1, verification: "disputed" }, disputed2], "2026-11-12T01:00:00.000Z");
  assert.ok(!isActive(re.list[0], [{ ...a1, verification: "disputed" }, disputed2]));
  assert.match(re.changes[0], /set aside/);
  assert.match(misconceptionLine(re.list[0], [{ ...a1, verification: "disputed" }, disputed2]), /set aside: its evidence no longer counts/);
  // A resolution whose correcting answer is disputed is withdrawn, back to what the evidence supports.
  const c = attempt({ id: "c", result: "correct", timestamp: "2026-11-11T10:00:00.000Z" });
  const resolved = applyObservation(r.list, { attempt: c, targets: M }, [a1, a2, c]);
  assert.equal(resolved.list[0].status, "resolved");
  re = recompute(resolved.list, [a1, a2, { ...c, verification: "disputed" }], "2026-11-12T00:00:00.000Z");
  assert.deepEqual([re.list[0].status, re.list[0].history.at(-1)?.cause], ["confirmed", "evidence-withdrawn"]);
});

test("misconceptions: legacy lists are kept as legacy suspicions and read the same by older code", () => {
  const list = fromLegacy([], ["thinks dividing by zero is fine"], "2026-11-15T00:00:00.000Z");
  assert.deepEqual(list.map((m) => [m.concept, m.status, m.legacy]), [["", "suspected", true]]);
  assert.deepEqual(activeDescriptions(list, []), ["thinks dividing by zero is fine"]);
  // A legacy note removed by hand from state.md goes; one with evidence stays.
  assert.deepEqual(reconcile(list, [], [], "x").records, []);
  const withEvidence = rec({ evidence: ["a1"] });
  const kept = reconcile([withEvidence], [], [attempt({ id: "a1" })], "x");
  assert.deepEqual([kept.records.length, kept.list], [1, ["keeps the exponent"]]);
  // A stored record line is not an attempt to older code.
  const line = { kind: "misconception", ...withEvidence };
  assert.equal(normaliseAttempt(line), null);
  assert.deepEqual(parseMisconception(JSON.parse(JSON.stringify(line))), withEvidence);
  assert.equal(parseMisconception({ id: "x", description: "y", status: "unknown" }), null);
});

test("misconceptions: a 0.8 state with a plain list loads unchanged and the evidence log is not rewritten for it", async () => {
  const t = await setup();
  const state = await t.store.loadState(t.dir, 4);
  state.attempts = [attempt({ id: "old", concept: t.concept })];
  state.misconceptions = ["confuses the derivative with the slope of a chord"];
  delete state.misconceptionRecords;
  await t.store.saveState(t.dir, state);
  // Read and written once by this version: the attempts are normalised, nothing else is added.
  await t.store.saveState(t.dir, await t.store.loadState(t.dir, 4));
  const evidence = await t.fs.read(`${t.dir}/evidence.md`);
  assert.ok(!/"kind":"misconception"/.test(evidence), "a pristine legacy note is not written to the log");
  const again = await t.store.loadState(t.dir, 4);
  assert.deepEqual(again.misconceptions, ["confuses the derivative with the slope of a chord"]);
  assert.deepEqual(again.misconceptionRecords?.map((m) => [m.legacy, m.status]), [[true, "suspected"]]);
  assert.match(await t.fs.read(`${t.dir}/state.md`), /## Misconceptions\n\n- confuses the derivative with the slope of a chord/);
  await t.store.saveState(t.dir, again);
  assert.equal(await t.fs.read(`${t.dir}/evidence.md`), evidence);
});

// ---------- 3. Master mode: one next move ----------

const input = (over: Partial<Parameters<typeof chooseMove>[0]> = {}): Parameters<typeof chooseMove>[0] => ({ intent: "none", pending: false, concept: "calc/derivatives", attempts: [], misconceptions: [], askedUnder: "", targets: "", discriminates: "", helpGiven: 0, ...over });

test("moves: the learner's requests come first, and hints are graduated", () => {
  const confirmed = rec({ status: "confirmed", evidence: ["a1", "a2"] });
  let d = chooseMove(input({ intent: "hint", pending: true, misconceptions: [confirmed] }));
  assert.deepEqual([d.move, d.reason, d.hintStage, d.misconception?.id], ["hint", "LEARNER_ASKED_HELP", 1, M]);
  assert.match(moveBrief(d), /Give hint 1 of 4: point to the step.*Aim it at the confirmed pattern/s);
  assert.equal(chooseMove(input({ intent: "hint", pending: true, helpGiven: 2 })).hintStage, 3);
  assert.equal(chooseMove(input({ intent: "hint", pending: true, helpGiven: 9 })).hintStage, 4, "the ladder stops at a full explanation");
  assert.deepEqual([chooseMove(input({ intent: "skip", pending: true })).move, chooseMove(input({ intent: "skip", pending: true })).reason], ["worked-solution", "LEARNER_SKIPPED"]);
  assert.equal(chooseMove(input({ intent: "reveal", pending: true })).reason, "LEARNER_ASKED_ANSWER");
  assert.deepEqual([chooseMove(input({ intent: "switch", pending: true })).move, chooseMove(input({ intent: "switch", pending: true })).reason], ["fresh-application", "LEARNER_MOVED_ON"]);
  assert.equal(chooseMove(input({ intent: "question", pending: true })).reason, "OPEN_QUESTION_WAITING");
  // An answer is checked; the follow-up branches are decided in code, one per kind of mark.
  d = chooseMove(input({ intent: "attempt", pending: true, misconceptions: [confirmed, rec({ id: "calc/derivatives#drops-the-coefficient", description: "drops the coefficient", evidence: ["a3"] })] }));
  assert.equal(d.move, "check");
  const brief = moveBrief(d);
  assert.match(brief, /wrong, and it shows "keeps the exponent" → address-misconception \[CONFIRMED_MISCONCEPTION\] \(calc\/derivatives#keeps-the-exponent\)/);
  assert.match(brief, /wrong, and it may show "drops the coefficient" → probe \[SUSPECTED_MISCONCEPTION\]/);
  assert.match(brief, /right, though "keeps the exponent" is still open → address-misconception/);
  assert.match(brief, /exactly one question/);
});

test("moves: with too little evidence the move says so, and a suspicion is told apart before anything is assumed", () => {
  let d = chooseMove(input());
  assert.deepEqual([d.move, d.reason, d.evidence], ["fresh-application", "NO_EVIDENCE", []]);
  d = chooseMove(input({ misconceptions: [rec({ evidence: ["gone"] })] }));
  assert.deepEqual([d.move, d.reason, d.misconception?.id], ["probe", "SUSPECTED_MISCONCEPTION", M]);
  // An answer that could not be judged is probed, never treated as wrong.
  d = chooseMove(input({ attempts: [attempt({ id: "u", concept: "calc/derivatives", result: "ungraded" })] }));
  assert.deepEqual([d.move, d.reason], ["probe", "AMBIGUOUS_ANSWER"]);
  const uncheckable = attempt({ id: "x", concept: "calc/derivatives", result: "incorrect", reasoning: { ...parseReasoning({ result: "unclear", certainty: "uncheckable" })! } });
  assert.equal(afterMark(uncheckable, [], { askedUnder: "", targets: "", discriminates: "" }).reason, "AMBIGUOUS_ANSWER");
  assert.match(moveLine(d), /^Tutor move: probe \(AMBIGUOUS_ANSWER: the last answer could not be judged yet\) · evidence u$/);
});

test("moves: conflicting signals resolve by code's order, and a disputed answer is passed over", () => {
  const concept = "calc/derivatives";
  const confirmed = rec({ status: "confirmed", evidence: ["w1", "w2"] });
  const right = attempt({ id: "r", concept, result: "correct", timestamp: "2026-11-12T10:00:00.000Z", reasoning: parseReasoning({ result: "correct", method: "sound" })! });
  // Right, but a confirmed misconception it was not aimed at is still open: that comes first.
  let d = chooseMove(input({ attempts: [right], misconceptions: [confirmed] }));
  assert.deepEqual([d.move, d.reason, d.evidence[0]], ["address-misconception", "MISCONCEPTION_STILL_OPEN", "r"]);
  // Right, aimed at it: the justified answer gets a fresh application.
  d = chooseMove(input({ attempts: [right], misconceptions: [confirmed], targets: M }));
  assert.deepEqual([d.move, d.reason], ["fresh-application", "JUSTIFIED"]);
  // Right result, flawed method: ask for the justification, unless that was the question.
  const flawed = { ...right, reasoning: parseReasoning({ result: "correct", method: "flawed" })! };
  assert.equal(chooseMove(input({ attempts: [flawed] })).reason, "FLAWED_METHOD");
  assert.equal(chooseMove(input({ attempts: [flawed], askedUnder: "ask-justification" })).reason, "JUSTIFIED");
  // Right as a guess, and right with help.
  assert.equal(chooseMove(input({ attempts: [{ ...right, reasoning: undefined, answer: "B or C, I guess" }] })).reason, "HEDGED_CORRECT");
  assert.equal(chooseMove(input({ attempts: [{ ...right, assisted: true }] })).reason, "HELPED_SUCCESS");
  // Wrong, its cause unknown: find the failed step, aimed at the earliest error when there is one.
  const wrong = attempt({ id: "w", concept, timestamp: "2026-11-13T10:00:00.000Z", reasoning: parseReasoning({ result: "incorrect", method: "sound", earliest_error: { step: "2^3 = 6", kind: "arithmetic" } })! });
  d = chooseMove(input({ attempts: [right, wrong] }));
  assert.deepEqual([d.move, d.reason, d.step], ["probe", "FIND_FAILED_STEP", "2^3 = 6"]);
  // The latest answer disputed: the one before it is what stands.
  d = chooseMove(input({ attempts: [right, { ...wrong, verification: "disputed" }] }));
  assert.equal(d.reason, "JUSTIFIED");
});

test("moves in a Master-mode chat: code picks the follow-up from the mark, the misconception moves with the evidence, levels only by attempts", async () => {
  const t = await setup();
  const chat = await t.chatIn("tutor");
  const id = `${t.concept}#multiplies-by-the-exponent-but-does-not`;
  // 1. No evidence yet: a fresh application.
  t.replies.push(`Differentiate $x^3$?\n${session({ pendingQuestion: "Differentiate $x^3$?" })}`);
  let r = await t.engine.turn(t.dir, chat, "");
  assert.deepEqual([r.move?.move, r.move?.reason], ["fresh-application", "NO_EVIDENCE"]);
  assert.match(t.calls[0].input, /Tutor move: fresh-application \[NO_EVIDENCE\]/);
  await tick();
  // 2. A wrong answer, classified: a suspicion opens, and the follow-up tells it apart.
  t.replies.push(`Not quite. What is the exponent of x after you differentiate $x^3$?\n${tag({ result: "incorrect", error_type: "conceptual", misconception: "multiplies by the exponent but does not lower it", reasoning: { result: "incorrect", method: "flawed", earliest_error: "3x^3", certainty: "complete" }, next_move: "probe" })}\n${session({ pendingQuestion: "What is the exponent of x after you differentiate $x^3$?" })}`);
  r = await t.engine.turn(t.dir, chat, "3x^3");
  assert.match(t.calls[1].input, /Tutor move: check \[ANSWER_TO_CHECK\]/);
  assert.match(t.calls[1].input, /Add "next_move"/);
  assert.match(t.calls[1].input, /add "reasoning" to the attempt line/);
  assert.deepEqual([r.attempt?.result, r.attempt?.reasoning?.method.verdict, r.attempt?.reasoning?.earliestError?.step], ["incorrect", "flawed", "3x^3"]);
  assert.deepEqual([r.move?.move, r.move?.reason, r.move?.misconception?.id, r.move?.chosen], ["probe", "SUSPECTED_MISCONCEPTION", id, "probe"]);
  assert.ok(r.changes.includes("misconception suspected: multiplies by the exponent but does not lower it"));
  let rec1 = r.state.misconceptionRecords!.find((m) => m.id === id)!;
  assert.equal(rec1.status, "suspected");
  let chatNow = await t.store.loadChat(chat);
  let s = JSON.parse(String(chatNow.fm.session));
  assert.deepEqual([s.action, s.askedUnder, s.discriminates, s.move.reason], ["probe", "probe", id, "SUSPECTED_MISCONCEPTION"]);
  await tick();
  // 3. The discriminating question answered the same wrong way: confirmed, and addressed next.
  t.replies.push(`That keeps the exponent. Differentiate $x^5$ and check it against the slope at $x=1$.\n${tag({ result: "incorrect", error_type: "conceptual", misconception: id, next_move: "address-misconception" })}\n${session({ pendingQuestion: "Differentiate $x^5$ and check it against the slope at $x=1$." })}`);
  r = await t.engine.turn(t.dir, chat, "still 3, the exponent stays");
  rec1 = r.state.misconceptionRecords!.find((m) => m.id === id)!;
  assert.deepEqual([rec1.status, rec1.history.at(-1)?.cause], ["confirmed", "discriminating-answer"]);
  assert.deepEqual([r.move?.move, r.move?.reason], ["address-misconception", "CONFIRMED_MISCONCEPTION"]);
  chatNow = await t.store.loadChat(chat);
  s = JSON.parse(String(chatNow.fm.session));
  assert.equal(s.targets, id);
  await tick();
  // 4. Right without help, aimed at it: resolved, and a fresh application follows.
  t.replies.push(`Right. Now differentiate $3x^4$.\n${tag({ result: "correct", reasoning: { result: "correct", method: "sound", certainty: "complete" }, next_move: "fresh-application" })}\n${session({ pendingQuestion: "Now differentiate $3x^4$." })}`);
  r = await t.engine.turn(t.dir, chat, "5x^4, the exponent drops by one");
  rec1 = r.state.misconceptionRecords!.find((m) => m.id === id)!;
  assert.deepEqual([rec1.status, rec1.corrections.length], ["resolved", 1]);
  assert.deepEqual([r.move?.move, r.move?.reason], ["fresh-application", "JUSTIFIED"]);
  assert.deepEqual(r.state.misconceptions, []);
  // Levels moved only by marked answers: every change is caused by an attempt.
  const st = await t.store.loadState(t.dir, 4);
  assert.ok(st.changes.every((c) => st.attempts.some((a) => a.id === c.cause)), JSON.stringify(st.changes));
  // The records are kept in the evidence log, next to the attempts they cite.
  assert.match(await t.fs.read(`${t.dir}/evidence.md`), /"kind":"misconception".*"status":"resolved"/);
});

test("moves in a chat: the hint ladder climbs with each request, and a late hint brings the lesson in", async () => {
  const t = await setup();
  const chat = await t.chatIn("tutor");
  const q = "Differentiate $x^3$?";
  t.replies.push(`${q}\n${session({ pendingQuestion: q })}`);
  await t.engine.turn(t.dir, chat, "");
  for (const k of [1, 2, 3]) {
    t.replies.push(`A hint. ${q}\n${session({ pendingQuestion: q })}`);
    const r = await t.engine.turn(t.dir, chat, "hint please");
    assert.deepEqual([r.move?.move, r.move?.hintStage], ["hint", k]);
    assert.match(t.calls[k].input, new RegExp(`Give hint ${k} of 4`));
    assert.equal(r.depth?.level, k >= 3 ? "lesson" : "card");
  }
  // The third hint shows a step worked: the lesson for the concept comes with it, gaps marked.
  assert.match(t.calls[3].input, /# Lesson material for Derivatives \(from the course as compiled; no deeper lesson\)/);
  assert.match(t.calls[3].input, /Missing from the course: this course was compiled before deeper lessons/);
  assert.ok(!/# Lesson material/.test(t.calls[1].input), "a routine turn works from the card");
});

test("a Master reply that reports a different move does not record a diagnostic target", async () => {
  const t = await setup();
  const chat = await t.chatIn("tutor");
  t.replies.push(`Differentiate $x^3$?\n${session({ pendingQuestion: "Differentiate $x^3$?" })}`);
  await t.engine.turn(t.dir, chat, "");
  t.replies.push(`Try a different function. What is the derivative of $x^2$?\n${tag({ result: "incorrect", error_type: "conceptual", misconception: "multiplies by the exponent but does not lower it", next_move: "fresh-application" })}\n${session({ pendingQuestion: "What is the derivative of $x^2$?" })}`);
  const result = await t.engine.turn(t.dir, chat, "3x^3");
  assert.deepEqual([result.move?.reason, result.move?.chosen], ["SUSPECTED_MISCONCEPTION", "fresh-application"]);
  const saved = JSON.parse(String((await t.store.loadChat(chat)).fm.session));
  assert.deepEqual([saved.targets, saved.discriminates], ["", ""]);
  assert.ok(result.notes?.some(note => note.includes("without the misconception target")));
});

// ---------- 4. outcome kept apart from reasoning ----------

test("reasoning: a rubric maps to result, method and assumptions, the same way every time", () => {
  assert.deepEqual(rubricDimensions("final answer 1/4; justifies each step by a valid rule; states that the divisor is nonzero").map((x) => x.dimension), ["result", "method", "assumptions"]);
  assert.deepEqual(rubricDimensions("uses the antiderivative x^3; evaluates at both limits; final answer 8").map((x) => x.dimension), ["method", "method", "result"]);
  assert.equal(finalExpression("16/64\n= 1/4"), "1/4");
  assert.equal(finalExpression("16/64 = 1/4 (divide numerator and denominator by 16)"), "1/4");
  assert.equal(finalExpression("it is about speed, I think"), "it is about speed, I think");
  assert.equal(finalExpression("first line\nsecond line"), "");
});

test("reasoning: SymPy settles only the result it compared, and a disagreement with the grader is kept visible", () => {
  const graded = parseReasoning({ result: "correct", method: "flawed", earliest_error: { step: "cancel the 6s", kind: "conceptual" } }, "final answer 1/4; justifies each step")!;
  const checked = withCheck(graded, { evaluated: "the final result 1/4 against the expected 1/4", kind: "symbolic", outcome: true, assumptions: "compared by simplifying the difference" });
  assert.deepEqual([checked.result.verdict, checked.result.by, checked.method.verdict, checked.gradedResult], ["correct", "symbolic", "flawed", undefined]);
  const lines = reasoningLines(checked);
  assert.match(lines[0], /^Result: right \(checked symbolically by SymPy: the final result 1\/4 against the expected 1\/4/);
  assert.match(lines[1], /^Method: flawed \(the grader's judgement; SymPy does not check methods\)\./);
  const wrongly = withCheck(parseReasoning({ result: "correct", method: "sound" })!, { evaluated: "1/5 against 1/4", kind: "symbolic", outcome: false, assumptions: "" });
  assert.deepEqual([wrongly.result.verdict, wrongly.gradedResult, resultConflict(wrongly)], ["incorrect", "correct", true]);
  assert.equal(resultConflict(withCheck(parseReasoning({ result: "unclear" })!, { evaluated: "", kind: "symbolic", outcome: null, assumptions: "" })), false, "an undecided check decides nothing");
  assert.equal(parseReasoning({ grade: "good" }), null, "a grader that gives no breakdown is read as before");
  assert.equal(parseReasoning({ result: "unclear" })!.certainty, "incomplete", "an unclear result cannot be complete");
});

test("reasoning in a quiz: right result by a flawed method, and a good method with a late slip", async () => {
  const t = await setup({ maths: true });
  const chat = await t.chatIn("quiz");
  const c = await t.store.loadChat(chat);
  c.fm.card = "Q1";
  c.messages.push({ role: "tutor", text: "Simplify 16/64, showing your method." });
  await t.store.saveChat(chat, c);
  t.replies.push(JSON.stringify({ grade: "hard", feedback: "Right answer, but cancelling digits is not a valid rule.", reasoning: { result: "correct", method: "flawed", method_note: "cancelling digits is not a rule", assumptions: "unstated", earliest_error: { step: "cancel the 6s", kind: "conceptual", why: "digits are not factors" }, certainty: "complete", rubric_met: ["yes", "no", "no"] } }));
  let r = await t.engine.quizTurn(t.dir, chat, "Cancel the 6s:\n16/64 = 1/4");
  assert.ok(t.calls[0].jsonSchema.properties.reasoning, "an open answer is graded with the breakdown");
  assert.match(t.calls[0].input, /Rubric by what it checks:\n- result: final answer 1\/4\n- method: justifies each step by a valid rule\n- assumptions: states that the divisor is nonzero/);
  let a = r.attempt!;
  assert.deepEqual([a.result, a.reasoning?.result.verdict, a.reasoning?.result.by, a.reasoning?.method.verdict, a.reasoning?.earliestError?.step], ["partial", "correct", "symbolic", "flawed", "cancel the 6s"]);
  assert.deepEqual(a.reasoning?.rubric.map((x) => [x.dimension, x.met]), [["result", "yes"], ["method", "no"], ["assumptions", "no"]]);
  assert.match(a.assumptions, /SymPy checked the final result only, not the method/);
  assert.deepEqual(t.maths.asked.at(-1)?.map((x) => [x.a, x.b]), [["1/4", "1/4"]]);

  // A sound method that ends in a late arithmetic slip.
  const c2 = await t.store.loadChat(chat);
  c2.fm.card = "Q2";
  await t.store.saveChat(chat, c2);
  t.replies.push(JSON.stringify({ grade: "hard", feedback: "Sound method; 2^3 is 8.", reasoning: { result: "incorrect", method: "sound", assumptions: "none-needed", earliest_error: { step: "2^3 - 0 = 6", kind: "arithmetic", why: "2^3 is 8" }, certainty: "complete" } }));
  r = await t.engine.quizTurn(t.dir, chat, "antiderivative x^3\n[x^3] from 0 to 2\n= 2^3 - 0 = 6");
  a = r.attempt!;
  assert.deepEqual([a.result, a.reasoning?.result.verdict, a.reasoning?.result.by, a.reasoning?.method.verdict, a.reasoning?.earliestError?.kind, a.reasoning?.gradedResult], ["partial", "incorrect", "symbolic", "sound", "arithmetic", undefined]);
  // Stored and read back exactly.
  const st = await t.store.loadState(t.dir, 4);
  assert.deepEqual(st.attempts.find((x) => x.id === a.id)?.reasoning, a.reasoning);
});

test("reasoning in a quiz: an ambiguous answer stays uncertain, and a conflict with SymPy leaves the answer ungraded", async () => {
  const t = await setup({ maths: true });
  const chat = await t.chatIn("quiz");
  const set = async (card: string) => {
    const c = await t.store.loadChat(chat);
    c.fm.card = card;
    await t.store.saveChat(chat, c);
  };
  await set("Q3");
  t.replies.push(JSON.stringify({ grade: "again", feedback: "Too vague to judge.", reasoning: { result: "unclear", method: "unclear", certainty: "uncheckable" } }));
  let r = await t.engine.quizTurn(t.dir, chat, "kind of like speed, maybe");
  assert.deepEqual([r.attempt?.reasoning?.result.verdict, r.attempt?.reasoning?.certainty, r.attempt?.reasoning?.result.by], ["unclear", "uncheckable", "model"]);
  assert.match(reasoningLines(r.attempt!.reasoning!).join(" "), /could not be checked from what was given/);
  assert.equal(t.maths.asked.length, 0, "prose is not sent to SymPy");

  await set("Q1");
  const before = await t.store.loadState(t.dir, 4);
  const total = Number((await t.store.loadChat(chat)).fm.total);
  t.replies.push(JSON.stringify({ grade: "good", feedback: "Correct.", reasoning: { result: "correct", method: "sound", certainty: "complete" } }));
  r = await t.engine.quizTurn(t.dir, chat, "16/64 = 1/5");
  assert.equal(r.attempt?.result, "ungraded");
  assert.ok(resultConflict(r.attempt?.reasoning));
  assert.match(r.reply, /^\*\*Left ungraded\.\*\* SymPy and the grader disagree about the final result/);
  const after = await t.store.loadState(t.dir, 4);
  assert.deepEqual([after.levels, after.bank], [before.levels, before.bank], "an ungraded answer moves nothing");
  assert.equal(Number((await t.store.loadChat(chat)).fm.total), total);
});

test("grading: the overall mark never says more than its breakdown, and an uncheckable answer is no evidence", () => {
  const rubric = "final answer 1/4; justifies each step by a valid rule; states that the divisor is nonzero";
  const br = (o: Record<string, unknown>) => parseReasoning({ certainty: "complete", ...o }, rubric)!;
  const sympyRight = (o: Record<string, unknown>) => withCheck(br(o), { evaluated: "the final result 1/4 against the expected 1/4", kind: "symbolic", outcome: true, assumptions: "compared as expressions" });
  const cases: [string, Parameters<typeof normaliseMark>[0], string, boolean, string[]][] = [
    ["uncheckable, marked right", { proposed: "correct", reasoning: br({ result: "correct", method: "sound", certainty: "uncheckable" }), rubric }, "ungraded", false, ["uncheckable"]],
    ["uncheckable, marked wrong", { proposed: "incorrect", reasoning: br({ result: "incorrect", method: "flawed", certainty: "uncheckable" }), rubric }, "ungraded", false, ["uncheckable"]],
    ["SymPy-checked result cannot establish an unassessed method", { proposed: "correct", reasoning: sympyRight({ result: "unclear", method: "not-assessed", assumptions: "sound" }), rubric }, "partial", false, ["method-unassessed"]],
    ["marked right while its own result verdict says wrong", { proposed: "correct", reasoning: br({ result: "incorrect", method: "sound", assumptions: "sound" }), rubric }, "ungraded", false, ["overall-contradicts-result"]],
    ["right result by a flawed method keeps partial credit", { proposed: "correct", reasoning: sympyRight({ result: "correct", method: "flawed", assumptions: "sound" }), rubric }, "partial", true, ["method-flawed"]],
    ["sound method with a late slip keeps justified partial credit", { proposed: "partial", reasoning: br({ result: "incorrect", method: "sound", assumptions: "sound", earliest_error: { step: "2^3 = 6", kind: "arithmetic" } }), rubric }, "partial", true, []],
    ["marked wrong with nothing assessed against it", { proposed: "incorrect", reasoning: sympyRight({ result: "correct", method: "sound", assumptions: "sound" }), rubric }, "ungraded", false, ["negative-without-basis"]],
    ["required assumption not stated", { proposed: "correct", reasoning: br({ result: "correct", method: "sound", assumptions: "unstated" }), rubric }, "partial", true, ["assumptions-unstated"]],
    ["every required dimension judged sound", { proposed: "correct", reasoning: sympyRight({ result: "correct", method: "sound", assumptions: "sound" }), rubric }, "correct", true, []],
    ["no breakdown (exact answer or multiple choice) stands", { proposed: "correct", reasoning: null }, "correct", true, []],
    ["no rubric: an unassessed method blocks nothing", { proposed: "correct", reasoning: parseReasoning({ result: "correct", certainty: "complete" }, "") }, "correct", true, []],
  ];
  for (const [name, input, result, counts, rules] of cases) {
    const m = normaliseMark(input);
    assert.deepEqual([m.result, m.basis.conclusive, m.basis.rules], [result, counts, rules], name);
  }
  // The proposed mark is kept beside the recorded one, and the panel explains the change.
  const m = normaliseMark(cases[2][1]);
  assert.equal(m.basis.proposed, "correct");
  assert.deepEqual(m.basis.requires, ["result", "method", "assumptions"]);
  assert.match(markLine({ result: m.result, mark: m.basis }), /^Proposed as correct, recorded as partly right \(method unassessed\)\. Kept for the record; not used as evidence/);
});

test("grading: an inconclusive mark is history, not a data point, and survives a reload", async () => {
  const t = await setup({ maths: true });
  const chat = await t.chatIn("quiz");
  const set = async (card: string) => {
    const c = await t.store.loadChat(chat);
    c.fm.card = card;
    await t.store.saveChat(chat, c);
  };
  // A right final answer, but the method the rubric asks for cannot be judged from a bare result.
  await set("Q1");
  t.replies.push(JSON.stringify({ grade: "good", feedback: "Correct.", reasoning: { result: "correct", method: "unclear", assumptions: "unclear", certainty: "incomplete" } }));
  let r = await t.engine.quizTurn(t.dir, chat, "16/64 = 1/4");
  let a = r.attempt!;
  assert.deepEqual([a.result, a.reasoning?.result.by, a.mark?.proposed, a.mark?.conclusive], ["partial", "symbolic", "correct", false]);
  assert.match(r.reply, /^\*\*Partly right\.\*\* Correct\. The final result is right, but the method the question asks for could not be judged/);
  let st = await t.store.loadState(t.dir, 4);
  assert.deepEqual(st.attempts.find((x) => x.id === a.id)?.mark, a.mark, "the basis is stored and read back");
  let e = skillEvidence(st.attempts, 1);
  assert.deepEqual([e.independent, e.inconclusive, e.recentFailures, e.partialAny, e.errors], [0, 1, 0, 1, {}], "it shows the result was right, and is neither a success nor a failure point");
  assert.equal(st.misconceptionRecords?.filter((m) => !m.legacy).length ?? 0, 0);

  // An answer the grader says it could not check moves nothing, whatever overall mark it proposed.
  await set("Q3");
  const before = await t.store.loadState(t.dir, 4);
  t.replies.push(JSON.stringify({ grade: "again", feedback: "Too vague to judge.", reasoning: { result: "unclear", method: "unclear", certainty: "uncheckable" } }));
  r = await t.engine.quizTurn(t.dir, chat, "kind of like speed, maybe");
  a = r.attempt!;
  assert.deepEqual([a.result, a.mark?.rules], ["ungraded", ["uncheckable"]]);
  assert.match(r.reply, /^\*\*Left ungraded\.\*\* The grader could not judge this answer/);
  st = await t.store.loadState(t.dir, 4);
  assert.deepEqual([st.levels, st.bank, st.cards.Q3], [before.levels, before.bank, before.cards.Q3], "no level, counter or card schedule moved");
  e = skillEvidence(st.attempts, 2);
  assert.deepEqual([e.graded, e.errors], [skillEvidence(before.attempts, 2).graded, skillEvidence(before.attempts, 2).errors]);
});

test("grading: a tutor's mark is held to its breakdown, and SymPy checking the reply does not verify the mark", async () => {
  const t = await setup({ maths: true });
  const chat = await t.chatIn("tutor");
  const c = await t.store.loadChat(chat);
  c.messages.push({ role: "tutor", text: "What does the derivative measure?" });
  c.fm.session = JSON.stringify({ version: 2, pendingQuestion: "What does the derivative measure?", questionId: "q-free", askedAt: new Date(Date.now() - 30000).toISOString(), action: "independent-practice", helpGiven: [] });
  await t.store.saveChat(chat, c);
  t.replies.push(`Hard to say from that.\n${tag({ result: "correct", task_type: "explanation", reasoning: { result: "unclear", method: "unclear", certainty: "uncheckable" } })}\n${session({ action: "probe" })}`);
  const r = await t.engine.study(t.dir, chat, "it is the slope thing");
  assert.deepEqual([r.attempt?.result, r.attempt?.verification, r.attempt?.mark?.rules], ["ungraded", "unverified", ["uncheckable"]]);
  assert.match(r.attempt!.note, /could not judge this answer/);
  const st = await t.store.loadState(t.dir, 4);
  assert.equal(skillEvidence(st.attempts, 2).independent, 0);
});

test("reasoning: exact answers, multiple choice and legacy attempts keep working without a breakdown", async () => {
  const t = await setup();
  const chat = await t.chatIn("quiz");
  for (const [card, answer] of [["Q4", "B"], ["Q5", "2x"]]) {
    const c = await t.store.loadChat(chat);
    c.fm.card = card;
    await t.store.saveChat(chat, c);
    const r = await t.engine.quizTurn(t.dir, chat, answer);
    assert.equal(r.attempt?.result, "correct");
    assert.equal(r.attempt?.reasoning, undefined);
  }
  assert.equal(t.calls.length, 0, "marked by code, no grading call");
  // A short answer the code cannot match goes to the grader without the breakdown.
  const c = await t.store.loadChat(chat);
  c.fm.card = "Q5";
  await t.store.saveChat(chat, c);
  t.replies.push('{"grade":"good","feedback":""}');
  await t.engine.quizTurn(t.dir, chat, "two times x");
  assert.equal(t.calls[0].jsonSchema.properties.reasoning, undefined);
  // A legacy record has no breakdown, and a damaged one is dropped rather than guessed.
  const legacy = normaliseAttempt({ id: "old", timestamp: "2026-01-01T00:00:00Z", question: "q", result: "correct", source: "bank" })!;
  assert.ok(!("reasoning" in legacy));
  assert.equal(normaliseAttempt({ id: "d", timestamp: "2026-01-01T00:00:00Z", question: "q", reasoning: { v: 2, junk: true } })!.reasoning, undefined);
  assert.equal(normaliseReasoning(undefined), undefined);
});

// ---------- 5. lesson depth and gap closing ----------

test("depth: routine turns use the card; remediation, late hints and why-questions use the lesson", () => {
  const routine = chooseMove(input({ intent: "attempt", pending: true }));
  assert.equal(lessonDepth({ mode: "tutor", action: null, move: routine, said: "3x^2", intent: "attempt" }).level, "card");
  assert.equal(lessonDepth({ mode: "tutor", action: null, move: { ...routine, move: "address-misconception", reason: "CONFIRMED_MISCONCEPTION" }, said: "", intent: "none" }).level, "lesson");
  assert.equal(lessonDepth({ mode: "tutor", action: null, move: { ...routine, move: "probe", reason: "AMBIGUOUS_ANSWER" }, said: "", intent: "none" }).level, "card");
  assert.equal(lessonDepth({ mode: "expert", action: null, move: null, said: "why does the power rule work?", intent: "question" }).level, "lesson");
  assert.deepEqual(Object.values(lessonDepth({ mode: "expert", action: null, move: null, said: "what is a limit", intent: "question" })).slice(0, 2), ["card", true]);
  assert.equal(lessonDepth({ mode: "teach", action: "explain", move: null, said: "", intent: "none" }).level, "card");
  assert.equal(lessonDepth({ mode: "teach", action: "diagnose-error", move: null, said: "", intent: "none" }).level, "lesson");
});

test("depth: an older course falls back to what it has, and says what is missing per objective", () => {
  const sk: F.Subskill = { n: 2, name: "Derivatives", prerequisites: [1], relations: [], sources: ["[[Calc notes]]"], section: "", objectives: ["O1", "O2"], worked: "" };
  let m = fallbackMaterial({ conceptId: "c", subskill: sk, pkg: null, objectives: [{ id: "O1", text: "Differentiate powers", source: "Spec 2.1" }] });
  assert.deepEqual([m.from, m.objectives.map((o) => [o.id, o.ref, o.source, o.assessment])], ["card", [["O1", "Spec 2.1", "available", "unknown"], ["O2", "", "unknown", "unknown"]]]);
  assert.deepEqual(missingEvidence(m), ["this course was compiled before deeper lessons, so only the card and its worked example are available", "no worked example"]);
  const pkg: any = { lessons: [{ n: 2, concept: "c", worked: "d/dx x^3 = 3x^2", citations: ["[[Calc notes]]"], objectives: ["O1"] }], objectives: [{ id: "O1", text: "Differentiate powers", source: "Spec 2.1", subskills: [2], questions: [] }] };
  m = fallbackMaterial({ conceptId: "c", subskill: sk, pkg, objectives: [] });
  assert.deepEqual([m.from, m.worked, m.objectives[0].assessment], ["package", "d/dx x^3 = 3x^2", "missing"]);
  assert.ok(missingEvidence(m).includes("objective O1 (Spec 2.1): no assessment material"));
});

test("depth in a chat: the compiled lesson is used when the compiler provides one", async () => {
  const t = await setup();
  t.engine.material = { lessonFor: async (_dir, id) => ({ conceptId: id, lesson: "Derivatives measure instantaneous change; the power rule follows from the binomial expansion.", worked: "d/dx x^3 = 3x^2", refs: ["[[Calc notes]]"], objectives: [{ id: "O1", text: "Differentiate powers", ref: "Spec 2.1", source: "available", teaching: "available", assessment: "missing" }], from: "compiled" }) };
  const chat = await t.chatIn("expert");
  t.replies.push("Because of the binomial expansion.");
  const r = await t.engine.turn(t.dir, chat, "Why does the power rule work?");
  assert.match(t.calls[0].input, /# Lesson material for Derivatives \(compiled lesson\)\n\nDerivatives measure instantaneous change/);
  assert.match(t.calls[0].input, /Objectives: O1 \[Spec 2\.1\] Differentiate powers/);
  assert.match(t.calls[0].input, /Missing from the course: objective O1 \(Spec 2\.1\): no assessment material/);
  assert.deepEqual([r.depth?.level, r.depth?.missing], ["lesson", ["objective O1 (Spec 2.1): no assessment material"]]);
  assert.ok(t.calls[0].system.indexOf("binomial expansion") < 0, "the lesson goes in the turn input, so the cached system prompt is unchanged");
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

test("expansion: without a compiler adapter the request is unavailable, and tutoring carries on", async () => {
  const t = await setup();
  const before = await t.store.loadState(t.dir, 4);
  const chat = await t.chatIn("expert");
  t.replies.push("Here is what the course covers.");
  const r = await t.engine.turn(t.dir, chat, "How is this used in physics? I want to go further.");
  assert.equal(r.reply, "Here is what the course covers.");
  assert.deepEqual([r.expansion?.status, r.expansion?.request.kind, r.expansion?.request.anchor.conceptId], ["unavailable", "extension", t.concept]);
  assert.match(t.calls[0].input, /# Linked material not available\nMaterial for going further: "How is this used in physics\? I want to go further\." could not be prepared \(unavailable\)/);
  assert.match(expansionLine(r.expansion!), /Extension request: .* · not available here/);
  const after = await t.store.loadState(t.dir, 4);
  assert.deepEqual([after.levels, after.attempts.length, after.changes.length], [before.levels, before.attempts.length, before.changes.length]);
  assert.equal((await t.store.loadExpansions(t.dir)).length, 1);
});

test("expansion: a request runs without blocking, its result is labelled and used next turn, and it never touches evidence", async () => {
  const t = await setup();
  const gate = deferred<ExpansionResult>();
  const sent: ExpansionRequest[] = [];
  t.engine.expander = { request: async (req) => (sent.push(req), gate.promise) };
  const before = JSON.stringify((await t.store.loadState(t.dir, 4)).attempts);
  const chat = await t.chatIn("expert");
  t.replies.push("Meanwhile, from the course: …");
  let r = await t.engine.turn(t.dir, chat, "Can we go further: how is this used in physics?");
  assert.equal(r.expansion?.status, "pending");
  assert.match(t.calls[0].input, /# Linked material requested\n.*is not ready\. Teach from what the course has now/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].maxConcepts, 2);
  // The same request is not sent twice while it runs.
  t.replies.push("Still preparing.");
  r = await t.engine.turn(t.dir, chat, "Can we go further: how is this used in physics?");
  assert.equal(sent.length, 1);
  assert.equal(r.expansion?.status, "pending");
  // It settles: partial, one objective left uncovered.
  gate.resolve({ requestId: sent[0].id, status: "complete", linked: [{ conceptId: "physics/velocity", name: "Velocity", topicDir: "Tutor/Topics/Physics", relation: "applies_to" }], coverage: [{ objectiveId: "X1", text: "velocity as a derivative", status: "covered", refs: ["[[Physics notes]]"] }, { objectiveId: "X2", text: "acceleration", status: "uncovered", refs: [] }], beyondSpec: false, message: "" });
  const settled = await t.engine.expansionSettled(sent[0].id);
  assert.equal(settled?.status, "partial", "a complete result with an uncovered objective is partial");
  t.replies.push("Velocity is the derivative of position.");
  r = await t.engine.turn(t.dir, chat, "Tell me about velocity.");
  assert.match(t.calls[2].input, /# Linked material ready \(partial\)\nFor going further: .* the course now links: Velocity \(applies_to, in Tutor\/Topics\/Physics\)\. References: \[\[Physics notes\]\]\. This is beyond the original specification: say so when you use it/);
  assert.match(t.calls[2].input, /Still uncovered: X2 \(acceleration\): not covered\./);
  assert.match(t.calls[2].input, /It is study material only: it changes no level\./);
  // Told once, then not repeated.
  t.replies.push("ok");
  await t.engine.turn(t.dir, chat, "thanks");
  assert.ok(!/Linked material/.test(t.calls[3].input));
  assert.equal(JSON.stringify((await t.store.loadState(t.dir, 4)).attempts), before, "no evidence was written");
});

test("expansion: cancelled, failed, or left pending by a closed app; and a missing prerequisite the course has is not requested", async () => {
  const t = await setup();
  t.engine.expander = { request: (_req, signal) => new Promise((_res, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))) };
  const req = expansionRequest({ kind: "prerequisite", topicDir: t.dir, conceptId: t.concept, conceptName: "Derivatives", gap: "trigonometric identities", evidence: ["a1"], at: "2026-11-15T00:00:00Z" });
  assert.equal((await t.engine.requestExpansion(t.dir, req)).status, "pending");
  const stopped = await t.engine.cancelExpansion(t.dir, req.id);
  assert.equal(stopped?.status, "cancelled");
  assert.match(expansionNote(stopped!), /could not be prepared \(cancelled/);
  // A failure is reported, not hidden.
  const failing: CourseExpander = { request: async () => { throw new Error("compiler busy"); } };
  t.engine.expander = failing;
  const req2 = expansionRequest({ kind: "extension", topicDir: t.dir, conceptId: t.concept, conceptName: "Derivatives", application: "economics", evidence: [], at: "x" });
  await t.engine.requestExpansion(t.dir, req2);
  assert.deepEqual([(await t.engine.expansionSettled(req2.id))?.status, (await t.store.loadExpansions(t.dir)).find((x) => x.request.id === req2.id)?.result?.message], ["failed", "compiler busy"]);
  // A request left pending when the app closed is marked cancelled on the next turn, and said so.
  const fresh = new Engine(t.store, () => t.settings, () => "2026-11-15");
  (fresh as any).call = async () => ({ text: "Carry on.", usage });
  await t.store.saveExpansion(t.dir, { v: 1, request: { ...req, id: "prerequisite:x:left-over" }, status: "pending", result: null, updated: "", delivered: false });
  const chat = await t.chatIn("expert");
  const r = await fresh.turn(t.dir, chat, "go on");
  assert.equal(r.reply, "Carry on.");
  assert.equal((await t.store.loadExpansions(t.dir)).find((x) => x.request.id === "prerequisite:x:left-over")?.result?.message, "stopped when the app was closed");
  // A prerequisite the course already has is taught from what is there.
  assert.equal(inCourse("limits", [{ id: "calculus/limits", name: "Limits", topic: t.dir }])?.id, "calculus/limits");
  assert.equal(inCourse("trigonometric identities", [{ id: "calculus/limits", name: "Limits", topic: t.dir }]), null);
});

test("expansion: a missing prerequisite named in a mark sends one narrow request with the evidence behind it", async () => {
  const t = await setup();
  const sent: ExpansionRequest[] = [];
  t.engine.expander = { request: async (r) => (sent.push(r), { requestId: r.id, status: "complete", linked: [{ conceptId: "trig/identities", name: "Trig identities", topicDir: "", relation: "requires" }], coverage: [], beyondSpec: false, message: "" }) };
  const chat = await t.chatIn("tutor");
  const q = "Differentiate $\\sin^2 x$?";
  t.replies.push(`${q}\n${session({ pendingQuestion: q })}`);
  await t.engine.turn(t.dir, chat, "");
  t.replies.push(`That needs an identity. What is $\\sin 2x$ in terms of $\\sin x$ and $\\cos x$?\n${tag({ result: "incorrect", error_type: "prerequisite", prerequisite_gap: "double angle identities" })}\n${session({ pendingQuestion: "What is $\\sin 2x$ in terms of $\\sin x$ and $\\cos x$?" })}`);
  const r = await t.engine.turn(t.dir, chat, "2 sin x");
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].kind, sent[0].gap, sent[0].anchor.conceptId, sent[0].evidence, sent[0].maxConcepts], ["prerequisite", "double angle identities", t.concept, [r.attempt!.id], 1]);
  assert.equal(readResult({ requestId: "other" }, sent[0]).status, "failed", "a result for another request is not used");
  assert.equal(readResult({ requestId: sent[0].id, status: "complete", linked: [], coverage: [] }, sent[0]).status, "partial", "nothing linked is not complete");
  // The same gap named again is not requested again once it succeeded.
  await t.engine.expansionSettled(sent[0].id);
  t.replies.push(`Not yet. ${q}\n${tag({ result: "incorrect", error_type: "prerequisite", prerequisite_gap: "double angle identities" })}\n${session({ pendingQuestion: q })}`);
  await t.engine.turn(t.dir, chat, "sin x cos x");
  assert.equal(sent.length, 1);
  // One the course has is not requested at all.
  t.replies.push(`Check the limit first. ${q}\n${tag({ result: "incorrect", error_type: "prerequisite", prerequisite_gap: "Limits" })}\n${session({ pendingQuestion: q })}`);
  const r3 = await t.engine.turn(t.dir, chat, "I don't know limits");
  assert.equal(sent.length, 1);
  assert.match(r3.notes?.join(" ") ?? "", /the prerequisite "Limits" is in the course as Limits/);
});

test("Details: the move, its reason and evidence read as one line; old session records still load", () => {
  const d = chooseMove(input({ intent: "hint", pending: true, misconceptions: [rec({ status: "confirmed", evidence: ["a1"] })] }));
  assert.equal(moveLine(d), `Tutor move: hint (LEARNER_ASKED_HELP: you asked for help with the open question) · evidence ${M} · confirmed misconception "keeps the exponent"`);
  assert.deepEqual(onConcept([rec({ concept: "other", evidence: ["a1"] })], "calc/derivatives", [attempt({ id: "a1" })]), []);
  // A 0.8 session record has no move, aim or hint count: it reads with empty ones.
  const state = F.blankState("Calculus");
  const chat: F.Chat = { fm: { session: JSON.stringify({ version: 2, pendingQuestion: "Differentiate x^3?", action: "check", askedUnder: "check", helpGiven: ["a hint"] }) }, summary: "", messages: [{ role: "tutor", text: "Differentiate x^3?" }] } as any;
  const old = sessionFor(chat, state, "tutor");
  assert.deepEqual([old.move, old.targets, old.discriminates, old.hints, old.askedUnder], [undefined, "", "", 0, "check"]);
  // A new question carries its aim; answering it and asking nothing clears it.
  const next = readSessionReply("What is 2+2?", { ...old, pendingQuestion: "" }, { now: "t", aim: { targets: M, discriminates: "" } }).record;
  assert.deepEqual([next.pendingQuestion, next.targets, next.hints], ["What is 2+2?", M, 0]);
  assert.equal(readSessionReply(`Done.\n${session({ pendingQuestion: "", completedStep: true })}`, next, { resolved: true }).record.targets, "");
});

// ---------- code questions: from a spec to marked evidence ----------

const ADD_TASK = { language: "python", entry: "add", tests: [{ name: "small", args: [1, 2], expected: "3" }, { name: "negatives cancel", args: [-1, 1], expected: "0", hidden: true }] };
const THREAD_TASK = { language: "cpp", concurrent: true, starter: "#include <thread>\nint main() {}\n", tests: [{ name: "three lines", stdin: "a\nb\nc\n", expected: "3" }, { name: "empty stream", stdin: "", expected: "0", hidden: true }] };
const ADD_SOLUTION = "def add(a, b):\n    return a + b";
const CODE_BANK = [
  "### Q1", "subskill: 1", "type: code", "question: Write add(a, b), returning the sum.", `answer: ${JSON.stringify(ADD_SOLUTION)}`, "explanation: Return a + b.", `code: ${JSON.stringify(ADD_TASK)}`, "",
  "### Q2", "subskill: 2", "type: code", "question: Count the lines on standard input with two threads.", `answer: ${JSON.stringify("int main() { return 0; }")}`, "explanation: Join both threads before printing.", `code: ${JSON.stringify(THREAD_TASK)}`, "",
  // Its "entry" would make a test's argument run as code: the task is refused, and the question stays an open one.
  "### Q3", "subskill: 1", "type: code", "question: Evaluate the expression.", "answer: 2", "explanation: Add.", 'code: {"language":"python","entry":"eval","tests":[{"name":"t","args":["1+1"],"expected":"2"}]}', "",
].join("\n");

/** A scripted runner: it runs nothing, and answers with whatever the test sets. */
class FakeRunner implements CodeRunner {
  runs: { task: CodeTask; source: string }[] = [];
  constructor(public next: (task: CodeTask) => CodeRunReport) {}
  async available() {
    return { ok: true, backend: "fake" };
  }
  async run(task: CodeTask, source: string) {
    this.runs.push({ task, source });
    return this.next(task);
  }
}

const ran = (task: CodeTask, statuses: CodeTestStatus[], over: Partial<CodeRunReport> = {}): CodeRunReport => {
  const st = (i: number): CodeTestStatus => statuses[i] ?? "pass";
  return {
    status: "ran", language: task.language, backend: "CPython 3.12 (fake)", message: "", limits: "2 s per test, no network", ms: 12,
    tests: task.tests.map((t, i) => ({ name: t.name, hidden: !!t.hidden, status: st(i), detail: st(i) === "pass" ? "" : `expected ${t.expected}, got 41`, ms: 3 })),
    passed: task.tests.filter((_, i) => st(i) === "pass").length, total: task.tests.length, ...over,
  };
};

async function codeQuiz(runner: CodeRunner | null) {
  const t = await setup();
  await t.fs.write(`${t.dir}/questions.md`, F.withFrontmatter({ tutor: "questions", topic: "Calculus" }, CODE_BANK));
  if (runner) t.engine.codeRunner = runner;
  const chat = await t.chatIn("quiz");
  const answer = async (card: string, text: string) => {
    const c = await t.store.loadChat(chat);
    c.fm.card = card;
    await t.store.saveChat(chat, c);
    return t.engine.quizTurn(t.dir, chat, text);
  };
  return { ...t, chat, answer };
}

test("code questions: a task is checked as data, and one with code in its tests, too many tests or an unknown language is refused", () => {
  const ok = parseCodeTask(JSON.stringify(ADD_TASK));
  assert.ok("task" in ok);
  assert.deepEqual(ok.task.tests.map((x) => [x.name, x.args, x.expected, !!x.hidden]), [["small", [1, 2], "3", false], ["negatives cancel", [-1, 1], "0", true]]);
  // A whole program reads stdin; a number given as its expected output is the same text.
  const program = parseCodeTask({ language: "c", tests: [{ name: "one", stdin: "1\n", expected: 1 }] });
  assert.ok("task" in program && program.task.tests[0].expected === "1" && program.task.tests[0].stdin === "1\n");
  const err = (v: unknown) => {
    const r = parseCodeTask(v);
    return "error" in r ? r.error : "accepted";
  };
  const withTest = (o: Record<string, unknown>) => ({ ...ADD_TASK, tests: [{ name: "t", args: [1, 2], expected: "3", ...o }] });
  const cases: [string, unknown, RegExp][] = [
    ["unknown language", { ...ADD_TASK, language: "rust" }, /unknown language "rust"/],
    ["missing tests", { language: "python", entry: "add" }, /no tests/],
    ["empty tests", { ...ADD_TASK, tests: [] }, /no tests/],
    ["over the test limit", { ...ADD_TASK, tests: Array.from({ length: 31 }, (_, i) => ({ name: `t${i}`, args: [i, 0], expected: String(i) })) }, /more than 30 tests/],
    ["over the time limit", { ...ADD_TASK, timeLimitMs: 60000 }, /time limit/],
    ["over the size limit", JSON.stringify({ ...ADD_TASK, starter: "x".repeat(30000) }), /size limit/],
    ["args written as code", withTest({ args: "add(1, 2)" }), /args must be a JSON array of values/],
    ["a check written as code", withTest({ check: "lambda r: r == 3" }), /unknown field "check": tests are data, never code/],
    ["a harness written as code", { ...ADD_TASK, harness: "import os" }, /unknown field "harness"/],
    ["an entry that runs its arguments", { ...ADD_TASK, entry: "eval" }, /not a plain function name/],
    ["a dunder entry", { ...ADD_TASK, entry: "__import__" }, /not a plain function name/],
    ["an entry for C++", { ...ADD_TASK, language: "cpp" }, /only a Python task calls an entry function/],
    ["args without an entry", { language: "python", tests: [{ name: "t", args: [1], expected: "1" }] }, /args need an entry function/],
    ["an expected value that is not JSON text", withTest({ expected: "three" }), /return value as JSON text/],
    ["every test hidden", withTest({ hidden: true }), /no test is visible/],
    ["not JSON", "{language: python}", /not JSON/],
  ];
  for (const [name, v, re] of cases) assert.match(err(v), re, name);

  // The bank reads a coding exercise as an open question with its task; a refused task leaves an open question with none.
  const qs = F.parseQuestions(CODE_BANK);
  assert.deepEqual(qs.map((q) => [q.id, q.type, !!q.code]), [["Q1", "open", true], ["Q2", "open", true], ["Q3", "open", false]]);
  assert.equal(qs[0].answer, ADD_SOLUTION, "the reference solution keeps its lines and indentation");
  const state = F.blankState("Calculus");
  state.names = { 1: "Limits", 2: "Derivatives" };
  const shown = F.formatQuizQuestion(qs[0], state);
  assert.match(shown, /add\(1, 2\)\n→ 3/);
  assert.match(shown, /1 more is hidden until your answer is marked/);
  assert.doesNotMatch(shown, /negatives cancel|-1, 1/, "a hidden test is not shown before marking");
  const threads = F.formatQuizQuestion(qs[1], state);
  assert.match(threads, /```cpp\n#include <thread>\nint main\(\) \{\}\n```/);
  assert.match(threads, /counts as fully correct only when a thread sanitizer runs clean/);
  assert.doesNotMatch(threads, /empty stream/);

  // Old attempts read as before; a damaged run record is dropped, and "executed" survives a reload.
  const back = normaliseAttempt({ ...attempt({ id: "x" }), grading: "executed", code: { v: 1, language: "rust", status: "ran" } })!;
  assert.deepEqual([back.grading, back.verification, back.code], ["executed", "unverified", undefined]);
  assert.equal(normaliseAttempt({ ...attempt({ id: "y" }), verification: undefined, grading: "executed" })?.verification, "verified");
  assert.equal("code" in normaliseAttempt(attempt({ id: "z" }))!, false);
});

test("code questions: a run settles the result only; a required method, races nobody checked, and failures each mark as they should", () => {
  const add = (parseCodeTask(ADD_TASK) as { task: CodeTask }).task;
  const marked = (report: CodeRunReport, rubric = "") => {
    const m = markCodeRun(add, report, rubric)!;
    const n = normaliseMark({ proposed: m.proposed, reasoning: m.reasoning, rubric: m.rubric });
    return [n.result, n.basis.conclusive, n.basis.rules, m.errorType];
  };
  assert.deepEqual(marked(ran(add, [])), ["correct", true, [], ""]);
  assert.deepEqual(marked(ran(add, []), "uses a single pass over the input; runs in O(n) time"), ["partial", false, ["method-unassessed"], ""], "tests cannot show a method the rubric asks for");
  assert.deepEqual(marked(ran(add, ["pass", "error"])), ["partial", true, [], "runtime-error"]);
  assert.deepEqual(marked(ran(add, ["timeout", "timeout"])), ["incorrect", true, [], "timeout"]);
  assert.deepEqual(marked(ran(add, ["fail", "fail"])), ["incorrect", true, [], "wrong-output"]);
  // A runner that reports fewer tests than the task has has not passed the rest.
  assert.deepEqual(marked({ ...ran(add, []), tests: ran(add, []).tests.slice(0, 1), passed: 1, total: 1 }), ["partial", true, [], "runtime-error"]);
  assert.equal(markCodeRun(add, notRun("python", "switched off")), null, "no runner: no execution evidence");
  assert.equal(markCodeRun(add, { ...ran(add, []), status: "rejected", message: "source over the limit" }), null);
});

test("code questions in a quiz: the runner marks passes, partial work and compile errors with no model call, and keeps the provenance", async () => {
  const runner = new FakeRunner((task) => ran(task, ["pass", "pass"]));
  const t = await codeQuiz(runner);
  let r = await t.answer("Q1", "Here it is:\n\n```python\ndef add(a, b):\n    return a + b\n```");
  assert.equal(runner.runs[0].source, `${ADD_SOLUTION}\n`, "the fenced block is what runs");
  assert.equal(runner.runs[0].task.entry, "add");
  let a = r.attempt!;
  assert.deepEqual([a.result, a.grading, a.verification, a.errorType, a.mark?.conclusive, a.reasoning], ["correct", "executed", "verified", "", true, undefined]);
  assert.equal(gradingLabel(a), "checked by running the tests");
  assert.match(a.assumptions, /ran the learner's Python code against 2 tests with CPython 3\.12 \(fake\); 2 passed; 2 s per test, no network; the tests check outputs only, not the method/);
  assert.deepEqual(a.code?.tests.map((x) => [x.name, x.hidden, x.status]), [["small", false, "pass"], ["negatives cancel", true, "pass"]]);
  assert.match(r.reply, /^\*\*Correct\.\*\* All 2 tests passed, including 1 hidden\./);
  assert.match(r.reply, /- passed: negatives cancel \(hidden\)/, "hidden tests are named once the answer is marked");
  let st = await t.store.loadState(t.dir, 4);
  assert.deepEqual(st.attempts.find((x) => x.id === a.id)?.code, a.code, "the run is stored and read back");
  assert.equal(skillEvidence(st.attempts, 1).independentCorrect, 1, "an unaided pass is independent evidence");

  // Some tests pass: partly right, with the failed test's diff and the reference solution shown now.
  runner.next = (task) => ran(task, ["pass", "fail"]);
  r = await t.answer("Q1", "def add(a, b):\n    return a + b if a > 0 else 41");
  a = r.attempt!;
  assert.deepEqual([a.result, a.errorType, a.mark?.conclusive, a.code?.passed, a.code?.total], ["partial", "wrong-output", true, 1, 2]);
  assert.match(r.reply, /^\*\*Partly right\.\*\* 1 of 2 tests passed; "negatives cancel" gave the wrong output\./);
  assert.match(r.reply, /negatives cancel:\n\n```text\nexpected 0, got 41\n```/);
  assert.match(r.reply, /A reference solution:\n\n```python\ndef add\(a, b\):\n {4}return a \+ b\n```/);

  // A compile error is a wrong answer, with the compiler's output.
  runner.next = (task) => ({ ...ran(task, []), status: "compile-error", tests: [], passed: 0, backend: "g++ 13.2.0 -std=c++20", message: "main.cpp:1:28: error: expected ';' before '}'" });
  r = await t.answer("Q2", "```cpp\nint main() { return 0 }\n```");
  a = r.attempt!;
  assert.deepEqual([a.result, a.errorType, a.code?.status], ["incorrect", "compile-error", "compile-error"]);
  assert.match(r.reply, /Did not compile \(C\+\+, run by g\+\+ 13\.2\.0 -std=c\+\+20\)/);
  assert.match(r.reply, /```text\nmain\.cpp:1:28: error: expected ';' before '\}'\n```/);

  // Words are not code: the learner is asked for code, and nothing runs or is recorded.
  const runs = runner.runs.length;
  r = await t.answer("Q1", "use a plus sign");
  assert.match(r.reply, /^Reply with your code/);
  assert.deepEqual([r.attempt, runner.runs.length], [undefined, runs]);
  assert.equal(t.calls.length, 0, "no model call happened while the runner marked");
  st = await t.store.loadState(t.dir, 4);
  assert.equal(st.attempts.filter((x) => x.grading === "executed").length, 3);
});

test("code questions in a quiz: threaded code counts only with a clean thread sanitizer, and a sanitizer report is a failure", async () => {
  const runner = new FakeRunner((task) => ran(task, ["pass", "pass"], { backend: "g++ 13.2.0 -std=c++20 -fsanitize=address,undefined", sanitizer: "clean" }));
  const t = await codeQuiz(runner);
  const source = "```cpp\n#include <thread>\nint main() {}\n```";
  let r = await t.answer("Q2", source);
  let a = r.attempt!;
  assert.deepEqual([a.result, a.grading, a.mark?.conclusive, a.mark?.rules, a.errorType], ["partial", "executed", false, ["assumptions-unassessed"], ""]);
  assert.match(a.note, /All 2 tests passed, but passing tests cannot show that threaded code is free of data races, and no thread sanitizer ran clean\./);
  assert.match(a.assumptions, /passing tests cannot show the absence of data races/);
  let st = await t.store.loadState(t.dir, 4);
  const e = skillEvidence(st.attempts, 2);
  assert.deepEqual([e.inconclusive, e.independent], [1, 0], "kept for the record, not a data point either way");

  runner.next = (task) => ran(task, ["pass", "pass"], { backend: "clang++ 17 -std=c++20 -fsanitize=thread", sanitizer: "clean" });
  r = await t.answer("Q2", source);
  assert.deepEqual([r.attempt?.result, r.attempt?.mark?.conclusive], ["correct", true]);
  assert.match(r.attempt!.assumptions, /a thread sanitizer ran clean on these runs/);

  runner.next = (task) => ran(task, ["pass", "pass"], { backend: "clang++ 17 -std=c++20 -fsanitize=thread", sanitizer: "reported" });
  r = await t.answer("Q2", source);
  a = r.attempt!;
  assert.deepEqual([a.result, a.errorType], ["incorrect", "sanitizer"]);
  assert.match(r.reply, /The sanitizer reported a data race or a memory error, although every output matched/);
  assert.equal(t.calls.length, 0);
  st = await t.store.loadState(t.dir, 4);
  assert.deepEqual(st.attempts.map((x) => x.result), ["partial", "correct", "incorrect"]);
});

test("code questions in a quiz: with no runner, or one that cannot run the language, the grader marks it and says the code was not run", async () => {
  const runner = new FakeRunner((task) => ({ status: "unavailable", language: task.language, backend: "", message: "no C++ compiler found", tests: [], passed: 0, total: 0, limits: "", ms: 0 }));
  const t = await codeQuiz(runner);
  t.replies.push(JSON.stringify({ grade: "good", feedback: "This would pass the tests.", reasoning: { result: "correct", method: "sound", certainty: "complete" } }));
  const r = await t.answer("Q2", "```cpp\n#include <thread>\nint main() {}\n```");
  assert.equal(t.calls.length, 1, "one grading call");
  assert.match(t.calls[0].input, /code was not run\. Judge whether it would pass these tests/);
  assert.match(t.calls[0].input, /empty stream/, "the grader sees every test, as data");
  const a = r.attempt!;
  assert.deepEqual([a.result, a.grading, a.verification, a.code?.status, a.code?.message], ["correct", "model", "unverified", "unavailable", "no C++ compiler found"]);
  assert.equal(gradingLabel(a), "graded by the model, unverified");
  assert.ok(a.reasoning, "the grader's breakdown is kept as its judgement");
  assert.match(r.reply, /^\*\*Correct\.\*\* Not run \(no C\+\+ compiler found\), so the model judged your code without running it\. This would pass the tests\./);
  assert.match(a.assumptions, /the code was not run \(no C\+\+ compiler found\); one model judgement/);

  const bare = await codeQuiz(null);
  bare.replies.push(JSON.stringify({ grade: "again", feedback: "It returns the difference.", reasoning: { result: "incorrect", method: "flawed", certainty: "complete" } }));
  const r2 = await bare.answer("Q1", "def add(a, b): return a - b");
  assert.deepEqual([r2.attempt?.result, r2.attempt?.grading, bare.calls.length], ["incorrect", "model", 1]);
  assert.match(r2.attempt!.assumptions, /no code runner is set up here/);
});

test("code questions: the compiler keeps a coding exercise whose tests pass the checks and drops one that fails them", async () => {
  const data = new Map<string, unknown>();
  const cache = { read: async <T>(k: string) => (data.get(k) as T | undefined) ?? null, write: async (k: string, v: unknown) => void data.set(k, JSON.parse(JSON.stringify(v))) };
  const draft = { type: "code", options: [], answer: ADD_SOLUTION, explanation: "Return the sum.", rubric: "", task: "application", family: "add", difficulty: 2, generator: "" };
  const seen: any[] = [];
  const call = async (o: any) => {
    seen.push(o);
    const input = JSON.parse(o.input);
    const props = o.jsonSchema.properties;
    let structured: unknown;
    if (props.objectives) structured = { objectives: input.passages.filter((p: any) => !p.text.startsWith("#")).map((p: any) => ({ text: p.text.trim().slice(0, 120), references: [p.id], search: "" })) };
    else if (props.units) {
      structured = { overview: "Functions return values.", subject: "none", units: input.objectives.map((ob: any, i: number) => ({
        objective: ob.id, name: "Writing a function", prerequisites: [], claims: ["A function returns its result."], example: "add(1, 2) returns 3.", misconceptions: [], details: "Define the function with def and return the result.",
        passages: input.packet[i].passages.map((p: any) => p.id), visualKind: "", visualReason: "",
        questions: [
          { ...draft, question: "Write add(a, b), returning the sum.", code: JSON.stringify(ADD_TASK) },
          { ...draft, question: "Write add(a, b) again.", code: JSON.stringify({ ...ADD_TASK, tests: [{ name: "small", args: "add(1, 2)", expected: "3" }] }) },
          { ...draft, type: "short", question: "What does add(1, 2) return?", answer: "3", code: "" },
        ],
      })) };
    } else if (props.rows) structured = { rows: input.objectives.map((ob: any, i: number) => ({ objective: ob.id, sources: input.packet[i].passages.map((p: any) => p.id), teaching: true, questions: input.questions.map((q: any) => q.id), gap: "" })) };
    else assert.fail("unexpected compile stage");
    return { structured, text: "", usage };
  };
  const r = await compileCourse({ title: "Python functions", goal: "Write small functions", mode: "notes", material: [{ name: "Python notes", path: "Py/Python notes.md", text: "# Functions\n\nA function returns its result with return.\n" }], subjects: [], skill: "compile exercises", model: "fixture", singlePassWords: 600, cache, call });
  const synth = seen.find((o) => o.jsonSchema.properties.units);
  assert.match(synth.system, /coding exercise: type "code"/);
  assert.ok(synth.jsonSchema.properties.units.items.properties.questions.items.properties.code, "the schema offers a code task");
  const qs = F.parseQuestions(r.questionsBody);
  assert.deepEqual(qs.map((q) => [q.id, q.type, !!q.code]), [["Q1", "open", true], ["Q2", "short", false]], "the exercise with code for args is dropped whole");
  assert.equal(qs[0].answer, ADD_SOLUTION);
  assert.deepEqual(qs[0].code?.tests.map((x) => [x.name, !!x.hidden]), [["small", false], ["negatives cancel", true]]);
  assert.deepEqual([r.staged.metrics.codeTasks, r.staged.metrics.codeTasksRejected], [1, 1]);
});

// ---------- ask anything: a free question with no topic ----------

function askRig() {
  const fs = new MemFS();
  const store = new Store(fs, "Tutor");
  const settings: any = { claudePath: "", chatModel: "sonnet", compileModel: "sonnet", utilityModel: "haiku", effort: "low", targetLevel: 4, maxChatWords: 6000, maxTopicWords: 2000, singlePassWords: 6000, smartRouting: true, hardEffort: "high", bankQuiz: true, codePlacement: true, mathCheck: false };
  const engine = new Engine(store, () => settings, () => "2026-11-21");
  const calls: any[] = [];
  let replies: string[] = [];
  engine.call = async (o: any) => {
    calls.push(o);
    return { text: replies[calls.length - 1] ?? "ok", usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 20, costUsd: 0, calls: 1 } };
  };
  let local = 0;
  engine.local = { model: "qwen", chatJson: async () => { local++; throw new Error("no Ollama in Ask"); } } as any;
  (engine as any).compile = async () => { throw new Error("no compile in Ask"); };
  (engine as any).placementTurn = async () => { throw new Error("no placement in Ask"); };
  return { fs, store, engine, settings, calls, setReplies: (r: string[]) => (replies = r), local: () => local };
}

test("ask anything: one chat-model call with no topic, the header goes to the chat's frontmatter, and later turns carry the conversation", async () => {
  const t = askRig();
  await t.store.installSkills();
  assert.ok(await t.fs.exists("Tutor/_skills/ask.md"), "the ask prompt is installed like the other skills");
  const goal = "Teach me concurrency well enough to defend my queue in an interview next Friday";
  t.setReplies([
    `<ask>{"kind":"broad","goal":"Defend a concurrent queue design in an interview","first_step":"Why data races happen"}</ask>\nStart with data races: two threads write the same slot.\n\nTry this: name the shared state in your queue.`,
    "A memory barrier stops reordering across it.",
  ]);
  const before = new Map(t.fs.files);
  const path = await t.engine.startAsk(goal);
  assert.match(path, /^Tutor\/Ask\/[^/]+\.md$/, "free chats live in the Ask folder, not under a topic");
  const r = await t.engine.askTurn(path, goal, {});
  assert.equal(t.calls.length, 1, "exactly one model call");
  assert.equal(t.local(), 0, "no Ollama call");
  assert.equal(t.calls[0].model, "sonnet", "the primary chat model answers, whatever the router would say");
  assert.match(t.calls[0].system, /^# Ask anything/);
  assert.match(t.calls[0].system, /narrow question or a broad learning goal/);
  assert.match(t.calls[0].input, /LEARNER: Teach me concurrency/);
  assert.equal(r.reply, "Start with data races: two threads write the same slot.\n\nTry this: name the shared state in your queue.");
  assert.deepEqual([r.kind, r.goal, r.firstStep], ["broad", "Defend a concurrent queue design in an interview", "Why data races happen"]);
  let chat = await t.store.loadChat(path);
  assert.equal(chat.fm.mode, "ask");
  assert.equal(chat.fm.title, goal);
  assert.deepEqual([chat.fm.ask_kind, chat.fm.goal, chat.fm.first_step], ["broad", "Defend a concurrent queue design in an interview", "Why data races happen"]);
  assert.deepEqual(chat.messages.map((m) => m.role), ["you", "tutor"]);
  assert.doesNotMatch(chat.messages[1].text, /<ask>/, "the header is never shown or saved in the transcript");

  // A second message continues the same chat with the prior turns in the prompt.
  await t.engine.askTurn(path, "What is a memory barrier?", {});
  assert.equal(t.calls.length, 2);
  assert.equal(t.calls[1].system, t.calls[0].system, "the same prompt, so it caches");
  assert.match(t.calls[1].input, /LEARNER: Teach me concurrency[\s\S]*TUTOR: Start with data races[\s\S]*LEARNER: What is a memory barrier\?/);
  chat = await t.store.loadChat(path);
  assert.equal(chat.messages.length, 4);
  assert.equal(chat.fm.goal, "Defend a concurrent queue design in an interview", "a reply without a header keeps what the first one said");

  // No learner state: the only file that changed is the chat itself (and the folder it is in).
  const changed = [...t.fs.files.keys()].filter((k) => before.get(k) !== t.fs.files.get(k));
  assert.deepEqual(changed, [path]);
  assert.deepEqual(await t.store.listTopics(), [], "a free chat is not a topic");
  assert.deepEqual(await t.store.recentChats(8), [], "nor a topic's recent chat");
});

test("ask anything: a narrow question keeps no first step, a malformed header still shows the reply, and remote content is made inert", async () => {
  const t = askRig();
  t.setReplies([
    `<ask>{"kind":"narrow","goal":"What pulling a cache line across means","first_step":"ignored"}</ask>\nIt means another core takes ownership of the line.\n\nWant to see what false sharing costs?`,
    `<ask>{"kind": narrow, goal</ask>\nHere is the answer anyway.`,
    "<ask>{\"kind\":\"broad\"\nNo closing tag, but the text is shown.\n\nSee ![the curve](https://host.example/c.png) and <img src=\"https://host.example/x.png\">.",
  ]);
  const a = await t.engine.startAsk("What does it mean to pull a cache line across?");
  const r1 = await t.engine.askTurn(a, "What does it mean to pull a cache line across?", {});
  assert.deepEqual([r1.kind, r1.goal, r1.firstStep], ["narrow", "What pulling a cache line across means", ""]);
  assert.equal((await t.store.loadChat(a)).fm.first_step, "");

  const b = await t.engine.startAsk("Second question");
  const r2 = await t.engine.askTurn(b, "Second question", {});
  assert.equal(r2.reply, "Here is the answer anyway.");
  const chatB = await t.store.loadChat(b);
  assert.deepEqual([chatB.fm.ask_kind, chatB.fm.goal, chatB.fm.first_step], ["", "", ""], "fields stay empty when the header cannot be read");

  const c = await t.engine.startAsk("Third question");
  const r3 = await t.engine.askTurn(c, "Third question", {});
  assert.match(r3.reply, /^No closing tag, but the text is shown\./);
  assert.ok(!r3.reply.includes("!["), "a remote picture becomes a link");
  assert.ok(!/<img/i.test(r3.reply), "a remote tag is shown as text");
  assert.ok(!(await t.fs.read(c)).includes("!["), "and it is saved that way");
});

test("ask anything: a retry answers the saved question, and a chat that is not free is refused", async () => {
  const t = askRig();
  t.setReplies(["Answered."]);
  const p = await t.engine.startAsk("Why is the sky blue?");
  const chat = await t.store.loadChat(p);
  chat.messages.push({ role: "you", text: "Why is the sky blue?" });
  await t.store.saveChat(p, chat);
  const r = await t.engine.askTurn(p, "", {});
  assert.equal(r.reply, "Answered.");
  assert.equal((await t.store.loadChat(p)).messages.length, 2, "the question is not saved twice");
  const other = await t.store.newChat("Tutor/Topics/X", "X", "auto");
  await assert.rejects(t.engine.askTurn(other, "hi", {}), /not a free question/);
});

test("ask anything: a long free chat sends the opening message and the latest ones within maxChatWords, and keeps the whole transcript on disk", async () => {
  const t = askRig();
  t.settings.maxChatWords = 500; // below the free-chat floor of 1500 words, so the floor applies
  t.setReplies(["Latest answer."]);
  const p = await t.engine.startAsk("GOALMARK teach me queues");
  const chat = await t.store.loadChat(p);
  chat.messages.push({ role: "you", text: "GOALMARK teach me queues" });
  const filler = (k: string) => `${k} ` + Array.from({ length: 99 }, (_, i) => `w${i}`).join(" ");
  for (let i = 0; i < 30; i++) chat.messages.push({ role: i % 2 ? "you" : "tutor", text: filler(`MSG${i}X`) });
  await t.store.saveChat(p, chat);
  await t.engine.askTurn(p, "LATESTQ what next?", {});
  const input: string = t.calls[0].input;
  assert.match(input, /LEARNER: GOALMARK teach me queues/, "the first message, with the goal, is always sent");
  assert.match(input, /LEARNER: LATESTQ what next\?/);
  assert.match(input, /MSG29X/, "the most recent messages are sent");
  assert.doesNotMatch(input, /MSG0X|MSG1X|MSG10X/, "older ones are left out");
  assert.match(input, /\[\d+ earlier messages omitted\]/);
  const sent = (input.match(/\bw\d+\b/g) ?? []).length;
  assert.ok(sent > 500 && sent <= 1500, `a free chat sends up to the 1500-word floor, not the lower maxChatWords (${sent})`);
  assert.equal((await t.store.loadChat(p)).messages.length, 33, "the whole transcript stays on disk: 32 messages and the reply");

  // A short chat is sent whole, with no marker.
  const u = askRig();
  u.setReplies(["ok"]);
  const q = await u.engine.startAsk("short");
  await u.engine.askTurn(q, "short", {});
  assert.doesNotMatch(u.calls[0].input, /omitted/);
});

test("ask anything: the opening header sets the goal, a later header never overwrites it, and only a header at the start is read", async () => {
  const t = askRig();
  t.setReplies([
    `<ask>{"kind":"broad","goal":"Learn concurrency for an interview","first_step":"Data races"}</ask>\nStart with data races.`,
    `<ask>{"kind":"narrow","goal":"What a mutex is","first_step":""}</ask>\nA mutex is a lock.`,
  ]);
  const p = await t.engine.startAsk("Teach me concurrency");
  await t.engine.askTurn(p, "Teach me concurrency", {});
  const r = await t.engine.askTurn(p, "What is a mutex?", {});
  assert.equal(r.reply, "A mutex is a lock.", "a later header is still stripped");
  const chat = await t.store.loadChat(p);
  assert.deepEqual([chat.fm.ask_kind, chat.fm.goal, chat.fm.first_step], ["broad", "Learn concurrency for an interview", "Data races"]);

  const u = askRig();
  u.setReplies([
    `Answer first.\n<ask>{"kind":"broad","goal":"Late goal","first_step":"x"}</ask>`,
    `<ask>{"kind":"broad" Here is the reply, on the same line.`,
  ]);
  const a = await u.engine.startAsk("one");
  const ra = await u.engine.askTurn(a, "one", {});
  assert.equal(ra.reply, "Answer first.", "a header that is not at the start is stripped from the text");
  assert.equal((await u.store.loadChat(a)).fm.ask_kind, "", "but not read");
  const b = await u.engine.startAsk("two");
  const rb = await u.engine.askTurn(b, "two", {});
  assert.equal(rb.reply, "Here is the reply, on the same line.", "an unclosed header does not swallow the reply");
});
test("ask anything: recent questions read only the newest files they need", async () => {
  const fs = new MemFS();
  const store = new Store(fs, "Tutor");
  const made: string[] = [];
  for (let i = 0; i < 10; i++) {
    const p = await store.newAskChat(`Question ${i}`, new Date(2026, 10, 1 + i, 9, 0));
    const chat = await store.loadChat(p);
    chat.messages.push({ role: "you", text: `Question ${i}` });
    await store.saveChat(p, chat);
    made.push(p);
  }
  // The newest file of all has no message yet, so it is skipped and one more is read.
  await store.newAskChat("Empty", new Date(2026, 10, 20, 9, 0));
  let reads = 0;
  const read = fs.read.bind(fs);
  fs.read = async (path: string) => {
    if (path.startsWith("Tutor/Ask/")) reads++;
    return read(path);
  };
  const asks = await store.recentAsks(3);
  assert.deepEqual(asks.map((a) => a.title), ["Question 9", "Question 8", "Question 7"]);
  assert.equal(reads, 4, "the empty newest chat and the three it returns, not all eleven files");
});