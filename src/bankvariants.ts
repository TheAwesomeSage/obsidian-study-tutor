// Fresh numbers for bank questions whose family the compiler described as data (Question.generator).
// The model wrote the spec once; families.ts makes, checks and marks every instance with trusted
// code, so a new instance costs no model call. Task ids keep the ancestry (parseTaskId): "Q3~17"
// is question Q3 with seed 17, "Q3~17#fix0" is the repair task for that instance's first expected
// mistake, and "Q3~17#fade2" is that instance as a worked example with its last two steps left to
// the learner. No Obsidian imports.

import type { Attempt } from "./evidence";
import { FamilySpec, Instance, TaskKind, baseQuestionId, fade, flawedSolution, instantiate, markNumeric, parseTaskId, taskId } from "./families";
import type { Grade, LearnerState, Question } from "./formats";

/** A bank question as asked: the original, an instance with new numbers, or a repair task or faded example on one. */
export interface BankTask {
  base: Question;
  question: Question;
  inst: Instance | null;
  /** For "fix", k is the index into inst.mistakes; for "fade", the steps left to the learner. */
  kind: TaskKind;
  k: number;
}

/** True for the ids of bank questions and their instances, as opposed to the tutor's own questions. */
export const isBankId = (id: string): boolean => /^Q\d+$/.test(parseTaskId(id)?.base ?? "");

const numbered = (steps: string[]) => steps.map((s, i) => `${i + 1}. ${s}`).join("\n");

function variantQuestion(base: Question, inst: Instance): Question {
  return {
    ...base,
    id: taskId(base.id, inst.seed),
    type: "short",
    options: [],
    question: inst.question,
    answer: inst.answerText,
    explanation: inst.steps.length ? numbered(inst.steps) : "Study Tutor worked this out from the question's formula.",
    rubric: undefined,
  };
}

function repairQuestion(base: Question, inst: Instance, k: number): Question | null {
  const flawed = flawedSolution(inst, k);
  if (!flawed) return null;
  return {
    ...variantQuestion(base, inst),
    id: taskId(base.id, inst.seed, "fix", k),
    task: "error-finding",
    question: `${inst.question}\n\nThis worked solution has one mistake in it:\n\n${numbered(flawed.steps)}\n\n*Reply with the step that goes wrong and the right answer, as "step N, answer X", and say why if you like.*`,
    answer: `step ${flawed.wrongStep}, answer ${inst.answerText}`,
  };
}

function fadedQuestion(base: Question, inst: Instance, hidden: number): Question | null {
  const f = fade(inst, hidden);
  if (!f.blanks || f.blanks >= inst.steps.length) return null;
  return {
    ...variantQuestion(base, inst),
    id: taskId(base.id, inst.seed, "fade", f.blanks),
    question: `${inst.question}\n\nA worked solution with ${f.blanks === 1 ? "its last step" : `its last ${f.blanks} steps`} left for you:\n\n${numbered(f.shown)}\n\n*Finish it and reply with the final answer.*`,
  };
}

/** The task a card id names, rebuilt from its seed. Null when the id names nothing this bank can make. */
export function taskOf(questions: Question[], id: string): BankTask | null {
  const ref = parseTaskId(id);
  const base = ref ? questions.find((q) => q.id === ref.base) : undefined;
  if (!ref || !base) return null;
  if (ref.seed === null) return { base, question: base, inst: null, kind: "question", k: 0 };
  const inst = base.generator ? instantiate(base.generator, ref.seed) : null;
  if (!inst) return null;
  const question = ref.kind === "fix" ? repairQuestion(base, inst, ref.k) : ref.kind === "fade" ? fadedQuestion(base, inst, ref.k) : variantQuestion(base, inst);
  return question && { base, question, inst, kind: ref.kind, k: ref.k };
}

/** An instance with a seed never used for this question, in this chat or in any recorded attempt. */
function freshInstance(base: Question, s: LearnerState, asked: string[]): Instance | null {
  if (!base.generator) return null;
  let seed = 1;
  const see = (id: string) => {
    const r = id.includes("~") ? parseTaskId(id) : null;
    if (r?.seed && r.base === base.id && r.seed >= seed) seed = r.seed + 1;
  };
  asked.forEach(see);
  s.attempts.forEach((a) => see(a.questionId));
  for (let tries = 0; tries < 8; tries++, seed++) {
    const inst = instantiate(base.generator, seed);
    if (inst) return inst;
  }
  return null;
}

/** A new instance of a question with a generator. */
export function freshVariant(base: Question, s: LearnerState, asked: string[]): Question | null {
  const inst = freshInstance(base, s, asked);
  return inst && variantQuestion(base, inst);
}

