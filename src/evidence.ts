// Structured attempt evidence, and the rules that decide what it can support.
// Pure functions with no Obsidian imports. The rules here are enforced in code: no prompt,
// routing weight or model reply can raise a level past what `supportedLevel` returns.
// docs/policy.md describes the same rules in prose.

import { addDays } from "./dates";
import { ReasoningAssessment, normaliseReasoning } from "./reasoning";
import { MarkBasis, conclusive, normaliseBasis } from "./grading";
import { onCurrentVersion } from "./objective-version";
import { baseQuestionId } from "./families";
import { CodeRunRecord, normaliseCodeRun } from "./codequestions";

export type Outcome = "correct" | "partial" | "incorrect" | "skipped" | "ungraded";

/**
 * How the outcome was decided.
 *   deterministic  plain code: a multiple-choice letter or an exact match after normalising
 *   symbolic       SymPy simplified the difference of the two expressions to zero
 *   numeric        SymPy compared values (random test points, or the decimal places written)
 *   executed       the learner's code was run against the question's tests (codequestions.ts)
 *   model          a language model judged it
 *   self           the learner rated themselves after seeing the answer
 */
export type Grading = "deterministic" | "symbolic" | "numeric" | "executed" | "model" | "self";

/** verified: decided or confirmed by code. unverified: one judgement, unchecked. disputed: the learner contests it. */
export type Verification = "verified" | "unverified" | "disputed";

/**
 * What kind of task the question was. Recorded from 0.6 on; earlier attempts have none, and
 * cannot show the evidence that needs one (teach-back and edge cases for level 5).
 *   recall         say back a fact, definition or rule
 *   application    use the idea on a problem of a familiar kind
 *   transfer       use it in an unfamiliar setting
 *   prediction     say what will happen before seeing it
 *   explanation    say why something holds
 *   error-finding  find the mistake in a worked claim
 *   teach-back     explain the idea well enough to teach it
 *   edge-case      handle a boundary or degenerate case
 *   interactive    a prediction or challenge inside an interactive activity
 */
export type TaskType = "recall" | "application" | "transfer" | "prediction" | "explanation" | "error-finding" | "teach-back" | "edge-case" | "interactive";
export const TASK_TYPES: TaskType[] = ["recall", "application", "transfer", "prediction", "explanation", "error-finding", "teach-back", "edge-case", "interactive"];

export interface Attempt {
  id: string;
  v: 2;
  /** Subskill number in the topic card as it is now. 0 when the concept was retired by a recompile. */
  skill: number;
  /** Stable concept id from the course graph. Survives renumbering. */
  concept: string;
  /** Bank id (Q7) for bank questions, otherwise a fingerprint of the question text. */
  questionId: string;
  question: string;
  answer: string;
  /** placement, diagnosis, guided-practice, independent-practice, transfer, retrieval, review, quiz. */
  activity: string;
  mode: string;
  difficulty: number | null;
  result: Outcome;
  /**
   * conceptual, procedural, arithmetic, notation, prerequisite, careless, skipped, or empty. A run
   * code question records compile-error, wrong-output, timeout, runtime-error or sanitizer.
   */
  errorType: string;
  /** Feedback shown to the learner, or why the attempt could not be graded. */
  note: string;
  /** Self-reported confidence from 0 to 1, given before feedback. Null when not given. */
  confidence: number | null;
  /** Any hint, worked step or explanation was given for this question before the answer. */
  assisted: boolean;
  assistance: string[];
  /** The answer to this question had been shown before this attempt. */
  answerExposed: boolean;
  /** A fresh application, not a question seen in the notes or earlier in the chat. */
  transfer: boolean;
  /** Seconds from the question being asked to the answer being sent. Null when unknown. */
  seconds: number | null;
  timestamp: string;
  grading: Grading;
  verification: Verification;
  /** What the check assumed, for example "sampled at random points; not a proof". */
  assumptions: string;
  /** The kind of task, when it was recorded (0.6 on). Empty for older attempts. */
  taskType?: TaskType | "";
  /** The question family: questions that test the same thing the same way. Empty when unknown. */
  family?: string;
  /**
   * The outcome kept apart from the reasoning: result, method and assumptions judged separately,
   * the earliest error, and any SymPy check labelled with what it evaluated. Open answers only;
   * exact answers, multiple choice and attempts from before 0.9 have none.
   */
  reasoning?: ReasoningAssessment;
  /**
   * How the proposed mark was normalised against the breakdown (grading.ts): the mark as
   * proposed, the rules that changed it, and whether the attempt is conclusive evidence.
   * Absent where no breakdown was given.
   */
  mark?: MarkBasis;
  /**
   * The objectives this attempt assessed, as "id@version", at the versions current when it was
   * made. Attempts from before 0.10 have none and are dated by their timestamp instead.
   */
  objectives?: string[];
  /**
   * A code question: the run that marked it, with each test's result (hidden tests are named only
   * here, after marking), or, when the code could not be run, why not. Absent for other questions.
   */
  code?: CodeRunRecord;
  /**
   * A cold-probe answer: a sealed question, never practised, that measures transfer. A ruler, not
   * a lever: it is recorded, and levels, estimates, BKT, card schedules and misconceptions ignore it.
   */
  probe?: boolean;
  /**
   * A bridge answer: given before this concept was taught, by mapping onto it a concept from another
   * topic with the same deep structure (structures.ts). That concept's stable id.
   */
  transferFrom?: string;
}

