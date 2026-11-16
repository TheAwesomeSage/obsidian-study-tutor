// Master mode's next move. Socratic tutoring asks one question per turn; this decides, in code,
// what kind of question it is and why, from the evidence and the session state:
//
//   probe                   an answer that cannot be judged yet, or a wrong one whose cause is not
//                           known: one narrower question (a discriminating one for a suspicion)
//   address-misconception   a supported misconception on this concept: a question aimed at it
//   ask-justification       a right result without a sound method shown: ask why it holds
//   fresh-application       a justified answer, a success with help, or no evidence yet: a new problem
//
// A request from the learner comes first: help gets the next graduated hint, a skip or a request for
// the answer gets the worked solution. The move goes to the model with a short reason code and the
// evidence behind it, and is kept with the session and shown in Details.
//
// When the learner has just answered, the move depends on a mark the model is about to give in the
// same reply. Code then sends the few branches that can follow, decided here, and afterwards works
// out from the recorded mark which branch applied (`afterMark`), so what is logged is code's choice.

import type { Attempt } from "./evidence";
import type { Intent } from "./session";
import { Misconception, countable } from "./misconceptions";

export type Move = "check" | "hint" | "worked-solution" | "continue" | "probe" | "address-misconception" | "ask-justification" | "fresh-application";
export const FOLLOW_UPS: Move[] = ["probe", "address-misconception", "ask-justification", "fresh-application"];

export type ReasonCode =
  | "LEARNER_ASKED_HELP"
  | "LEARNER_SKIPPED"
  | "LEARNER_ASKED_ANSWER"
  | "LEARNER_MOVED_ON"
  | "OPEN_QUESTION_WAITING"
  | "ANSWER_TO_CHECK"
  | "AMBIGUOUS_ANSWER"
  | "SUSPECTED_MISCONCEPTION"
  | "CONFIRMED_MISCONCEPTION"
  | "MISCONCEPTION_STILL_OPEN"
  | "FIND_FAILED_STEP"
  | "FLAWED_METHOD"
  | "RESULT_WITHOUT_METHOD"
  | "HEDGED_CORRECT"
  | "JUSTIFIED"
  | "HELPED_SUCCESS"
  | "AFTER_WORKED_SOLUTION"
  | "NO_EVIDENCE";

export const REASON_TEXT: Record<ReasonCode, string> = {
  LEARNER_ASKED_HELP: "you asked for help with the open question",
  LEARNER_SKIPPED: "you skipped the open question",
  LEARNER_ASKED_ANSWER: "you asked to see the answer",
  LEARNER_MOVED_ON: "you asked to move on",
  OPEN_QUESTION_WAITING: "the open question is still waiting for an answer",
  ANSWER_TO_CHECK: "you answered the open question",
  AMBIGUOUS_ANSWER: "the last answer could not be judged yet",
  SUSPECTED_MISCONCEPTION: "a suspected misconception needs a question that tells it apart",
  CONFIRMED_MISCONCEPTION: "a confirmed misconception showed in the answer",
  MISCONCEPTION_STILL_OPEN: "a confirmed misconception on this concept is still open",
  FIND_FAILED_STEP: "the last answer was wrong and its cause is not known yet",
  FLAWED_METHOD: "the result was right but the method was flawed",
  RESULT_WITHOUT_METHOD: "the result was right but no method was shown",
  HEDGED_CORRECT: "the answer was right but given as a guess",
  JUSTIFIED: "the answer was right and justified",
  HELPED_SUCCESS: "the answer was right with help, so a fresh one comes without",
  AFTER_WORKED_SOLUTION: "the answer was shown, so a fresh problem follows",
  NO_EVIDENCE: "there is no marked answer on this concept yet",
};

export interface MoveDecision {
  move: Move;
  reason: ReasonCode;
  /** Attempt ids and misconception ids behind the choice. */
  evidence: string[];
  /** The misconception a question is aimed at, or set to tell apart. */
  misconception: { id: string; description: string; status: Misconception["status"] } | null;
  /** For a hint: which step of the ladder (1 point to the step, 2 conceptual hint, 3 one step worked, 4 full explanation). */
  hintStage?: number;
  /** For a probe: the step to aim at, when the earliest error is known. */
  step?: string;
  /** When the learner has just answered: the follow-up for each kind of mark, decided by code. */
  branches?: Branch[];
  /** The learner asked something with no question open: answer it first, briefly. */
  answerFirst?: boolean;
}

