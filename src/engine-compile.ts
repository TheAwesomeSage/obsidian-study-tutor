// Compiling a topic, refreshing it from changed notes, and compiling a linked prerequisite or extension.
// Part of the engine (see engine.ts): each function takes the engine it works for, and the
// engine has a method of the same name that calls it. No Obsidian imports.

import { ClaudeError, zeroUsage } from "./claude";
import { modelFor, providerFor } from "./model-provider";
import { Frontmatter, contentHash, fmList, fmStr, parseCompileOutput, parseQuestions, parseTopic, splitFrontmatter } from "./formats";
import { CoursePackage, buildPackage, coverageLine, mergeRefresh, sourceChanges, subskillSections, withStagedCoverage } from "./coursepkg";
import { checkCompilation, compileCourse, CompileCancelled, type ExpansionRequest as CompileExpansionRequest, type StagedCourse } from "./compiler";
import { buildRefreshInput } from "./prompts";
import { Material, CompileRequest, CompileResult } from "./engine-common";
import type { Engine } from "./engine";

/** Plan, collect evidence and verify a candidate before writing the topic. */
export async function compile(eng: Engine, req: CompileRequest, onProgress: (msg: string) => void = () => {}): Promise<CompileResult> {
  const s = eng.settings();
  const model = modelFor(s, "compileModel");
  checkCompilation(req.signal);
  const subjects = await eng.store.subjectNames();
  const candidate = await compileCourse({
    ...req, model, planModelKey: providerFor(s) === "codex" ? `codex:${model || "default"}` : undefined,
    subjects, skill: await eng.store.skill("compile.md"), singlePassWords: s.singlePassWords,
    limits: s.researchLimits, progress: onProgress, provider: eng.researchProvider, local: eng.compilationLocal,
    cache: { read: key => eng.store.readCompileCache(key), write: (key, value) => eng.store.writeCompileCache(key, value) },
    call: o => eng.call(o, s),
  });
  const existing = req.existingDir ? await eng.store.loadPackage(req.existingDir).catch(() => null) : null;
  const preserve = candidate.staged.status === "partial" && !!req.existingDir;
  checkCompilation(req.signal);
  onProgress("Saving the compiled course…");
  const subject = subjects.includes(candidate.subject) ? candidate.subject : "none";
  const dir = await eng.store.saveCompiled({
    title: preserve ? `${req.title} (partial)` : req.title,
    fm: { source: req.mode, subject, goal: req.goal.trim(), research: req.research ? "yes" : "no", ...req.fm, ...(preserve ? { candidate_of: req.existingDir! } : {}) },
    topicBody: candidate.topicBody,
    questionsBody: candidate.questionsBody,
    target: s.targetLevel,
    existingDir: preserve ? undefined : req.existingDir,
  });
  const pkg = await eng.writePackage(dir, req, preserve ? null : existing, undefined, candidate.staged);
  return { dir, subskills: pkg.lessons.length, questions: parseQuestions(candidate.questionsBody).length, usage: candidate.usage, agents: candidate.calls,
    status: candidate.staged.status, coverage: coverageLine(pkg), complete: pkg.coverage.complete, metrics: candidate.staged.metrics, preservedCourse: preserve ? req.existingDir : undefined };
}

/** Compiler boundary for a single missing prerequisite or requested beyond-spec application. */
export async function expandCourse(eng: Engine, request: CompileExpansionRequest, signal?: AbortSignal, progress?: (message: string) => void, existingDir?: string): Promise<
  { status: "complete" | "partial"; result: CompileResult; availability: StagedCourse["availability"] } |
  { status: "cancelled" | "failed"; reason: string }