/** One change of level, with what caused it. Every change is logged so it can be explained later. */
export interface LevelChange {
  t: string;
  skill: number;
  concept: string;
  from: number | null;
  to: number | null;
  /** An attempt id, or one of: placement, lapse, dispute, recompile, legacy. */
  cause: string;
  note: string;
}

const OUTCOMES: Outcome[] = ["correct", "partial", "incorrect", "skipped", "ungraded"];
const GRADINGS: Grading[] = ["deterministic", "symbolic", "numeric", "executed", "model", "self"];

/** FNV-1a over the normalised text. Two wordings that differ only in case or spacing share a key. */
export function questionKey(text: string): string {
  const s = text.toLowerCase().replace(/\s+/g, " ").trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return "t" + (h >>> 0).toString(16);
}

const day = (iso: string): string => iso.slice(0, 10);

/** An objective at a version, as attempts record it: "O1a2b3c@2". */
export const OBJECTIVE_REF = /^[A-Za-z0-9_.:\/-]{1,80}@\d{1,6}$/;

/**
 * Reads a stored attempt of any version. Records from 0.5.0 had `source`, `assisted` and `error`
 * only; they are upgraded in memory and written back in the new shape on the next save.
 * Returns null for anything that is not an attempt.
 */
export function normaliseAttempt(raw: unknown): Attempt | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.timestamp !== "string" || typeof r.question !== "string") return null;
  const str = (k: string, d = ""): string => (typeof r[k] === "string" ? (r[k] as string) : d);
  const result = OUTCOMES.includes(r.result as Outcome) ? (r.result as Outcome) : "ungraded";
  const legacyNote = str("error");
  let grading: Grading;
  if (GRADINGS.includes(r.grading as Grading)) grading = r.grading as Grading;
  else if (r.source === "self") grading = "self";
  else if (r.source === "bank") grading = /^SymPy/.test(legacyNote) ? "symbolic" : legacyNote ? "model" : "deterministic";
  else grading = "model";
  const verification: Verification = r.verification === "disputed" ? "disputed" : r.verification === "verified" || r.verification === "unverified" ? r.verification : grading === "model" || grading === "self" ? "unverified" : "verified";
  const assistance = Array.isArray(r.assistance) ? r.assistance.filter((x): x is string => typeof x === "string") : [];
  const confidence = typeof r.confidence === "number" && r.confidence >= 0 && r.confidence <= 1 ? r.confidence : null;
  const reasoning = normaliseReasoning(r.reasoning);
  const mark = normaliseBasis(r.mark);
  const code = normaliseCodeRun(r.code);
  return {
    id: r.id,
    v: 2,
    skill: Number.isInteger(r.skill) ? (r.skill as number) : 0,
    concept: str("concept"),
    questionId: str("questionId") || questionKey(r.question),
    question: r.question,
    answer: str("answer"),
    activity: str("activity") || (r.mode === "review" ? "review" : r.mode === "quiz" ? "quiz" : "other"),
    mode: str("mode"),
    difficulty: typeof r.difficulty === "number" ? r.difficulty : null,
    result,
    errorType: str("errorType"),
    note: str("note") || (r.note === undefined ? legacyNote : ""),
    confidence,
    assisted: r.assisted === true || assistance.length > 0,
    assistance,
    // A self-rated review shows the answer before the rating by design.
    answerExposed: r.answerExposed === true || (r.answerExposed === undefined && grading === "self"),
    transfer: r.transfer === true,
    seconds: typeof r.seconds === "number" && r.seconds >= 0 ? r.seconds : null,
    timestamp: r.timestamp,
    grading,
    verification,
    assumptions: str("assumptions"),
    taskType: TASK_TYPES.includes(r.taskType as TaskType) ? (r.taskType as TaskType) : "",
    family: str("family").slice(0, 80),
    ...(reasoning ? { reasoning } : {}),
    ...(mark ? { mark } : {}),
    ...(Array.isArray(r.objectives) ? { objectives: r.objectives.filter((x): x is string => typeof x === "string" && OBJECTIVE_REF.test(x)).slice(0, 12) } : {}),
    ...(code ? { code } : {}),
    ...(r.probe === true ? { probe: true } : {}),
    ...(typeof r.transferFrom === "string" && r.transferFrom ? { transferFrom: r.transferFrom.slice(0, 80) } : {}),
  };
}

