// The course knowledge graph: which concepts exist and how they relate. It holds nothing about
// the learner; levels and attempts live in the learner state and are joined to concepts by id.
// Pure functions, no Obsidian imports.

import { OBJECTIVE_REF } from "./evidence";
import type { Topic } from "./formats";

/**
 * Edges read "from <relation> to".
 *   requires        `from` cannot be learned without `to`. The only relation that orders study.
 *   supports        knowing `from` helps with `to`, without being necessary for it
 *   applies_to      `from` is used in the application `to`
 *   contrasts_with  the two are commonly confused (symmetric)
 *   derived_from    `from` is derived mathematically from `to`
 *   synoptic        a joint problem connects the two concepts (symmetric, never orders study)
 */
export type Relation = "requires" | "supports" | "applies_to" | "contrasts_with" | "derived_from" | "synoptic";
export const RELATIONS: Relation[] = ["requires", "supports", "applies_to", "contrasts_with", "derived_from", "synoptic"];

export const RELATION_TEXT: Record<Relation, { out: string; back: string }> = {
  synoptic: { out: "connects in a synoptic problem with", back: "connects in a synoptic problem with" },
  requires: { out: "requires", back: "is required by" },
  supports: { out: "supports", back: "is supported by" },
  applies_to: { out: "applies to", back: "is applied by" },
  contrasts_with: { out: "contrasts with", back: "contrasts with" },
  derived_from: { out: "is derived from", back: "gives rise to" },
};

/** inferred: proposed by the compile step or by a migration. reviewed: confirmed by the learner. rejected: ruled out by the learner, and ignored. */
export type EdgeStatus = "inferred" | "reviewed" | "rejected";

export interface Concept {
  /** Stable for the life of the concept: it survives renumbering and renaming of the subskill. */
  id: string;
  /** Current subskill number in the topic card. */
  n: number;
  name: string;
  /** Notes the topic card cites for this subskill, as [[links]]. */
  sources: string[];
  /** Dropped by a recompile. Kept so that old evidence still names something. */
  retired?: boolean;
  /** The objective versions this concept teaches now, as "id@v" (objective-version.ts). */
  objectives?: string[];
  /** When an objective it teaches last changed materially, and how. A focused recheck follows. */
  revisedAt?: string;
  revisedWhy?: string;
}

export interface CourseEdge {
  from: string;
  to: string;
  type: Relation;
  status: EdgeStatus;
  /** Where the edge came from: "topic card", "learner", or a [[note]]. */
  source: string;
  rationale?: string;
  challenge?: string;
}

export interface TopicGraph {
  version: 1;
  concepts: Concept[];
  edges: CourseEdge[];
}

export const slug = (s: string): string => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "x";

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Word overlap of two names, from 0 to 1. */
export function similarity(a: string, b: string): number {
  const A = new Set(norm(a).split(" ").filter(Boolean));
  const B = new Set(norm(b).split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both);
}

const edgeKey = (e: Pick<CourseEdge, "from" | "to" | "type">): string => `${e.type}|${e.from}|${e.to}`;

/**
 * Brings a topic's graph into line with its topic card.
 *
 * Concepts keep their id when the subskill is recognisably the same: same name first, then the
 * same number with a similar name, then the most similar name left over. A subskill nothing
 * matches gets a new id, and a concept nothing matches is retired, not deleted.
 * Edges that come from the card are rebuilt from it and keep the status the learner gave them.
 * Edges the learner added are kept as they are.
 *
 * `remap` gives, for each old subskill number, the number the same concept has now.
 */
