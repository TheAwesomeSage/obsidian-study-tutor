// The local instructional policy: which subskill to work on and what to do with it.
// It is plain arithmetic over the learner state, so every choice can be inspected, logged and
// replayed. Weights only rank what to study next. They cannot change a level: levels move
// through the evidence rules in evidence.ts and nowhere else.

import { dayNumber } from "./dates";
import type { Mode, NextStep, Topic } from "./formats";
import type { Intent } from "./session";
import type { Attempt } from "./evidence";
import { BKT_DEFAULTS, BktParams, BrierComparison, bktAll, bktTrace, brierComparison } from "./bkt";

/**
 * Bumped whenever the scoring or the action rules change, so logged decisions can be compared
 * across versions.
 *   1  0.5.0: priority × distance from level 5, one fixed ladder of actions
 *   2  0.5.1: weighted components, explicit constraints, local dispatch, Learn-mode limits
 *   3  0.6.0: concept-level delayed checks; recency from unaided work only; no transfer question
 *      on the day it cannot count; prerequisites in other topics checked one by one with their
 *      outcomes; teach-back and edge-case steps toward level 5; Home uses the same decision
 *      0.10.0 adds, still as 3: exam weight and the exam date scale a subskill's priority within
 *      fixed bounds, with the reason in the decision, and unaided practice suggests the exam's
 *      minutes. Without exam metadata every decision is unchanged, so logs stay comparable; BKT is
 *      logged in shadow and never read. Bump to 4 if exam-weighted logs must be told apart.
 */
export const POLICY_VERSION = 3;

export interface PolicyWeights {
  /** Exam relevance: the study priority set per concept. */
  exam: number;
  /** How much else rests on the concept. */
  prerequisite: number;
  /** Recent unaided errors and lapses. */
  errors: number;
  /** How little unaided evidence there is. */
  uncertainty: number;
  /** How long since the concept was last practised. */
  recency: number;
  /** How strongly the time available shapes the choice. */
  time: number;
}

// Observed errors weigh most: they are the most direct sign of where study is needed.
export const DEFAULT_WEIGHTS: PolicyWeights = { exam: 1, prerequisite: 1, errors: 1.5, uncertainty: 0.5, recency: 0.5, time: 1 };
/** Roughly what version 1 did: priority and distance from target only. Used to compare policies. */
export const V1_WEIGHTS: PolicyWeights = { exam: 1, prerequisite: 0, errors: 0, uncertainty: 0, recency: 0, time: 0 };

export const WEIGHT_LABELS: Record<keyof PolicyWeights, [string, string]> = {
  exam: ["Exam relevance", "How much a concept's study priority counts. Set priorities per concept in the graph or the topic page."],
  prerequisite: ["Prerequisite importance", "Favour concepts that many others rest on."],
  errors: ["Observed errors", "Favour concepts where recent unaided answers were wrong."],
  uncertainty: ["Uncertainty", "Favour concepts with little unaided evidence either way."],
  recency: ["Recency", "Favour concepts not practised for a while."],
  time: ["Available time", "With little time, favour quick practice over new lessons."],
};

export type Action =
  | "diagnose"
  | "diagnose-prerequisite"
  | "diagnose-error"
  | "explain"
  | "worked-example"
  | "re-explain"
  | "hint"
  | "guided-practice"
  | "independent-practice"
  | "transfer"
  | "retrieval"
  | "teach-back"
  | "edge-case"
  | "check"
  | "continue";

export const ACTION_LABEL: Record<Action, string> = {
  diagnose: "Diagnosis",
  "diagnose-prerequisite": "Prerequisite check",
  "diagnose-error": "Error diagnosis",
  explain: "Explanation",
  "worked-example": "Worked example",
  "re-explain": "Another explanation",
  hint: "Hint",
  "guided-practice": "Guided practice",
  "independent-practice": "Independent practice",
  transfer: "Transfer question",
  retrieval: "Retrieval check",
  "teach-back": "Teach it back",
  "edge-case": "Edge case",
  check: "Checking your answer",
  continue: "Continuing",
};

