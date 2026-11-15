// Closing a gap the course does not cover. When a learner is missing a prerequisite the course
// has no material for, or asks to go further than the course goes, the tutor sends one narrow
// request to the compiler: the concept (and objective) it is anchored to, and the gap or the
// application asked for. The compiler answers with linked material, its coverage per objective,
// and a status of complete, partial, cancelled or failed.
//
// The request never blocks a turn: tutoring goes on from what the course has while it runs, and
// after it fails or is cancelled. A result is labelled beyond the specification where it is, says
// what a partial result leaves uncovered, and is never evidence: it writes no grade and no level.

import { similarity, slug } from "./course";

export type ExpansionKind = "prerequisite" | "extension";
export type ExpansionStatus = "pending" | "complete" | "partial" | "cancelled" | "failed" | "unavailable";

export interface ExpansionRequest {
  v: 1;
  /** Stable for the same anchor and gap, so the same request is not sent twice. */
  id: string;
  kind: ExpansionKind;
  anchor: { topicDir: string; conceptId: string; conceptName: string; objectiveId?: string };
  /** For a prerequisite: what the learner is missing, in words. */
  gap?: string;
  /** For an extension: the application or direction the learner asked for. */
  application?: string;
  /** Attempt ids and passage refs behind the request. */
  evidence: string[];
  /** Keep the request narrow: at most this many new concepts. */
  maxConcepts: number;
  at: string;
}

export interface ExpansionCoverage {
  objectiveId: string;
  text: string;
  status: "covered" | "partial" | "uncovered";
  refs: string[];
}

export interface ExpansionResult {
  requestId: string;
  status: "complete" | "partial" | "cancelled" | "failed";
  /** Concepts the compiler linked or added, by stable id. */
  linked: { conceptId: string; name: string; topicDir: string; relation: string }[];
  coverage: ExpansionCoverage[];
  /** The material goes beyond the original specification. */
  beyondSpec: boolean;
  message: string;
}

/** The compiler's side, wired by the host. It must honour the signal, and it never writes learner state. */
export interface CourseExpander {
  request(req: ExpansionRequest, signal: AbortSignal): Promise<ExpansionResult>;
}

export interface ExpansionRecord {
  v: 1;
  request: ExpansionRequest;
  status: ExpansionStatus;
  result: ExpansionResult | null;
  updated: string;
  /** The tutor has been told about the result. */
  delivered: boolean;
}

/** The learner asks to go beyond the course: an extension, an application, the next step on. */
export const GO_FURTHER = /\b(go (further|beyond|past)|beyond (the |this )?(spec(ification)?|syllabus|course|exam)|extension (work|material|question)s?|more advanced|harder version|what comes (next|after)|where (does|do) (this|it|they) lead|how (is|are) (this|it|they) used in|(real[- ]world|practical) (use|application)s?|apply (this|it) to)\b/i;

/** Builds a request. `id` is stable for the same kind, anchor and wording, so repeats are recognised. */
export function expansionRequest(p: { kind: ExpansionKind; topicDir: string; conceptId: string; conceptName: string; objectiveId?: string; gap?: string; application?: string; evidence: string[]; at: string }): ExpansionRequest {
  const what = (p.kind === "prerequisite" ? p.gap : p.application) ?? "";
  return {
    v: 1,
    id: `${p.kind}:${p.conceptId || slug(p.conceptName)}:${slug(what).slice(0, 40)}`,
    kind: p.kind,
    anchor: { topicDir: p.topicDir, conceptId: p.conceptId, conceptName: p.conceptName, ...(p.objectiveId ? { objectiveId: p.objectiveId } : {}) },
    ...(p.kind === "prerequisite" ? { gap: what.slice(0, 300) } : { application: what.slice(0, 300) }),
    evidence: p.evidence.slice(0, 6),
    maxConcepts: p.kind === "prerequisite" ? 1 : 2,
    at: p.at,
  };
}

/** A prerequisite the course already has, matched by name: then existing material is used and nothing is requested. */
export function inCourse(gap: string, concepts: { id: string; name: string; topic: string }[]): { id: string; name: string; topic: string } | null {
  let best: { c: { id: string; name: string; topic: string }; s: number } | null = null;
  for (const c of concepts) {
    const s = c.name.toLowerCase() === gap.toLowerCase().trim() ? 1 : similarity(c.name, gap);
    if (s >= 0.5 && (!best || s > best.s)) best = { c, s };
  }
  return best?.c ?? null;
}

const STATUSES = ["complete", "partial", "cancelled", "failed"] as const;
const COVER = ["covered", "partial", "uncovered"] as const;
const str = (v: unknown, n: number): string => (typeof v === "string" ? v.trim().slice(0, n) : "");

/**
 * Reads what the compiler returned, defensively. A result for another request, or one that cannot
 * be read, is a failure. A complete result that leaves an objective uncovered is partial. An
 * extension is beyond the specification by definition.
 */
