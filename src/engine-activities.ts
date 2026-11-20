// Diagrams, simulations and games: choosing one, configuring it locally (or planning blueprints at compile time with the main provider), opening a saved one and recording its result.
// Part of the engine (see engine.ts): each function takes the engine it works for, and the
// engine has a method of the same name that calls it. No Obsidian imports.

import { addUsage, zeroUsage, type Usage } from "./claude";
import { Attempt, Outcome, recordAttempt } from "./evidence";
import { Chat, LearnerState, Mode, Topic, evidenceOf, objectiveStamp, contentHash, fmStr, words } from "./formats";
import { Decision } from "./policy";
import { ActivityRecord, CONFIG_PROMPT_VERSION, LESSON_SCHEMA_VERSION, activityKey, configureActivity, providerModel, toResult } from "./configure";
import { compileStrategyFor, modelFor, modelIdentity } from "./model-provider";
import { isSystemsModule } from "./visuals/systems-modules";
import { DEFAULT_LOCAL_MODEL, LocalModel } from "./ollama";
import { ExplicitRequest, PresentationDecision, choosePresentation, matchModules } from "./presentation";
import { AssessmentResult, ModuleDescriptor, PresentationKind, PresentationRequest, SourceRef, VisualLesson } from "./visualcontract";
import { SessionRecord, sessionFor } from "./session";
import { NO_MODULES, PresentationOutcome, TurnResult, applyAttempt, bestExcerpts } from "./engine-common";
import type { Engine } from "./engine";

/** Short exact passages from the concept's source notes, with provenance; the card section when there are none. */
export async function sourceRefsFor(eng: Engine, dir: string, topic: Topic, n: number, query: string): Promise<SourceRef[]> {
  const sk = topic.subskills.find((k) => k.n === n);
  if (!sk) return [];
  const refs: SourceRef[] = [];
  for (const link of sk.sources.slice(0, 2)) {
    const name = link.replace(/^\[\[|\]\]$/g, "");
    const got = eng.readSource ? await eng.readSource(name).catch(() => null) : eng.readNote ? await eng.readNote(name).then((text) => (text === null ? null : { path: `${name}.md`, text })).catch(() => null) : null;
    if (!got) continue;
    const paragraphs = got.text.split(/\n\s*\n/).filter((p) => words(p) >= 6);
    const excerpt = bestExcerpts(paragraphs, query, 120).join("\n\n");
    // The hash is of the excerpt itself: an edit elsewhere in the note leaves the activity valid,
    // and any change to the passage it rests on makes a new one.
    if (excerpt) refs.push({ path: got.path, contentHash: contentHash(excerpt), excerpt });
  }
  if (!refs.length) {
    const excerpt = sk.section.split(/\s+/).slice(0, 120).join(" ");
    refs.push({ path: `${dir}/topic.md`, contentHash: contentHash(excerpt), excerpt });
  }
  return refs;
}

/** The objective an activity for a concept is written for: the card's name and its first bullet. */
export const conceptObjective = (sk: Topic["subskills"][number]): string =>
  `${sk.name}: ${(sk.section.split("\n").find((l) => /^\s*-\s+/.test(l)) ?? "").replace(/^\s*-\s+/, "").replace(/\s*\(\[\[[^\]]+\]\]\)\s*$/, "").trim()}`.replace(/:\s*$/, "");

/** True when saved source references still match the passages an activity would rest on. */
const sameRefs = (saved: SourceRef[], refs: SourceRef[]): boolean => saved.length === refs.length && saved.every((x) => refs.some((y) => y.path === x.path && y.contentHash === x.contentHash));

/**
 * Saved activities for a concept that still hold: sources, module, catalogue, schema and prompt
 * unchanged. A local record also needs the same local model. A main-provider record is kept only
 * while it is ready and does not depend on the main model's name: a blueprint that passed its
 * checks stays valid when the model alias moves on, and a failed plan never blocks the local model.
 */