> {
  try {
    checkCompilation(signal);
    const gap = request.gap.trim();
    if (!gap || gap.length > 600 || !["prerequisite", "extension"].includes(request.kind)) throw new Error("Specify one prerequisite or beyond-spec application.");
    if (!(await eng.store.listTopics()).some(t => t.dir === request.anchorDir)) throw new Error("Select an existing topic to extend.");
    const topic = await eng.store.loadTopic(request.anchorDir);
    const pkg = await eng.store.loadPackage(request.anchorDir);
    const state = await eng.store.loadState(request.anchorDir, eng.settings().targetLevel);
    const concept = request.anchorConcept && Object.entries(state.concepts).find(([, id]) => id === request.anchorConcept);
    const objective = request.anchorObjective && pkg?.objectives.find(o => o.id === request.anchorObjective);
    if (!concept && !objective) throw new Error("Select an existing concept or objective to extend.");
    if (existingDir && (await eng.store.loadPackage(existingDir))?.staged?.expansion?.anchorDir !== request.anchorDir) throw new Error("The linked topic no longer matches this expansion.");
    const anchor = objective ? objective.text : concept ? state.names[Number(concept[0])] : topic.title;
    const label = request.kind === "extension" ? "Beyond specification" : "Prerequisite";
    const savedSources = await eng.store.compiledSources(request.anchorDir);
    const anchorNotes: Material[] = [];
    if (!savedSources.length && eng.readSource) {
      const refs = concept ? topic.subskills.find(s => s.n === Number(concept[0]))?.sources ?? [] : fmList(topic.fm, "sources");
      for (const ref of [...new Set(refs)].slice(0, 8)) {
        checkCompilation(signal);
        const name = ref.replace(/^\[\[|\]\]$/g, "");
        const source = await eng.readSource(name).catch(() => null);
        if (source) anchorNotes.push({ name, ...source });
      }
    }
    const result = await eng.compile({
      title: `${label}: ${gap.slice(0, 100)}`, mode: "notes", goal: `${label} for ${topic.title} — ${anchor}. ${gap}`,
      material: anchorNotes, savedSources, signal, expansion: { ...request, gap }, research: request.research, existingDir,
      fm: { kind: "subject", expansion_of: request.anchorDir, expansion_kind: request.kind },
    }, progress);
    return { status: result.status!, result, availability: (await eng.store.loadPackage(result.dir))?.staged?.availability ?? [] };
  } catch (e) {
    return { status: e instanceof CompileCancelled ? "cancelled" : "failed", reason: (e as Error).message };
  }
}

/** Builds and saves the course package for a compiled topic, fingerprinting its source notes. */
export async function writePackage(eng: Engine, dir: string, req: Pick<CompileRequest, "mode" | "material" | "research">, previous: CoursePackage | null, refreshed?: { subskills: number[]; notes: string[] }, staged?: StagedCourse): Promise<CoursePackage> {
  const s = eng.settings();
  const topic = await eng.store.loadTopic(dir);
  const state = await eng.store.loadState(dir, s.targetLevel);
  const sources = req.mode === "subject" ? {} : Object.fromEntries(req.material.map((m) => [m.name, contentHash(m.text)]));
  let pkg = buildPackage({ topic, questions: await eng.store.loadQuestions(dir), concepts: state.concepts, sources: refreshed && previous ? { ...previous.sources, ...sources } : sources, previous, at: new Date().toISOString(), mode: req.mode, research: !!req.research, refreshed });
  if (staged) pkg = withStagedCoverage(pkg, staged);
  await eng.store.savePackage(dir, pkg);
  return pkg;
}

/**
 * Recompiles only what changed. Source notes are compared with the fingerprints in the course
 * package: unchanged notes cost nothing, and a change that reaches a few subskills rewrites
 * just those sections and their questions in one call, keeping every other section, question
 * id and review schedule. New notes, a change reaching most of the topic, or a topic with no
 * package yet get a full compile. Learner evidence is kept either way, through stable ids.
 */