/** What each action asks of the model, sent with the turn. */
export const ACTION_GUIDE: Record<Action, string> = {
  diagnose: "Ask one short question that shows whether the learner can already do this. Teach nothing yet.",
  "diagnose-prerequisite": "Before anything else, ask one short question on the prerequisite named in the reason. Do not assume it is weak or strong until the learner has answered.",
  "diagnose-error": "Find the cause of the recent error with one narrower question before choosing how to help.",
  explain: "Teach the idea: why it matters, the idea in plain words and then in notation, one fully worked example, then one question for the learner to try.",
  "worked-example": "Show a different, fully worked example with each step justified, then ask the learner to do a similar one.",
  "re-explain": "Explain it again in a different representation from before (numbers, a picture in words, code, or an analogy with its limits stated), then check with one question.",
  hint: "Help in steps, one step per request: first point to the step that is going wrong, then give a conceptual hint, then show that one step worked, and only then explain fully. Do not give the answer to the pending question. After full help, the next question should be a fresh one answered without help.",
  "guided-practice": "Set one problem and support the learner through it, giving graduated hints only when asked or when they are stuck.",
  "independent-practice": "Set one fresh problem. Give no hint, example or method before the attempt.",
  transfer: "Set one unfamiliar problem that uses the idea in a new setting. Give no hints.",
  retrieval: "Ask one recall question on this material without warning and without hints.",
  "teach-back": "Ask the learner to explain the idea as if teaching a classmate: what it says, why it holds, and one example of their own. Give no explanation or example before the attempt. When marking, judge accuracy, completeness and whether someone could learn from it.",
  "edge-case": "Set one boundary or degenerate case where the usual method needs care (an empty or extreme input, a limit, an exception to the rule). Give no hint. When marking, ask for the reason, not only the result.",
  check: "The learner has answered the pending question. Check the answer step by step, say plainly whether it is right, and record the attempt.",
  continue: "Carry on with the current step and keep the pending question open.",
};

/** The actions Learn mode may take. It teaches; it does not examine. */
export const LEARN_ACTIONS: Action[] = ["diagnose-prerequisite", "explain", "worked-example", "re-explain", "hint", "guided-practice", "check", "continue"];

export interface SkillInput {
  n: number;
  name: string;
  level: number | null;
  /** In-topic prerequisites (subskill numbers), from the course graph. */
  prerequisites: number[];
  /** How many subskills rest on this one, directly or not. */
  dependents: number;
  /** Study priority, 0.1 to 5. 1 is neutral. */
  priority: number;
  taught: boolean;
  /** The level the recorded attempts can hold. */
  supported: number;
  independent: number;
  independentCorrect: number;
  recentFailures: number;
  lapse: boolean;
  /** Days since the last unaided attempt. Helped work does not count as renewed retention. Null when there is none. */
  daysSince: number | null;
  /** Bank questions on this subskill that practice may use, that code can mark and that this chat has not asked (one with a generator can come back twice with new numbers). */
  bankLeft: number;
  /** A bank question on this subskill has worked steps code can fade, so supported practice needs no model. */
  faded?: boolean;
  /** A delayed independent check on this concept falls due today or earlier. */
  checkDue?: boolean;
  /** When that check falls due (yyyy-mm-dd), for the reason shown. */
  nextCheck?: string | null;
  /** Set when the check is due because an objective changed materially since the last unaided success: what changed. */
  recheck?: string;
  /**
   * A transfer question answered today could count: the first unaided success was on an earlier
   * day. False means a transfer today cannot satisfy the delayed requirement. Unset means true.
   */
  transferReady?: boolean;
  /** Level 5 still needs an unaided teach-back, or an unaided edge case. */
  needsTeachBack?: boolean;
  needsEdgeCase?: boolean;
  /** Exam metadata from the objectives this subskill teaches (examSignals). It scales the priority within fixed bounds. */
  exam?: ExamSignal;
  /**
   * Shadow measurement (bkt.ts), logged with the decision so it can be re-scored later.
   * decide() never reads it, and a test holds it to that.
   */
  shadow?: { pKnown: number; pCorrect: number; observations: number };
}

/** What the exam says about one subskill, from the objectives it teaches. */
export interface ExamSignal {
  /** Its share of the exam's marks, 0 to 1: each objective's weight split evenly over the subskills that teach it. */
  weight: number | null;
  /** Days from today to the nearest exam date that has not passed (negative when all have), or null with no date. */
  daysToExam: number | null;
  /** Typical minutes and marks for a question on it, from its heaviest objective that gives them. */
  minutes: number | null;
  marks: number | null;
  /** Papers or components, and command words, as the objectives give them. */
  paper: string;
  commands: string[];
}

/** Exam metadata scales a subskill's priority by at most these factors, whatever the weights and dates say. */
export const EXAM_FACTOR_MAX = 1.5;
export const EXAM_FACTOR_MIN = 0.75;
/** Within this many days of the exam, nearness raises the priority, by up to EXAM_URGENCY on the day. */
export const EXAM_WINDOW = 60;
export const EXAM_URGENCY = 0.25;