async function savedFor(eng: Engine, dir: string, conceptId: string, refs: SourceRef[], modelName: string, catalog: string, descriptors: ModuleDescriptor[]): Promise<ActivityRecord[]> {
  return (await eng.store.loadActivities(dir)).filter((a) => a.conceptId === conceptId && a.schemaVersion === LESSON_SCHEMA_VERSION && a.promptVersion === CONFIG_PROMPT_VERSION && (a.provider === "main" ? a.status === "ready" : a.model === modelName) && a.catalogVersion === catalog && sameRefs(a.sourceRefs, refs) && (!a.moduleId || descriptors.some((d) => d.id === a.moduleId && d.version === a.moduleVersion)));
}

/** The compiled worked lesson for a concept: the simpler explanation offered when an interactive is not available. */
export async function workedLesson(eng: Engine, dir: string, topic: Topic, n: number): Promise<string> {
  const sk = topic.subskills.find((k) => k.n === n);
  if (sk?.worked) return sk.worked;
  const pkg = await eng.store.loadPackage(dir).catch(() => null);
  return pkg?.lessons.find((l) => l.n === n)?.worked ?? "";
}

/**
 * Runs the presentation gate for the concept in focus and prepares what it chose. An explicit
 * request is carried out now (a saved activity, or a local configuration on a cache miss); an
 * offer is only recorded, and configured if the learner opens it. Returns null when the text
 * alone is the format. Never calls Claude.
 */
