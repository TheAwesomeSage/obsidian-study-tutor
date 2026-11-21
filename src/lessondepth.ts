// How deep a turn goes. Routine turns work from the compact topic card, which is already in the
// system prompt. A turn that needs more (re-explaining, finding a failed step, remediating a
// supported misconception, a late hint, a worked solution, a learner asking why) also gets the
// compiled lesson for the concept and its references, and quotes the sources.
//
// The lesson comes from the compiler through `CourseMaterial`. Older courses have no deeper
// lesson; for them it is assembled from what they do have (the course package and the card), and
// whatever is missing is listed, so the tutor says so instead of filling the gap from memory.

import type { MoveDecision } from "./tutormove";
import type { Intent } from "./session";
import type { CoursePackage } from "./coursepkg";
import type { Objective, Subskill } from "./formats";

export type Availability = "available" | "missing" | "unknown";

/** One objective the concept serves, and what the course has for it. */
export interface ObjectiveCoverage {
  /** Stable objective id. */
  id: string;
  text: string;
  /** The original clause or section reference. */
  ref: string;
  source: Availability;
  teaching: Availability;
  assessment: Availability;
}

export interface LessonMaterial {
  conceptId: string;
  /** The deeper lesson beyond the card. Empty when the course has none. */
  lesson: string;
  /** A worked example. Empty when the course has none. */
  worked: string;
  /** The references the lesson rests on: [[notes]], URLs, or passage ids. */
  refs: string[];
  objectives: ObjectiveCoverage[];
  /** compiled: from the compiler. package / card: assembled from an older course. */
  from: "compiled" | "package" | "card";
}

/** The compiler's lesson store, wired by the host. Returns null when it has nothing for the concept. */
export interface CourseMaterial {
  lessonFor(topicDir: string, conceptId: string): Promise<LessonMaterial | null>;
}

export interface Depth {
  level: "card" | "lesson";
  /** Quote the source passages this turn. */
  sources: boolean;
  /** The word budget for quoted passages. */
  sourceWords: number;
  /** Why, for Details. */
  reason: string;
}

/** The learner asks for more than the card gives: why, a proof, a derivation, more depth. */
export const DEEPER = /\b(why (does|is|do|did|would|should|can)|how come|prove|proof|derive|derivation|in (more )?(depth|detail)|more detail|go deeper|explain (it |this |that )?(further|more|properly|in full)|where does (this|that|it) come from|intuition (behind|for))\b/i;

const ROUTINE: Depth = { level: "card", sources: false, sourceWords: 160, reason: "a routine step: the topic card is enough" };

/**
 * Card or lesson, decided in code. Auto and Learn modes keep their rule for quoting sources (a
 * teaching step or an error diagnosis) and go deeper for a re-explanation or a diagnosis; Master
 * goes deeper for moves that remediate or locate an error; Ask goes deeper when asked why or how.
 */
export function lessonDepth(p: { mode: string; action: string | null; move: MoveDecision | null; said: string; intent: Intent }): Depth {
  const asked = !!p.said && DEEPER.test(p.said);
  const deep = (reason: string): Depth => ({ level: "lesson", sources: true, sourceWords: 280, reason });
  if (p.mode === "auto" || p.mode === "teach") {
    if (p.action === "re-explain" || p.action === "diagnose-error") return deep(p.action === "re-explain" ? "the first explanation did not land" : "an error is being diagnosed");
    if (asked) return deep("you asked why or how");
    return ROUTINE;
  }
  if (p.mode === "tutor" && p.move) {
    const m = p.move;
    if (m.move === "address-misconception") return deep("a supported misconception is being addressed");
    if (m.move === "probe" && (m.reason === "FIND_FAILED_STEP" || m.reason === "SUSPECTED_MISCONCEPTION")) return deep(m.reason === "FIND_FAILED_STEP" ? "the failed step is being located" : "a suspected misconception is being told apart");
    if (m.move === "hint" && (m.hintStage ?? 1) >= 3) return deep("a late hint shows a step worked");
    if (m.move === "worked-solution") return deep("the answer is being worked through");
    if (m.move === "reteach") return deep("the idea is being taught again another way");
    if (m.move === "model-strategy") return deep("a parallel problem is being worked to show a way in");
    if (asked) return deep("you asked why or how");
    return ROUTINE;
  }
  if (p.mode === "expert" && p.said) return asked ? deep("you asked why or how") : { ...ROUTINE, sources: true, reason: "a direct question: the sources are quoted" };
  return ROUTINE;
}

