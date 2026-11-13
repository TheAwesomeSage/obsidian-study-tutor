export interface Attempt {
  id: string;
  skill: number;
  question: string;
  answer: string;
  timestamp: string;
  mode: string;
  result: "correct" | "partial" | "incorrect" | "ungraded";
  confidence: number | null;
  assisted: boolean;
  transfer: boolean;
  source: "model" | "bank" | "self";
  error: string;
}

export function skillEvidence(attempts: Attempt[], skill: number) {
  const graded = attempts.filter(a => a.skill === skill && a.result !== "ungraded");
  const independent = graded.filter(a => !a.assisted && a.source !== "self");
  const unique = [...new Map(independent.map(a => [a.question, a])).values()];
  const correct = unique.filter(a => a.result === "correct");
  const days = new Set(correct.map(a => a.timestamp.slice(0, 10)));
  const calibrated = independent.filter(a => a.confidence !== null);
  return {
    count: unique.length,
    correct: correct.length,
    estimate: unique.length ? (correct.length + 1) / (unique.length + 2) : null,
    last: graded[graded.length - 1]?.timestamp ?? null,
    delayedTransfer: days.size >= 2 && correct.some(a => a.transfer && a.timestamp.slice(0, 10) > correct[0].timestamp.slice(0, 10)),
    brier: calibrated.length ? calibrated.reduce((sum, a) => sum + ((a.confidence! - (a.result === "correct" ? 1 : 0)) ** 2), 0) / calibrated.length : null,
  };
}

export function recordAttempt(attempts: Attempt[], attempt: Attempt): Attempt[] {
  const next = attempts.filter(a => a.id !== attempt.id);
  next.push(attempt);
  return next;
}

export const EVIDENCE_RULES = `If grading an actual learner attempt, add <attempt>{"skill":1,"result":"correct|partial|incorrect|ungraded","assisted":true,"transfer":false,"error":"specific error or empty"}</attempt>.
Use ungraded when uncertain. Assisted is true if hints, an example solution or the answer have helped with this question. Transfer is true only for a fresh application. Never treat a request, agreement or explanation you supplied as a learner performance. The app enforces promotion eligibility from recorded attempts.`;