export function syncTopicGraph(prefix: string, topic: Topic, prev: TopicGraph | null): { graph: TopicGraph; remap: Record<number, number> } {
  const old = prev?.concepts ?? [];
  const taken = new Set<string>();
  const idFor = new Map<number, string>();
  const claim = (n: number, c: Concept) => {
    idFor.set(n, c.id);
    taken.add(c.id);
  };
  const free = () => old.filter((c) => !taken.has(c.id));
  for (const sk of topic.subskills) {
    const exact = free().find((c) => norm(c.name) === norm(sk.name));
    if (exact) claim(sk.n, exact);
  }
  for (const sk of topic.subskills) {
    if (idFor.has(sk.n)) continue;
    const same = free().find((c) => c.n === sk.n && !c.retired && similarity(c.name, sk.name) >= 0.34);
    if (same) claim(sk.n, same);
  }
  for (const sk of topic.subskills) {
    if (idFor.has(sk.n)) continue;
    const best = free().map((c) => ({ c, s: similarity(c.name, sk.name) })).sort((a, b) => b.s - a.s)[0];
    if (best && best.s >= 0.6) claim(sk.n, best.c);
  }
  const used = new Set(old.map((c) => c.id));
  for (const sk of topic.subskills) {
    if (idFor.has(sk.n)) continue;
    const stem = `${slug(prefix)}/${slug(sk.name)}`;
    let id = stem;
    for (let i = 2; used.has(id); i++) id = `${stem}-${i}`;
    used.add(id);
    idFor.set(sk.n, id);
  }

  // Objective versions travel with the concept; a compile rewrites them from the course package.
  const versionOf = (id: string): Partial<Concept> => {
    const c = old.find((x) => x.id === id);
    return c ? { ...(c.objectives ? { objectives: c.objectives } : {}), ...(c.revisedAt ? { revisedAt: c.revisedAt, revisedWhy: c.revisedWhy ?? "" } : {}) } : {};
  };
  const concepts: Concept[] = topic.subskills.map((sk) => ({ id: idFor.get(sk.n)!, n: sk.n, name: sk.name, sources: sk.sources ?? [], ...versionOf(idFor.get(sk.n)!) }));
  const live = new Set(concepts.map((c) => c.id));
  for (const c of old) if (!live.has(c.id)) concepts.push({ ...c, retired: true });

  const before = new Map((prev?.edges ?? []).map((e) => [edgeKey(e), e]));
  const edges: CourseEdge[] = [];
  const seen = new Set<string>();
  const add = (e: CourseEdge) => {
    const k = edgeKey(e);
    if (seen.has(k) || e.from === e.to) return;
    seen.add(k);
    edges.push(e);
  };
  const known = new Set(topic.subskills.map((k) => k.n));
  for (const sk of topic.subskills) {
    const from = idFor.get(sk.n)!;
    for (const p of [...new Set(sk.prerequisites)]) {
      if (p === sk.n || !known.has(p)) continue;
      const e = { from, to: idFor.get(p)!, type: "requires" as Relation };
      add({ ...e, status: before.get(edgeKey(e))?.status ?? "inferred", source: "topic card" });
    }
    for (const r of sk.relations ?? []) {
      if (r.n === sk.n || !known.has(r.n) || r.type === "requires") continue;
      const e = { from, to: idFor.get(r.n)!, type: r.type };
      add({ ...e, status: before.get(edgeKey(e))?.status ?? "inferred", source: "topic card" });
    }
  }
  for (const e of prev?.edges ?? []) if (e.source !== "topic card") add(e);

  const remap: Record<number, number> = {};
  for (const c of old) {
    if (c.retired) continue;
    const now = concepts.find((x) => x.id === c.id && !x.retired);
    if (now) remap[c.n] = now.n;
  }
  return { graph: { version: 1, concepts, edges }, remap };
}

export function parseTopicGraph(md: string): TopicGraph | null {
  const m = /```json\s*\n([\s\S]*?)\n```/.exec(md);
  if (!m) return null;
  try {
    const g = JSON.parse(m[1]);
    if (!g || !Array.isArray(g.concepts) || !Array.isArray(g.edges)) return null;
    const concepts: Concept[] = g.concepts
      .filter((c: Concept) => c && typeof c.id === "string" && Number.isInteger(c.n) && typeof c.name === "string")
      .map((c: Concept) => ({
        id: c.id, n: c.n, name: c.name, sources: Array.isArray(c.sources) ? c.sources.filter((s) => typeof s === "string") : [], ...(c.retired ? { retired: true } : {}),
        ...(Array.isArray(c.objectives) ? { objectives: c.objectives.filter((x) => typeof x === "string" && OBJECTIVE_REF.test(x)).slice(0, 24) } : {}),
        ...(typeof c.revisedAt === "string" && !Number.isNaN(Date.parse(c.revisedAt)) ? { revisedAt: c.revisedAt, revisedWhy: typeof c.revisedWhy === "string" ? c.revisedWhy.slice(0, 240) : "" } : {}),
      }));
    const edges: CourseEdge[] = g.edges
      .filter((e: CourseEdge) => e && typeof e.from === "string" && typeof e.to === "string" && RELATIONS.includes(e.type))
      .map((e: CourseEdge) => ({ from: e.from, to: e.to, type: e.type, status: e.status === "reviewed" || e.status === "rejected" ? e.status : "inferred", source: typeof e.source === "string" ? e.source : "topic card", ...(typeof e.rationale === "string" ? { rationale: e.rationale.slice(0, 2000) } : {}), ...(typeof e.challenge === "string" ? { challenge: e.challenge.slice(0, 4000) } : {}) }));
    return { version: 1, concepts, edges };
  } catch {
    return null;
  }
}

