// The course package: the reusable, versioned form of a compiled topic. It is built in plain
// code from the compiled topic card and question bank, and says what covers each objective,
// which questions belong together, how open answers are marked, where every claim came from,
// and which concepts could use an interactive (eligibility only: nothing is generated until a
// study turn asks for it). Source notes are fingerprinted, so a later refresh recompiles only
// the subskills whose notes changed. Pure functions, no Obsidian imports.

import type { Question, Topic } from "./formats";

export const PACKAGE_VERSION = 1;

export interface PackageObjective {
  id: string;
  text: string;
  source: string;
  /** Subskills that teach it, and the bank questions that assess it. */
  subskills: number[];
  questions: string[];
  covered: boolean;
}

export interface PackageLesson {
  n: number;
  concept: string;
  name: string;
  /** The compiled concise worked example. Empty on cards from before 0.6. */
  worked: string;
  /** Notes and links the subskill cites. */
  citations: string[];
  objectives: string[];
  visual: { kind: string; reason: string } | null;
  questions: number;
}

export interface QuestionFamily {
  id: string;
  subskill: number;
  task: string;
  questions: string[];
  /** Kept for assessment: practice from the bank does not use it, so it stays fresh. */
  reserved: boolean;
  /** The compiler gave no family, so one was made from the subskill and task. */
  derived: boolean;
}

export interface CoursePackage {
  format: "study-tutor-course";
  version: number;
  /** Goes up by one at every compile or refresh of this topic. */
  revision: number;
  topic: string;
  compiledAt: string;
  mode: string;
  research: boolean;
  /** Where the objectives came from: the card's Objectives section, or one per subskill. */
  objectivesFrom: "card" | "subskills";
  objectives: PackageObjective[];
  lessons: PackageLesson[];
  families: QuestionFamily[];
  rubrics: { question: string; rubric: string }[];
  citations: string[];
  /** Fingerprint of each source note's text when it was last compiled. */
  sources: Record<string, string>;
  coverage: { objectives: number; covered: number; missing: string[]; subskillsWithoutQuestions: number[]; lessonsWithoutWorked: number[]; complete: boolean };
  refreshed: { at: string; subskills: number[]; notes: string[] }[];
}

