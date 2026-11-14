// What the home screen knows about each topic, and which one to suggest next.
// Pure functions, no Obsidian imports.

import { LearnerState, NextStep, Prereqs, dueCount, mastery, nextStep, progress } from "./formats";
import type { Decision } from "./policy";

export interface TopicInfo {
  dir: string;
  title: string;
  state: LearnerState;
  pre: Prereqs;
  /** Flashcards due today, from whichever plugin keeps the schedule. */
  due: number;
  /** Percent of the way to the target level. */
  progress: number;
  concepts: number;
  /** Concepts at target with the evidence to hold it. */
  secured: number;
  /** Concepts whose recorded level is above what the evidence supports. */
  unbacked: number;
  /** Timestamp of the last marked answer, or null. */
  last: string | null;
  step: NextStep;
  /** The study policy's decision behind `step`, when the step came from it (0.6 on). */
  decision?: Decision;
}

/**
 * What Home knows about a topic. With `policy` (the engine's recommendTopic result) the step is
 * the one Adaptive study would take; without it, the older guided path is used.
 */
export function topicInfo(dir: string, title: string, state: LearnerState, pre: Prereqs, today: string, srDue?: number, policy?: { step: NextStep; decision: Decision }): TopicInfo {
  const ns = Object.keys(state.names).map(Number);
  const ms = ns.map((n) => mastery(state, n));
  const last = state.attempts.reduce<string | null>((a, x) => (!a || x.timestamp > a ? x.timestamp : a), null);
  return {
    dir,
    title,
    state,
    pre,
    due: srDue ?? dueCount(state, today),
    progress: progress(state),
    concepts: ns.length,
    secured: ms.filter((m) => m.level !== null && m.level >= state.target && m.backed).length,
    unbacked: ms.filter((m) => m.level !== null && m.level > 0 && !m.backed).length,
    last,
    step: policy?.step ?? nextStep(state, today, srDue, pre),
    ...(policy ? { decision: policy.decision } : {}),
  };
}

const WEIGHT: Record<string, number> = { Revisit: 100, Review: 80, Learn: 60, Practise: 55, Master: 50, Confirm: 40, "Retrieval check": 30 };

/** How strongly a policy decision presses, for choosing between topics. Same order as the policy's own rules. */
function pressure(d: Decision): number {
  if (d.action === "diagnose-error") return 100;
  if (d.action === "retrieval" && /delayed independent check/.test(d.constraint)) return 90;
  if (d.action === "diagnose-prerequisite" || d.local === "placement") return 70;
  // Otherwise the policy's own score for the concept it chose, so topics compare on one scale.
  const top = d.scores.find((s) => s.n === d.focus)?.score ?? 0;
  return 20 + Math.min(40, top * 20);
}

/**
 * The one thing to suggest across every topic. A lapse comes first, then due reviews, then the
 * guided path. With little time, quick work that needs no lesson moves up. The topic already
 * open wins a tie, so the suggestion does not jump about.
 */
export function recommend(infos: TopicInfo[], activeDir: string | null, minutes: number): { info: TopicInfo; step: NextStep; why: string } | null {
  let best: { info: TopicInfo; score: number } | null = null;
  for (const info of infos) {
    const title = info.step.title;
    if (info.step.action === "done") continue;
    const policy = info.decision && info.step.action !== "review" ? info.decision : null;
    let score = policy ? pressure(policy) : WEIGHT[title] ?? 20;
    const quickWork = title === "Review" || title === "Practise" || title === "Retrieval check" || (!!policy && (policy.local === "bank" || policy.action === "retrieval"));
    const lesson = title === "Learn" || (!!policy && ["explain", "worked-example", "re-explain"].includes(policy.action));
    if (minutes <= 10 && quickWork) score += 30;
    if (minutes <= 10 && lesson) score -= 20;
    if (info.dir === activeDir) score += 5;
    if (!best || score > best.score) best = { info, score };
  }
  if (!best) return null;
  const quick = minutes <= 10 && (/Review|Practise|Retrieval/.test(best.info.step.title) || best.info.decision?.local === "bank") ? " It fits the time you have." : "";
  return { info: best.info, step: best.info.step, why: best.info.step.detail + quick };
}

/** "today", "yesterday", "3 days ago", or the date, for a yyyy-mm-dd day or an ISO timestamp. */
export function ago(stamp: string | null, today: string): string {
  if (!stamp) return "not yet";
  const day = stamp.slice(0, 10);
  const days = Math.round((Date.parse(today + "T00:00:00") - Date.parse(day + "T00:00:00")) / 86400000);
  if (!Number.isFinite(days)) return day;
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return day;
}