export function readResult(raw: unknown, req: ExpansionRequest): ExpansionResult {
  const fail = (message: string): ExpansionResult => ({ requestId: req.id, status: "failed", linked: [], coverage: [], beyondSpec: req.kind === "extension", message });
  if (!raw || typeof raw !== "object") return fail("the compiler returned nothing readable");
  const r = raw as Record<string, unknown>;
  if (r.requestId !== req.id) return fail("the compiler answered a different request");
  let status = STATUSES.includes(r.status as (typeof STATUSES)[number]) ? (r.status as ExpansionResult["status"]) : "failed";
  const linked = Array.isArray(r.linked)
    ? r.linked.flatMap((x) => (x && typeof x === "object" && typeof (x as Record<string, unknown>).conceptId === "string" ? [{ conceptId: str((x as Record<string, unknown>).conceptId, 120), name: str((x as Record<string, unknown>).name, 120), topicDir: str((x as Record<string, unknown>).topicDir, 300), relation: str((x as Record<string, unknown>).relation, 40) || (req.kind === "prerequisite" ? "requires" : "applies_to") }] : [])).slice(0, 6)
    : [];
  const coverage = Array.isArray(r.coverage)
    ? r.coverage.flatMap((x) => {
        if (!x || typeof x !== "object") return [];
        const o = x as Record<string, unknown>;
        return [{ objectiveId: str(o.objectiveId, 80), text: str(o.text, 300), status: COVER.includes(o.status as (typeof COVER)[number]) ? (o.status as ExpansionCoverage["status"]) : "uncovered", refs: Array.isArray(o.refs) ? o.refs.map((y) => str(y, 300)).filter(Boolean).slice(0, 6) : [] }];
      }).slice(0, 12)
    : [];
  if (status === "complete" && coverage.some((c) => c.status !== "covered")) status = "partial";
  if (status === "complete" && !linked.length) status = "partial";
  return { requestId: req.id, status, linked, coverage, beyondSpec: req.kind === "extension" || r.beyondSpec === true, message: str(r.message, 400) };
}

/** What a result leaves uncovered, one phrase each. */
export function uncovered(r: ExpansionResult): string[] {
  return r.coverage.filter((c) => c.status !== "covered").map((c) => `${c.objectiveId || "an objective"}${c.text ? ` (${c.text})` : ""}${c.status === "partial" ? ": only partly" : ": not covered"}`);
}

const what = (req: ExpansionRequest): string => (req.kind === "prerequisite" ? `the missing prerequisite "${req.gap}"` : `going further: "${req.application}"`);

/** What the tutor is told this turn about a request: pending, unavailable, or a result to use. */
export function expansionNote(rec: ExpansionRecord): string {
  const req = rec.request;
  switch (rec.status) {
    case "pending":
      return `# Linked material requested\nMaterial for ${what(req)} has been asked for and is not ready. Teach from what the course has now; if that is not enough, say that more is being prepared.`;
    case "unavailable":
    case "failed":
    case "cancelled":
      return `# Linked material not available\nMaterial for ${what(req)} could not be prepared (${rec.status}${rec.result?.message ? `: ${rec.result.message}` : ""}). Teach from what the course has and say plainly what it does not cover. Do not present anything from memory as course material.`;
    case "complete":
    case "partial": {
      const r = rec.result!;
      const left = uncovered(r);
      const linked = r.linked.map((l) => `${l.name} (${l.relation}${l.topicDir ? `, in ${l.topicDir}` : ""})`).join("; ");
      const refs = [...new Set(r.coverage.flatMap((c) => c.refs))].slice(0, 6);
      return `# Linked material ready (${rec.status})\nFor ${what(req)} the course now links: ${linked || "nothing new"}.${refs.length ? ` References: ${refs.join(", ")}.` : ""}${r.beyondSpec ? " This is beyond the original specification: say so when you use it, and keep it apart from what the course requires." : ""}${left.length ? ` Still uncovered: ${left.join("; ")}. Say so if the learner relies on it.` : ""} It is study material only: it changes no level.`;
    }
  }
}

/** One line for Details and the chip. */
export function expansionLine(rec: ExpansionRecord): string {
  const req = rec.request;
  const head = req.kind === "prerequisite" ? `Prerequisite request: ${req.gap}` : `Extension request: ${req.application}`;
  const tail = rec.status === "pending" ? "preparing" : rec.status === "unavailable" ? "not available here" : rec.status;
  const left = rec.result ? uncovered(rec.result) : [];
  return `${head} · ${tail}${rec.result?.beyondSpec && (rec.status === "complete" || rec.status === "partial") ? " · beyond the specification" : ""}${left.length ? ` · uncovered: ${left.join("; ")}` : ""}`;
}

/** Reads a stored record. Returns null for anything that is not one. */
export function parseExpansion(raw: unknown): ExpansionRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const q = r.request as Record<string, unknown> | undefined;
  if (r.v !== 1 || !q || typeof q.id !== "string" || (q.kind !== "prerequisite" && q.kind !== "extension") || !q.anchor || typeof q.anchor !== "object") return null;
  const status = ["pending", "complete", "partial", "cancelled", "failed", "unavailable"].includes(r.status as string) ? (r.status as ExpansionStatus) : "failed";
  const req = r.request as unknown as ExpansionRequest;
  return { v: 1, request: req, status, result: r.result && typeof r.result === "object" ? readResult(r.result, req) : null, updated: typeof r.updated === "string" ? r.updated : "", delivered: r.delivered === true };
}
