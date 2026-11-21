// Misconceptions as evidence-backed learner state. Each one names a concept, has a stable id, a
// short description, the attempts that show it, and a status:
//
//   suspected  one plausible classification of a marked answer, or a note carried over from before
//              misconceptions had evidence. It can be tested with a question that tells it apart.
//   confirmed  supported: shown again on a different question, or in the answer to a question set
//              to tell it apart. Only a confirmed pattern shapes hints and remediation.
//   resolved   corrected: an unaided correct answer to a question aimed at it, after the evidence.
//
// The transitions are pure functions over saved attempts, so they can be replayed and tested
// without a model. They never touch a level: mastery stays derived from assessments alone.

import { conclusive } from "./grading";
import type { Attempt } from "./evidence";
import { similarity, slug } from "./course";

export type MisconceptionStatus = "suspected" | "confirmed" | "resolved";

export type MisconceptionCause =
  /** A marked answer was classified as showing it. */
  | "classified"
  /** Shown again, on a different question. */
  | "repeated"
  /** Shown in the answer to a question set to tell it apart. */
  | "discriminating-answer"
  /** An unaided correct answer to a question aimed at it. */
  | "unaided-correction"
  /** Shown again after it was resolved. */
  | "relapse"
  /** Some of its evidence was disputed, regraded or removed, and the status was worked out again. */
  | "evidence-withdrawn"
  /** Carried over from a state file written before misconceptions had evidence. */
  | "legacy";

export interface MisconceptionEvent {
  t: string;
  from: MisconceptionStatus | null;
  to: MisconceptionStatus;
  cause: MisconceptionCause;
  attempts: string[];
  note: string;
}

export interface Misconception {
  id: string;
  /** Stable concept id. Empty when unknown (a legacy note). */
  concept: string;
  description: string;
  status: MisconceptionStatus;
  /** Attempts whose answers show the pattern. */
  evidence: string[];
  /** Of those, the ones that answered a question set to tell it apart. */
  discriminating: string[];
  /** Unaided correct attempts that show it corrected. */
  corrections: string[];
  opened: string;
  updated: string;
  history: MisconceptionEvent[];
  /** Recorded before misconceptions carried evidence: kept as a suspicion with nothing behind it. */
  legacy?: boolean;
}

const STATUSES: MisconceptionStatus[] = ["suspected", "confirmed", "resolved"];
const CAUSES: MisconceptionCause[] = ["classified", "repeated", "discriminating-answer", "unaided-correction", "relapse", "evidence-withdrawn", "legacy"];
const MAX_RECORDS = 60;

const strs = (x: unknown, max = 40): string[] => (Array.isArray(x) ? [...new Set(x.filter((i): i is string => typeof i === "string" && !!i.trim()))].slice(-max) : []);

/** Reads one stored record. Returns null for anything that is not one. */
export function parseMisconception(raw: unknown): Misconception | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id || typeof r.description !== "string" || !STATUSES.includes(r.status as MisconceptionStatus)) return null;
  const history = Array.isArray(r.history)
    ? r.history.flatMap((h): MisconceptionEvent[] => {
        if (!h || typeof h !== "object") return [];
        const e = h as Record<string, unknown>;
        if (typeof e.t !== "string" || !STATUSES.includes(e.to as MisconceptionStatus) || !CAUSES.includes(e.cause as MisconceptionCause)) return [];
        return [{ t: e.t, from: STATUSES.includes(e.from as MisconceptionStatus) ? (e.from as MisconceptionStatus) : null, to: e.to as MisconceptionStatus, cause: e.cause as MisconceptionCause, attempts: strs(e.attempts), note: typeof e.note === "string" ? e.note.slice(0, 300) : "" }];
      }).slice(-30)
    : [];
  return {
    id: r.id.slice(0, 120),
    concept: typeof r.concept === "string" ? r.concept : "",
    description: r.description.trim().slice(0, 200),
    status: r.status as MisconceptionStatus,
    evidence: strs(r.evidence),
    discriminating: strs(r.discriminating),
    corrections: strs(r.corrections),
    opened: typeof r.opened === "string" ? r.opened : "",
    updated: typeof r.updated === "string" ? r.updated : "",
    history,
    ...(r.legacy === true ? { legacy: true } : {}),
  };
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** A stable id for a new misconception: the concept's id and the description, made unique. */
export function misconceptionId(concept: string, description: string, taken: Set<string>): string {
  const stem = `${concept || "unplaced"}#${slug(description).slice(0, 40).replace(/-+$/, "")}`;
  let id = stem;
  for (let i = 2; taken.has(id); i++) id = `${stem}-${i}`;
  return id;
}

