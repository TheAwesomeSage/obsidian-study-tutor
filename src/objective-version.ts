// Objective versions: which version of an objective an attempt assessed, and whether a recompile
// changed what the objective asks for. A version goes up only on a material change (a number, a
// condition, a negation or quantifier, an added or removed requirement, a corrected source). An
// editorial edit (spacing, case, punctuation, Markdown, a typo, a filler word) keeps the version,
// so mastery is never reset by tidying a note. A material change does not reset mastery either:
// earlier attempts stay on record, and the concept gets a focused recheck (evidence.ts).
//
// The classification is plain code over normalised text, deliberately conservative: when in doubt
// a change is material, which costs one recheck question, never lost evidence.
// Pure functions, no Obsidian imports.

import type { Attempt } from "./evidence";
import type { CoursePackage } from "./coursepkg";

export interface ObjectiveVersion {
  id: string;
  /** Goes up by one at each material change. Starts at 1. */
  v: number;
  /** Digest of the material text last compiled for it (editorial edits update this, not `v`). */
  fingerprint: string;
  /** When `v` last went up, or when the objective was added to a course that already existed. Absent on a first compile. */
  materialAt?: string;
  /** Why, in a short phrase. */
  why?: string;
  /** Ids the same objective had in earlier compiles. */
  aliases?: string[];
  subskills: number[];
  /** Source passage ids or note names the version was compiled from. */
  sources: string[];
}

/** Per subskill: the objective versions it teaches now, and its latest material change. */
export interface ConceptRevision {
  refs: string[];
  at?: string;
  why?: string;
}

/** An objective at a version, as attempts and concepts record it. */
export const formatRef = (id: string, v: number): string => `${id}@${v}`;
export function parseRef(r: string): [string, number] {
  const i = r.lastIndexOf("@");
  return [r.slice(0, i), Number(r.slice(i + 1))];
}

/** Longest material text kept for comparing with the next compile. Longer text is compared by digest alone. */
export const MAX_MATERIAL = 20000;

