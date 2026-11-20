// What a subskill asks the learner to know, one idea at a time, and which of those ideas they have
// been asked and have secured. A tutor that picks the next question from the whole subskill tends
// to circle one idea and skip others; this keeps the list. Also the rule for whether the next
// question builds on the last one (same idea, from another angle) or moves to an idea not yet asked.
// Pure functions; no Obsidian imports, no model calls.

import type { Attempt } from "./evidence";
import { conclusive } from "./grading";
import { baseQuestionId } from "./families";
import type { LearnerState, Question, Topic } from "./formats";
import { terms } from "./presentation";

/** One thing a subskill asks the learner to know: an objective it teaches, or a claim on its card. */
export interface Idea {
  id: string;
  text: string;
}

/** An idea with what the learner's answers say about it. */
export interface IdeaStatus extends Idea {
  /** Graded attempts on questions that test this idea. */
  asked: number;
  /** Unaided right answers on it. */
  unaidedCorrect: number;
  /** At least two unaided right answers: it has been shown, not just once. */
  secured: boolean;
  /** Bank questions that test it. */
  questions: string[];
}

/** An idea needs this many unaided right answers to count as secured. */
export const SECURED_AFTER = 2;

const BLOCK_KEYS = /^\s*(?:misconceptions|worked example)\s*:/i;
const LINE_KEYS = /^\s*(?:objectives|prerequisites|relations|visual)\s*:/i;

/**
 * The ideas a subskill teaches. Its objectives when the card has two or more for it (their ids and
 * text); otherwise the claims on its card, one per bullet outside the misconceptions and worked
 * example. A subskill with neither has one idea: itself.
 */
export function ideasOf(topic: Pick<Topic, "subskills" | "objectives">, n: number): Idea[] {
  const sk = topic.subskills.find((s) => s.n === n);
  if (!sk) return [];
  const mine = (sk.objectives ?? []).map((id) => (topic.objectives ?? []).find((o) => o.id.toLowerCase() === id.toLowerCase())).filter((o): o is NonNullable<typeof o> => !!o);
  if (mine.length >= 2) return mine.map((o) => ({ id: o.id, text: o.text }));
  const claims: Idea[] = [];
  let skipping = false;
  for (const line of sk.section.split(/\r?\n/)) {
    if (BLOCK_KEYS.test(line)) skipping = true;
    else if (LINE_KEYS.test(line)) skipping = false;
    const bullet = /^\s*-\s+(.*\S)\s*$/.exec(line);
    if (bullet && !skipping) claims.push({ id: `c${claims.length + 1}`, text: bullet[1].replace(/\s*\(\[\[[^\]]+\]\]\)\s*$/, "").trim() });
  }
  if (claims.length >= 2) return claims;
  return [{ id: mine[0]?.id ?? `S${n}`, text: mine[0]?.text ?? claims[0]?.text ?? sk.name }];
}

/**
 * Which of the ideas a question tests, by the words they share, or null when none stands out. A
 * guess made from wording, so it is used to steer the next question and never to change a level.
 */
export function ideaOf(q: { question: string; answer?: string; explanation?: string }, ideas: Idea[]): string | null {
  if (ideas.length === 1) return ideas[0].id;
  const have = terms(`${q.question} ${q.answer ?? ""} ${q.explanation ?? ""}`);
  const scored = ideas.map((i) => {
    const want = terms(i.text);
    const hit = [...want].filter((w) => have.has(w)).length;
    return { id: i.id, score: want.size ? hit / Math.sqrt(want.size) : 0, hit };
  }).sort((a, b) => b.score - a.score);
  const [best, next] = scored;
  return best && best.hit >= 2 && (!next || best.score > next.score * 1.15) ? best.id : null;
}

/** An unaided answer: marked by something that can be relied on, with no help and the answer unseen. */
const unaided = (a: Attempt): boolean => conclusive(a) && a.grading !== "self" && !a.assisted && !a.answerExposed && a.result !== "ungraded";

/** Every idea of a subskill with how often it was asked and whether it is secured. */
export function coverageOf(topic: Pick<Topic, "subskills" | "objectives">, questions: Question[], state: Pick<LearnerState, "attempts">, n: number): IdeaStatus[] {
  const ideas = ideasOf(topic, n);
  const byQuestion = new Map(questions.filter((q) => q.subskill === n).map((q) => [q.id, ideaOf(q, ideas)]));
  const out: IdeaStatus[] = ideas.map((i) => ({ ...i, asked: 0, unaidedCorrect: 0, secured: false, questions: [] }));
  const at = (id: string | null) => out.find((i) => i.id === id);
  for (const [id, idea] of byQuestion) at(idea)?.questions.push(id);
  for (const a of state.attempts) {
    if (a.skill !== n || a.result === "ungraded" || a.result === "skipped") continue;
    const id = byQuestion.get(baseQuestionId(a.questionId)) ?? ideaOf({ question: a.question }, ideas);
    const idea = at(id);
    if (!idea) continue;
    idea.asked++;
    if (a.result === "correct" && unaided(a)) idea.unaidedCorrect++;
  }
  for (const i of out) i.secured = i.unaidedCorrect >= SECURED_AFTER;
  return out;
}

