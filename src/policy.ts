// The local instructional policy: which subskill to work on and what to do with it.
// It is plain arithmetic over the learner state, so every choice can be inspected, logged and
// replayed. Weights only rank what to study next. They cannot change a level: levels move
// through the evidence rules in evidence.ts and nowhere else.

import type { Mode, NextStep } from "./formats";
import type { Intent } from "./session";

/**
 * Bumped whenever the scoring or the action rules change, so logged decisions can be compared
 * across versions.
 *   1  0.5.0: priority × distance from level 5, one fixed ladder of actions
 *   2  0.5.1: weighted components, explicit constraints, local dispatch, Learn-mode limits
 *   3  0.6.0: concept-level delayed checks; recency from unaided work only; no transfer question
 *      on the day it cannot count; prerequisites in other topics checked one by one with their
 *      outcomes; teach-back and edge-case steps toward level 5; Home uses the same decision
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
  /** Bank questions on this subskill that code can mark and this chat has not asked. */
  bankLeft: number;
  /** A delayed independent check on this concept falls due today or earlier. */
  checkDue?: boolean;
  /** When that check falls due (yyyy-mm-dd), for the reason shown. */
  nextCheck?: string | null;
  /**
   * A transfer question answered today could count: the first unaided success was on an earlier
   * day. False means a transfer today cannot satisfy the delayed requirement. Unset means true.
   */
  transferReady?: boolean;
  /** Level 5 still needs an unaided teach-back, or an unaided edge case. */
  needsTeachBack?: boolean;
  needsEdgeCase?: boolean;
}

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
}

/** Level a prerequisite must hold before what builds on it is taught. */
export const UNLOCK = 2;

const round = (x: number): number => Math.round(x * 1000) / 1000;

/** Ranks every subskill. Higher means more worth studying now. */
export function scoreSkills(p: PolicyInput): Score[] {
  const w = p.weights;
  const by = new Map(p.skills.map((s) => [s.n, s]));
  return p.skills
    .map((s) => {
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
        exam: round((Math.min(5, Math.max(0.1, s.priority)) - 1) / 4),
        prerequisite: round(below / Math.max(1, p.skills.length - 1)),
        errors: round(Math.min(1, s.recentFailures / 3 + (s.lapse ? 0.5 : 0))),
        uncertainty: round(s.level === null ? 1 : 1 / (1 + s.independent)),
        recency: round(s.daysSince === null || level < 2 ? 0 : Math.min(1, s.daysSince / 21)),
        time: p.minutes <= 10 ? (level <= 1 ? -1 : s.bankLeft > 0 ? 1 : 0) : 0,
      };
      const lift = 1 + w.exam * parts.exam + w.prerequisite * parts.prerequisite + w.errors * parts.errors + w.uncertainty * parts.uncertainty + w.recency * parts.recency + w.time * parts.time;
      // Nothing left to gain: only staleness can bring it back, and weakly.
      const score = gap > 0 ? gap * Math.max(0.05, lift) : 0.1 * w.recency * parts.recency;
      return { n: s.n, name: s.name, score: round(score), parts };
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
    return { version: POLICY_VERSION, action: a, focus, reason, constraint, local: p.mode === "auto" ? local : null, suggestIndependent, scores };
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
  if (level <= 1) return out(s.taught ? "worked-example" : "explain", s.n, `${why}${s.name} is new to you${s.taught ? ", so another worked example comes before practice" : ", so it is explained with a worked example first"}.`);
  if (s.lapse || s.recentFailures >= 2) return out("diagnose-error", s.n, `${why}Your recent unaided answers on ${s.name} were wrong, so the cause is found before more practice.`);
  if (level === 2) return out("guided-practice", s.n, `${why}You can follow ${s.name}, so the next step is practice with help on hand.`);
  const backed = level <= s.supported;
  const bank = s.bankLeft > 0 ? "bank" : null;
  const delayed = () => out("retrieval", s.n, `${why}A delayed check on ${s.name} is due${s.nextCheck ? ` (from ${s.nextCheck})` : ""}. One question without help shows whether it has held.`, "a delayed independent check is taken when it falls due", bank);
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
  const named: [number, string][] = [
    [w.errors * score.parts.errors, "your recent answers on it were wrong"],
    [w.prerequisite * score.parts.prerequisite, "other concepts rest on it"],
    [w.exam * score.parts.exam, "you gave it a high priority"],
    [w.recency * score.parts.recency, "it has not been practised for a while"],
    [w.uncertainty * score.parts.uncertainty, "there is little evidence on it yet"],
    [w.time * score.parts.time, "it fits the time you have"],
  ];
  const lead = named.filter(([v]) => v > 0.15).sort((a, b) => b[0] - a[0])[0];
  return lead ? `Chosen because ${lead[1]}. ` : "";
}

/** One logged decision: what the policy saw and what it chose. */
export interface PolicyCase {
  t: string;
  topic: string;
  input: PolicyInput;
  decision: { version: number; action: Action; focus: number | null; local: Decision["local"] };
}

/** Runs logged cases through the policy with other weights and reports where the choice differs. */
export function replay(cases: PolicyCase[], weights: PolicyWeights): { total: number; same: number; changed: { t: string; topic: string; was: string; now: string }[] } {
  const changed: { t: string; topic: string; was: string; now: string }[] = [];
  const name = (c: PolicyCase, focus: number | null) => c.input.skills.find((s) => s.n === focus)?.name ?? "none";
  for (const c of cases) {
    const d = decide({ ...c.input, weights });
    if (d.action === c.decision.action && d.focus === c.decision.focus) continue;
    changed.push({ t: c.t, topic: c.topic, was: `${c.decision.action} on ${name(c, c.decision.focus)}`, now: `${d.action} on ${name(c, d.focus)}` });
  }
  return { total: cases.length, same: cases.length - changed.length, changed };
}