const linkName = (l: string): string => l.replace(/^\[\[|\]\]$/g, "").split(/[|#]/)[0].trim();

function citationsIn(text: string): string[] {
  const notes = [...text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map((m) => `[[${m[1].trim()}]]`);
  const links = [...text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]);
  return [...new Set([...notes, ...links])];
}

export function buildPackage(p: { topic: Topic; questions: Question[]; concepts: Record<number, string>; sources: Record<string, string>; previous: CoursePackage | null; at: string; mode: string; research: boolean; refreshed?: { subskills: number[]; notes: string[] } }): CoursePackage {
  const { topic, questions } = p;
  const bySkill = (n: number) => questions.filter((q) => q.subskill === n);
  const lessons: PackageLesson[] = topic.subskills.map((s) => ({ n: s.n, concept: p.concepts[s.n] ?? "", name: s.name, worked: s.worked ?? "", citations: citationsIn(s.section), objectives: s.objectives ?? [], visual: s.visual ?? null, questions: bySkill(s.n).length }));

  const fromCard = (topic.objectives ?? []).length > 0;
  const objectives: PackageObjective[] = fromCard
    ? topic.objectives!.map((o) => {
        const subskills = topic.subskills.filter((s) => (s.objectives ?? []).some((x) => x.toLowerCase() === o.id.toLowerCase())).map((s) => s.n);
        const qs = questions.filter((q) => subskills.includes(q.subskill)).map((q) => q.id);
        return { id: o.id, text: o.text, source: o.source, subskills, questions: qs, covered: subskills.length > 0 && qs.length > 0 };
      })
    : topic.subskills.map((s) => ({ id: `S${s.n}`, text: s.name, source: "subskill", subskills: [s.n], questions: bySkill(s.n).map((q) => q.id), covered: bySkill(s.n).length > 0 }));

  const groups = new Map<string, QuestionFamily>();
  for (const q of questions) {
    const derived = !q.family;
    const id = q.family || `s${q.subskill}-${q.task ?? q.type}`;
    const f = groups.get(id) ?? { id, subskill: q.subskill, task: q.task ?? "", questions: [], reserved: false, derived };
    f.questions.push(q.id);
    groups.set(id, f);
  }
  const families = [...groups.values()];
  for (const s of topic.subskills) {
    const mine = families.filter((f) => f.subskill === s.n);
    const transfer = mine.filter((f) => f.task === "transfer");
    // Fresh families are kept for assessment: the transfer ones, or else the last family of a
    // subskill that has at least three.
    if (transfer.length) transfer.forEach((f) => (f.reserved = true));
    else if (mine.length >= 3 && !mine[mine.length - 1].derived) mine[mine.length - 1].reserved = true;
  }

  const missing = objectives.filter((o) => !o.covered).map((o) => o.id);
  const withoutQ = lessons.filter((l) => l.questions === 0).map((l) => l.n);
  const withoutWorked = lessons.filter((l) => !l.worked).map((l) => l.n);
  return {
    format: "study-tutor-course",
    version: PACKAGE_VERSION,
    revision: (p.previous?.revision ?? 0) + 1,
    topic: topic.title,
    compiledAt: p.refreshed ? p.previous?.compiledAt ?? p.at : p.at,
    mode: p.mode,
    research: p.research,
    objectivesFrom: fromCard ? "card" : "subskills",
    objectives,
    lessons,
    families,
    rubrics: questions.filter((q) => q.rubric).map((q) => ({ question: q.id, rubric: q.rubric! })),
    citations: citationsIn(topic.body),
    sources: { ...p.sources },
    coverage: { objectives: objectives.length, covered: objectives.length - missing.length, missing, subskillsWithoutQuestions: withoutQ, lessonsWithoutWorked: withoutWorked, complete: !missing.length && !withoutQ.length && !withoutWorked.length },
    refreshed: [...(p.previous?.refreshed ?? []), ...(p.refreshed ? [{ at: p.at, ...p.refreshed }] : [])].slice(-20),
  };
}

/** One line on coverage, for the compile notice and the topic page. */
export function coverageLine(pkg: CoursePackage): string {
  const c = pkg.coverage;
  const parts = [`${c.covered} of ${c.objectives} ${pkg.objectivesFrom === "card" ? "objectives" : "subskills"} covered by lessons and questions`];
  if (c.missing.length) parts.push(`not covered: ${c.missing.join(", ")}`);
  if (c.subskillsWithoutQuestions.length) parts.push(`no questions for subskill ${c.subskillsWithoutQuestions.join(", ")}`);
  if (c.lessonsWithoutWorked.length) parts.push(`no worked example for subskill ${c.lessonsWithoutWorked.join(", ")}`);
  return parts.join("; ") + (c.complete ? "." : ". The package is not complete.");
}

export interface SourceChange {
  /** Notes whose text changed, or that are gone. */
  changed: string[];
  removed: string[];
  /** Notes not used before. */
  added: string[];
  /** Subskills that cite a changed or removed note. */
  subskills: number[];
}

/** Which notes changed since the package was built, and which subskills they reach. */
export function sourceChanges(pkg: CoursePackage, now: Record<string, string>): SourceChange {
  const changed = Object.keys(now).filter((k) => k in pkg.sources && pkg.sources[k] !== now[k]);
  const removed = Object.keys(pkg.sources).filter((k) => !(k in now));
  const added = Object.keys(now).filter((k) => !(k in pkg.sources));
  const touched = new Set([...changed, ...removed].map((k) => k.toLowerCase()));
  const subskills = pkg.lessons.filter((l) => l.citations.some((c) => touched.has(linkName(c).toLowerCase()))).map((l) => l.n);
  return { changed, removed, added, subskills };
}

/** The "### n. name" sections of a topic body, by number, as written. */
export function subskillSections(body: string): Map<number, string> {
  const out = new Map<number, string>();
  const re = /^###\s+(\d+)\s*[.):-]?\s+.+$/gm;
  const heads: { n: number; start: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) heads.push({ n: Number(m[1]), start: m.index });
  heads.forEach((h, i) => {
    let end = i + 1 < heads.length ? heads[i + 1].start : body.length;
    const cut = /^##\s+\S/m.exec(body.slice(h.start + 4, end));
    if (cut) end = h.start + 4 + cut.index;
    out.set(h.n, body.slice(h.start, end).trimEnd());
  });
  return out;
}

/**
 * Puts refreshed subskill sections and their questions into the existing card and bank. Only the
 * listed subskills change; the others are kept byte for byte. New questions take fresh ids after
 * the highest existing one, so no id is reused for a different question.
 */
export function mergeRefresh(p: { topicBody: string; questionsBody: string; sections: Map<number, string>; questions: string; subskills: number[] }): { topicBody: string; questionsBody: string; replaced: number[] } {
  const old = subskillSections(p.topicBody);
  let body = p.topicBody;
  const replaced: number[] = [];
  for (const n of p.subskills) {
    const was = old.get(n);
    const now = p.sections.get(n);
    if (!was || !now) continue;
    body = body.replace(was, now.trim());
    replaced.push(n);
  }
  // Questions: drop those on replaced subskills, append the new ones renumbered.
  const blocks = p.questionsBody.split(/^(?=#{2,4}\s+\**Q\d+\**[.:]?[ \t]*$)/m);
  const head = blocks[0] && !/^#{2,4}\s+\**Q\d+/.test(blocks[0]) ? blocks.shift()! : "";
  const kept = blocks.filter((b) => {
    const m = /^\s*(?:[-*]\s+)?\**subskill\**\s*:\**\s*(\d+)/im.exec(b);
    return !(m && replaced.includes(Number(m[1])));
  });
  let next = Math.max(0, ...blocks.map((b) => Number(/Q(\d+)/.exec(b)?.[1] ?? 0))) + 1;
  const added = p.questions
    .split(/^(?=#{2,4}\s+\**Q\d+\**[.:]?[ \t]*$)/m)
    .filter((b) => /^#{2,4}\s+\**Q\d+/.test(b))
    .filter((b) => {
      const m = /^\s*(?:[-*]\s+)?\**subskill\**\s*:\**\s*(\d+)/im.exec(b);
      return !!m && replaced.includes(Number(m[1]));
    })
    .map((b) => b.replace(/^(#{2,4}\s+\**)Q\d+/, `$1Q${next++}`));
  const questionsBody = [head.trimEnd(), ...kept.map((b) => b.trimEnd()), ...added.map((b) => b.trimEnd())].filter(Boolean).join("\n\n");
  return { topicBody: body, questionsBody, replaced };
}