export async function presentationFor(eng: Engine, p: { dir: string; topic: Topic; state: LearnerState; mode: Mode; action: string | null; said: string; visualAsk: ExplicitRequest | null; tutorKind?: PresentationKind | null; chatPath?: string; concept?: number; preferredModuleId?: string; variantSeed?: number }): Promise<PresentationOutcome | null> {
  const n = p.concept ?? p.state.focus;
  const sk = p.topic.subskills.find((k) => k.n === n);
  if (!sk || n === null || n === undefined) return null;
  // Most turns have nothing to decide: no request, no proposal, and nothing the course marked.
  if (!p.visualAsk && !p.tutorKind && !sk.visual) return null;
  const conceptId = p.state.concepts[n] ?? "";
  const descriptors = eng.visuals ? eng.visuals.listModuleDescriptors() : [];
  const catalog = eng.visuals?.catalogVersion() ?? "none";
  const modelName = eng.local?.model ?? eng.settings().localModel ?? DEFAULT_LOCAL_MODEL;
  const objective = conceptObjective(sk);
  // Excerpts are chosen by the concept, not by how the learner worded the request, so the same
  // activity is found again however it is asked for.
  const refs = await eng.sourceRefsFor(p.dir, p.topic, n, objective);
  // A saved record is reused only while its sources, module, catalogue, schema, prompt and
  // model are all unchanged. Anything else is a miss, and the old record stays on disk.
  const saved = await savedFor(eng, p.dir, conceptId, refs, modelName, catalog, descriptors);
  const e = evidenceOf(p.state, n);
  const lastWrong = [...p.state.attempts].reverse().find((a) => a.skill === n && a.result !== "correct" && a.result !== "ungraded");
  // Modules are shortlisted against the card and the source passages the activity would rest on.
  const context = [sk.section, ...refs.map((r) => r.excerpt)].join("\n");
  const decision = choosePresentation(
    { mode: p.mode, action: p.action, message: p.said, objective, context, recentFailures: e.recentFailures, errorType: lastWrong?.errorType ?? "", misconception: p.state.misconceptions.length > 0, eligibility: sk.visual ?? null, descriptors, saved: saved.map((a) => ({ id: a.id, kind: a.kind, moduleId: a.moduleId, status: a.status })), preferredModuleId: p.preferredModuleId },
    p.visualAsk,
    p.tutorKind ?? null,
  );
  if (decision.status === "none") return null;
  const outcome: PresentationOutcome = { decision, request: null, activity: null, lesson: null, result: null, fallback: "", cacheHit: false, calls: { local: 0, claude: 0 }, concept: n };
  if (decision.status === "text") return outcome;
  const t = new Date().toISOString();
  const log = (event: string, a: ActivityRecord | null) => eng.store.logActivity(p.dir, { t, activityId: a?.id ?? decision.activityId ?? "", conceptId, event, trigger: decision.trigger, reason: decision.reason, ...(p.chatPath ? { chatPath: p.chatPath } : {}) });
  const request: PresentationRequest = { version: 1, kind: decision.kind, reason: decision.reason, objective, sourceRefs: refs, ...(decision.moduleId ? { preferredModuleId: decision.moduleId } : {}) };
  outcome.request = request;
  const configure = (candidates: ModuleDescriptor[], model: LocalModel | null) => configureActivity({ request, conceptId, candidates, assets: eng.visuals?.listAssets() ?? [], registry: eng.visuals ?? NO_MODULES, model, catalogVersion: catalog, trigger: decision.trigger, modelName });

  if (decision.status === "cached") {
    const rec = saved.find((a) => a.id === decision.activityId) ?? null;
    outcome.activity = rec;
    outcome.cacheHit = !!rec;
    if (rec?.lesson) {
      outcome.lesson = eng.variant(rec.lesson, p.variantSeed) ?? rec.lesson;
      outcome.result = { status: "ready", lesson: outcome.lesson };
    }
    await log(decision.trigger === "explicit" ? "reused" : "offered", rec);
    return outcome;
  }
  if (decision.status === "offer") {
    await log("offered", null);
    return outcome;
  }
  if (decision.status === "unsupported") {
    // A failure saved for this concept and kind is reused; otherwise code records the gap.
    const known = saved.find((a) => a.status !== "ready" && a.kind === decision.kind && !a.moduleId) ?? null;
    const rec = known ?? (await configure([], null));
    outcome.cacheHit = !!known;
    if (!known) await eng.store.saveActivity(p.dir, rec);
    return eng.declined(p.dir, p.topic, n, outcome, rec, conceptId, !!known, log);
  }
  // configure: a saved configuration (or saved failure) for exactly these sources and versions
  // is reused first, so a repeated failure never runs the local model again.
  if (!eng.visuals) return eng.declined(p.dir, p.topic, n, outcome, null, conceptId, false, log);
  const candidates = matchModules(`${objective}\n${context}\n${p.said}`, decision.kind, descriptors, decision.moduleId ?? undefined, sk.name).map((m) => m.descriptor);
  const hit = saved.find((a) => a.kind === decision.kind && a.moduleId === candidates[0]?.id && a.objective === objective) ?? null;
  let rec: ActivityRecord;
  if (hit) {
    rec = hit;
    outcome.cacheHit = true;
  } else {
    rec = await configure(candidates, eng.settings().localActivities === false ? null : eng.local);
    outcome.calls.local = rec.localCalls;
    await eng.store.saveActivity(p.dir, rec);
  }
  outcome.activity = rec;
  if (rec.status === "ready" && rec.lesson) {
    outcome.lesson = eng.variant(rec.lesson, p.variantSeed) ?? rec.lesson;
    outcome.result = { status: "ready", lesson: outcome.lesson };
    await log(hit ? "reused" : "generated", rec);
    return outcome;
  }
  return eng.declined(p.dir, p.topic, n, outcome, rec, conceptId, !!hit, log);
}

/** An interactive that cannot be given: the gap is recorded, and the compiled worked lesson is offered instead. */
export async function declined(eng: Engine, dir: string, topic: Topic, n: number, outcome: PresentationOutcome, rec: ActivityRecord | null, conceptId: string, known: boolean, log: (event: string, a: ActivityRecord | null) => Promise<void>): Promise<PresentationOutcome> {
  outcome.activity = rec;
  outcome.result = rec ? toResult(rec) : { status: "invalid", reason: "No visual modules are installed.", validationErrors: [{ path: "$", message: "no module registry" }] };
  outcome.fallback = await eng.workedLesson(dir, topic, n);
  if (rec?.status === "unsupported" && rec.missingCapability && !known) {
    await eng.store.logCapability({ t: rec.createdAt, topic: topic.title, conceptId, kind: rec.kind, operation: rec.missingCapability.operation, objective: rec.objective, motivatingTask: rec.missingCapability.motivatingTask, sources: rec.sourceRefs.map((s) => ({ path: s.path, contentHash: s.contentHash })) });
  }
  await log(rec?.status === "unsupported" ? "unsupported" : "failed", rec);
  return outcome;
}

