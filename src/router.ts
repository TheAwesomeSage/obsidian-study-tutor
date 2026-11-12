// Decides, in plain code and before any model is called, how much model a chat turn needs.
//
//   simple   -> the cheap model. Only for short look-up questions asked of the expert.
//   standard -> the chat model at its normal effort.
//   complex  -> the chat model with more thinking, for proofs, derivations, code and maths answers.
//
// The router is deliberately lopsided: a turn is "simple" only when every check agrees, and
// anything doubtful goes up a tier. Sending a hard question to the cheap model costs a wrong
// answer; sending an easy one to the chat model costs a few tokens.

import { Mode, words } from "./formats";

export type Route = "simple" | "standard" | "complex";

export interface RouteDecision {
  route: Route;
  reason: string;
}

/** Work that needs careful reasoning whichever mode it appears in. */
const HARD =
  /\b(prove|proof|proofs|derive|derivation|show that|rigorous(ly)?|justify|induction|contradiction|contrapositive|counter-?examples?|generali[sz]e|edge cases?|corner cases?|debug|optimi[sz]e|time complexity|space complexity|big[- ]o|converges?|convergence|implement|refactor|trace through|step by step|walk me through|from first principles|formally|invariant holds|correctness)\b/i;

const WRITE_CODE = /\bwrite (me )?(a|an|the|some)?\s*(code|function|program|algorithm|class|script|proof)\b/i;

/** The only shapes of question the cheap model is trusted with: asking what something is. */
const LOOKUP =
  /^(what is|what's|what are|what was|define|definition of|give me the definition of|meaning of|what does [^?]{1,60} (mean|stand for)|what is meant by|who (is|was|invented|discovered|proved)|what is the (name|symbol|notation|unit|abbreviation) (of|for)|remind me what)\b/i;

/** Anything here means the question wants reasoning, comparison or working, not a look-up. */
const NOT_LOOKUP =
  /\b(why|how|prove|derive|compare|comparison|differ|difference|different|versus|vs|relate[sd]?|relationship|intuition|intuitively|explain|because|should|best|better|worse|when (would|should|do|does)|instead|rather than|trade-?offs?|example|examples|calculate|compute|solve|evaluate|simplify|find|apply|check|verify|wrong|mistake|error|my (answer|notes|code|solution)|in my|this|these|that|those|it|above|here)\b/i;

const hasCode = (s: string): boolean => /```|^\s{4,}\S|[;{}]\s*$|\b(def|function|class)\s+\w+\s*\(|=>|\breturn\b.*;|\b(for|while|if)\s*\(.*\)\s*[{:]/m.test(s);
const hasMaths = (s: string): boolean => /\$|\\[a-zA-Z]+|[=<>≤≥≠∑∫√^]|\d\s*[-+*/×÷]\s*\d|\b\d+\b/.test(s);
const questionMarks = (s: string): number => (s.match(/\?/g) ?? []).length;

export function routeTurn(p: { mode: Mode; message: string; attached?: boolean }): RouteDecision {
  const msg = p.message.trim();
  const n = words(msg);

  // Opening a chat, or retrying: the model writes a lesson, a plan or a first question.
  if (!msg) return { route: "standard", reason: "opening turn" };

  if (HARD.test(msg) || WRITE_CODE.test(msg)) return { route: "complex", reason: "asks for a proof, derivation or code" };
  if (hasCode(msg)) return { route: "complex", reason: "contains code" };
  if (n > 80) return { route: "complex", reason: "long message" };

  if (p.mode !== "expert") {
    // In the teaching modes the message is an answer to be judged. Judging maths or a long
    // argument wrongly is the costliest mistake the tutor can make, so those get more thinking.
    if (hasMaths(msg)) return { route: "complex", reason: "answer contains maths to check" };
    if (n > 40) return { route: "complex", reason: "long answer to judge" };
    // A question put to the quizzer mid-quiz is answered briefly; a plain look-up can go cheap.
    if (p.mode === "quiz" && isLookup(msg, n, p.attached)) return { route: "simple", reason: "short look-up question" };
    return { route: "standard", reason: "answer to judge" };
  }

  if (isLookup(msg, n, p.attached)) return { route: "simple", reason: "short look-up question" };
  if (hasMaths(msg) && n > 25) return { route: "complex", reason: "worked maths question" };
  return { route: "standard", reason: "explanation" };
}

function isLookup(msg: string, n: number, attached?: boolean): boolean {
  return !attached && n <= 14 && questionMarks(msg) <= 1 && LOOKUP.test(msg) && !NOT_LOOKUP.test(msg) && !hasMaths(msg) && !hasCode(msg) && !/[\n;]/.test(msg);
}
