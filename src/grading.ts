// One place that turns a proposed mark into the outcome an attempt records. Every grading path
// (the bank's grading call, a tutor's attempt line, a regrade after a dispute) goes through
// `normaliseMark`, so the overall mark can never say more than the breakdown behind it.
//
// The four dimensions stay apart:
//   result       is the final answer right (the grader, or SymPy when it decided)
//   method       is the reasoning that reaches it valid (the grader only; SymPy never checks it)
//   assumptions  are the conditions it depends on stated and right
//   certainty    could the work shown be judged at all
//
// The grader's certainty is its own report, not a calibrated reliability. It is used in one
// direction only: an answer the grader says it could not check gives no evidence either way.
// A "complete" certainty never makes a mark more trusted than an unverified model judgement.
// Pure functions, no Obsidian imports.

import type { Outcome } from "./evidence";
import type { Grade } from "./formats";
import { Dimension, ReasoningAssessment, resultConflict, rubricDimensions } from "./reasoning";

/** Which rule changed the proposed mark. Stored with the attempt, so the change can be explained later. */
export type MarkRule =
  | "uncheckable"
  | "result-conflict"
  | "overall-contradicts-result"
  | "result-partial"
  | "result-unclear"
  | "method-flawed"
  | "method-missing"
  | "method-unassessed"
  | "assumptions-wrong"
  | "assumptions-unstated"
  | "assumptions-unassessed"
  | "negative-without-basis";

export const MARK_RULES: MarkRule[] = ["uncheckable", "result-conflict", "overall-contradicts-result", "result-partial", "result-unclear", "method-flawed", "method-missing", "method-unassessed", "assumptions-wrong", "assumptions-unstated", "assumptions-unassessed", "negative-without-basis"];

/** How a mark was normalised. Absent on attempts whose mark needed no breakdown (exact, multiple choice, older ones). */
export interface MarkBasis {
  v: 1;
  /** The overall mark as it was proposed, before normalisation. */
  proposed: Outcome;
  /** The rules that changed it, in the order they applied. Empty when the mark stood. */
  rules: MarkRule[];
  /**
   * False when the attempt is kept for the record but is evidence neither for nor against
   * mastery: a right result whose required method or assumptions could not be judged, or a
   * lower mark the breakdown gives no reason for.
   */
  conclusive: boolean;
  /** The dimensions the rubric checks. Empty when there was no rubric. */
  requires: Dimension[];
}

export interface MarkInput {
  proposed: Outcome;
  reasoning: ReasoningAssessment | null | undefined;
  /** The rubric the answer was marked against, when there is one. Its points say which dimensions are required. */
  rubric?: string;
}

export interface NormalisedMark {
  result: Outcome;
  basis: MarkBasis;
  /** One sentence for the learner when the mark was changed. Empty when it stood. */
  note: string;
}

/** The dimensions a rubric checks, in a fixed order. */
export function requiredDimensions(rubric: string | undefined): Dimension[] {
  if (!rubric?.trim()) return [];
  const found = new Set(rubricDimensions(rubric).map((d) => d.dimension));
  return (["result", "method", "assumptions"] as Dimension[]).filter((d) => found.has(d));
}

const NOTES: Record<MarkRule, string> = {
  uncheckable: "The grader could not judge this answer from what was written, so it counts neither for nor against you.",
  "result-conflict": "SymPy and the grader disagree about the final result, so this answer was left ungraded. Dispute it for a second look.",
  "overall-contradicts-result": "The overall mark contradicted the check of the final result, so this answer was left ungraded. Dispute it for a second look.",
  "result-partial": "The final result is only partly right, so this counts as partly right.",
  "result-unclear": "The final result could not be judged, so this cannot count as fully correct.",
  "method-flawed": "The final result is right but the method has a flaw, so this counts as partly right.",
  "method-missing": "The question asks for the method and none was shown, so this counts as partly right.",
  "method-unassessed": "The final result is right, but the method the question asks for could not be judged, so this counts as partly right and is not used as evidence either way.",
  "assumptions-wrong": "An assumption the answer relies on is wrong, so this counts as partly right.",
  "assumptions-unstated": "The question asks for the assumptions and they were not stated, so this counts as partly right.",
  "assumptions-unassessed": "The assumptions the question asks for could not be judged, so this is not used as evidence either way.",
  "negative-without-basis": "The breakdown gives no reason for the lower mark, so this answer is not used as evidence against you.",
};

/**
 * The outcome an attempt records, from the proposed overall mark and the breakdown behind it.
 *
 *   - Skipped, ungraded, and marks without a breakdown stand as proposed.
 *   - An uncheckable answer, or SymPy disagreeing with the grader, is ungraded: no evidence.
 *   - "Correct" needs the result right and every dimension the rubric checks judged sound.
 *     A result checked by SymPy settles the result only: an unassessed required method or
 *     assumption makes it partly right and inconclusive, never fully correct.
 *   - A flaw that was assessed (a flawed method, a wrong or missing required piece) keeps
 *     justified partial credit and counts.
 *   - A lower mark that no assessed dimension explains is not evidence against the learner:
 *     a "wrong" answer whose result was checked right becomes ungraded, a "partly right" one
 *     is kept but marked inconclusive.
 */