/** The misconceptions a compiled topic card lists under a subskill ("misconceptions:" lines). */
export function courseMisconceptions(section: string): string[] {
  const m = /^misconceptions:\s*\n((?:\s*[-*]\s+.+\n?)+)/im.exec(section);
  return m ? m[1].split("\n").map((l) => l.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean) : [];
}

/** A classification matches a record when it names its id, or describes the same thing on the same concept. */
function matches(rec: Misconception, concept: string, p: { id?: string; description: string }): boolean {
  if (p.id && p.id === rec.id) return true;
  if (rec.concept && concept && rec.concept !== concept) return false;
  return norm(rec.description) === norm(p.description) || similarity(rec.description, p.description) >= 0.5;
}

/** An attempt that can count as evidence either way: marked, not disputed, not a self-rating, not a cold probe, and a mark its breakdown backs. */
export const countable = (a: Attempt | undefined): a is Attempt => !!a && !a.probe && a.result !== "ungraded" && a.result !== "skipped" && a.verification !== "disputed" && a.grading !== "self" && conclusive(a);
const shows = (a: Attempt | undefined): boolean => countable(a) && (a.result === "incorrect" || a.result === "partial");
const corrects = (a: Attempt | undefined): boolean => countable(a) && a.result === "correct" && !a.assisted && !a.answerExposed;

/** The evidence still standing behind a record, against the attempts as they are now. */
export function standing(rec: Misconception, attempts: Attempt[]): { supports: Attempt[]; discriminating: Attempt[]; corrections: Attempt[] } {
  const by = new Map(attempts.map((a) => [a.id, a]));
  const supports = rec.evidence.map((id) => by.get(id)).filter((a): a is Attempt => shows(a));
  return {
    supports,
    discriminating: rec.discriminating.map((id) => by.get(id)).filter((a): a is Attempt => shows(a)),
    corrections: rec.corrections.map((id) => by.get(id)).filter((a): a is Attempt => corrects(a)),
  };
}

/**
 * Whether the evidence supports a confirmation: the pattern shown in an answer to a question set
 * to tell it apart, or shown on two different questions. Only evidence since the last resolution
 * counts, so a relapse needs its own support.
 */
function confirmable(rec: Misconception, supports: Attempt[], discriminating: Attempt[], skipLastResolution = false): boolean {
  // Resolutions that still stand: a later withdrawal cancels the one before it.
  const resolutions: MisconceptionEvent[] = [];
  for (const h of rec.history) {
    if (h.to === "resolved") resolutions.push(h);
    else if (h.from === "resolved" && h.cause === "evidence-withdrawn") resolutions.pop();
  }
  const since = (skipLastResolution ? resolutions[resolutions.length - 2] : resolutions[resolutions.length - 1])?.t ?? "";
  const fresh = supports.filter((a) => a.timestamp > since);
  return discriminating.some((a) => a.timestamp > since) || new Set(fresh.map((a) => a.questionId)).size >= 2;
}

/** Active means it should shape tutoring now: not resolved, and backed by evidence (or carried over from before evidence was kept). */
export function isActive(rec: Misconception, attempts: Attempt[]): boolean {
  return rec.status !== "resolved" && (!!rec.legacy || standing(rec, attempts).supports.length > 0);
}

/** The descriptions of active misconceptions, newest last: the plain list the rest of the app reads. */
export function activeDescriptions(list: Misconception[], attempts: Attempt[]): string[] {
  return list.filter((m) => isActive(m, attempts)).map((m) => m.description);
}