export interface Branch {
  /** When this branch applies, in words for the model. */
  when: string;
  move: Move;
  reason: ReasonCode;
  misconception?: string;
}

export interface MoveInput {
  intent: Intent;
  /** A question is open. */
  pending: boolean;
  /** The concept in focus (stable id). */
  concept: string;
  /** Every attempt on record for the topic; the latest countable one on the concept is the evidence. */
  attempts: Attempt[];
  /** Active misconceptions on the concept, confirmed first (misconceptions.onConcept). */
  misconceptions: Misconception[];
  /** What the open (or last) question was asked under, and what it was aimed at. */
  askedUnder: string;
  targets: string;
  discriminates: string;
  /** Help already given for the open question, for the hint ladder. */
  helpGiven: number;
}

/** An answer that hedges: a guess, or two answers at once. Read in code, so a hedge is never mistaken for a reason. */
export function hedged(answer: string): boolean {
  return /\b(i guess(ed)?|just guess(ed|ing)?|not sure|no idea why|maybe|probably|i think it'?s|might be|could be)\b/i.test(answer) || /\b[A-E]\s+or\s+[A-E]\b/.test(answer);
}

const misc = (m: Misconception | undefined) => (m ? { id: m.id, description: m.description, status: m.status } : null);

/**
 * The move after one marked answer. Code's rule, applied in this order:
 *   1. an answer that could not be judged, or work too incomplete to judge, is probed;
 *   2. a wrong answer showing a confirmed misconception addresses it; a suspected one is told apart;
 *   3. any other wrong answer is probed at its earliest failed step;
 *   4. a right answer leaves a confirmed misconception it was not aimed at still open: it is addressed;
 *   5. a right answer with a flawed or missing method, or given as a guess, asks for the justification
 *      (unless the question already asked for one);
 *   6. a right answer with help, or a justified one, is followed by a fresh application.
 */
export function afterMark(a: Attempt, ms: Misconception[], ctx: { askedUnder: string; targets: string; discriminates: string; pattern?: string }): MoveDecision {
  const r = a.reasoning;
  const confirmed = ms.filter((m) => m.status === "confirmed");
  const shown = ctx.pattern ? ms.find((m) => m.id === ctx.pattern) : undefined;
  if (a.result === "ungraded" || a.verification === "disputed" || r?.certainty === "uncheckable" || (r && r.result.verdict === "unclear")) return { move: "probe", reason: "AMBIGUOUS_ANSWER", evidence: [a.id], misconception: null };
  if (a.result === "skipped") return { move: "fresh-application", reason: "AFTER_WORKED_SOLUTION", evidence: [a.id], misconception: null };
  if (a.result === "incorrect" || a.result === "partial") {
    if (shown?.status === "confirmed") return { move: "address-misconception", reason: "CONFIRMED_MISCONCEPTION", evidence: [a.id, ...shown.evidence.filter((x) => x !== a.id)].slice(0, 4), misconception: misc(shown) };
    if (shown) return { move: "probe", reason: "SUSPECTED_MISCONCEPTION", evidence: [a.id, shown.id], misconception: misc(shown) };
    return { move: "probe", reason: "FIND_FAILED_STEP", evidence: [a.id], misconception: null, ...(r?.earliestError ? { step: r.earliestError.step } : {}) };
  }
  // A right answer.
  const open = confirmed.find((m) => m.id !== ctx.targets && m.id !== ctx.discriminates);
  if (open) return { move: "address-misconception", reason: "MISCONCEPTION_STILL_OPEN", evidence: [a.id, ...open.evidence].slice(0, 4), misconception: misc(open) };
  const justifying = ctx.askedUnder === "ask-justification";
  if (!justifying && r?.method.verdict === "flawed") return { move: "ask-justification", reason: "FLAWED_METHOD", evidence: [a.id], misconception: null };
  if (!justifying && !a.assisted && hedged(a.answer)) return { move: "ask-justification", reason: "HEDGED_CORRECT", evidence: [a.id], misconception: null };
  if (!justifying && !a.assisted && r && (r.method.verdict === "missing" || r.method.verdict === "unclear")) return { move: "ask-justification", reason: "RESULT_WITHOUT_METHOD", evidence: [a.id], misconception: null };
  if (a.assisted || a.answerExposed) return { move: "fresh-application", reason: "HELPED_SUCCESS", evidence: [a.id], misconception: null };
  return { move: "fresh-application", reason: "JUSTIFIED", evidence: [a.id], misconception: null };
}

/** The latest attempt on the concept that can count as evidence, and the latest one of any kind (it may have been disputed). */
function latest(attempts: Attempt[], concept: string): { usable: Attempt | null; any: Attempt | null } {
  const mine = attempts.filter((a) => a.concept === concept).sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  // A disputed answer is passed over: the one before it is the evidence that stands.
  const usable = (a: Attempt): boolean => a.result === "ungraded" || a.result === "skipped" || countable(a);
  return { usable: [...mine].reverse().find(usable) ?? null, any: mine[mine.length - 1] ?? null };
}

/** The follow-ups an answer can lead to, decided before it is marked, for the model to pick from by its mark. */
export function branches(ms: Misconception[], askedUnder: string, targets: string, discriminates: string): Branch[] {
  const out: Branch[] = [{ when: "you cannot tell whether it is right, or the work is too incomplete to judge", move: "probe", reason: "AMBIGUOUS_ANSWER" }];
  for (const m of ms.slice(0, 3)) {
    if (m.status === "confirmed") out.push({ when: `wrong, and it shows "${m.description}"`, move: "address-misconception", reason: "CONFIRMED_MISCONCEPTION", misconception: m.id });
    else out.push({ when: `wrong, and it may show "${m.description}"`, move: "probe", reason: "SUSPECTED_MISCONCEPTION", misconception: m.id });
  }
  out.push({ when: "wrong in another way", move: "probe", reason: "FIND_FAILED_STEP" });
  const open = ms.find((m) => m.status === "confirmed" && m.id !== targets && m.id !== discriminates);
  if (open) out.push({ when: `right, though "${open.description}" is still open`, move: "address-misconception", reason: "MISCONCEPTION_STILL_OPEN", misconception: open.id });
  else {
    if (askedUnder !== "ask-justification") {
      out.push({ when: "right, but the method is flawed", move: "ask-justification", reason: "FLAWED_METHOD" });
      out.push({ when: "right, but no method is shown, or it reads as a guess", move: "ask-justification", reason: "RESULT_WITHOUT_METHOD" });
    }
    out.push({ when: askedUnder === "ask-justification" ? "right and the justification holds" : "right and justified", move: "fresh-application", reason: "JUSTIFIED" });
  }
  return out;
}

/**
 * The move for this turn. A request from the learner is honoured first; an answer is checked and
 * the follow-up decided by its mark; otherwise the latest evidence on the concept decides.
 */
export function chooseMove(p: MoveInput): MoveDecision {
  const ms = p.misconceptions;
  const target = ms.find((m) => m.status === "confirmed") ?? null;
  if (p.pending) {
    if (p.intent === "hint") return { move: "hint", reason: "LEARNER_ASKED_HELP", evidence: target ? [target.id] : [], misconception: misc(target ?? undefined), hintStage: Math.min(4, p.helpGiven + 1) };
    if (p.intent === "skip") return { move: "worked-solution", reason: "LEARNER_SKIPPED", evidence: [], misconception: null };
    if (p.intent === "reveal") return { move: "worked-solution", reason: "LEARNER_ASKED_ANSWER", evidence: [], misconception: null };
    if (p.intent === "attempt") return { move: "check", reason: "ANSWER_TO_CHECK", evidence: [], misconception: null, branches: branches(ms, p.askedUnder, p.targets, p.discriminates) };
    if (p.intent !== "switch") return { move: "continue", reason: "OPEN_QUESTION_WAITING", evidence: [], misconception: null };
  }
  if (p.intent === "switch") return { move: "fresh-application", reason: "LEARNER_MOVED_ON", evidence: [], misconception: null };
  const { usable } = latest(p.attempts, p.concept);
  // With no usable evidence, a suspected misconception is told apart before anything is assumed.
  const first = p.intent === "question" ? { answerFirst: true } : {};
  if (!usable) {
    const suspect = ms.find((m) => m.status === "suspected");
    if (suspect) return { move: "probe", reason: "SUSPECTED_MISCONCEPTION", evidence: [suspect.id], misconception: misc(suspect), ...first };
    if (target) return { move: "address-misconception", reason: "CONFIRMED_MISCONCEPTION", evidence: [target.id, ...target.evidence].slice(0, 4), misconception: misc(target), ...first };
    return { move: "fresh-application", reason: "NO_EVIDENCE", evidence: [], misconception: null, ...first };
  }
  const pattern = ms.find((m) => m.evidence.includes(usable.id))?.id;
  const d = afterMark(usable, ms, { askedUnder: p.askedUnder, targets: p.targets, discriminates: p.discriminates, pattern });
  return p.intent === "question" ? { ...d, answerFirst: true } : d;
}

const HINT_STEPS = ["point to the step that is going wrong, without giving the answer", "give a conceptual hint about that step", "show that one step worked, and nothing after it", "explain fully, then ask a fresh question on the same idea to be answered without help"];

/** What the model is told about the move: the action, its reason code, the evidence ids, and the follow-up branches. */
export function moveBrief(d: MoveDecision): string {
  const ev = d.evidence.length ? ` Evidence: ${d.evidence.join(", ")}.` : "";
  const m = d.misconception ? ` Misconception ${d.misconception.id} (${d.misconception.status}): "${d.misconception.description}".` : "";
  const head = `Tutor move: ${d.move} [${d.reason}].${ev}${m}${d.answerFirst ? "\nFirst answer what the learner asked, briefly; then make this move." : ""}`;
  switch (d.move) {
    case "hint": {
      const k = d.hintStage ?? 1;
      return `${head}\nGive hint ${k} of 4: ${HINT_STEPS[k - 1]}.${d.misconception?.status === "confirmed" ? ` Aim it at the confirmed pattern: show where "${d.misconception.description}" leads astray here.` : ""} Keep the open question open.`;
    }
    case "worked-solution":
      return `${head}\nShow the answer to the open question worked step by step, then ask one fresh question on the same idea, in a different representation, to be answered without help.`;
    case "continue":
      return `${head}\nAnswer what the learner asked, briefly, and keep the open question open.`;
    case "check": {
      const lines = (d.branches ?? []).map((b) => `- ${b.when} → ${b.move} [${b.reason}]${b.misconception ? ` (${b.misconception})` : ""}`);
      return `${head}\nCheck the answer step by step and say plainly whether it is right. Then ask exactly one question, chosen by what you found:\n${lines.join("\n")}\nAdd "next_move" (the move you chose) to the attempt line, and "misconception" (an id above, or a short new description) when a wrong answer shows one.`;
    }
    case "probe":
      return `${head}\n${d.reason === "SUSPECTED_MISCONCEPTION" ? "Ask one question whose answer tells the suspected misconception apart from other causes: someone holding it would answer differently from someone who does not. Give no hint." : d.step ? `Ask one narrower question about this step: "${d.step}". Give no answer.` : "Ask one narrower question that finds which step failed, or what the learner meant. Give no answer."}`;
    case "address-misconception":
      return `${head}\nSet one question where the misconception gives a visibly wrong result, so the learner meets the conflict themselves. Do not explain it first.`;
    case "ask-justification":
      return `${head}\nAsk the learner to justify the result: why each step holds, or why the method is valid${d.reason === "FLAWED_METHOD" ? ", aimed at the flawed step" : ""}. Not "are you sure?".`;
    case "fresh-application":
      return `${head}\nSet one fresh problem on this concept that has not appeared before. Give no hint, example or method first.`;
  }
}

/** The move as one line in Details. */
export function moveLine(d: MoveDecision): string {
  return `Tutor move: ${d.move} (${d.reason}: ${REASON_TEXT[d.reason]})${d.evidence.length ? ` · evidence ${d.evidence.join(", ")}` : ""}${d.misconception ? ` · ${d.misconception.status} misconception "${d.misconception.description}"` : ""}`;
}
