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
import { fallbackMaterial, lessonDepth, missingEvidence } from "../src/lessondepth";
import { CourseExpander, ExpansionRequest, ExpansionResult, expansionLine, expansionNote, expansionRequest, inCourse, readResult } from "../src/expansion";
import { Claim, ClaimResult, MathBackend } from "../src/sympy";

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