export function serializeTopicGraph(title: string, g: TopicGraph): string {
  const lines = [
    "---",
    "tutor: graph",
    `topic: ${JSON.stringify(title)}`,
    "---",
    "The course graph for this topic: its concepts and how they relate. It holds nothing about your progress.",
    "Study Tutor keeps this file in step with the topic card. Relations you add or review in the graph view are stored here.",
    "",
    "```json",
    JSON.stringify(g, null, 1),
    "```",
    "",
  ];
  return lines.join("\n");
}

/** Prerequisites by subskill number, from the `requires` edges inside one topic that have not been rejected. */
export function effectivePrereqs(g: TopicGraph): Record<number, number[]> {
  const byId = new Map(g.concepts.filter((c) => !c.retired).map((c) => [c.id, c.n]));
  const out: Record<number, number[]> = {};
  for (const n of byId.values()) out[n] = [];
  for (const e of g.edges) {
    if (e.type !== "requires" || e.status === "rejected") continue;
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (from === undefined || to === undefined || from === to) continue;
    if (!out[from].includes(to)) out[from].push(to);
  }
  return out;
}

// ---------- the whole course: every topic's graph joined ----------

export interface CourseConcept extends Concept {
  /** Topic folder. */
  topic: string;
  topicTitle: string;
}

export interface Course {
  concepts: Map<string, CourseConcept>;
  edges: CourseEdge[];
}

export function joinCourse(parts: { dir: string; title: string; graph: TopicGraph }[]): Course {
  const concepts = new Map<string, CourseConcept>();
  for (const p of parts) for (const c of p.graph.concepts) if (!c.retired && !concepts.has(c.id)) concepts.set(c.id, { ...c, topic: p.dir, topicTitle: p.title });
  const seen = new Set<string>();
  const edges: CourseEdge[] = [];
  for (const p of parts) {
    for (const e of p.graph.edges) {
      // An edge to a concept that no longer exists is kept on disk and left out here.
      if (!concepts.has(e.from) || !concepts.has(e.to) || seen.has(edgeKey(e))) continue;
      seen.add(edgeKey(e));
      edges.push(e);
    }
  }
  return { concepts, edges };
}

const ordering = (edges: CourseEdge[]): CourseEdge[] => edges.filter((e) => e.type === "requires" && e.status !== "rejected");

/** True when making `from` require `to` would close a loop of prerequisites. */
export function wouldCycle(edges: CourseEdge[], from: string, to: string): boolean {
  if (from === to) return true;
  const next = new Map<string, string[]>();
  for (const e of ordering(edges)) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === from) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(next.get(cur) ?? []));
  }
  return false;
}

export interface Neighbourhood {
  /** Direct prerequisites: what the concept requires. */
  prerequisites: CourseEdge[];
  /** Direct dependents: what requires the concept. */
  dependents: CourseEdge[];
  /** Every other relation touching the concept, in either direction. */
  related: CourseEdge[];
  /** Everything the concept rests on, through any number of `requires` steps. */
  ancestors: Set<string>;
  /** Everything that rests on the concept. */
  descendants: Set<string>;
}

export function neighbourhood(course: Course, id: string): Neighbourhood {
  const order = ordering(course.edges);
  const walk = (start: string, key: "from" | "to", other: "from" | "to"): Set<string> => {
    const out = new Set<string>();
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const e of order) {
        if (e[key] !== cur || out.has(e[other]) || e[other] === start) continue;
        out.add(e[other]);
        stack.push(e[other]);
      }
    }
    return out;
  };
  return {
    prerequisites: order.filter((e) => e.from === id),
    dependents: order.filter((e) => e.to === id),
    related: course.edges.filter((e) => e.status !== "rejected" && e.type !== "requires" && (e.from === id || e.to === id)),
    ancestors: walk(id, "from", "to"),
    descendants: walk(id, "to", "from"),
  };
}

/** How many concepts rest on each concept, directly or not. Used to weigh a prerequisite's importance. */
export function dependentCounts(pre: Record<number, number[]>): Record<number, number> {
  const out: Record<number, number> = {};
  const ns = Object.keys(pre).map(Number);
  for (const n of ns) {
    const seen = new Set<number>();
    const stack = [n];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const m of ns) {
        if (!(pre[m] ?? []).includes(cur) || seen.has(m) || m === n) continue;
        seen.add(m);
        stack.push(m);
      }
    }
    out[n] = seen.size;
  }
  return out;
}
