// When a cold probe is due and what it asks: pure decisions over the sealed questions and the learner
// state. A probe answer is recorded but moves no level (evidence.ts), so nothing here writes anything.
import { daysBetween } from "./dates";
import { Attempt, skillEvidence } from "./evidence";
import { baseQuestionId } from "./families";
import { LearnerState, Question } from "./formats";

export const PROBE_MAX = 6;
export const PROBE_INTERVAL_DAYS = 14;
export const PROBE_EXAM_DAYS = 7;
/** The fewest probe answers worth showing as a result. */
export const PROBE_MIN_SHOWN = 3;
export const PROBE_ELIGIBLE_LEVEL = 3;
export const NOT_TRANSFERRING_LEVEL = 4;

/** The subskill number a concept has now, or undefined when a recompile retired it. */
const subskillOf = (s: LearnerState, concept: string | undefined): number | undefined => {
  if (!concept) return undefined;
  const hit = Object.keys(s.concepts).find((k) => s.concepts[Number(k)] === concept);
  return hit === undefined ? undefined : Number(hit);
};

/** Sealed questions with `subskill` set from their concept as it is numbered now; those of a retired concept are dropped. */
export function currentSealed(sealed: Question[], s: LearnerState): Question[] {
  const out: Question[] = [];
  for (const q of sealed) {
    const n = subskillOf(s, q.concept);
    if (n !== undefined) out.push({ ...q, subskill: n });
  }
  return out;
}

/** Ids of sealed questions that have been answered, whatever the answer was. */
export function spentSealed(sealed: Question[], attempts: Attempt[]): Set<string> {
  const asked = new Set(attempts.map((a) => baseQuestionId(a.questionId)));
  return new Set(sealed.filter((q) => asked.has(q.id)).map((q) => q.id));
}

/** One unspent sealed question for each concept ready for it: level 3 or more, first unaided success before today. */
export function probeQueue(sealed: Question[], s: LearnerState, today: string): Question[] {
  const live = currentSealed(sealed, s);
  const spent = spentSealed(live, s.attempts);
  const picks: { q: Question; level: number }[] = [];
  for (const n of new Set(live.map((q) => q.subskill))) {
    const level = s.levels[n] ?? 0;
    const first = skillEvidence(s.attempts, n).firstIndependentDay;
    if (level < PROBE_ELIGIBLE_LEVEL || !first || first >= today) continue;
    const open = live.filter((q) => q.subskill === n && !spent.has(q.id));
    const q = open.find((x) => x.generator) ?? open[0];
    if (q) picks.push({ q, level });
  }
  picks.sort((a, b) => b.level - a.level || a.q.subskill - b.q.subskill);
  return picks.slice(0, PROBE_MAX).map((p) => p.q);
}

export interface ProbeStatus {
  count: number;
  due: boolean;
  why: string;
  asked: number;
  correct: number;
  lastProbe: string | null;
  /** Subskills at a high level whose latest probe answer was wrong or skipped. */
  notTransferring: number[];
  sealedTotal: number;
}

export function probeStatus(sealed: Question[], s: LearnerState, today: string, examDate?: string): ProbeStatus {
  const live = currentSealed(sealed, s);
  const count = probeQueue(sealed, s, today).length;
  const probes = s.attempts.filter((a) => a.probe).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const lastProbe = probes.length ? probes[probes.length - 1].timestamp.slice(0, 10) : null;
  const counted = probes.filter((a) => a.result !== "ungraded" && a.verification !== "disputed");
  // The latest counted answer per concept. An attempt's own concept id survives renumbering; an old
  // one without it is traced through its question to the sealed question's concept.
  const latest = new Map<string, Attempt>();
  for (const a of counted) {
    const concept = a.concept || sealed.find((q) => q.id === baseQuestionId(a.questionId))?.concept;
    if (concept) latest.set(concept, a);
  }
  const notTransferring: number[] = [];
  for (const [concept, a] of latest) {
    const n = subskillOf(s, concept);
    if (n !== undefined && (s.levels[n] ?? 0) >= NOT_TRANSFERRING_LEVEL && (a.result === "incorrect" || a.result === "skipped")) notTransferring.push(n);
  }
  let why = "";
  if (count > 0) {
    if (lastProbe === null) why = "no cold probe yet";
    else if (daysBetween(lastProbe, today) >= PROBE_INTERVAL_DAYS) why = "14 days since the last cold probe";
    else if (examDate && daysBetween(today, examDate) >= 0 && daysBetween(today, examDate) <= PROBE_EXAM_DAYS && daysBetween(lastProbe, today) >= PROBE_EXAM_DAYS) why = "the exam is within a week";
  }
  return {
    count, due: why !== "", why,
    asked: counted.length, correct: counted.filter((a) => a.result === "correct").length,
    lastProbe, notTransferring: notTransferring.sort((a, b) => a - b), sealedTotal: live.length,
  };
}
