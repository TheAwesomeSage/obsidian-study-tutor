// Bayesian Knowledge Tracing, in shadow mode. It runs beside the evidence rules, is shown and
// logged under its own label and is scored against what happened next, but nothing reads it to
// choose a step or move a level: decide() in policy.ts never looks at it. The point is to find out,
// from real histories, whether a standard knowledge-tracing model predicts the next unaided answer
// better than the plain estimate in evidence.ts, before anything relies on it.
//
// Its observations are exactly the independent data points that skillEvidence counts (conclusive,
// not helped, answer not seen, not self-rated, not a same-day repeat). This module does not restate
// those rules: it asks skillEvidence whether each attempt added a data point.
// Pure functions, no Obsidian imports.

import { Attempt, skillEvidence } from "./evidence";
import { baseQuestionId } from "./families";
import type { Question } from "./formats";

export interface BktParams {
  /** P(L0): the chance the subskill is already known before any observation. */
  pInit: number;
  /** P(T): the chance an unknown subskill becomes known between one observation and the next. */
  pLearn: number;
  /** P(S): the chance of a wrong answer although it is known. */
  pSlip: number;
  /** P(G): the chance of a right answer although it is not known. At least 1/options for multiple choice. */
  pGuess: number;
}

/**
 * Untuned starting values in the usual published ranges (a guess under 0.3 and a slip under 0.1
 * keep the model from explaining knowledge away as guessing). They are what the shadow comparison
 * tests, not values fitted to anyone.
 */
export const BKT_DEFAULTS: BktParams = { pInit: 0.3, pLearn: 0.15, pSlip: 0.1, pGuess: 0.2 };

/** How every BKT number is labelled wherever it is shown. */
export const BKT_LABEL = "BKT (shadow, not used for decisions)";

/** Only the latest this-many attempts on a subskill are traced, so the cost stays bounded. */
export const BKT_HISTORY = 600;

/** Below this many scored answers the Brier comparison is shown with a warning that it cannot tell the two apart. */
export const BKT_MIN_COMPARE = 20;

/** The guess probability for a question with this many options (0 when it is not multiple choice). */
export const guessFor = (p: BktParams, options = 0): number => (options >= 2 ? Math.max(p.pGuess, 1 / options) : p.pGuess);

/**
 * One BKT observation. `pCorrect` is the prediction made before the answer; `posterior` is
 * P(known) given the answer; `next` adds the chance of learning before the next observation.
 */
export function bktStep(pKnown: number, correct: boolean, p: BktParams, guess = p.pGuess): { pCorrect: number; posterior: number; next: number } {
  const pCorrect = pKnown * (1 - p.pSlip) + (1 - pKnown) * guess;
  const known = pKnown * (correct ? 1 - p.pSlip : p.pSlip);
  const unknown = (1 - pKnown) * (correct ? guess : 1 - guess);
  const posterior = known + unknown > 0 ? known / (known + unknown) : pKnown;
  return { pCorrect, posterior, next: posterior + (1 - posterior) * p.pLearn };
}

export interface BktStepRecord {
  attempt: string;
  at: string;
  correct: boolean;
  guess: number;
  /** P(known) before the answer, the prediction made from it, and P(known) after (learning included). */
  before: number;
  pCorrect: number;
  after: number;
  /** The existing estimate (evidence.ts) just before this answer, as the prediction to compare with. */
  estimate: number;
  /** The learner's stated confidence, when given. */
  confidence: number | null;
}

export interface BktTrace {
  skill: number;
  params: BktParams;
  /** One per observation, in time order. */
  steps: BktStepRecord[];
  /** P(known) now, and the predicted chance that the next unaided first answer is fully correct (plain guess). */
  pKnown: number;
  pCorrect: number;
  /** Attempts on the subskill that were not observations: helped, answer seen, self-rated, inconclusive, disputed, unmarked or a same-day repeat. */
  skipped: number;
}

const byTime = (a: Attempt, b: Attempt): number => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0);

/** Option counts of the bank's multiple-choice questions, by question id, for the guess floor. */
export const mcqOptions = (questions: Question[]): Record<string, number> => Object.fromEntries(questions.filter((q) => q.type === "mcq" && q.options.length >= 2).map((q) => [q.id, q.options.length]));

/**
 * Traces one subskill through its attempts. An attempt is an observation exactly when adding it
 * raises skillEvidence's count of independent data points; every other attempt leaves P(known)
 * where it was. The estimate recorded with each step is skillEvidence's estimate over the attempts
 * before it, so the two predictions are made from the same history.
 */