/** Adds an attempt, replacing any earlier record with the same id: a retried turn is one attempt, not two. */
export function recordAttempt(attempts: Attempt[], attempt: Attempt): Attempt[] {
  const next = attempts.filter((a) => a.id !== attempt.id);
  next.push(attempt);
  return next;
}

export interface SkillEvidence {
  /** Attempts with an outcome, whatever their provenance. Disputed ones are left out everywhere. */
  graded: number;
  /** Distinct questions answered fully correctly, with or without help. Self-ratings do not count. */
  correctAny: number;
  partialAny: number;
  /** Independent data points: unassisted, answer not seen, not self-rated, not a same-day repeat. */
  independent: number;
  /** Distinct questions with an independent fully correct answer. */
  independentCorrect: number;
  /** Distinct days on which an independent success happened. */
  independentDays: number;
  /** An independent success on a transfer question, on a later day than the first independent success. */
  delayedTransfer: boolean;
  /** Failures among the last three independent data points. */
  recentFailures: number;
  /** The latest independent data point is a failure, and an earlier one was a success. */
  lapse: boolean;
  /** True when that lapse came on a later day than the last success. */
  delayedLapse: boolean;
  /** Share of independent data points that were fully correct, smoothed. Null without data. */
  estimate: number | null;
  /** Mean squared gap between stated confidence and the outcome, over independent data points that had one. */
  brier: number | null;
  /** Independent data points that came with a confidence. */
  rated: number;
  /** Mean confidence minus observed accuracy over those points. Positive means overconfident. */
  calibrationGap: number | null;
  last: string | null;
  lastResult: Outcome | null;
  /** Counts by error type over graded attempts that were not correct. */
  errors: Record<string, number>;
  assistedCount: number;
  exposedCount: number;
  selfCount: number;
  ungraded: number;
  disputed: number;
  /** Marked attempts kept for the record that count neither for nor against (grading.ts). */
  inconclusive: number;
  /** Timestamp of the last independent data point. Helped work never moves it. */
  lastIndependent: string | null;
  /** Timestamp of the last independent fully correct answer. */
  lastIndependentSuccess: string | null;
  /** Day of the first independent success, or null. A transfer counts only on a later day. */
  firstIndependentDay: string | null;
  /** Timestamp of that first qualifying success, for counts that stop at the actual answer. */
  firstIndependentSuccess: string | null;
  /** Day the next delayed independent check on this concept falls due, or null before any independent success. */
  nextCheck: string | null;
  /** Distinct days in a row (since the last independent failure) with an independent success. */
  streakDays: number;
  /** An independent correct answer to a teach-back task: an explanation good enough to teach from. */
  teachBack: boolean;
  /** An independent correct answer to an edge-case task. */
  edgeCase: boolean;
  /** Independent correct answers recorded before task types were (0.6), which cannot show teach-back or edge cases. */
  untyped: number;
  /** Question families with an independent success. */
  families: number;
  /**
   * An objective this concept teaches changed materially after the last independent success, and
   * no independent answer has been given on the new version yet. History is kept; the delayed
   * check falls due on the day of the change, so a focused recheck comes next.
   */
  recheck: { since: string; why: string } | null;
}

