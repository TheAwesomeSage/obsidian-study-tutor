import type { SourceRevision } from "./compile-sources";
import type { Engine } from "./engine";
import type { CourseExpander, ExpansionResult } from "./expansion";
import type { CourseMaterial } from "./lessondepth";
import { NoteSourceStore, type SourcePassage, type SourceStore } from "./retrieval";
import type { Store } from "./store";

function isTopicDir(store: Store, dir: string): boolean {
  const prefix = store.topicsDir + "/";
  const name = dir.slice(prefix.length);
  return dir.startsWith(prefix) && !!name && name !== "." && name !== ".." && !/[\\/]/.test(name);
}

function citationName(name: string): string {
  const citation = name.replace(/^\[\[|\]\]$/g, "").trim();
  if (/^https?:\/\//i.test(citation)) return citation;
  return citation.split(/[|#]/)[0].trim().replace(/\.md$/i, "");
}

function toTutorPassage(source: SourceRevision, order: number): SourcePassage {
  const passage = source.passages[order];
  return {
    id: passage.id, sourceId: source.url ?? citationName(source.path ?? source.title),
    title: passage.title, revision: source.id, heading: passage.heading,
    url: passage.url, text: passage.text, order,
  };
}

export function courseSources(store: Store, readNote: (name: string) => Promise<string | null>): SourceStore {
  const notes = new NoteSourceStore(readNote);
  async function revisions(topic?: string): Promise<SourceRevision[]> {
    return topic && isTopicDir(store, topic) ? store.compiledSources(topic) : [];
  }
  return {
    async citations(topic, conceptId) {
      if (!isTopicDir(store, topic)) return [];
      const pkg = await store.loadPackage(topic);
      return pkg?.lessons.find(lesson => lesson.concept === conceptId)?.citations ?? [];
    },
    async passagesOf(source, topic) {
      const name = citationName(source);
      const saved = await revisions(topic);
      const exact = saved.filter(revision => (revision.url ?? citationName(revision.path ?? revision.title)) === name);
      const aliases = exact.length ? exact : saved.filter(revision => !revision.url && citationName(revision.title) === name);
      const match = aliases.length === 1 ? aliases[0] : undefined;
      return match ? match.passages.map((_, i) => toTutorPassage(match, i)) : notes.passagesOf(name);
    },
    async passage(id, around, topic) {
      if (!/^p-[a-f\d]{18}-\d+$/.test(id)) return notes.passage(id, around);
      for (const source of await revisions(topic)) {
        const position = source.passages.findIndex(passage => passage.id === id);
        if (position < 0) continue;
        const n = Math.max(0, Math.min(2, around));
        return {
          passage: toTutorPassage(source, position),
          before: source.passages.slice(Math.max(0, position - n), position).map((_, i) => toTutorPassage(source, Math.max(0, position - n) + i)),
          after: source.passages.slice(position + 1, position + n + 1).map((_, i) => toTutorPassage(source, position + 1 + i)),
        };
      }
      return null;
    },
  };
}

export function courseLessons(store: Store): CourseMaterial {
  return {
    async lessonFor(topic, conceptId) {
      if (!isTopicDir(store, topic)) return null;
      const pkg = await store.loadPackage(topic);
      const lesson = pkg?.lessons.find(item => item.concept === conceptId);
      if (!pkg?.staged || !lesson) return null;
      const { inventory, availability, lessons } = pkg.staged;
      const verified = lessons.filter(item => item.subskill === lesson.n &&
        availability.some(row => row.objective === item.objective && row.lessons.includes(lesson.n)));
      const objectives = inventory.filter(item => lesson.objectives.includes(item.id)).map(item => {
        const coverage = availability.find(row => row.objective === item.id);
        return {
          id: item.id, text: item.text, ref: item.references.join(", "),
          source: coverage?.sources.length ? "available" as const : "missing" as const,
          teaching: coverage?.lessons.includes(lesson.n) ? "available" as const : "missing" as const,
          assessment: coverage?.questions.length ? "available" as const : "missing" as const,
        };
      });
      return {
        conceptId, lesson: verified.map(item => item.text).join("\n\n"), worked: lesson.worked,
        refs: [...new Set([...lesson.citations, ...verified.flatMap(item => item.passages)])].slice(0, 8),
        objectives, from: "compiled",
      };
    },
  };
}

export function courseExpansions(store: Store, compile: Engine["expandCourse"]): CourseExpander {
  return {
    async request(req, signal) {
      const { topicDir, conceptId, objectiveId } = req.anchor;
      const beyondSpec = req.kind === "extension";
      const empty = (status: "failed" | "cancelled", message: string): ExpansionResult =>
        ({ requestId: req.id, status, linked: [], coverage: [], beyondSpec, message });
      if (signal.aborted) return empty("cancelled", "Compilation cancelled.");
      if (!isTopicDir(store, topicDir)) return empty("failed", "Select an existing study topic.");
      const anchor = await store.loadTopic(topicDir);
      const compiled = await compile({
        kind: req.kind, anchorDir: topicDir, anchorConcept: conceptId, anchorObjective: objectiveId,
        gap: (beyondSpec ? req.application : req.gap) ?? "",
        research: anchor.fm.research === "yes", maxObjectives: req.maxConcepts,
      }, signal);
      if (!("result" in compiled)) return empty(compiled.status, compiled.reason);
      if (signal.aborted) return empty("cancelled", "Compilation cancelled.");
      const dir = compiled.result.dir;
      const pkg = await store.loadPackage(dir);
      const linked: ExpansionResult["linked"] = [];
      const coverage = compiled.availability.map(item => {
        const objective = pkg?.staged?.inventory.find(o => o.id === item.objective);
        const status = item.gaps.length === 0 ? "covered" as const : item.sources.length || item.lessons.length || item.questions.length ? "partial" as const : "uncovered" as const;
        return { objectiveId: item.objective, text: objective?.text ?? item.objective, status, refs: item.sources };
      });
      let linkFailed = false;
      const relation = beyondSpec ? "applies_to" : "requires";
      for (const lesson of pkg?.lessons ?? []) {
        if (signal.aborted) return empty("cancelled", "Compilation cancelled.");
        const audited = compiled.availability.some(item => item.lessons.includes(lesson.n) && (beyondSpec || !item.gaps.length));
        if (!lesson.concept || !audited) continue;
        try {
          await store.addRelation({ from: conceptId, to: lesson.concept, type: relation, status: "inferred", source: "linked compilation" });
          linked.push({ conceptId: lesson.concept, name: lesson.name, topicDir: dir, relation });
        } catch {
          linkFailed = true;
        }
      }
      const status = compiled.status === "partial" || linkFailed || !linked.length ? "partial" : "complete";
      return { requestId: req.id, status, linked, coverage, beyondSpec,
        message: linkFailed ? "Some concepts could not be added to the course graph." : (compiled.result.coverage ?? "") };
    },
  };
}