export function bktTrace(attempts: Attempt[], skill: number, opts: { params?: BktParams; options?: Record<string, number> } = {}): BktTrace {
  const params = opts.params ?? BKT_DEFAULTS;
  const mine = attempts.filter((a) => a.skill === skill && !a.probe).sort(byTime).slice(-BKT_HISTORY);
  const steps: BktStepRecord[] = [];
  let pKnown = params.pInit;
  let prev = skillEvidence([], skill);
  for (let i = 0; i < mine.length; i++) {
    const now = skillEvidence(mine.slice(0, i + 1), skill);
    if (now.independent > prev.independent) {
      const a = mine[i];
      const correct = a.result === "correct";
      const guess = guessFor(params, opts.options?.[baseQuestionId(a.questionId)] ?? 0);
      const s = bktStep(pKnown, correct, params, guess);
      steps.push({ attempt: a.id, at: a.timestamp, correct, guess, before: pKnown, pCorrect: s.pCorrect, after: s.next, estimate: prev.estimate ?? 0.5, confidence: a.confidence });
      pKnown = s.next;
    }
    prev = now;
  }
  return { skill, params, steps, pKnown, pCorrect: pKnown * (1 - params.pSlip) + (1 - pKnown) * params.pGuess, skipped: mine.length - steps.length };
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000;

/** What the policy input carries for a subskill: logged with each decision, never read by decide(). Null before any observation. */
export function bktShadow(attempts: Attempt[], skill: number, options?: Record<string, number>): { pKnown: number; pCorrect: number; observations: number } | null {
  const t = bktTrace(attempts, skill, { options });
  return t.steps.length ? { pKnown: r3(t.pKnown), pCorrect: r3(t.pCorrect), observations: t.steps.length } : null;
}

export interface BrierComparison {
  /** Unaided answers scored: every observation in the traces. */
  n: number;
  /** Mean squared gap between each prediction and the outcome (1 fully correct, 0 otherwise). Lower is better. */
  bkt: number | null;
  estimate: number | null;
  /** Of those answers, the ones with a stated confidence, and all three predictions on just those. */
  rated: number;
  bktRated: number | null;
  estimateRated: number | null;
  confidence: number | null;
}

const brier = (xs: { p: number; y: boolean }[]): number | null => (xs.length ? xs.reduce((s, x) => s + (x.p - (x.y ? 1 : 0)) ** 2, 0) / xs.length : null);

/** BKT's predictions against the existing estimate's, over the same answers. Learner confidence is compared where it was given. */
export function brierComparison(traces: BktTrace[]): BrierComparison {
  const steps = traces.flatMap((t) => t.steps);
  const rated = steps.filter((s) => s.confidence !== null);
  return {
    n: steps.length,
    bkt: brier(steps.map((s) => ({ p: s.pCorrect, y: s.correct }))),
    estimate: brier(steps.map((s) => ({ p: s.estimate, y: s.correct }))),
    rated: rated.length,
    bktRated: brier(rated.map((s) => ({ p: s.pCorrect, y: s.correct }))),
    estimateRated: brier(rated.map((s) => ({ p: s.estimate, y: s.correct }))),
    confidence: brier(rated.map((s) => ({ p: s.confidence!, y: s.correct }))),
  };
}

/** Traces every subskill that has attempts. */
export const bktAll = (attempts: Attempt[], opts: { params?: BktParams; options?: Record<string, number> } = {}): BktTrace[] => [...new Set(attempts.map((a) => a.skill).filter((n) => n > 0))].sort((a, b) => a - b).map((n) => bktTrace(attempts, n, opts));

/** "BKT (shadow, not used for decisions): P(known) 0.74 after 6 unaided answers". */
export function shadowLine(t: BktTrace): string {
  const n = t.steps.length;
  return `${BKT_LABEL}: P(known) ${t.pKnown.toFixed(2)}${n ? ` after ${n} unaided answer${n === 1 ? "" : "s"}` : ", the starting value: no unaided answers yet"}`;
}

/** The Brier comparison in one line, with the counts, and a warning while there are too few answers to tell the two apart. */
export function comparisonLine(c: BrierComparison): string {
  if (!c.n || c.bkt === null || c.estimate === null) return "No unaided answers to score BKT against yet";
  const rated = c.rated && c.bktRated !== null && c.estimateRated !== null && c.confidence !== null ? `; on the ${c.rated} with your confidence: BKT ${c.bktRated.toFixed(2)}, estimate ${c.estimateRated.toFixed(2)}, your confidence ${c.confidence.toFixed(2)}` : "";
  const few = c.n < BKT_MIN_COMPARE ? `; fewer than ${BKT_MIN_COMPARE} answers, too few to tell them apart` : "";
  return `Brier over ${c.n} unaided answer${c.n === 1 ? "" : "s"} (lower is better): BKT ${c.bkt.toFixed(2)}, existing estimate ${c.estimate.toFixed(2)}${rated}${few}`;
}