/** True when the learner has met this question, with any numbers, in this chat or in a recorded attempt. */
export const metBefore = (base: Question, s: LearnerState, asked: string[]): boolean =>
  asked.some((id) => baseQuestionId(id) === base.id) || s.attempts.some((a) => baseQuestionId(a.questionId) === base.id);

/**
 * A faded worked example on new numbers: the learner finishes the last steps. Each faded example
 * on this question answered right leaves one more step to the learner; with nothing left to show,
 * there is no faded example and plain practice takes over.
 */
export function fadedFor(base: Question, s: LearnerState, asked: string[]): Question | null {
  const steps = base.generator?.steps?.length ?? 0;
  if (steps < 2) return null;
  const done = s.attempts.filter((a) => {
    const r = a.result === "correct" ? parseTaskId(a.questionId) : null;
    return r?.kind === "fade" && r.base === base.id;
  }).length;
  const inst = done + 1 < steps ? freshInstance(base, s, asked) : null;
  return inst && fadedQuestion(base, inst, done + 1);
}

const HELP: Partial<Record<TaskKind, string>> = {
  fix: "a repair task set straight after a mistake on the same kind of question, with a worked solution in view",
  fade: "a faded worked example: the first steps of the solution were shown",
};

/** The help a task itself gives, recorded with the attempt so it does not count as unaided. */
export const taskHelp = (task: BankTask | null): string | undefined => (task ? HELP[task.kind] : undefined);

/** A task code sets next, with the step and reason the session record shows. */
export interface FollowUp {
  question: Question;
  action: string;
  reason: string;
}

/**
 * After a known mistake on new numbers comes a worked solution that makes it, to find and fix
 * (helped work); after that repair, new numbers check the fix without help. Null otherwise.
 */
export function followUp(task: BankTask, a: Attempt, s: LearnerState, asked: string[]): FollowUp | null {
  if (!task.inst) return null;
  if (task.kind === "fix") {
    const question = freshVariant(task.base, s, asked);
    return question && { question, action: "fresh-check", reason: "After the repair, new numbers check the fix without help." };
  }
  const k = a.result === "incorrect" && a.errorType ? task.inst.mistakes.findIndex((m) => m.label === a.errorType) : -1;
  const question = k >= 0 ? repairQuestion(task.base, task.inst, k) : null;
  return question && { question, action: "repair", reason: "Your answer matched a known mistake, so a worked solution that makes it comes next: find the step and fix it. It counts as helped work." };
}

export interface TaskMark {
  grade: Grade;
  /** The expected mistake the answer matches, as recorded in the attempt's error type. */
  mistake: string;
  note: string;
  assumptions: string;
}

function markInstance(inst: Instance, spec: FamilySpec, reply: string): TaskMark | null {
  const m = markNumeric(inst, spec, reply);
  if (m.result === "unreadable") return null;
  const mistake = m.mistake ?? "";
  return {
    grade: m.result === "correct" ? "good" : "again",
    mistake,
    note: mistake ? `Your answer is what this mistake gives: ${mistake}.` : "",
    assumptions: "Study Tutor computed the answer from the question's formula and compared your number with it",
  };
}

/** A repair is right when it names the wrong step and gives the right answer, and partly right with one of the two. */
function markRepair(inst: Instance, spec: FamilySpec, k: number, reply: string): TaskMark | null {
  const flawed = flawedSolution(inst, k);
  const step = /\bstep\s*(\d+)/i.exec(reply) ?? /^\s*(\d+)(?![\d.])/.exec(reply);
  // The step number is not the answer: only what follows it is marked as one.
  const fixed = markNumeric(inst, spec, step ? reply.replace(step[0], " ") : reply).result;
  if (!flawed || (!step && fixed === "unreadable")) return null;
  const located = !!step && Number(step[1]) === flawed.wrongStep;
  const right = fixed === "correct";
  return {
    grade: located && right ? "good" : located || right ? "hard" : "again",
    mistake: located && right ? "" : flawed.label,
    note: `${located ? `Step ${flawed.wrongStep} is the one that goes wrong` : `The mistake is in step ${flawed.wrongStep}`}: ${flawed.label}. ${right ? "Your corrected answer is right." : `The right answer is ${inst.answerText}.`} Any explanation you gave is kept with the answer but not marked.`,
    assumptions: "Study Tutor compared the step you named with the one it changed, and your number with the answer it computed",
  };
}

/** Marks an answer to an instance or a repair task with code. Null when the reply has nothing to mark, so the learner is asked again. */
export function markTask(task: BankTask, reply: string): TaskMark | null {
  const spec = task.base.generator;
  if (!task.inst || !spec) return null;
  return task.kind === "fix" ? markRepair(task.inst, spec, task.k, reply) : markInstance(task.inst, spec, reply);
}