/**
 * Days until the next delayed check, by how many separate days in a row the concept has been
 * answered correctly without help. A failure starts the ladder again. These are product
 * hypotheses to be tuned against later unaided answers, not established intervals.
 */
export const CHECK_INTERVALS = [1, 3, 7, 14, 30, 60];

const addDaysIso = addDays;

/** Below this many independent data points an estimate is not shown as a number. */
export const MIN_ESTIMATE_N = 3;
/** Below this many confidence-rated independent data points calibration is not shown. */
export const MIN_CALIBRATION_N = 3;

/**
 * What the estimate predicts. Brier scores use the same binary target.
 * Shown wherever a probability is displayed, so the number always has a defined meaning.
 */
export const PREDICTION_TARGET = "the next unassisted first answer on this concept is fully correct";

/**
 * Summarises the attempts on one subskill.
 *
 * An attempt is an independent data point only if it was not assisted, the answer had not been
 * shown, it was not self-rated, and it is not a repeat of a question whose answer the learner
 * saw earlier the same day. Once a question has been answered and marked, its answer is known,
 * so asking it again that day shows memory of the feedback and nothing more. On a later day
 * the same question counts again, as delayed retrieval.
 */
export function skillEvidence(attempts: Attempt[], skill: number, revision?: { at: string; why: string; refs?: string[] }): SkillEvidence {
  const mine = attempts.filter((a) => a.skill === skill && !a.probe).sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  const e: SkillEvidence = { graded: 0, correctAny: 0, partialAny: 0, independent: 0, independentCorrect: 0, independentDays: 0, delayedTransfer: false, recentFailures: 0, lapse: false, delayedLapse: false, estimate: null, brier: null, rated: 0, calibrationGap: null, last: null, lastResult: null, errors: {}, assistedCount: 0, exposedCount: 0, selfCount: 0, ungraded: 0, disputed: 0, inconclusive: 0, lastIndependent: null, lastIndependentSuccess: null, firstIndependentDay: null, firstIndependentSuccess: null, nextCheck: null, streakDays: 0, teachBack: false, edgeCase: false, untyped: 0, families: 0, recheck: null };
  const exposedOn = new Map<string, string>();
  const correctQs = new Set<string>();
  const partialQs = new Set<string>();
  const indCorrectQs = new Set<string>();
  const indDays = new Set<string>();
  /** Families met in any graded attempt so far. A question from one of them is not a transfer. */
  const familiesSeen = new Set<string>();
  const familiesWon = new Set<string>();
  const points: { ok: boolean; day: string; transfer: boolean; confidence: number | null; at: string; current: boolean }[] = [];
  for (const a of mine) {
    const d = day(a.timestamp);
    if (a.verification === "disputed") {
      e.disputed++;
      continue;
    }
    if (a.answerExposed) e.exposedCount++;
    if (a.result === "ungraded") {
      e.ungraded++;
      if (a.answerExposed) exposedOn.set(a.questionId, d);
      continue;
    }
    e.graded++;
    e.last = a.timestamp;
    e.lastResult = a.result;
    if (a.assisted) e.assistedCount++;
    // New numbers for a question are the same question for these counts (bankvariants.ts).
    const question = baseQuestionId(a.questionId);
    if (a.grading === "self") e.selfCount++;
    else if (a.result === "correct") correctQs.add(question);
    else if (a.result === "partial") partialQs.add(question);
    // A mark the breakdown could not back is history, not evidence: it adds no error and no data point.
    const counts = conclusive(a);
    if (!counts) e.inconclusive++;
    if (a.result !== "correct" && counts) {
      const kind = a.errorType || (a.result === "skipped" ? "skipped" : "unclassified");
      e.errors[kind] = (e.errors[kind] ?? 0) + 1;
    }
    const seen = exposedOn.get(a.questionId);
    const independent = counts && a.grading !== "self" && !a.assisted && !a.answerExposed && (seen === undefined || d > seen);
    const family = a.family ?? "";
    if (independent) {
      const ok = a.result === "correct";
      // A question from a family already met is practice of a known kind, whatever the mark
      // says. A family never met before, asked as an application, is a fresh one.
      const familiar = !!family && familiesSeen.has(family);
      const freshFamily = !!family && !familiar && (a.taskType === "application" || a.taskType === "transfer" || a.taskType === "prediction" || a.taskType === "error-finding");
      const transfer = !familiar && (a.transfer || a.taskType === "transfer" || freshFamily);
      points.push({ ok, day: d, transfer, confidence: a.confidence, at: a.timestamp, current: !revision || onCurrentVersion(a, revision) });
      if (ok) {
        indCorrectQs.add(question);
        indDays.add(d);
        if (a.taskType === "teach-back") e.teachBack = true;
        if (a.taskType === "edge-case") e.edgeCase = true;
        if (!a.taskType) e.untyped++;
        if (family) familiesWon.add(family);
      }
    }
    if (family) familiesSeen.add(family);
    // Marking an answer tells the learner what the answer is, right or wrong.
    exposedOn.set(a.questionId, d);
  }
  e.families = familiesWon.size;
  e.correctAny = correctQs.size;
  e.partialAny = [...partialQs].filter((q) => !correctQs.has(q)).length;
  e.independent = points.length;
  e.independentCorrect = indCorrectQs.size;
  e.independentDays = indDays.size;
  const firstOk = points.find((p) => p.ok);
  e.delayedTransfer = !!firstOk && points.some((p) => p.ok && p.transfer && p.day > firstOk.day);
  e.recentFailures = points.slice(-3).filter((p) => !p.ok).length;
  const lastPoint = points[points.length - 1];
  const lastOk = [...points].reverse().find((p) => p.ok);
  e.lapse = !!lastPoint && !lastPoint.ok && !!lastOk;
  e.delayedLapse = e.lapse && lastPoint.day > lastOk!.day;
  if (points.length) e.estimate = (points.filter((p) => p.ok).length + 1) / (points.length + 2);
  const rated = points.filter((p) => p.confidence !== null);
  e.rated = rated.length;
  if (rated.length) {
    e.brier = rated.reduce((sum, p) => sum + (p.confidence! - (p.ok ? 1 : 0)) ** 2, 0) / rated.length;
    e.calibrationGap = rated.reduce((sum, p) => sum + p.confidence!, 0) / rated.length - rated.filter((p) => p.ok).length / rated.length;
  }
  // Retention is judged from independent work alone: a helped answer is not a fresh recall.
  e.lastIndependent = lastPoint?.at ?? null;
  e.lastIndependentSuccess = [...points].reverse().find((p) => p.ok)?.at ?? null;
  e.firstIndependentDay = firstOk?.day ?? null;
  e.firstIndependentSuccess = firstOk?.at ?? null;
  if (e.lastIndependentSuccess) {
    // Separate success days since the last independent failure set the next interval.
    const days: string[] = [];
    for (const p of points) {
      if (!p.ok) days.length = 0;
      else if (days[days.length - 1] !== p.day) days.push(p.day);
    }
    e.streakDays = days.length;
    if (lastPoint && !lastPoint.ok) e.nextCheck = addDaysIso(lastPoint.day, CHECK_INTERVALS[0]);
    else e.nextCheck = addDaysIso(day(e.lastIndependentSuccess), CHECK_INTERVALS[Math.min(CHECK_INTERVALS.length - 1, Math.max(0, days.length - 1))]);
    // A material change to an objective since then: the evidence is about the old version until
    // one unaided answer on the new one. Nothing is reset; the check simply falls due now.
    if (revision && !points.some((p) => p.current)) {
      e.recheck = { since: revision.at, why: revision.why };
      if (e.nextCheck > day(revision.at)) e.nextCheck = day(revision.at);
    }
  }
  return e;
}