/** A fresh numeric variant made and validated by module code, when the module offers one. */
export function variant(eng: Engine, lesson: VisualLesson, seed?: number): VisualLesson | null {
  if (seed === undefined || !eng.visuals) return null;
  const v = eng.visuals.createVariant(lesson, seed);
  if (!v) return null;
  const ok = eng.visuals.validateLesson(v);
  return ok.ok ? ok.lesson : null;
}

/** Answers an explicit request for an activity in the chat, with no model call. */
export async function presentLocally(eng: Engine, p: { chatPath: string; chat: Chat; state: LearnerState; session: SessionRecord; outcome: PresentationOutcome; decision: Decision | null }): Promise<TurnResult> {
  const { outcome, session } = p;
  const kind = outcome.decision.kind;
  const label = kind === "game" ? "Challenge" : kind === "external" ? "External activity" : kind.charAt(0).toUpperCase() + kind.slice(1);
  let reply: string;
  if (outcome.lesson) {
    reply = `**${label}** · ${outcome.decision.reason}\n\n${outcome.lesson.predictionQuestion}\n\n*Make your prediction in the activity before you run it. Moving its controls, playing and resetting use no tokens.*`;
    session.nextAction = session.pendingQuestion ? "Answer the open question." : "Make a prediction in the activity.";
  } else {
    const why = outcome.activity?.reason || outcome.decision.reason;
    reply = `**No ${kind} for this yet** · ${why}${outcome.fallback ? `\n\nHere is the worked example from your course instead:\n\n${outcome.fallback}` : ""}\n\n*Ask for an explanation in words or a diagram if you want one.*`;
  }
  p.chat.messages.push({ role: "tutor", text: reply });
  session.exactExcerpts = p.chat.messages.slice(-2).map((m) => `${m.role}: ${m.text}`);
  session.unresolvedMisconceptions = [...p.state.misconceptions];
  p.chat.fm.session = JSON.stringify(session);
  p.chat.fm.pending_confidence = "";
  p.chat.fm.answered_at = "";
  await eng.store.saveChat(p.chatPath, p.chat);
  const out: TurnResult = { reply, changes: [], state: p.state, usage: zeroUsage(), local: true, presentation: outcome };
  if (p.decision) out.decision = p.decision;
  return out;
}

/** Records, on an open question in a chat, that an activity was used for it, so the answer counts as helped. */
export async function noteActivityHelp(eng: Engine, chatPath: string | undefined, state: LearnerState, kind: string): Promise<void> {
  if (!chatPath) return;
  const chat = await eng.store.loadChat(chatPath);
  const record = sessionFor(chat, state, (fmStr(chat.fm, "mode", "tutor") as Mode) || "tutor");
  if (!record.pendingQuestion) return;
  const line = `learner opened an interactive ${kind} for this question`;
  if (!record.helpGiven.includes(line)) record.helpGiven = [...record.helpGiven, line].slice(-8);
  chat.fm.session = JSON.stringify(record);
  if (fmStr(chat.fm, "card")) chat.fm.card_help = "yes";
  await eng.store.saveChat(chatPath, chat);
}

/**
 * An explicit request from the interface, such as a "Show a simulation" button: reopens a saved
 * activity or configures one on a cache miss. Supported activities open with no approval step
 * and no Claude call. With `chatPath`, an open question in that chat is marked as helped.
 */