/**
 * How a prerequisite check in another topic came out in this chat, by the prerequisite's id.
 * "asked" means the question was put and not marked; "taught" means it was explained after a
 * failed check. Missing means not yet checked.
 */
export type PrereqCheck = "asked" | "correct" | "partial" | "incorrect" | "skipped" | "ungraded" | "taught";

export interface PolicyInput {
  mode: Mode;
  target: number;
  focus: number | null;
  skills: SkillInput[];
  /** A question is open and the step is not finished. */
  pending: boolean;
  completedStep: boolean;
  intent: Intent;
  misconceptions: number;
  /** Minutes the learner has, when they said. */
  minutes: number;
  weights: PolicyWeights;
  /** Placement by bank questions is possible: nothing is placed yet and the chat is empty. */
  placementReady: boolean;
  /** Prerequisites in other topics of each subskill, with the level held there. */
  external: { skill: number; name: string; topic: string; level: number | null; id?: string }[];
  /** Subskills whose outside prerequisites a chat from before 0.6 recorded as all checked. */
  checked: number[];
  /** Outside prerequisite checks in this chat, by prerequisite id, with their outcome. */
  prereqChecks?: Record<string, PrereqCheck>;
  /** The subskill of a run of unaided bank practice whose last answer was right, when one is under way. */
  continuing?: number | null;
}

export interface Score {
  n: number;
  name: string;
  score: number;
  parts: { gap: number; exam: number; prerequisite: number; errors: number; uncertainty: number; recency: number; time: number };
  /**
   * Present when the subskill has exam metadata: the factor applied to its priority (1 when the
   * metadata changed nothing), why, and what the exam asks ("Paper 2 · derive · 6 marks · 8 min").
   */
  exam?: { factor: number; priority: number; note: string; about: string };
}

export interface Decision {
  version: number;
  action: Action;
  focus: number | null;
  reason: string;
  /** The explicit rule that decided this turn, when one did. Empty when the ranking chose. */
  constraint: string;
  /** Handled by plain code with no model call: placement questions, or a bank question. */
  local: "placement" | "bank" | null;
  /** True when Learn mode thinks the learner is ready to practise unaided. */
  suggestIndependent: boolean;
  scores: Score[];
  /**
   * Stable id of a concept in another topic that this turn's question checks. Set only for a
   * prerequisite check across topics, whose answer is evidence about that concept, not the focus.
   */
  assesses?: string;
  /**
   * Stable id of a concept in another topic that this turn explains, after a failed check on it.
   * The lesson is exposure to that concept, not to the focus.
   */
  teaches?: string;
  /** Minutes suggested for timed practice, as in the exam. Set only on unaided practice the time available can hold. */
  timed?: number;
}

/** Level a prerequisite must hold before what builds on it is taught. */
export const UNLOCK = 2;

const round = (x: number): number => Math.round(x * 1000) / 1000;
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const pct = (x: number): string => `${Math.round(x * 1000) / 10}%`;
const num = (x: number): string => String(Math.round(x * 100) / 100);

/** Mean share of the marks over the subskills that have one, or null with fewer than two to compare. */
function meanWeight(skills: SkillInput[]): number | null {
  const ws = skills.map((s) => s.exam?.weight ?? 0).filter((x) => x > 0);
  return ws.length >= 2 ? ws.reduce((a, b) => a + b, 0) / ws.length : null;
}

/**
 * How a subskill's exam metadata scales its study priority, and why. Weight counts relative to the
 * topic's average share (so it only reorders concepts within a topic), and an exam date within
 * EXAM_WINDOW days adds up to EXAM_URGENCY. The product is held between EXAM_FACTOR_MIN and
 * EXAM_FACTOR_MAX, and the priority stays within its usual 0.1 to 5. Null without metadata.
 */