/** The idea one question tests, in a subskill's coverage, or null. */
export const ideaOfQuestion = (status: IdeaStatus[], q: Question): string | null => status.find((i) => i.questions.includes(q.id))?.id ?? null;

/** How far a subskill's ideas are covered, for the reason shown and the study screen. */
export function coverageSummary(status: IdeaStatus[]): { total: number; asked: number; secured: number; unasked: IdeaStatus[] } {
  return { total: status.length, asked: status.filter((i) => i.asked > 0).length, secured: status.filter((i) => i.secured).length, unasked: status.filter((i) => i.asked === 0) };
}

// ---------- build on the last question, or move on ----------

/** Confidence (0 to 1) at or below this counts as unsure; at or above, as sure. */
export const UNSURE = 0.5;
export const SURE = 0.8;
/** An answer this many times slower than the learner's usual counts as slow. */
export const SLOW_FACTOR = 2;
/** At most this many follow-ups on one idea in a row, so a shaky idea never traps the session. */
export const MAX_BUILDS = 2;

export type MoveKind = "build-on" | "advance";

/** What the next question does with the last one, and why in words the learner sees. */
export interface Move {
  kind: MoveKind;
  reason: string;
}

/** What is known about the last answer. */
export interface MoveInput {
  attempt: Pick<Attempt, "result" | "confidence" | "assisted" | "answerExposed" | "seconds">;
  /** Whether the question could be matched to one of the subskill's ideas. Without that there is nothing to build on. */
  idea: IdeaStatus | null;
  /** The learner's usual seconds per answer, when enough have been timed. */
  typicalSeconds: number | null;
  /** Follow-ups already made on this idea in a row in this chat. */
  buildsInARow: number;
}

/**
 * Whether the next question builds on the last (the same idea from another angle) or moves to an
 * idea not yet asked. The last answer's mark decides first; confidence and time refine it:
 *   - help was given, or the answer was seen: build on it, so the idea is asked again without help;
 *   - wrong or partly right: build on it, with a smaller step when the learner was unsure and a
 *     different angle when they were sure (a confident error is a misconception, not a gap);
 *   - right but unsure, or right but slow while not sure: build on it, to see whether it holds;
 *   - otherwise move on, as a secured or confident idea gains little from another question.
 * Confidence is self-reported and noisy, so it never decides alone against the mark, and two
 * follow-ups on one idea are the most. Pure.
 */
export function nextMove(i: MoveInput): Move {
  const a = i.attempt;
  const idea = i.idea;
  if (!idea) return { kind: "advance", reason: "" };
  if (a.result === "skipped" || a.result === "ungraded") return { kind: "advance", reason: "" };
  if (i.buildsInARow >= MAX_BUILDS) return { kind: "advance", reason: "That idea has had two follow-ups, so on to something new. It stays marked as shaky." };
  const sure = a.confidence !== null && a.confidence >= SURE;
  const unsure = a.confidence !== null && a.confidence <= UNSURE;
  if (a.assisted || a.answerExposed) return { kind: "build-on", reason: "That answer had help, so the same idea comes back without it." };
  if (a.result !== "correct") {
    if (sure) return { kind: "build-on", reason: "You were sure and it didn't hold, so the same idea from another angle." };
    if (unsure) return { kind: "build-on", reason: "You weren't sure, so a smaller step on the same idea." };
    return { kind: "build-on", reason: "That one didn't hold yet, so the same idea again." };
  }
  if (idea.secured) return { kind: "advance", reason: "" };
  if (unsure) return { kind: "build-on", reason: "Right, but you weren't sure, so the same idea once more to see that it holds." };
  const slow = typeof a.seconds === "number" && i.typicalSeconds !== null && a.seconds > i.typicalSeconds * SLOW_FACTOR;
  if (slow && !sure) return { kind: "build-on", reason: "Right, but it took a while, so the same idea once more to see that it holds." };
  return { kind: "advance", reason: "" };
}

/** A short label for an idea in a line shown to the learner. */
export const ideaLabel = (i: Idea, max = 70): string => (i.text.length > max ? `${i.text.slice(0, max - 1).trimEnd()}…` : i.text);

/**
 * The coverage block a model-led turn is given for the subskill in focus: each idea with what the
 * learner's answers show, and how the last answer says to continue. Empty for a subskill with a
 * single idea, where there is nothing to cover or to choose between.
 */
export function coverageBrief(subskill: string, status: IdeaStatus[], last: { idea: IdeaStatus; move: Move } | null): string {
  if (status.length < 2) return "";
  const lines = status.slice(0, 10).map((i) => `- ${i.id}: ${ideaLabel(i, 110)} — ${i.asked === 0 ? "not asked yet" : i.secured ? "secured" : `asked ${i.asked}, not secured`}`);
  const rule = last
    ? last.move.kind === "build-on"
      ? `Build on the last question: stay on ${last.idea.id} and ask it from another angle or in a smaller step, without help. ${last.move.reason}`
      : `Move on from ${last.idea.id}: choose the next question on an idea not yet asked${last.move.reason ? `. ${last.move.reason}` : ""}.`
    : "Choose the next question on an idea not yet asked.";
  return `# Coverage of ${subskill}\nEvery idea below must be asked at least once before this subskill is done. Do not circle one idea while others are untouched. When a question builds on the last, say in one line how.\n${lines.join("\n")}\n${rule}`;
}