/** True when a delayed independent check on the concept is due on `today`. */
export const checkDue = (e: SkillEvidence, today: string): boolean => !!e.nextCheck && e.nextCheck <= today;

/**
 * The highest level the evidence can hold. Levels 1 and 2 describe exposure and following
 * along, so help is allowed there. From level 4 up only independent work counts, and
 * confidence never enters into it.
 *
 *   1  the idea has been taught, or any attempt has been marked
 *   2  one answer at least partly right (help allowed)
 *   3  two different questions answered fully correctly (help allowed)
 *   4  two different questions answered correctly without help, one of them a transfer question
 *      on a later day than the first success, and no more than one recent failure
 *   5  "can teach it and handle edge cases": as 4, with three such questions over two or more
 *      days, no recent failure, and, without help, an explanation good enough to teach from
 *      (a teach-back task) and an edge case handled. Attempts recorded before task types were
 *      cannot show the last two, so an older level 5 reads as not yet backed until they are shown.
 */
export function supportedLevel(e: SkillEvidence, taught = false): number {
  let level = 0;
  if (taught || e.graded > 0) level = 1;
  if (e.correctAny + e.partialAny >= 1) level = 2;
  if (e.correctAny >= 2) level = 3;
  if (level === 3 && e.independentCorrect >= 2 && e.delayedTransfer && e.recentFailures < 2) level = 4;
  if (level === 4 && e.independentCorrect >= 3 && e.independentDays >= 2 && e.recentFailures === 0 && e.teachBack && e.edgeCase) level = 5;
  return level;
}