export async function requestActivity(eng: Engine, dir: string, o: { kind: PresentationKind; concept?: number; chatPath?: string; preferredModuleId?: string; variantSeed?: number }): Promise<PresentationOutcome> {
  const s = eng.settings();
  const topic = await eng.store.loadTopic(dir);
  const state = await eng.store.loadState(dir, s.targetLevel);
  const said = `show me a ${o.kind}`;
  const outcome = await eng.presentationFor({ dir, topic, state, mode: "auto", action: null, said, visualAsk: { kind: o.kind, said }, chatPath: o.chatPath, concept: o.concept, preferredModuleId: o.preferredModuleId, variantSeed: o.variantSeed });
  if (!outcome) throw new Error("Choose a concept first.");
  if (outcome.lesson) await eng.noteActivityHelp(o.chatPath, state, o.kind);
  return outcome;
}

/** Reopens a saved activity by id with no model call; with a seed, a fresh variant checked by the module. */
export async function openActivity(eng: Engine, dir: string, activityId: string, o: { chatPath?: string; variantSeed?: number } = {}): Promise<PresentationOutcome> {
  const rec = (await eng.store.loadActivities(dir)).find((a) => a.id === activityId);
  if (!rec) throw new Error("That activity is no longer saved.");
  const state = await eng.store.loadState(dir, eng.settings().targetLevel);
  const lesson = rec.lesson ? eng.variant(rec.lesson, o.variantSeed) ?? rec.lesson : null;
  await eng.store.logActivity(dir, { t: new Date().toISOString(), activityId, conceptId: rec.conceptId, event: "opened", trigger: rec.trigger, reason: rec.selectionReason, ...(o.chatPath ? { chatPath: o.chatPath } : {}) });
  if (lesson) await eng.noteActivityHelp(o.chatPath, state, rec.kind);
  const decision: PresentationDecision = { kind: rec.kind, trigger: "explicit", status: rec.status === "ready" ? "cached" : "unsupported", reason: rec.selectionReason, moduleId: rec.moduleId || null, activityId, candidates: rec.moduleId ? [rec.moduleId] : [] };
  const concept = Number(Object.entries(state.concepts).find(([, id]) => id === rec.conceptId)?.[0] ?? NaN);
  return { decision, request: null, activity: rec, lesson, result: lesson ? { status: "ready", lesson } : toResult(rec), fallback: "", cacheHit: true, calls: { local: 0, claude: 0 }, concept: Number.isFinite(concept) ? concept : null };
}

/**
 * The learner's answer inside an activity, assessed by the module's own code. It is logged with
 * the activity and recorded as evidence, always as helped work: an interactive shows its result
 * as the learner works, so it can support "can do with help" and never counts as unaided
 * retention or transfer. No model is called.
 *
 * With `lesson`, the answer was given in a numeric variant of the saved activity (from
 * openActivity with a seed). It is assessed against that variant, which must validate and must
 * be the same activity: module, version, assessment, objective and sources unchanged.
 */
