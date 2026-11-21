import { digest } from "./compile-sources";
import { similarity } from "./course";
import { Q_HEADING, parseQuestions } from "./formats";

/** A probe this similar to a practice question on the same subskill is not unseen work, so it is dropped. */
export const SEAL_SIMILARITY = 0.5;

export interface SealedSection {
  id: string;
  subskill: number;
  /** The question's markdown, with its "### <id>" line rewritten to the sealed id. */
  section: string;
}

/** Stable id for a sealed question, from its text. */
export function sealedId(questionText: string): string {
  return "P" + digest(questionText).slice(0, 10);
}

/**
 * Splits the probe sections out of a compiled questions body. Pure: the caller stores the parts.
 * Non-probe sections stay in `bank` byte for byte and in order. A probe that nearly copies a
 * practice question on its subskill is dropped, not sealed.
 */
export function splitSealed(questionsBody: string): { bank: string; sealed: SealedSection[]; dropped: number } {
  // Cut at the parser's own heading; the id group is made non-capturing so split() adds no extra items.
  const parts = questionsBody.split(new RegExp(`^(?=${Q_HEADING.source.replace("(Q", "(?:Q")})`, "m"));
  const parsed = parts.map((p) => parseQuestions(p)[0]);
  const practice = parsed.filter((q) => q && q.task !== "probe");
  const kept: string[] = [];
  const sealed: SealedSection[] = [];
  let dropped = 0;
  parts.forEach((part, i) => {
    const q = parsed[i];
    if (!q || q.task !== "probe") {
      kept.push(part);
      return;
    }
    if (practice.some((o) => o && o.subskill === q.subskill && similarity(q.question, o.question) >= SEAL_SIMILARITY)) {
      dropped++;
      return;
    }
    const id = sealedId(q.question);
    sealed.push({ id, subskill: q.subskill, section: part.replace(Q_HEADING, `### ${id}`) });
  });
  return { bank: kept.join(""), sealed, dropped };
}

/** How many questions a compiled body leaves in the bank: probes are sealed away and not counted. */
export function bankCount(questionsBody: string): number {
  return parseQuestions(splitSealed(questionsBody).bank).length;
}