export function normaliseMark(input: MarkInput): NormalisedMark {
  const requires = requiredDimensions(input.rubric);
  const r = input.reasoning;
  const basis = (result: Outcome, rules: MarkRule[], conclusive = true): NormalisedMark => ({
    result,
    basis: { v: 1, proposed: input.proposed, rules, conclusive: result === "ungraded" ? false : conclusive, requires },
    // The first rule is the main reason; the panel lists them all.
    note: rules.length ? NOTES[rules[0]] : "",
  });
  if (!r || input.proposed === "skipped" || input.proposed === "ungraded") return basis(input.proposed, []);
  if (r.certainty === "uncheckable") return basis("ungraded", ["uncheckable"]);
  if (resultConflict(r)) return basis("ungraded", ["result-conflict"]);

  const needs = (d: Dimension) => requires.includes(d);
  const result = r.result.verdict;
  const method = r.method.verdict;
  const assumptions = r.assumptions.verdict;
  // What was assessed as wrong or missing. Only these can justify a mark below full credit.
  const flaws: MarkRule[] = [];
  if (result === "partial") flaws.push("result-partial");
  if (method === "flawed") flaws.push("method-flawed");
  if (method === "missing" && needs("method")) flaws.push("method-missing");
  if (assumptions === "wrong") flaws.push("assumptions-wrong");
  if (assumptions === "unstated" && needs("assumptions")) flaws.push("assumptions-unstated");
  const resultWrong = result === "incorrect";
  const namedError = !!r.earliestError;
  // Required dimensions nobody could judge: they block full credit but are not evidence against.
  const unjudged: MarkRule[] = [];
  if (needs("method") && (method === "unclear" || method === "not-assessed")) unjudged.push("method-unassessed");
  if (needs("assumptions") && (assumptions === "unclear" || assumptions === "not-assessed")) unjudged.push("assumptions-unassessed");

  if (input.proposed === "correct") {
    if (resultWrong) return basis("ungraded", ["overall-contradicts-result"]);
    if (flaws.length) return basis("partial", flaws);
    if (result === "unclear") {
      // Nothing about the result is known. A sound method is still partly right, but not evidence either way.
      return method === "sound" ? basis("partial", ["result-unclear", ...unjudged], false) : basis("ungraded", ["result-unclear"]);
    }
    if (unjudged.length) return basis("partial", unjudged, false);
    return basis("correct", []);
  }

  // A lower mark: kept when an assessed dimension explains it.
  const explained = resultWrong || flaws.length > 0 || namedError;
  if (explained) return basis(input.proposed, []);
  if (input.proposed === "incorrect") {
    // A "wrong" answer whose result was checked right, or with nothing assessed against it, says nothing either way.
    return basis("ungraded", ["negative-without-basis"]);
  }
  // Partly right with no named shortfall: the part that is right still shows, but it is not a failure point.
  return basis("partial", ["negative-without-basis", ...unjudged], false);
}

/** The outcome a grading call's again/hard/good/easy stands for. */
export const outcomeOfGrade = (g: Grade): Outcome => (g === "again" ? "incorrect" : g === "hard" ? "partial" : "correct");

/** The card grade an outcome is scheduled with. Null for an outcome that is not scheduled. */
export const gradeOfOutcome = (o: Outcome, proposed: Grade): Grade | null => (o === "ungraded" ? null : o === "correct" ? proposed : o === "partial" ? "hard" : "again");

/** The feedback to keep with a normalised mark: the rule's note replaces it when the answer was left ungraded, and follows it otherwise. */
export const withNote = (note: string, m: NormalisedMark): string => (!m.note ? note : m.result === "ungraded" ? m.note : [note, m.note].filter(Boolean).join(" "));

/** Reads a stored mark basis. Older attempts have none; a damaged one is dropped. */
export function normaliseBasis(raw: unknown): MarkBasis | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const b = raw as Record<string, unknown>;
  const outcomes: Outcome[] = ["correct", "partial", "incorrect", "skipped", "ungraded"];
  if (b.v !== 1 || !outcomes.includes(b.proposed as Outcome)) return undefined;
  const rules = Array.isArray(b.rules) ? b.rules.filter((x): x is MarkRule => MARK_RULES.includes(x as MarkRule)) : [];
  const requires = Array.isArray(b.requires) ? b.requires.filter((x): x is Dimension => x === "result" || x === "method" || x === "assumptions") : [];
  return { v: 1, proposed: b.proposed as Outcome, rules, conclusive: b.conclusive !== false, requires };
}

/** True when an attempt can count as evidence for or against mastery. Attempts with no basis count as before. */
export const conclusive = (a: { mark?: MarkBasis }): boolean => a.mark?.conclusive !== false;

const OUTCOME_TEXT: Record<Outcome, string> = { correct: "correct", partial: "partly right", incorrect: "wrong", skipped: "skipped", ungraded: "ungraded" };

/** For the feedback panel: what the mark was proposed as, what it became, and whether it counts. Empty when the mark stood and counts. */
export function markLine(a: { result: Outcome; mark?: MarkBasis }): string {
  const m = a.mark;
  if (!m || (!m.rules.length && m.conclusive)) return "";
  const changed = m.proposed !== a.result ? `Proposed as ${OUTCOME_TEXT[m.proposed]}, recorded as ${OUTCOME_TEXT[a.result]}` : `Recorded as ${OUTCOME_TEXT[a.result]}`;
  const why = m.rules.length ? ` (${m.rules.map((r) => r.replace(/-/g, " ")).join("; ")})` : "";
  return `${changed}${why}.${a.result !== "ungraded" && !m.conclusive ? " Kept for the record; not used as evidence for or against a level." : ""}`;
}