export async function recordActivityResult(eng: Engine, dir: string, activityId: string, response: unknown, o: { hintUsed?: boolean; chatPath?: string; confidence?: number | null; lesson?: unknown } = {}): Promise<{ assessment: AssessmentResult; attempt: Attempt | null; changes: string[] }> {
  const s = eng.settings();
  if (!eng.visuals) throw new Error("No visual modules are installed.");
  const rec = (await eng.store.loadActivities(dir)).find((a) => a.id === activityId);
  if (!rec?.lesson) throw new Error("That activity is no longer saved.");
  let played: VisualLesson = rec.lesson;
  if (o.lesson !== undefined) {
    const v = eng.visuals.validateLesson(o.lesson);
    const same = v.ok && v.lesson.moduleId === rec.lesson.moduleId && v.lesson.moduleVersion === rec.lesson.moduleVersion && v.lesson.assessmentId === rec.lesson.assessmentId && v.lesson.objective === rec.lesson.objective && JSON.stringify(v.lesson.sourceRefs) === JSON.stringify(rec.lesson.sourceRefs);
    if (!v.ok || !same) throw new Error("That activity does not match the saved one, so its answer was not recorded.");
    played = v.lesson;
  }
  const assessment = eng.visuals.assessLesson(played, response);
  // The contract's response carries its own hintsUsed flag; either source marks the hint.
  o = { ...o, hintUsed: !!o.hintUsed || (!!response && typeof response === "object" && (response as Record<string, unknown>).hintsUsed === true) };
  const now = new Date().toISOString();
  const state = await eng.store.loadState(dir, s.targetLevel);
  const n = Number(Object.entries(state.concepts).find(([, id]) => id === rec.conceptId)?.[0] ?? 0);
  let attempt: Attempt | null = null;
  let changes: string[] = [];
  if (assessment.correct !== null && n in state.names) {
    const result: Outcome = assessment.correct ? "correct" : assessment.score !== null && assessment.score > 0 ? "partial" : "incorrect";
    attempt = {
      id: `${activityId}:${now}`,
      v: 2,
      skill: n,
      concept: rec.conceptId,
      questionId: `${activityId}:${rec.lesson.assessmentId}`,
      question: played.predictionQuestion,
      answer: JSON.stringify(response ?? null).slice(0, 400),
      activity: "interactive",
      mode: "activity",
      difficulty: null,
      result,
      errorType: "",
      note: assessment.feedback.slice(0, 300),
      confidence: typeof o.confidence === "number" && o.confidence >= 0 && o.confidence <= 1 ? o.confidence : null,
      assisted: true,
      assistance: ["interactive activity: the representation responds as the learner works", ...(o.hintUsed ? ["the activity's hint was opened"] : [])],
      answerExposed: false,
      transfer: false,
      seconds: null,
      timestamp: now,
      grading: "deterministic",
      verification: "verified",
      assumptions: `assessed by ${rec.moduleId}'s own code; interactive work counts as helped, never as unaided evidence`,
      taskType: "interactive",
      family: `activity-${rec.moduleId}`,
      ...objectiveStamp(state, n),
    };
    state.attempts = recordAttempt(state.attempts, attempt);
    changes = applyAttempt(state, attempt);
    await eng.store.saveState(dir, state);
  }
  await eng.store.logActivity(dir, { t: now, activityId, conceptId: rec.conceptId, event: "assessed", trigger: rec.trigger, reason: rec.selectionReason, correct: assessment.correct, hintUsed: !!o.hintUsed, ...(attempt ? { attemptId: attempt.id } : {}), ...(o.chatPath ? { chatPath: o.chatPath } : {}) });
  return { assessment, attempt, changes };
}

/** The most blueprints one compile plans. Each is one main-provider call, or two with a repair. */
export const MAX_COMPILE_BLUEPRINTS = 8;

export interface BlueprintPlanning { planned: number; ready: number; failed: number; calls: number; usage: Usage }

/**
 * Plans the diagrams and simulations a compiled course marked as worth one, with the main
 * provider, so the learner meets a finished blueprint instead of waiting on the local model.
 * Runs only for the "main" compile strategy (the one that already spends the main provider on
 * every stage) and can be switched off. A concept that already has a record for these sources and
 * this catalogue is skipped, so a refresh costs nothing. Each plan goes through the same checks as a
 * local one, and a failure is saved as a failure, never an error: the course is already written.
 * Study time reuses the ready records and still never calls the main provider.
 */