/**
 * The lesson for an older course, from what it has: the course package's worked lesson,
 * citations and objectives, else the card's own. What is missing is marked missing; what the
 * course cannot say is marked unknown.
 */
export function fallbackMaterial(p: { conceptId: string; subskill: Subskill; pkg: CoursePackage | null; objectives: Objective[] }): LessonMaterial {
  const sk = p.subskill;
  const lesson = p.pkg?.lessons.find((l) => (p.conceptId && l.concept === p.conceptId) || l.n === sk.n);
  const worked = sk.worked || lesson?.worked || "";
  const ids = lesson?.objectives.length ? lesson.objectives : sk.objectives ?? [];
  const objectives: ObjectiveCoverage[] = ids.map((id) => {
    const po = p.pkg?.objectives.find((o) => o.id === id);
    const co = p.objectives.find((o) => o.id === id);
    if (!po) return { id, text: co?.text ?? "", ref: co?.source ?? "", source: co ? (co.source ? "available" : "missing") : "unknown", teaching: "unknown", assessment: "unknown" };
    return { id, text: po.text, ref: po.source, source: po.source ? "available" : "missing", teaching: po.subskills.length ? "available" : "missing", assessment: po.questions.length ? "available" : "missing" };
  });
  return { conceptId: p.conceptId, lesson: "", worked, refs: [...new Set([...(lesson?.citations ?? []), ...sk.sources])].slice(0, 8), objectives, from: p.pkg ? "package" : "card" };
}

/** What the course lacks for this concept, one short phrase each. Empty when nothing is known to be missing. */
export function missingEvidence(m: LessonMaterial): string[] {
  const out: string[] = [];
  if (!m.lesson) out.push(m.from === "compiled" ? "no deeper lesson was compiled for this concept" : "this course was compiled before deeper lessons, so only the card and its worked example are available");
  if (!m.worked) out.push("no worked example");
  if (!m.refs.length) out.push("no cited source");
  for (const o of m.objectives) {
    const lacks = (["source", "teaching", "assessment"] as const).filter((k) => o[k] === "missing");
    if (lacks.length) out.push(`objective ${o.id}${o.ref ? ` (${o.ref})` : ""}: no ${lacks.join(", no ")} material`);
  }
  return out;
}

const cap = (text: string, n: number): string => {
  const w = text.trim().split(/\s+/);
  return w.length <= n ? text.trim() : `${w.slice(0, n).join(" ")} …`;
};

/** The lesson as the turn input carries it: lesson, worked example, references, and what is missing. */
export function renderLesson(m: LessonMaterial, name: string, maxWords = 450): string {
  const parts = [`# Lesson material for ${name} (${m.from === "compiled" ? "compiled lesson" : "from the course as compiled; no deeper lesson"})`];
  if (m.lesson) parts.push(cap(m.lesson, Math.round(maxWords * 0.7)));
  if (m.worked) parts.push(`Worked example:\n${cap(m.worked, Math.round(maxWords * 0.3))}`);
  if (m.refs.length) parts.push(`References: ${m.refs.join(", ")}`);
  const objs = m.objectives.filter((o) => o.text || o.ref);
  if (objs.length) parts.push(`Objectives: ${objs.map((o) => `${o.id}${o.ref ? ` [${o.ref}]` : ""} ${o.text}`.trim()).join("; ")}`);
  const missing = missingEvidence(m);
  if (missing.length) parts.push(`Missing from the course: ${missing.join("; ")}. If the learner needs what is missing, say plainly that the course does not cover it here rather than filling it in from memory.`);
  return parts.join("\n\n");
}