const move = (rec: Misconception, to: MisconceptionStatus, cause: MisconceptionCause, at: string, ids: string[], note = ""): string => {
  const from = rec.status;
  rec.history = [...rec.history, { t: at, from, to, cause, attempts: ids, note: note.slice(0, 300) }].slice(-30);
  rec.status = to;
  rec.updated = at;
  return `misconception ${to === "suspected" && from === null ? "suspected" : to}: ${rec.description}`;
};

/** What one marked answer says about misconceptions. */
export interface Observation {
  attempt: Attempt;
  /** The tutor's classification of the error, when it named a pattern. */
  pattern?: { id?: string; description: string } | null;
  /** The question was set to tell this misconception apart (its id). */
  discriminates?: string;
  /** The question was aimed at this misconception (its id): remediation of it. */
  targets?: string;
  /** Misconceptions the tutor says no longer show (ids or descriptions). Honoured only with an unaided correct answer. */
  cleared?: string[];
  /** Misconceptions the course lists for this concept, so a match takes the course's stable wording. */
  known?: string[];
}

/**
 * Applies one marked answer. Returns readable lines for what changed, and a note when a request
 * could not be honoured (a clearing without an unaided correct answer).
 *
 *   - A wrong or partly right answer with a plausible classification opens a suspicion, or adds
 *     evidence to a record it matches; with enough support the record is confirmed.
 *   - An answer to a discriminating question that shows the pattern confirms it; one that is right
 *     without help resolves it.
 *   - An unaided correct answer to a question aimed at it (or that the tutor says shows it
 *     corrected), after its evidence, resolves it. Help, a seen answer or a self-rating never do.
 */
export function observe(list: Misconception[], o: Observation, attempts: Attempt[] = []): { list: Misconception[]; changes: string[]; notes: string[] } {
  const out = list.map((m) => ({ ...m, history: [...m.history], evidence: [...m.evidence], discriminating: [...m.discriminating], corrections: [...m.corrections] }));
  const changes: string[] = [];
  const notes: string[] = [];
  const a = o.attempt;
  if (!countable(a)) return { list: out, changes, notes };
  const at = a.timestamp;
  const concept = a.concept;

  if (shows(a)) {
    const target = o.discriminates ? out.find((m) => m.id === o.discriminates) : undefined;
    const pattern = o.pattern && o.pattern.description.trim() ? { ...o.pattern, description: o.pattern.description.trim().slice(0, 200) } : null;
    if (!pattern) {
      // A wrong answer to a discriminating question that the tutor did not classify says nothing either way.
      if (target && target.status !== "resolved") notes.push(`the answer to the question that tells "${target.description}" apart was wrong in another way, so it neither confirms nor clears it`);
      return { list: out, changes, notes };
    }
    const knownMatch = (o.known ?? []).find((k) => norm(k) === norm(pattern.description) || similarity(k, pattern.description) >= 0.5);
    const rec = out.find((m) => matches(m, concept, pattern)) ?? (knownMatch ? out.find((m) => matches(m, concept, { description: knownMatch })) : undefined);
    if (!rec) {
      // A plausible classification opens a suspicion, citing this answer. The course's own wording is used when it lists the same one.
      const description = knownMatch ?? pattern.description;
      const id = pattern.id && pattern.id.startsWith(`${concept}#`) && !out.some((m) => m.id === pattern.id) ? pattern.id : misconceptionId(concept, description, new Set(out.map((m) => m.id)));
      out.push({ id, concept, description, status: "suspected", evidence: [a.id], discriminating: [], corrections: [], opened: at, updated: at, history: [{ t: at, from: null, to: "suspected", cause: "classified", attempts: [a.id], note: knownMatch && norm(knownMatch) !== norm(pattern.description) ? `classified as: ${pattern.description}` : "" }] });
      changes.push(`misconception suspected: ${description}`);
      return { list: out, changes, notes };
    }
    if (!rec.concept && concept) rec.concept = concept;
    if (!rec.evidence.includes(a.id)) rec.evidence.push(a.id);
    if (rec.legacy) delete rec.legacy;
    const discriminating = target?.id === rec.id;
    if (discriminating && !rec.discriminating.includes(a.id)) rec.discriminating.push(a.id);
    rec.updated = at;
    if (rec.status === "resolved") changes.push(move(rec, "suspected", "relapse", at, [a.id]));
    // Shown in the answer to a question set to tell it apart: that is the support a confirmation needs.
    // A repeat on another question is confirmed by recompute(), which reads every cited answer as it stands.
    if (discriminating && rec.status === "suspected") changes.push(move(rec, "confirmed", "discriminating-answer", at, [a.id]));
    return { list: out, changes, notes };
  }

  // A correct answer.
  if (!corrects(a)) {
    if ((o.cleared ?? []).length || o.targets || o.discriminates) notes.push("a correct answer given with help, or after the answer was seen, does not resolve a misconception");
    return { list: out, changes, notes };
  }
  const named = new Set((o.cleared ?? []).map(norm));
  const all = attempts.some((x) => x.id === a.id) ? attempts : [...attempts, a];
  for (const rec of out) {
    if (rec.status === "resolved" || (rec.concept && rec.concept !== concept)) continue;
    const aimed = rec.id === o.targets || rec.id === o.discriminates || named.has(norm(rec.id)) || named.has(norm(rec.description));
    if (!aimed) continue;
    // The correction must come after the answers that showed the misconception.
    const latest = standing(rec, all).supports.reduce((t, x) => (x.timestamp > t ? x.timestamp : t), "");
    if (latest && a.timestamp <= latest) continue;
    if (!rec.corrections.includes(a.id)) rec.corrections.push(a.id);
    if (!rec.concept && concept) rec.concept = concept;
    changes.push(move(rec, "resolved", "unaided-correction", at, [a.id], rec.id === o.discriminates && rec.status === "suspected" ? "the question set to tell it apart was answered correctly without help" : ""));
  }
  for (const c of o.cleared ?? []) if (!out.some((r) => norm(r.id) === norm(c) || norm(r.description) === norm(c))) notes.push(`no recorded misconception matches "${c}"`);
  return { list: out, changes, notes };
}