export async function planBlueprints(eng: Engine, dir: string, opts: { signal?: AbortSignal; progress?: (message: string) => void } = {}): Promise<BlueprintPlanning> {
  const out: BlueprintPlanning = { planned: 0, ready: 0, failed: 0, calls: 0, usage: zeroUsage() };
  const s = eng.settings();
  if (!eng.visuals || s.compileBlueprints === false || compileStrategyFor(s) !== "main") return out;
  const registry = eng.visuals;
  const descriptors = registry.listModuleDescriptors().filter((d) => isSystemsModule(d.id));
  if (!descriptors.length) return out;
  const catalog = registry.catalogVersion();
  const topic = await eng.store.loadTopic(dir);
  const state = await eng.store.loadState(dir, s.targetLevel);
  const modelName = modelIdentity(s, "compileModel");
  const model = providerModel(modelName, async (o) => {
    const r = await eng.call({ model: modelFor(s, "compileModel"), system: o.system, input: o.user, jsonSchema: o.schema, effort: s.effort, timeoutMs: 180_000 }, s);
    out.usage = addUsage(out.usage, r.usage);
    return r.structured !== undefined ? JSON.stringify(r.structured) : r.text;
  });
  const existing = new Set((await eng.store.loadActivities(dir)).map((a) => a.id));
  for (const sk of topic.subskills) {
    if (out.planned >= MAX_COMPILE_BLUEPRINTS || opts.signal?.aborted) break;
    const kind = sk.visual?.kind;
    if (kind !== "diagram" && kind !== "simulation") continue;
    const conceptId = state.concepts[sk.n] ?? "";
    const objective = conceptObjective(sk);
    const refs = await eng.sourceRefsFor(dir, topic, sk.n, objective);
    const context = [sk.section, ...refs.map((r) => r.excerpt)].join("\n");
    const candidate = matchModules(`${objective}\n${context}`, kind, descriptors, undefined, sk.name)[0]?.descriptor;
    if (!candidate) continue;
    if (existing.has(activityKey({ conceptId, objective, kind, moduleId: candidate.id, moduleVersion: candidate.version, catalogVersion: catalog, model: modelName, sourceRefs: refs }))) continue;
    opts.progress?.(`Planning a ${kind} for ${sk.name}…`);
    out.planned++;
    const request: PresentationRequest = { version: 1, kind, reason: sk.visual?.reason ?? "", objective, sourceRefs: refs, preferredModuleId: candidate.id };
    const rec = await configureActivity({ request, conceptId, candidates: [candidate], assets: registry.listAssets(), registry, model, modelName, provider: "main", catalogVersion: catalog, trigger: "compile" });
    out.calls += rec.claudeCalls;
    // A failure that depends on the moment (the CLI missing, a timeout) is not saved, so a later compile tries again.
    if (rec.transient) { out.failed++; continue; }
    await eng.store.saveActivity(dir, rec);
    if (rec.status === "ready") out.ready++;
    else out.failed++;
  }
  return out;
}

/**
 * How activities have fared on a topic: offers never opened (unnecessary activations), local
 * configurations, cache hits, rejected configurations, missing capabilities, and whether the
 * next unaided answer on the concept after an activity was right (resolved) or wrong.
 */
export async function activityReport(eng: Engine, dir: string): Promise<{ offered: number; unopened: number; generated: number; reused: number; failed: number; unsupported: number; assessed: number; resolved: number; unresolved: number; pending: number; localCalls: number; claudeCalls: number }> {
  const log = await eng.store.loadActivityLog(dir);
  const records = await eng.store.loadActivities(dir);
  const state = await eng.store.loadState(dir, eng.settings().targetLevel);
  const count = (ev: string) => log.filter((e) => e.event === ev).length;
  const offeredIds = log.filter((e) => e.event === "offered");
  const opened = new Set(log.filter((e) => e.event === "opened" || e.event === "reused" || e.event === "generated").map((e) => e.conceptId));
  let resolved = 0;
  let unresolved = 0;
  let pending = 0;
  for (const use of log.filter((e) => e.event === "generated" || e.event === "reused" || e.event === "opened")) {
    const n = Number(Object.entries(state.concepts).find(([, id]) => id === use.conceptId)?.[0] ?? 0);
    const next = state.attempts.filter((a) => a.skill === n && a.timestamp > use.t && !a.assisted && !a.answerExposed && a.result !== "ungraded" && a.verification !== "disputed").sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1))[0];
    if (!next) pending++;
    else if (next.result === "correct") resolved++;
    else unresolved++;
  }
  return { offered: offeredIds.length, unopened: offeredIds.filter((e) => !opened.has(e.conceptId)).length, generated: count("generated"), reused: count("reused") + count("opened"), failed: count("failed"), unsupported: count("unsupported"), assessed: count("assessed"), resolved, unresolved, pending, localCalls: records.reduce((a, r) => a + r.localCalls, 0), claudeCalls: records.reduce((a, r) => a + r.claudeCalls, 0) };
}