export function examEffect(s: SkillInput, mean: number | null): { factor: number; priority: number; note: string; about: string } | null {
  const e = s.exam;
  if (!e) return null;
  const why: string[] = [];
  let byWeight = 1;
  let byDate = 1;
  if (e.weight !== null && e.weight > 0 && mean) {
    byWeight = e.weight / mean;
    why.push(`it carries ${pct(e.weight)} of the marks, ${byWeight.toFixed(1)}× this topic's average`);
  }
  const d = e.daysToExam;
  if (d !== null && d >= 0 && d <= EXAM_WINDOW) {
    byDate = 1 + EXAM_URGENCY * (1 - d / EXAM_WINDOW);
    why.push(d === 0 ? "the exam is today" : `the exam is in ${d} day${d === 1 ? "" : "s"}`);
  }
  const raw = byWeight * byDate;
  const factor = round(clamp(raw, EXAM_FACTOR_MIN, EXAM_FACTOR_MAX));
  const base = clamp(s.priority, 0.1, 5);
  const priority = round(clamp(base * factor, 0.1, 5));
  const bound = raw > EXAM_FACTOR_MAX ? `, the most exam metadata can add` : raw < EXAM_FACTOR_MIN ? `, the most exam metadata can take away` : "";
  const note = factor === 1 ? "" : `Exam weighting: ${why.join(" and ")}, so its priority is scaled ×${factor.toFixed(2)}${bound} (${num(base)} → ${num(priority)}).`;
  const about = [e.paper, e.commands.join(", "), e.marks ? `${e.marks} marks` : "", e.minutes ? `${e.minutes} min` : "", e.weight ? `${pct(e.weight)} of the marks` : "", d === null ? "" : d < 0 ? "exam date passed" : d === 0 ? "exam today" : `exam in ${d} day${d === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
  return { factor, priority, note, about };
}

/** Ranks every subskill. Higher means more worth studying now. */
export function scoreSkills(p: PolicyInput): Score[] {
  const w = p.weights;
  const by = new Map(p.skills.map((s) => [s.n, s]));
  const mean = meanWeight(p.skills);
  return p.skills
    .map((s) => {
      const ex = examEffect(s, mean);
      const level = s.level ?? 0;
      const backed = s.level !== null && s.level <= s.supported;
      let gap = Math.max(0, p.target - level) / Math.max(1, p.target);
      // At target on paper, without the evidence to hold it: worth a check, less than a real gap.
      if (gap === 0 && !backed) gap = 0.25;
      // A delayed check that has fallen due is worth doing even at target.
      if (s.checkDue && level >= 3) gap = Math.max(gap, 0.4);
      if (s.lapse) gap = Math.max(gap, 0.5);
      const below = p.skills.filter((o) => o.n !== s.n && (o.level ?? 0) < p.target && rests(o.n, s.n, by)).length;
      const parts = {
        gap: round(gap),
        exam: round(((ex ? ex.priority : Math.min(5, Math.max(0.1, s.priority))) - 1) / 4),
        prerequisite: round(below / Math.max(1, p.skills.length - 1)),
        errors: round(Math.min(1, s.recentFailures / 3 + (s.lapse ? 0.5 : 0))),
        uncertainty: round(s.level === null ? 1 : 1 / (1 + s.independent)),
        recency: round(s.daysSince === null || level < 2 ? 0 : Math.min(1, s.daysSince / 21)),
        time: p.minutes <= 10 ? (level <= 1 ? -1 : s.bankLeft > 0 ? 1 : 0) : 0,
      };
      const lift = 1 + w.exam * parts.exam + w.prerequisite * parts.prerequisite + w.errors * parts.errors + w.uncertainty * parts.uncertainty + w.recency * parts.recency + w.time * parts.time;
      // Nothing left to gain: only staleness can bring it back, and weakly.
      const score = gap > 0 ? gap * Math.max(0.05, lift) : 0.1 * w.recency * parts.recency;
      return { n: s.n, name: s.name, score: round(score), parts, ...(ex ? { exam: ex } : {}) };
    })
    .sort((a, b) => b.score - a.score || a.n - b.n);
}

/** True when `a` rests on `b` through any number of prerequisite steps. */
function rests(a: number, b: number, by: Map<number, SkillInput>): boolean {
  const seen = new Set<number>();
  const stack = [...(by.get(a)?.prerequisites ?? [])];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === b) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(by.get(cur)?.prerequisites ?? []));
  }
  return false;
}

/** Follows weak or unchecked prerequisites down to the first one whose own prerequisites are sound. */
function foundation(n: number, by: Map<number, SkillInput>): number {
  const seen = new Set<number>();
  let cur = n;
  while (!seen.has(cur)) {
    seen.add(cur);
    const weak = (by.get(cur)?.prerequisites ?? [])
      .filter((q) => by.has(q) && !seen.has(q) && (by.get(q)!.level ?? -1) < UNLOCK)
      .sort((a, b) => (by.get(a)!.level ?? -1) - (by.get(b)!.level ?? -1) || a - b);
    if (!weak.length) break;
    cur = weak[0];
  }
  return cur;
}

/**
 * Chooses the action for this turn. Explicit constraints come first, in this order, and the
 * weighted ranking only decides among what they leave open:
 *
 *   1. An open step is finished before another starts, unless the learner asks to move on.
 *   2. A subskill is not taught while a prerequisite is weak; an unchecked prerequisite is
 *      diagnosed with one question before it is treated as weak.
 *   3. Learn mode stays within teaching actions and only suggests unaided practice.
 *   4. Plain code handles what it can mark itself (placement, bank questions) in Adaptive mode.
 */
export function decide(p: PolicyInput): Decision {
  const scores = scoreSkills(p);
  const by = new Map(p.skills.map((s) => [s.n, s]));
  const out = (action: Action, focus: number | null, reason: string, constraint = "", local: Decision["local"] = null, suggestIndependent = false): Decision => {
    let a = action;
    if (p.mode === "teach" && !LEARN_ACTIONS.includes(a)) {
      // Learn mode teaches. Anything that would examine becomes supported practice, with a suggestion.
      suggestIndependent = a === "independent-practice" || a === "transfer" || a === "retrieval" || a === "teach-back" || a === "edge-case";
      a = a === "diagnose" ? "explain" : a === "diagnose-error" ? "re-explain" : "guided-practice";
      constraint = constraint || "Learn mode stays within explanation, examples and guided practice";
    }
    const timed = a === "independent-practice" || a === "transfer" || a === "retrieval" ? timedPractice(focus !== null ? by.get(focus) : undefined, p.minutes) : null;
    return { version: POLICY_VERSION, action: a, focus, reason: timed ? `${reason} ${timed.note}` : reason, constraint, local: p.mode === "auto" ? local : null, suggestIndependent, scores, ...(timed ? { timed: timed.minutes } : {}) };
  };

  // 1. The open step.
  if (p.pending && !p.completedStep && p.intent !== "switch") {
    const rule = "an open step is finished before another starts";
    if (p.intent === "attempt") return out("check", p.focus, "You answered the open question, so it is checked first.", rule);
    if (p.intent === "hint") return out("hint", p.focus, "You asked for help with the open question.", rule);
    if (p.intent === "reveal" || p.intent === "skip") return out("worked-example", p.focus, "You asked to see the answer, so it is shown and worked through. This attempt will not count as unaided.", "an assessment solution is shown only after an attempt or an explicit skip");
    return out("continue", p.focus, "The open question is still waiting for an answer.", rule);
  }

  if (!p.skills.length) return out("diagnose", null, "This topic has no subskills yet.");

  // A run of unaided practice that is going well carries on until it has the answers it needs,
  // so the guide does not hop to another concept after every question.
  const run = p.continuing !== null && p.continuing !== undefined ? by.get(p.continuing) : undefined;
  if (run && p.intent !== "switch" && (run.level ?? 0) >= 3 && run.independentCorrect < 2 && run.bankLeft > 0 && !run.lapse) {
    const left = 2 - run.independentCorrect;
    return out("independent-practice", run.n, `${run.name} needs ${left} more correct answer${left === 1 ? "" : "s"} without help before it can move up.`, "a run of unaided practice continues until it has the answers it needs", "bank");
  }

  // A concept waiting only for a transfer question that cannot count today is parked: asking it
  // now would spend a question on something the delayed rule cannot accept.
  const parked = (k: SkillInput): boolean => (k.level ?? 0) >= 3 && k.independentCorrect >= 2 && k.supported < 4 && k.transferReady === false && !k.checkDue && !k.lapse && k.recentFailures < 2;

  // Which subskill: stay with the focus while its step is unfinished, otherwise take the top of the ranking.
  const open = scores.filter((x) => !parked(by.get(x.n)!));
  const ranked = open.length ? open : scores;
  const top = ranked[0];
  const focusSkill = p.focus !== null ? by.get(p.focus) : undefined;
  const focusScore = scores.find((s) => s.n === p.focus)?.score ?? 0;
  const stay = !!focusSkill && p.intent !== "switch" && !p.completedStep && focusScore > 0 && !(open.length && parked(focusSkill));
  const wanted = stay ? focusSkill!.n : p.intent === "switch" && focusSkill && top.n === focusSkill.n && ranked[1] ? ranked[1].n : top.n;
  const why = stay ? "" : whyChosen(scores.find((s) => s.n === wanted) ?? top, p);

  // 2. Prerequisites inside the topic.
  const base = foundation(wanted, by);
  if (base !== wanted) {
    const b = by.get(base)!;
    const rule = "a prerequisite is checked before what builds on it is taught";
    if (b.level === null) {
      if (p.placementReady) return out("diagnose", base, "Nothing is placed yet, so a few quick questions set your starting levels.", "", "placement");
      return out("diagnose-prerequisite", base, `${by.get(wanted)!.name} builds on ${b.name}, which has not been checked yet. One short question comes first.`, rule);
    }
    return out(b.taught ? "re-explain" : "explain", base, `${by.get(wanted)!.name} builds on ${b.name}, which is still at level ${b.level}. That comes first.`, rule);
  }
  const s = by.get(wanted)!;

  // Prerequisites in other topics: each weak or unknown one is checked once per chat, by its id,
  // and one whose check failed is explained before going on, so every unresolved prerequisite
  // is reached in turn. Answering this concept correctly without help shows the prerequisite in
  // use, which settles it without a separate check.
  const outside = p.external.filter((e) => e.skill === s.n && (e.level === null || e.level < UNLOCK));
  if (outside.length && !p.checked.includes(s.n) && s.independentCorrect === 0) {
    const results = p.prereqChecks ?? {};
    const failed = outside.find((e) => !!e.id && ["incorrect", "partial", "skipped"].includes(results[e.id] ?? ""));
    if (failed) {
      const r = results[failed.id!];
      const how = r === "skipped" ? "was skipped" : r === "partial" ? "was only partly right" : "was not answered correctly";
      return { ...out("explain", s.n, `${s.name} builds on ${failed.name} from ${failed.topic}, and the check on it ${how}. A short explanation of ${failed.name} comes first.`, "a prerequisite that failed its check is taught before what builds on it"), teaches: failed.id };
    }
    const e = outside.find((x) => !x.id || !(x.id in results));
    if (e) {
      const d = out("diagnose-prerequisite", s.n, `${s.name} builds on ${e.name} from ${e.topic}, where your level is ${e.level === null ? "not known" : `only ${e.level}`}. One short question checks it before going on.`, "a suspected prerequisite weakness is diagnosed before it is treated as established");
      return e.id ? { ...d, assesses: e.id } : d;
    }
  }

  const level = s.level;
  if (level === null) {
    if (p.placementReady) return out("diagnose", s.n, "Nothing is placed yet, so a few quick questions set your starting levels.", "", "placement");
    return out("diagnose", s.n, `${why}There is no evidence on ${s.name} yet, so one question finds your starting point.`);
  }
  const faded = s.faded ? "bank" : null;
  if (level <= 1) return out(s.taught ? "worked-example" : "explain", s.n, `${why}${s.name} is new to you${s.taught ? ", so another worked example comes before practice" : ", so it is explained with a worked example first"}.`, "", s.taught ? faded : null);
  if (s.lapse || s.recentFailures >= 2) return out("diagnose-error", s.n, `${why}Your recent unaided answers on ${s.name} were wrong, so the cause is found before more practice.`);
  if (level === 2) return out("guided-practice", s.n, `${why}You can follow ${s.name}, so the next step is practice with help on hand.`, "", faded);
  const backed = level <= s.supported;
  const bank = s.bankLeft > 0 ? "bank" : null;
  const delayed = () => s.recheck
    ? out("retrieval", s.n, `${why}The course changed what ${s.name} asks for (${s.recheck}). One question without help checks that your understanding covers the new version; your earlier answers stay on record.`, "a material change to an objective is rechecked before the level is relied on", bank)
    : out("retrieval", s.n, `${why}A delayed check on ${s.name} is due${s.nextCheck ? ` (from ${s.nextCheck})` : ""}. One question without help shows whether it has held.`, "a delayed independent check is taken when it falls due", bank);
  if (level >= p.target && backed) {
    if (s.checkDue) return delayed();
    return out("retrieval", s.n, `${why}${s.name} is at target. A recall question checks that it has held.`, "", bank);
  }
  if (s.independentCorrect < 2) {
    return out("independent-practice", s.n, `${why}${s.name} needs ${2 - s.independentCorrect} more correct answer${2 - s.independentCorrect === 1 ? "" : "s"} without help before it can move up.`, "", bank);
  }
  if (s.supported < 4) {
    if (s.transferReady === false) {
      return out("independent-practice", s.n, `${why}${s.name} now needs a transfer question on a later day than your first unaided success, so that is due from tomorrow. Practice today keeps it going but cannot raise the level.`, "a transfer question is set only when it can count", bank);
    }
    // A transfer question on a later day is also the delayed check, so it is set instead of a recall question.
    return out("transfer", s.n, `${why}You have answered ${s.name} correctly without help. A new kind of problem shows whether it transfers.`);
  }
  if (s.checkDue) return delayed();
  // Level 4 is held. "Can teach it and handle edge cases" needs exactly that, shown without help.
  if (p.target >= 5 && s.needsTeachBack) return out("teach-back", s.n, `${why}${s.name} is held at level 4. Level 5 needs an explanation of it, without help, good enough to teach from.`, "level 5 needs a teach-back and an edge case");
  if (p.target >= 5 && s.needsEdgeCase) return out("edge-case", s.n, `${why}${s.name} is held at level 4. Level 5 also needs an edge case handled without help.`, "level 5 needs a teach-back and an edge case");
  return out("transfer", s.n, `${why}You have answered ${s.name} correctly without help. A new kind of problem shows whether it transfers.`);
}

/**
 * The Home screen's suggestion for one topic, taken from the same decision Adaptive study would
 * make on a fresh chat, so the two never disagree about the concept or the step. Following it
 * opens Adaptive study on that concept. Flashcards are item recall, kept apart from concept
 * evidence: they come first only when the policy has nothing pressing (a lapse, a due delayed
 * check, an unchecked prerequisite).
 */
export function homeStep(d: Decision, opts: { due: number; atTarget: boolean }): NextStep {
  const pressing = d.action === "diagnose-error" || d.action === "diagnose-prerequisite" || (d.action === "retrieval" && /delayed independent check/.test(d.constraint));
  if (!pressing && opts.due > 0) return { action: "review", title: "Review", detail: `${opts.due} flashcard${opts.due === 1 ? " is" : "s are"} due. Reviewing uses no tokens.` };
  if (opts.atTarget && !pressing) return { action: "done", title: "At target", detail: "Every concept is at your target level, your unaided answers back that up, and no delayed check is due." };
  return { action: "auto", title: ACTION_LABEL[d.action], detail: d.reason, ...(d.focus !== null ? { subskill: d.focus } : {}) };
}

function whyChosen(score: Score, p: PolicyInput): string {
  const w = p.weights;
  // A priority raised by exam metadata alone is the exam's doing, not the learner's.
  const fromExam = !!score.exam && score.exam.factor > 1 && (p.skills.find((s) => s.n === score.n)?.priority ?? 1) <= 1;
  const named: [number, string][] = [
    [w.errors * score.parts.errors, "your recent answers on it were wrong"],
    [w.prerequisite * score.parts.prerequisite, "other concepts rest on it"],
    [w.exam * score.parts.exam, fromExam ? "it counts for a lot in the exam" : "you gave it a high priority"],
    [w.recency * score.parts.recency, "it has not been practised for a while"],
    [w.uncertainty * score.parts.uncertainty, "there is little evidence on it yet"],
    [w.time * score.parts.time, "it fits the time you have"],
  ];
  const lead = named.filter(([v]) => v > 0.15).sort((a, b) => b[0] - a[0])[0];
  return `${lead ? `Chosen because ${lead[1]}. ` : ""}${score.exam?.note ? `${score.exam.note} ` : ""}`;
}

/**
 * Timed practice, as in the exam: for unaided practice on a subskill whose objectives give typical
 * minutes, when the time available holds them and the exam is not past or more than EXAM_WINDOW
 * days away (an objective without a date still gets it).
 */
function timedPractice(k: SkillInput | undefined, available: number): { minutes: number; note: string } | null {
  const e = k?.exam;
  if (!e || !e.minutes || e.minutes > available) return null;
  if (e.daysToExam !== null && (e.daysToExam < 0 || e.daysToExam > EXAM_WINDOW)) return null;
  const like = [e.marks ? `${e.marks} marks` : "", e.commands.join(", "), e.paper].filter(Boolean).join(", ");
  return { minutes: e.minutes, note: `Exam practice: allow about ${e.minutes} minute${e.minutes === 1 ? "" : "s"}, as in the exam${like ? ` (${like})` : ""}.` };
}

/**
 * The exam signal for each subskill, from the objectives it teaches (Objective.exam, parsed from
 * the card) and the topic's exam date. An objective's weight is split evenly over the subskills
 * that teach it; the nearest exam date that has not passed counts. Subskills with neither are left
 * out. `today` is yyyy-mm-dd, so the result, and decide(), stay deterministic.
 */
export function examSignals(topic: Pick<Topic, "subskills" | "objectives" | "examDate">, today: string): Record<number, ExamSignal> {
  const objectives = topic.objectives ?? [];
  // Objective ids each subskill teaches, lowercased once; the first subskill with a number wins.
  const taught = new Map<number, Set<string>>();
  for (const s of topic.subskills) if (!taught.has(s.n)) taught.set(s.n, new Set((s.objectives ?? []).map((x) => x.toLowerCase())));
  const teaches = (n: number, id: string) => taught.get(n)?.has(id.toLowerCase()) ?? false;
  const now = dayNumber(today);
  const out: Record<number, ExamSignal> = {};
  for (const s of topic.subskills) {
    const mine = objectives.filter((o) => teaches(s.n, o.id));
    const meta = mine.filter((o) => o.exam).map((o) => o.exam!);
    const dates = (mine.length ? mine.map((o) => o.exam?.date ?? topic.examDate ?? "") : [topic.examDate ?? ""]).filter(Boolean);
    if (!meta.length && !dates.length) continue;
    let weight: number | null = null;
    for (const o of mine) {
      if (!o.exam?.weight) continue;
      const shared = topic.subskills.filter((x) => teaches(x.n, o.id)).length;
      weight = (weight ?? 0) + o.exam.weight / Math.max(1, shared);
    }
    const days = Number.isFinite(now) ? dates.map((d) => Math.round(dayNumber(d) - now)) : [];
    const ahead = days.filter((d) => d >= 0);
    const timed = meta.filter((e) => e.minutes).sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0];
    out[s.n] = {
      weight: weight === null ? null : Math.round(weight * 10000) / 10000,
      daysToExam: days.length ? (ahead.length ? Math.min(...ahead) : Math.max(...days)) : null,
      minutes: timed?.minutes ?? null,
      marks: timed?.marks ?? meta.find((e) => e.marks)?.marks ?? null,
      paper: [...new Set(meta.map((e) => e.paper ?? "").filter(Boolean))].join(", "),
      commands: [...new Set(meta.flatMap((e) => e.commands ?? []))],
    };
  }
  return out;
}

/** One logged decision: what the policy saw and what it chose. */
export interface PolicyCase {
  t: string;
  topic: string;
  input: PolicyInput;
  decision: { version: number; action: Action; focus: number | null; local: Decision["local"] };
}

/** BKT re-scored over a decision log (replay with `shadow`). */
export interface ShadowReplay {
  params: BktParams;
  /** Per logged case: BKT on the logged focus, traced from the attempts made before the case. */
  cases: { t: string; topic: string; focus: number | null; pKnown: number | null; pCorrect: number | null; observations: number }[];
  /** BKT's predictions against the existing estimate's, over every unaided answer in the attempts given. */
  comparison: BrierComparison;
  /** Every replayed decision came out identical with the logged shadow values removed. */
  unaffected: boolean;
}

/**
 * Runs logged cases through the policy with other weights and reports where the choice differs.
 * With `shadow` (each case topic's attempts, optional BKT parameters and multiple-choice option
 * counts by topic) it also re-scores BKT over the log: its P(known) for each logged focus at the
 * time, its Brier score against the existing estimate's, and a check that removing the shadow
 * values changes no decision.
 */
export function replay(
  cases: PolicyCase[],
  weights: PolicyWeights,
  shadow?: { attempts: Record<string, Attempt[]>; params?: BktParams; options?: Record<string, Record<string, number>> },
): { total: number; same: number; changed: { t: string; topic: string; was: string; now: string }[]; shadow?: ShadowReplay } {
  const changed: { t: string; topic: string; was: string; now: string }[] = [];
  const name = (c: PolicyCase, focus: number | null) => c.input.skills.find((s) => s.n === focus)?.name ?? "none";
  let unaffected = true;
  for (const c of cases) {
    const d = decide({ ...c.input, weights });
    if (shadow) {
      const plain = c.input.skills.map((k) => {
        const copy = { ...k };
        delete copy.shadow;
        return copy;
      });
      if (JSON.stringify(decide({ ...c.input, weights, skills: plain })) !== JSON.stringify(d)) unaffected = false;
    }
    if (d.action === c.decision.action && d.focus === c.decision.focus) continue;
    changed.push({ t: c.t, topic: c.topic, was: `${c.decision.action} on ${name(c, c.decision.focus)}`, now: `${d.action} on ${name(c, d.focus)}` });
  }
  const out = { total: cases.length, same: cases.length - changed.length, changed };
  if (!shadow) return out;
  const params = shadow.params ?? BKT_DEFAULTS;
  const rows = cases.map((c) => {
    const at = Date.parse(c.t);
    const before = (shadow.attempts[c.topic] ?? []).filter((a) => Date.parse(a.timestamp) < at);
    const t = c.decision.focus === null ? null : bktTrace(before, c.decision.focus, { params, options: shadow.options?.[c.topic] });
    return { t: c.t, topic: c.topic, focus: c.decision.focus, pKnown: t ? round(t.pKnown) : null, pCorrect: t ? round(t.pCorrect) : null, observations: t?.steps.length ?? 0 };
  });
  const comparison = brierComparison(Object.entries(shadow.attempts).flatMap(([topic, list]) => bktAll(list, { params, options: shadow.options?.[topic] })));
  return { ...out, shadow: { params, cases: rows, comparison, unaffected } };
}