/** The record was already set aside: its last event moved it nowhere because its evidence stopped counting. */
const setAside = (rec: Misconception): boolean => {
  const last = rec.history[rec.history.length - 1];
  return !!last && last.cause === "evidence-withdrawn" && last.from === "suspected" && last.to === "suspected";
};

/**
 * Brings each record into line with the attempts as they now stand. Called after any attempt is
 * disputed, regraded or replaced, and after every observation: a record whose evidence now meets
 * the bar is confirmed; one whose support fell below it goes back to suspected; a resolution whose
 * correcting answer no longer counts is withdrawn. A suspicion left with no evidence at all stays
 * on record but is no longer active. Nothing is deleted.
 */
export function recompute(list: Misconception[], attempts: Attempt[], at: string): { list: Misconception[]; changes: string[] } {
  const changes: string[] = [];
  const out = list.map((m) => ({ ...m, history: [...m.history] }));
  for (const rec of out) {
    if (rec.legacy) continue;
    const s = standing(rec, attempts);
    const ok = confirmable(rec, s.supports, s.discriminating);
    const withdrawn = (ids: string[]) => ids.filter((id) => !s.supports.some((x) => x.id === id) && !s.corrections.some((x) => x.id === id));
    if (rec.status === "resolved" && !s.corrections.length) {
      // The resolution is withdrawn: the record goes back to what its evidence, before that resolution, supports.
      const back = confirmable(rec, s.supports, s.discriminating, true) ? "confirmed" : "suspected";
      changes.push(move(rec, back, "evidence-withdrawn", at, withdrawn(rec.corrections), "the answer that resolved it no longer counts"));
    } else if (rec.status === "suspected" && ok && s.supports.length) {
      const last = [...s.supports].sort((x, y) => (x.timestamp < y.timestamp ? -1 : 1)).pop()!;
      changes.push(move(rec, "confirmed", s.discriminating.length ? "discriminating-answer" : "repeated", last.timestamp > at ? last.timestamp : at, s.supports.map((x) => x.id)));
    } else if (rec.status === "confirmed" && !ok) {
      changes.push(move(rec, "suspected", "evidence-withdrawn", at, withdrawn(rec.evidence), s.supports.length ? "the evidence left no longer confirms it" : "none of its evidence counts any more"));
    } else if (rec.status === "suspected" && !s.supports.length && rec.evidence.length && !setAside(rec)) {
      const aside: MisconceptionEvent = { t: at, from: "suspected", to: "suspected", cause: "evidence-withdrawn", attempts: withdrawn(rec.evidence), note: "none of its evidence counts any more, so it is set aside" };
      rec.history = [...rec.history, aside].slice(-30);
      rec.updated = at;
      changes.push(`misconception set aside: ${rec.description} (its evidence no longer counts)`);
    }
  }
  return { list: out, changes };
}

