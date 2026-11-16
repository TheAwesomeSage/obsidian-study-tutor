// The tools a turn can run: maths with SymPy, the question bank, evidence, the course graph, retrieval and lessons.
// Part of the engine (see engine.ts): each function takes the engine it works for, and the
// engine has a method of the same name that calls it. No Obsidian imports.

import { Claim, ClaimResult } from "./sympy";
import { need } from "./tools";
import { Retrieval, RetrievalConcept, renderContext, renderRetrieval, retrieve } from "./retrieval";
import { fallbackMaterial, missingEvidence, renderLesson } from "./lessondepth";
import { equivalenceKind, bestExcerpts } from "./engine-common";
import type { Engine } from "./engine";

export function registerTools(eng: Engine): void {
  const claims = (raw: unknown): { claims: Claim[] } | string => {
    const o = need.object(raw);
    if (typeof o === "string") return o;
    return Array.isArray(o.claims) && o.claims.length ? { claims: o.claims as Claim[] } : "claims must be a non-empty list";
  };
  const sympy = async (list: Claim[]): Promise<ClaimResult[]> => {
    if (!eng.maths) throw new Error("SymPy is not available.");
    const results = await eng.maths.check(list);
    if (results.length !== list.length) throw new Error(`SymPy is unavailable (${eng.maths.status()}).`);
    return results;
  };
  eng.tools.register<{ expected: string; given: string }, { equal: boolean | null; detail: string }>({
    name: "maths.equivalent",
    description: "Whether a typed answer equals the expected expression, by SymPy.",
    kind: "symbolic-equivalence",
    timeoutMs: 30000,
    validate: (raw) => {
      const o = need.object(raw);
      if (typeof o === "string") return o;
      const expected = need.text(o, "expected", 400);
      const given = need.text(o, "given", 400);
      return expected && given ? { expected, given } : "expected and given must be short expressions";
    },
    run: async (input) => {
      const [r] = await sympy([{ type: "equal", a: input.given, b: input.expected, lenient: true }]);
      const kind = equivalenceKind(r.detail);
      return { output: { equal: r.ok, detail: r.detail }, assumptions: [kind.assumptions], kind: kind.grading === "numeric" ? "numeric-check" : "symbolic-equivalence" };
    },
  });
  eng.tools.register<{ claims: Claim[] }, ClaimResult[]>({
    name: "maths.check",
    description: "Recomputes the results a reply states (derivatives, integrals, solutions, values).",
    kind: "step-validation",
    timeoutMs: 40000,
    validate: claims,
    run: async (input) => ({ output: await sympy(input.claims), assumptions: ["each stated result was recomputed independently; the reasoning between results is not checked"] }),
  });
  eng.tools.register<{ claims: Claim[] }, ClaimResult[]>({
    name: "maths.compute",
    description: "Computes expressions with SymPy before a reply is written.",
    kind: "computed",
    timeoutMs: 40000,
    validate: claims,
    run: async (input) => ({ output: await sympy(input.claims), assumptions: ["computed by SymPy from the expression as the model wrote it"] }),
  });
  eng.tools.register<{ chatPath: string; query: string; maxWords: number }, { excerpts: string[] }>({
    name: "vault.transcript",
    description: "Finds exchanges from earlier parts of a chat that match what the learner is asking about.",
    kind: "retrieval",
    timeoutMs: 8000,
    validate: (raw) => {
      const o = need.object(raw);
      if (typeof o === "string") return o;
      const chatPath = need.text(o, "chatPath", 600);
      const query = need.text(o, "query", 4000);
      return chatPath && query ? { chatPath, query, maxWords: need.int(o, "maxWords") ?? 220 } : "chatPath and query are required";
    },
    run: async (input) => {
      const parts = await eng.store.earlierParts(input.chatPath);
      const messages = parts.flatMap((c) => c.messages);
      return { output: { excerpts: bestExcerpts(messages.map((m) => `${m.role === "you" ? "LEARNER" : "TUTOR"}: ${m.text}`), input.query, input.maxWords) }, assumptions: ["matched by shared words; quoted exactly, possibly out of order"] };
    },
  });
  eng.tools.register<{ dir: string; skill: number | null; notes: string[]; query: string; maxWords: number }, Retrieval & { excerpts: string[] }>({
    name: "vault.source",
    description: "Pulls the saved source passages most relevant to the question: the focus concept's sources first, then at most one related concept the question names.",
    kind: "retrieval",
    timeoutMs: 8000,
    validate: (raw) => {
      const o = need.object(raw);
      if (typeof o === "string") return o;
      const notes = Array.isArray(o.notes) ? o.notes.filter((n): n is string => typeof n === "string").slice(0, 4) : [];
      const query = need.text(o, "query", 4000);
      const dir = need.text(o, "dir", 600) ?? "";
      const skill = need.int(o, "skill");
      if (!query) return "query is required";
      if (!(dir && skill !== null) && !notes.length) return "a concept (dir and skill) or notes are required";
      return { dir, skill, notes, query, maxWords: Math.min(600, need.int(o, "maxWords") ?? 160) };
    },
    run: async (input) => {
      const focus: RetrievalConcept = { id: "", name: "", sources: input.notes };
      let neighbours: Parameters<typeof retrieve>[1]["neighbours"] = [];
      if (input.dir && input.skill !== null) {
        const topic = await eng.store.loadTopic(input.dir);
        const sk = topic.subskills.find((k) => k.n === input.skill);
        if (!sk) throw new Error("No such subskill.");
        const course = await eng.store.loadCourse();
        const id = [...course.concepts.values()].find((c) => c.topic === input.dir && c.n === sk.n)?.id ?? "";
        const mine = id ? course.concepts.get(id) : undefined;
        Object.assign(focus, { id, name: sk.name, sources: [...new Set([...sk.sources, ...(mine?.sources ?? []), ...input.notes])], section: sk.section, topic: input.dir });
        neighbours = course.edges
          .filter((e) => id && (e.from === id || e.to === id))
          .flatMap((e) => {
            const other = course.concepts.get(e.from === id ? e.to : e.from);
            return other ? [{ edge: e, concept: { id: other.id, name: other.name, sources: other.sources, topic: other.topic } }] : [];
          });
      }
      const r = await retrieve(eng.sourceStore(), { query: input.query, focus, neighbours, maxWords: input.maxWords });
      return { output: { ...r, excerpts: r.passages.map((x) => renderRetrieval({ ...r, via: null, passages: [x] })) }, assumptions: ["ranked by shared words with the question; quoted exactly from the saved source", ...(r.via ? [`followed one ${r.via.type} link to ${r.via.otherName}`] : []), ...(r.gap ? [`${r.gap.name}: ${r.gap.reason}`] : [])] };
    },
  });
  eng.tools.register<{ id: string; around: number; topic?: string }, { text: string; found: boolean }>({
    name: "vault.passage",
    description: "Returns a quoted passage's original text, and the passages around it, by its reference id.",
    kind: "retrieval",
    timeoutMs: 8000,
    validate: (raw) => {
      const o = need.object(raw);
      if (typeof o === "string") return o;
      const id = need.text(o, "id", 300);
      return id ? { id, topic: need.text(o, "topic", 600) ?? undefined, around: Math.max(0, Math.min(2, need.int(o, "around") ?? 1)) } : "id is required";
    },
    run: async (input) => {
      const store = eng.sourceStore();
      const c = store ? await store.passage(input.id, input.around, input.topic) : null;
      return { output: { text: renderContext(c, input.id), found: !!c }, assumptions: ["the passage as saved; neighbours are capped in length"] };
    },
  });
  eng.tools.register<{ dir: string; skill: number }, { text: string; missing: string[]; from: string }>({
    name: "course.lesson",
    description: "Returns the compiled lesson for a concept, its references, and what the course is missing for its objectives.",
    kind: "retrieval",
    timeoutMs: 8000,
    validate: (raw) => {
      const o = need.object(raw);
      if (typeof o === "string") return o;
      const dir = need.text(o, "dir", 600);
      const skill = need.int(o, "skill");
      return dir && skill !== null ? { dir, skill } : "dir and skill are required";
    },
    run: async (input) => {
      const topic = await eng.store.loadTopic(input.dir);
      const sk = topic.subskills.find((k) => k.n === input.skill);
      if (!sk) throw new Error("No such subskill.");
      const course = await eng.store.loadCourse();
      const id = [...course.concepts.values()].find((c) => c.topic === input.dir && c.n === sk.n)?.id ?? "";
      // The compiler's lesson when it has one; otherwise what an older course has, with the gaps marked.
      const compiled = eng.material && id ? await eng.material.lessonFor(input.dir, id).catch(() => null) : null;
      const m = compiled ?? fallbackMaterial({ conceptId: id, subskill: sk, pkg: await eng.store.loadPackage(input.dir).catch(() => null), objectives: topic.objectives ?? [] });
      const missing = missingEvidence(m);
      return { output: { text: renderLesson(m, sk.name), missing, from: m.from }, assumptions: [m.from === "compiled" ? "the compiled lesson for this concept" : "assembled from the course package and topic card: the course has no deeper lesson", ...(missing.length ? [`missing: ${missing.join("; ")}`] : [])] };
    },
  });
  eng.tools.register<{ dir: string; skill: number }, { name: string; prerequisites: string[]; dependents: string[]; weak: string[]; outside: string[] }>({
    name: "graph.inspect",
    description: "Reads a concept's place in the course graph: what it requires, what requires it, and which prerequisites are weak.",
    kind: "inspection",
    timeoutMs: 8000,
    validate: (raw) => {
      const o = need.object(raw);
      if (typeof o === "string") return o;
      const dir = need.text(o, "dir", 600);
      const skill = need.int(o, "skill");
      return dir && skill !== null ? { dir, skill } : "dir and skill are required";
    },
    run: async (input) => {
      const s = eng.settings();
      const state = await eng.store.loadState(input.dir, s.targetLevel);
      const pre = await eng.store.prereqs(input.dir);
      if (!(input.skill in state.names)) throw new Error("No such subskill.");
      const label = (n: number) => `${state.names[n]} (level ${state.levels[n] ?? "unset"})`;
      const outside = (await eng.store.externalPrereqs(input.dir, state.target)).filter((e) => e.skill === input.skill);
      return {
        output: {
          name: state.names[input.skill],
          prerequisites: (pre[input.skill] ?? []).map(label),
          dependents: Object.keys(pre).map(Number).filter((n) => (pre[n] ?? []).includes(input.skill)).map(label),
          weak: (pre[input.skill] ?? []).filter((n) => (state.levels[n] ?? -1) < 2).map(label),
          outside: outside.map((e) => `${e.name} in ${e.topic} (level ${e.level ?? "unknown"})`),
        },
        assumptions: ["relations marked rejected are left out"],
      };
    },
  });
}