/** Text reduced to what can change its meaning: links, emphasis, quotes and most punctuation go; numbers, symbols and words stay. */
export function materialText(parts: string[]): string {
  return parts
    .join("\n")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~#>$]+/g, " ")
    .replace(/["'‘’“”«»]/g, " ")
    .replace(/[,;:!?()[\]{}]/g, " ")
    .replace(/(?<!\d)\.|\.(?!\d)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const FILLER = new Set("the a an of to in on for by is are be being been this that these those its it as at from which".split(" "));
/** Words whose change alters a requirement: negation, quantity, modality, connectives, conditions. */
const SIGNIFICANT = new Set("not no never none nor all every each some any only must may might can cannot should shall unless except without and or if when while iff least most more less fewer greater smaller above below before after first last both either neither increase increases decrease decreases".split(" "));
const CONDITION = /^(assum\w*|condition\w*|domain|provided|non-?zero|positive|negative|continuous|differentiable|converg\w*|bounded|sorted|independent|finite|defined|restrict\w*|valid)$/;
const significant = (t: string): boolean => /\d/.test(t) || /^[=<>≤≥≠±^/*+-]+$/.test(t) || SIGNIFICANT.has(t) || CONDITION.test(t);

function levenshtein(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/** The token hunks that differ between two sequences, from a longest-common-subsequence diff. */
function hunks(a: string[], b: string[]): { removed: string[]; added: string[] }[] {
  const n = a.length, m = b.length;
  // Common prefix and suffix first: most edits are local, and this keeps the table small.
  let lo = 0;
  while (lo < n && lo < m && a[lo] === b[lo]) lo++;
  let hiA = n, hiB = m;
  while (hiA > lo && hiB > lo && a[hiA - 1] === b[hiB - 1]) { hiA--; hiB--; }
  const A = a.slice(lo, hiA), B = b.slice(lo, hiB);
  if (A.length * B.length > 4_000_000) return [{ removed: A, added: B }];
  const t: number[][] = Array.from({ length: A.length + 1 }, () => new Array<number>(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) t[i][j] = A[i] === B[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const out: { removed: string[]; added: string[] }[] = [];
  let cur = { removed: [] as string[], added: [] as string[] };
  const flush = () => {
    if (cur.removed.length || cur.added.length) out.push(cur);
    cur = { removed: [], added: [] };
  };
  let i = 0, j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) {
      flush();
      i++;
      j++;
    } else if (j < B.length && (i === A.length || t[i][j + 1] >= t[i + 1][j])) cur.added.push(B[j++]);
    else cur.removed.push(A[i++]);
  }
  flush();
  return out;
}

const quote = (ts: string[]) => `"${ts.join(" ").slice(0, 60)}"`;
const describe = (removed: string[], added: string[]) => (!removed.length ? `added ${quote(added)}` : !added.length ? `removed ${quote(removed)}` : `${quote(removed)} became ${quote(added)}`);

/**
 * Whether a change of material text is editorial or material. Both arguments are `materialText`
 * output. A hunk is editorial when it only adds or drops filler words, or swaps words one for one
 * with a typo-sized difference and no significant word among them. Anything else is material.
 */
export function classifyChange(prev: string, next: string): { change: "same" | "editorial" | "material"; why: string } {
  if (prev === next) return { change: "same", why: "" };
  const a = prev ? prev.split(" ") : [], b = next ? next.split(" ") : [];
  for (const h of hunks(a, b)) {
    const all = [...h.removed, ...h.added];
    if (all.every((t) => FILLER.has(t))) continue;
    if (all.some(significant)) return { change: "material", why: describe(h.removed, h.added) };
    const content = (ts: string[]) => ts.filter((t) => !FILLER.has(t));
    const r = content(h.removed), d = content(h.added);
    const typos = r.length === d.length && r.every((t, k) => t.length >= 4 && d[k].length >= 4 && levenshtein(t, d[k]) <= 2);
    if (typos) continue;
    return { change: "material", why: describe(r, d) };
  }
  return { change: "editorial", why: "wording only" };
}

export interface CurrentObjective {
  id: string;
  subskills: number[];
  sources: string[];
  /** `materialText` of the objective and the evidence it was compiled from. */
  material: string;
  fingerprint: string;
}

/**
 * Versions for this compile's objectives, given the previous compile's. Objectives are matched by
 * id, then by identical material, then by an editorial-only difference on overlapping subskills
 * (staged objective ids follow passage positions, which move when a note is edited above them).
 * `previousText` returns the stored material text of a previous fingerprint, or null when it is
 * not available; an unavailable or over-long text counts as a material change.
 */
export function versionObjectives(p: { previous: ObjectiveVersion[] | null; current: CurrentObjective[]; at: string; previousText: (fingerprint: string) => string | null }): ObjectiveVersion[] {
  const prev = p.previous ?? [];
  const taken = new Set<ObjectiveVersion>();
  const matched = new Map<string, ObjectiveVersion>();
  // Each pass matches what the earlier ones left, from the surest test to the loosest.
  const pass = (same: (o: ObjectiveVersion, c: CurrentObjective) => boolean) => {
    for (const c of p.current) {
      if (matched.has(c.id)) continue;
      const o = prev.find((x) => !taken.has(x) && same(x, c));
      if (o) (matched.set(c.id, o), taken.add(o));
    }
  };
  pass((o, c) => o.id === c.id || !!o.aliases?.includes(c.id));
  pass((o, c) => o.fingerprint === c.fingerprint);
  pass((o, c) => {
    const text = p.previousText(o.fingerprint);
    const overlap = !o.subskills.length || !c.subskills.length || o.subskills.some((n) => c.subskills.includes(n));
    return overlap && text !== null && classifyChange(text, c.material).change === "editorial";
  });
  return p.current.map((c) => {
    const old = matched.get(c.id);
    const base = { id: c.id, fingerprint: c.fingerprint, subskills: [...c.subskills], sources: [...c.sources] };
    const aliases = old ? [...new Set([...(old.aliases ?? []), ...(old.id !== c.id ? [old.id] : [])])].filter((x) => x !== c.id).slice(-6) : [];
    const keep = { ...(old?.materialAt ? { materialAt: old.materialAt, why: old.why } : {}), ...(aliases.length ? { aliases } : {}) };
    if (!old) return p.previous ? { ...base, v: 1, materialAt: p.at, why: "a new objective was added" } : { ...base, v: 1 };
    const text = old.fingerprint === c.fingerprint ? null : p.previousText(old.fingerprint);
    const verdict = old.fingerprint === c.fingerprint ? { change: "same" as const, why: "" } : text === null ? { change: "material" as const, why: "the earlier text is not available to compare" } : classifyChange(text, c.material);
    if (verdict.change !== "material") return { ...base, v: old.v, ...keep };
    return { ...base, v: old.v + 1, materialAt: p.at, why: verdict.why, ...(aliases.length ? { aliases } : {}) };
  });
}

/** By subskill: the current objective refs ("id@v") and the latest material change among them. */
export function conceptRevisions(versions: ObjectiveVersion[]): Record<number, ConceptRevision> {
  const out: Record<number, ConceptRevision> = {};
  for (const o of versions) {
    for (const n of o.subskills) {
      const r = out[n] ?? (out[n] = { refs: [] });
      r.refs.push(formatRef(o.id, o.v));
      if (o.materialAt && (!r.at || o.materialAt > r.at)) {
        r.at = o.materialAt;
        r.why = `${o.id} changed: ${o.why ?? "material change"}`.slice(0, 240);
      }
    }
  }
  return out;
}

/**
 * Whether an attempt assessed the current version of every objective its subskill teaches.
 * Attempts that recorded versions are compared by version; older ones by date.
 */
export function onCurrentVersion(a: Pick<Attempt, "objectives" | "timestamp">, rev: { at: string; refs?: string[] }): boolean {
  if (a.objectives?.length && rev.refs?.length) {
    const had = new Map(a.objectives.map(parseRef));
    return rev.refs.every((r) => {
      const [id, v] = parseRef(r);
      return (had.get(id) ?? -1) >= v;
    });
  }
  return a.timestamp >= rev.at;
}

/** Source → objective → question → attempt: what an attempt assessed, at which version, and what that version stands on. */
export function traceAttempt(pkg: Pick<CoursePackage, "objectives" | "versions">, a: Pick<Attempt, "questionId" | "objectives">): { id: string; assessed: number | null; current: number | null; sources: string[]; questions: string[] }[] {
  const versions = new Map((pkg.versions ?? []).map((v) => [v.id, v]));
  const stamped = new Map((a.objectives ?? []).map(parseRef));
  const ids = stamped.size ? [...stamped.keys()] : pkg.objectives.filter((o) => o.questions.includes(a.questionId)).map((o) => o.id);
  return ids.map((id) => {
    const o = pkg.objectives.find((x) => x.id === id);
    const v = versions.get(id) ?? [...versions.values()].find((x) => x.aliases?.includes(id));
    return { id, assessed: stamped.get(id) ?? null, current: v?.v ?? null, sources: v?.sources ?? (o?.source ? o.source.split(/,\s*/) : []), questions: o?.questions ?? [] };
  });
}