/** Observation followed by recompute: the one call a marked answer makes. */
export function applyObservation(list: Misconception[], o: Observation, attempts: Attempt[]): { list: Misconception[]; changes: string[]; notes: string[] } {
  const all = attempts.some((x) => x.id === o.attempt.id) ? attempts : [...attempts, o.attempt];
  const first = observe(list, o, all);
  const second = recompute(first.list, all, o.attempt.timestamp);
  return { list: trim(second.list), changes: [...first.changes, ...second.changes], notes: first.notes };
}

/** Old state files kept a plain list of descriptions. Each one not already on record becomes a legacy suspicion, with nothing behind it. */
export function fromLegacy(list: Misconception[], descriptions: string[], at: string): Misconception[] {
  const out = [...list];
  for (const d of descriptions) {
    const text = d.trim().slice(0, 200);
    if (!text || out.some((m) => norm(m.description) === norm(text))) continue;
    out.push({ id: misconceptionId("", text, new Set(out.map((m) => m.id))), concept: "", description: text, status: "suspected", evidence: [], discriminating: [], corrections: [], opened: at, updated: at, history: [{ t: at, from: null, to: "suspected", cause: "legacy", attempts: [], note: "recorded before misconceptions carried evidence" }], legacy: true });
  }
  return trim(out);
}

/**
 * The records a state holds, read with the plain list state.md keeps. Each listed description not
 * on record becomes a legacy suspicion. A legacy suspicion the list no longer names was removed by
 * hand, and goes; records with evidence stay whatever the list says. Returns the records and the
 * list derived from them, which is what the rest of the app reads.
 */
export function reconcile(stored: Misconception[], listed: string[], attempts: Attempt[], at: string): { records: Misconception[]; list: string[] } {
  const named = new Set(listed.map(norm));
  const kept = stored.filter((m) => !(m.legacy && m.status !== "resolved" && !named.has(norm(m.description))));
  const records = fromLegacy(kept, listed, at);
  return { records, list: activeDescriptions(records, attempts) };
}

/** Keeps the newest records when there are too many; active ones are kept before resolved ones. */
function trim(list: Misconception[]): Misconception[] {
  if (list.length <= MAX_RECORDS) return list;
  const resolved = list.filter((m) => m.status === "resolved").sort((a, b) => (a.updated < b.updated ? -1 : 1));
  const drop = new Set(resolved.slice(0, list.length - MAX_RECORDS).map((m) => m.id));
  return list.filter((m) => !drop.has(m.id)).slice(-MAX_RECORDS);
}

/** The active misconceptions on one concept, confirmed first. */
export function onConcept(list: Misconception[], concept: string, attempts: Attempt[]): Misconception[] {
  return list.filter((m) => m.concept === concept && isActive(m, attempts)).sort((a, b) => Number(b.status === "confirmed") - Number(a.status === "confirmed") || (a.updated < b.updated ? 1 : -1));
}

/** One line per record for the topic page and the session note: status, description, and what stands behind it. */
export function misconceptionLine(rec: Misconception, attempts: Attempt[]): string {
  const s = standing(rec, attempts);
  const behind = rec.legacy ? "recorded before evidence was kept" : rec.status === "resolved" ? `corrected without help (${s.corrections.length} answer${s.corrections.length === 1 ? "" : "s"})` : s.supports.length ? `${s.supports.length} answer${s.supports.length === 1 ? "" : "s"} show${s.supports.length === 1 ? "s" : ""} it` : "set aside: its evidence no longer counts";
  return `${rec.description} · ${rec.status} · ${behind}`;
}