export async function refresh(eng: Engine, req: CompileRequest & { existingDir: string }, onProgress: (msg: string) => void = () => {}): Promise<CompileResult & { refresh: "unchanged" | "partial" | "full"; subskillsRefreshed: number[]; why: string }> {
  const s = eng.settings();
  const dir = req.existingDir;
  const pkg = await eng.store.loadPackage(dir).catch(() => null);
  checkCompilation(req.signal);
  const full = async (why: string) => ({ ...(await eng.compile(req, onProgress)), refresh: "full" as const, subskillsRefreshed: [] as number[], why });
  if (!pkg || req.mode === "subject" || !req.material.length) return full(!pkg ? "there is no course package yet" : "a topic without notes is always compiled whole");
  const now = Object.fromEntries(req.material.map((m) => [m.name, contentHash(m.text)]));
  const ch = sourceChanges(pkg, now);
  const topic = await eng.store.loadTopic(dir);
  const questions = await eng.store.loadQuestions(dir);
  const sameScope = pkg.mode === req.mode && pkg.research === !!req.research && fmStr(topic.fm, "goal") === req.goal.trim();
  if (sameScope && !ch.changed.length && !ch.removed.length && !ch.added.length && (!pkg.staged || pkg.staged.status === "complete")) return { dir, subskills: topic.subskills.length, questions: questions.length, usage: zeroUsage(), agents: 0, coverage: coverageLine(pkg), complete: pkg.coverage.complete, status: pkg.staged?.status, refresh: "unchanged", subskillsRefreshed: [], why: "no source note has changed since the last compile" };
  if (!sameScope) return full("the compilation scope changed");
  if (pkg.staged || req.research || req.mode === "spec") return full("the objective inventory and source references need to be checked together");
  if (ch.added.length) return full(`new notes (${ch.added.slice(0, 3).join(", ")}) need a full compile to place them`);
  if (!ch.subskills.length) return full("the changed notes are not cited by any subskill");
  if (ch.subskills.length > Math.max(1, Math.floor(pkg.lessons.length / 2))) return full(`the changes reach ${ch.subskills.length} of ${pkg.lessons.length} subskills`);

  onProgress(`Refreshing ${ch.subskills.length} subskill${ch.subskills.length === 1 ? "" : "s"} from ${ch.changed.length + ch.removed.length} changed note${ch.changed.length + ch.removed.length === 1 ? "" : "s"}…`);
  const material = req.material.filter((m) => ch.changed.includes(m.name)).map((m) => `## [[${m.name}]]\n${m.text.trim()}`).join("\n\n");
  const stop = new AbortController();
  const abort = () => stop.abort();
  req.signal?.addEventListener("abort", abort, { once: true });
  const res = await (async () => {
    try {
      const system = await eng.store.skill("compile.md"), subjects = await eng.store.subjectNames();
      checkCompilation(req.signal);
      return await eng.call({ model: modelFor(s, "compileModel"), system, input: buildRefreshInput({ title: topic.title, goal: req.goal, subjects, card: topic.body, subskills: ch.subskills, removed: ch.removed, material }), timeoutMs: 600000, onSpawn: kill => stop.signal.addEventListener("abort", kill, { once: true }) }, s);
    } finally { req.signal?.removeEventListener("abort", abort); checkCompilation(req.signal); }
  })();
  const parsed = parseCompileOutput(res.text);
  const sections = subskillSections(parsed.topicBody);
  const missing = ch.subskills.filter((n) => !sections.has(n));
  if (missing.length) throw new ClaudeError(`The refresh did not return subskill ${missing.join(", ")}. Nothing was changed; recompile the whole topic instead.`);
  const qRaw = splitFrontmatter(await eng.store.readQuestionsRaw(dir)).body;
  const merged = mergeRefresh({ topicBody: topic.body, questionsBody: qRaw, sections, questions: parsed.questionsBody, subskills: ch.subskills });
  const check = parseTopic(merged.topicBody);
  if (check.subskills.length !== topic.subskills.length) throw new ClaudeError("The refreshed card did not keep the same subskills. Nothing was changed; recompile the whole topic instead.");
  const kept = parseQuestions(merged.questionsBody).filter((q) => !merged.replaced.includes(q.subskill)).map((q) => q.id);
  const fm: Frontmatter = { ...topic.fm };
  delete fm.compiled;
  checkCompilation(req.signal);
  onProgress("Saving the refreshed course…");
  await eng.store.saveCompiled({ title: topic.title, fm, topicBody: merged.topicBody, questionsBody: merged.questionsBody, target: s.targetLevel, existingDir: dir, keepCards: kept });
  const next = await eng.writePackage(dir, req, pkg, { subskills: merged.replaced, notes: [...ch.changed, ...ch.removed] });
  return { dir, subskills: check.subskills.length, questions: parseQuestions(merged.questionsBody).length, usage: res.usage, agents: 1, coverage: coverageLine(next), complete: next.coverage.complete, refresh: "partial", subskillsRefreshed: merged.replaced, why: `${[...ch.changed, ...ch.removed].join(", ")} changed` };
}