/** In a sentence, what is still missing before `level` can be recorded. Empty when nothing is. */
export function missingFor(e: SkillEvidence, level: number, taught = false): string {
  if (supportedLevel(e, taught) >= level) return "";
  if (level <= 1) return "a lesson or a first marked answer";
  if (level === 2) return "one answer that is at least partly right";
  if (level === 3) return `${Math.max(1, 2 - e.correctAny)} more fully correct answer${2 - e.correctAny === 1 ? "" : "s"} on different questions`;
  const need: string[] = [];
  const wanted = level === 4 ? 2 : 3;
  if (e.correctAny < 2) need.push("two fully correct answers on different questions");
  if (e.independentCorrect < wanted) need.push(`${wanted - e.independentCorrect} more correct answer${wanted - e.independentCorrect === 1 ? "" : "s"} without help`);
  if (!e.delayedTransfer) need.push("a correct transfer question on a later day");
  if (level === 5 && e.independentDays < 2) need.push("unaided success on two different days");
  if (e.recentFailures >= (level === 4 ? 2 : 1)) need.push("recent unaided answers to come out right");
  if (level === 5) {
    if (!e.teachBack) need.push("an unaided explanation good enough to teach from");
    if (!e.edgeCase) need.push("an unaided answer to an edge case");
    // Honest about history: answers from before task types were recorded cannot show these.
    if ((!e.teachBack || !e.edgeCase) && e.untyped > 0) need.push(`(${e.untyped} earlier unaided answer${e.untyped === 1 ? " was" : "s were"} recorded before the kind of task was, so ${e.untyped === 1 ? "it cannot" : "they cannot"} count for this)`);
  }
  return need.join(", ");
}

/** How a grading method reads in the interface. */
export function gradingLabel(a: Pick<Attempt, "grading" | "verification">): string {
  const base = { deterministic: "checked by the plugin", symbolic: "checked symbolically by SymPy", numeric: "checked numerically by SymPy", executed: "checked by running the tests", model: "graded by the model", self: "self-rated" }[a.grading];
  if (a.verification === "disputed") return `${base}, disputed`;
  if (a.grading === "model") return a.verification === "verified" ? `${base}, confirmed` : `${base}, unverified`;
  return base;
}

export const EVIDENCE_RULES = `If your reply grades an actual attempt by the learner at the pending question, add <attempt>{"skill":1,"result":"correct|partial|incorrect|ungraded","assisted":true,"transfer":false,"task_type":"recall|application|transfer|prediction|explanation|error-finding|teach-back|edge-case","error_type":"conceptual|procedural|arithmetic|notation|prerequisite|careless|","error":"specific error or empty","difficulty":3}</attempt>.
task_type says what the question asked for. Use teach-back only for a request to explain the idea as if teaching it, and edge-case only for a boundary or degenerate case.
If the question tested a prerequisite listed under Cross-topic prerequisites, not a subskill of this topic, add "external":"<that prerequisite's name>" to the attempt. Use ungraded when you are not sure. Assisted is true if a hint, a worked step or the answer helped with this question. Transfer is true only for a fresh application the learner has not seen. Difficulty is 1 to 5. Never treat a request, an agreement or an explanation you supplied as a performance by the learner. The app decides which levels the recorded attempts support; a level you propose beyond that is ignored.`;
