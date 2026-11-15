// Tests for on-demand presentation, local activity configuration, the 0.6 evidence and policy
// rules, and the course package. Claude is stubbed and counted; the local model is scripted;
// the visual modules are FIXTURES (tests/fixtures/visual-modules.ts), not the real ones, so
// nothing here shows end-to-end behaviour with the real player. Nothing here costs tokens.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as F from "../src/formats";
import { Attempt, checkDue, skillEvidence, supportedLevel } from "../src/evidence";
import { Engine } from "../src/engine";
import { Store } from "../src/store";
import { DEFAULT_WEIGHTS, PolicyInput, SkillInput, decide, homeStep } from "../src/policy";
import { choosePresentation, extractPresent, matchModules, readPresentationRequest, GateInput } from "../src/presentation";
import { CONFIG_PROMPT_VERSION, activityKey, checkConfiguration, configureActivity, outputSchema } from "../src/configure";
import { ollamaSchema, validateJson } from "../src/jsonschema";
import { LocalModelError, OllamaClient, isLoopback } from "../src/ollama";
import { adaptRegistry } from "../src/visualcontract";
import { buildPackage, mergeRefresh, sourceChanges } from "../src/coursepkg";
import { ARRAY_TRACE, ASSETS, PROJECTILE, arrayReply, makeFixtureRegistry, scriptedModel, trace } from "./fixtures/visual-modules";
import { MemFS } from "./memfs";

const CARD = `# Searching

## Overview
Finding values in arrays, and how a pipe stores bytes.

## Objectives
- O1: Index into an array by position ([[Arrays]])
- O2: Trace binary search on a sorted array ([[Search notes]])
- O3: Explain how a pipe's circular buffer wraps ([[Pipe notes]])
- O4: Compare the cost of linear and binary search (spec 2.4)

## Subskills

### 1. Array indexing
prerequisites: none
objectives: O1
- An array element is read by its index, counting from 0 ([[Arrays]]).
misconceptions:
- the first index is 1
worked example:
For a = [4, 7, 9], a[2] is 9: indices start at 0, so index 2 is the third element.

### 2. Binary search
prerequisites: 1
objectives: O2
visual: simulation | watching the search range halve on a sorted array
- Binary search compares the target with the middle element and halves the range ([[Search notes]]).
misconceptions:
- binary search works on unsorted arrays
worked example:
Search 25 in [3, 8, 12, 19, 25]: the middle 12 is below 25, so keep [19, 25]; 19 is below 25; then 25 is found.

### 3. Pipe buffer
prerequisites: 1
objectives: O3
visual: simulation | the read and write indices wrap around the array
- A pipe is an array-based circular buffer whose read and write indices wrap around ([[Pipe notes]]).
worked example:
With 4 slots, after writing slot 3 the write index wraps to slot 0, if slot 0 has been read.
`;

const BANK = `### Q1
subskill: 1
type: mcq
family: index-basics
task: recall
difficulty: 1
question: What is the first index of an array?
options:
- A. 0
- B. 1
answer: A
explanation: Indices count from 0.

### Q2
subskill: 1
type: short
family: index-basics
task: application
question: For a = [4, 7, 9], what is a[1]?
answer: 7
explanation: Index 1 is the second element.

### Q3
subskill: 2
type: mcq
family: halving
task: application
question: What does binary search compare the target with?
options:
- A. The first element
- B. The middle element
answer: B
explanation: It halves the range.

### Q4
subskill: 2
type: short
family: halving-transfer
task: transfer
question: How many comparisons at most for 7 sorted items?
answer: 3
explanation: Halving 7 three times.

### Q5
subskill: 3
type: open
family: wrap
task: explanation
question: Why does a pipe's write index go back to 0?
answer: The buffer is circular, so the index wraps after the last slot.
rubric: says the buffer is fixed-size; says the index wraps to the start; says it only reuses slots already read
explanation: Circular buffer.
`;

const NOTES: Record<string, string> = {
  "Search notes": "Binary search works on a sorted array only.\n\nBinary search compares the target with the middle element of the current range and discards the half that cannot contain it, so each comparison halves the range.",
  "Pipe notes": "A pipe is an array-based circular buffer in kernel memory.\n\nThe kernel keeps a read index and a write index that wrap around to the start of the array when they reach the end of it.",
  Arrays: "An array is a block of elements read by index, counting from zero.",
};

const usage = { input: 10, cacheRead: 0, cacheWrite: 0, output: 10, costUsd: 0, calls: 1 };
const session = (o: Record<string, unknown>) => `<session>${JSON.stringify({ helpGiven: [], nextAction: "check", completedStep: false, ...o })}</session>`;

async function setup(o: { local?: (string | Error)[]; registry?: ReturnType<typeof makeFixtureRegistry> | null; settings?: Record<string, unknown> } = {}) {
  const fs = new MemFS();
  const day = "2026-11-14";
  const store = new Store(fs, "Tutor", () => day);
  const settings: any = { claudePath: "", chatModel: "sonnet", compileModel: "sonnet", utilityModel: "haiku", effort: "low", targetLevel: 4, maxChatWords: 6000, maxTopicWords: 4000, singlePassWords: 6000, smartRouting: false, hardEffort: "high", bankQuiz: true, codePlacement: false, ...(o.settings ?? {}) };
  const engine = new Engine(store, () => settings, () => day);
  const dir = await store.saveCompiled({ title: "Searching", fm: { subject: "none" }, topicBody: F.parseCompileOutput(CARD).topicBody, questionsBody: BANK, target: 4 });
  const notes = { ...NOTES };
  engine.readSource = async (name) => (name in notes ? { path: `Software/${name}.md`, text: notes[name] } : null);
  const registry = o.registry === undefined ? makeFixtureRegistry() : o.registry;
  if (registry) engine.visuals = adaptRegistry(registry as any);
  const local = scriptedModel(o.local ?? []);
  engine.local = local;
  const calls: any[] = [];
  const replies: string[] = [];
  (engine as any).call = async (x: any) => {
    calls.push(x);
    return { text: replies.shift() ?? "ok", usage };
  };
  const chatIn = (mode: F.Mode) => store.newChat(dir, "Searching", mode, new Date(2026, 10, 14, 9, 0));
  const focus = async (n: number, levels: Record<number, number | null>, attempts: Attempt[] = [], misconceptions: string[] = []) => {
    const s = await store.loadState(dir, 4);
    s.focus = n;
    s.levels = { 1: null, 2: null, 3: null, ...levels };
    s.attempts = attempts;
    s.misconceptions = misconceptions;
    await store.saveState(dir, s);
  };
  return { fs, store, engine, dir, calls, replies, local, registry, notes, settings, chatIn, focus };
}

const att = (over: Partial<Attempt> & { id: string }): Attempt => ({
  v: 2, skill: 2, concept: "", questionId: `q-${over.id}`, question: `question ${over.id}`, answer: "a", activity: "independent-practice", mode: "auto", difficulty: null,
  result: "correct", errorType: "", note: "", confidence: null, assisted: false, assistance: [], answerExposed: false, transfer: false, seconds: null,
  timestamp: "2026-11-10T10:00:00.000Z", grading: "deterministic", verification: "verified", assumptions: "", ...over,
});

const gate = (over: Partial<GateInput> = {}): GateInput => ({ mode: "auto", action: "check", message: "it works on any list", objective: "Binary search: compares the target with the middle element", context: "Binary search halves the range on a sorted array", recentFailures: 0, errorType: "", misconception: false, eligibility: { kind: "simulation", reason: "watching the range halve" }, descriptors: [ARRAY_TRACE, PROJECTILE], saved: [], ...over });

// ---------- the gate: when a presentation is chosen ----------

test("explicit requests are read from the learner's words; an answer that mentions a diagram is not a request", () => {
  assert.equal(readPresentationRequest("can you show me a simulation of this?")?.kind, "simulation");
  assert.equal(readPresentationRequest("simulate it")?.kind, "simulation");
  assert.equal(readPresentationRequest("give me a game to practise this")?.kind, "game");
  assert.equal(readPresentationRequest("could you draw me a diagram")?.kind, "diagram");
  assert.equal(readPresentationRequest("show me an example step by step")?.kind, "worked-example");
  assert.equal(readPresentationRequest("just explain it in words please")?.kind, "text");
  assert.equal(readPresentationRequest("is there a PhET activity for this?")?.kind, "external");
  assert.equal(readPresentationRequest("The diagram in my notes has the write index ahead of the read index because the writer moved first and the reader has not caught up"), null);
  assert.equal(readPresentationRequest("25 is found after three comparisons"), null);
  assert.equal(readPresentationRequest(""), null);
});

test("the gate picks the simplest sufficient format and never fires on opening or on a first error", () => {
  // Opening a chat or pressing Continue: nothing, even on an eligible concept with a module.
  assert.equal(choosePresentation(gate({ message: "", recentFailures: 3, errorType: "conceptual" }), null).status, "none");
  // A first error, or repeated slips, gets a narrower question, not a simulation.
  assert.equal(choosePresentation(gate({ recentFailures: 1, errorType: "conceptual" }), null).status, "none");
  assert.equal(choosePresentation(gate({ recentFailures: 2, errorType: "arithmetic" }), null).status, "none");
  // Repeated failure without a diagnosed kind of error: still no interactive.
  assert.equal(choosePresentation(gate({ recentFailures: 2, errorType: "" }), null).status, "none");
  // Repeated, diagnosed conceptual difficulty on a concept marked for simulation: offered, not generated.
  const offer = choosePresentation(gate({ recentFailures: 2, errorType: "conceptual" }), null);
  assert.deepEqual([offer.status, offer.kind, offer.trigger, offer.moduleId], ["offer", "simulation", "difficulty", "fixture-array-trace"]);
  assert.ok(offer.reason.length <= 140 && /went wrong again/.test(offer.reason));
  // ...and with a saved activity, that one is offered as it is.
  const cached = choosePresentation(gate({ recentFailures: 2, errorType: "conceptual", saved: [{ id: "act-1", kind: "simulation", moduleId: "fixture-array-trace", status: "ready" }] }), null);
  assert.deepEqual([cached.status, cached.activityId], ["cached", "act-1"]);
  // No eligibility recorded: a difficulty alone never brings an interactive.
  assert.equal(choosePresentation(gate({ recentFailures: 3, errorType: "conceptual", eligibility: null }), null).status, "none");
  // A stable structure marked for a diagram is drawn by the tutor, with no module.
  const diagram = choosePresentation(gate({ recentFailures: 2, errorType: "conceptual", eligibility: { kind: "diagram", reason: "" } }), null);
  assert.deepEqual([diagram.status, diagram.kind], ["text", "diagram"]);
  // Learn and Ask never select one unasked.
  assert.equal(choosePresentation(gate({ mode: "teach", recentFailures: 2, errorType: "conceptual" }), null).status, "none");
  assert.equal(choosePresentation(gate({ mode: "expert", recentFailures: 2, errorType: "conceptual" }), null).status, "none");
});

test("an explicit request overrides the default and executes directly; unsupported kinds are said to be so", () => {
  const ask = (kind: any, over: Partial<GateInput> = {}) => choosePresentation(gate({ mode: "teach", ...over }), { kind, said: "x" });
  assert.deepEqual([ask("simulation").status, ask("simulation").moduleId], ["configure", "fixture-array-trace"]);
  assert.equal(ask("text").status, "text", "words only, as asked");
  assert.equal(ask("worked-example").status, "text", "the tutor writes worked examples");
  assert.equal(ask("diagram", { descriptors: [] }).status, "text", "with no diagram module the tutor draws a small one");
  const none = ask("simulation", { descriptors: [] });
  assert.deepEqual([none.status, none.trigger], ["unsupported", "explicit"]);
  assert.match(none.reason, /No simulation module can show/);
  // The tutor's structured proposal can only become an offer.
  assert.equal(choosePresentation(gate({ mode: "tutor" }), null, "simulation").status, "offer");
  assert.equal(choosePresentation(gate({ mode: "tutor", message: "" }), null, "simulation").status, "none");
  assert.equal(choosePresentation(gate({ mode: "tutor", descriptors: [] }), null, "simulation").status, "none");
});

test("module matching is a shortlist by supported objectives; the excerpt still has to fit", () => {
  assert.deepEqual(matchModules("Binary search halves the sorted array", "simulation", [ARRAY_TRACE, PROJECTILE]).map((m) => [m.descriptor.id, m.phrase]), [["fixture-array-trace", "binary search"]]);
  // A pipe's circular buffer shares "array" and "index" with the array trace: it is shortlisted,
  // and it is the configuration step that has to say it does not fit.
  assert.equal(matchModules("A pipe is an array-based circular buffer whose read and write indices wrap around", "simulation", [ARRAY_TRACE])[0]?.phrase, "array indexing");
  assert.deepEqual(matchModules("A process moves from running to ready when the scheduler preempts it", "simulation", [ARRAY_TRACE, PROJECTILE]), []);
  assert.deepEqual(matchModules("projectile range at a launch angle", "diagram", [PROJECTILE]), [], "a module that does not render diagrams is not offered for one");
  assert.deepEqual(extractPresent('Try again.\n<present>{"kind":"simulation","reason":"watch it halve"}</present>'), { text: "Try again.", kind: "simulation", reason: "watch it halve" });
  assert.equal(extractPresent('x <present>{"kind":"hologram"}</present>').kind, null);
});

// ---------- configuration by the local model ----------

const req = (over: Record<string, unknown> = {}) => ({ version: 1 as const, kind: "simulation" as const, reason: "You asked for a simulation.", objective: "Binary search: compares the target with the middle element", sourceRefs: [{ path: "Software/Search notes.md", contentHash: "abc", excerpt: "Binary search compares the target with the middle element and halves the range." }], ...over });
const configure = (replies: (string | Error)[], over: Record<string, unknown> = {}) => {
  const model = scriptedModel(replies);
  const registry = adaptRegistry(makeFixtureRegistry() as any);
  return { model, run: configureActivity({ request: req(), conceptId: "c/binary", candidates: [ARRAY_TRACE], assets: ASSETS, registry, model, catalogVersion: "fixture-catalog-1", trigger: "explicit", ...over } as any) };
};

test("a valid configuration is accepted on the first pass, with provenance, timing and call counts", async () => {
  const { model, run } = configure([arrayReply()]);
  const r = await run;
  assert.equal(r.status, "ready");
  assert.deepEqual([r.localCalls, r.repairs, r.claudeCalls, r.firstPassValid], [1, 0, 0, true]);
  assert.equal(r.lesson!.schemaVersion, 1);
  assert.deepEqual([r.lesson!.moduleId, r.lesson!.moduleVersion, r.lesson!.assessmentId], ["fixture-array-trace", "0.0.0-fixture", "predict-comparisons"]);
  assert.equal(r.lesson!.sourceRefs[0].path, "Software/Search notes.md");
  assert.deepEqual([r.model, r.promptVersion, r.catalogVersion], ["qwen2.5:3b", CONFIG_PROMPT_VERSION, "fixture-catalog-1"]);
  assert.ok(r.timing.localMs > 0 && r.timing.promptTokens === 160 && r.timing.evalTokens === 120);
  // The prompt holds only the module, its assessments, approved assets, the objective and the excerpt.
  const sent = model.requests[0];
  assert.match(sent.user, /^MODULE fixture-array-trace v0\.0\.0-fixture/);
  assert.match(sent.user, /ASSETS: none/, "the array trace takes no projectile assets");
  assert.match(sent.user, /EXCERPT 1 \(Software\/Search notes\.md\): Binary search compares/);
  assert.equal(sent.temperature, 0.1);
  assert.ok((sent.maxTokens ?? 0) <= 400);
  // The expected answer comes from the module's own algorithm, never from the model.
  assert.equal(trace(r.lesson!.settings).comparisons, 3, "19, then 31, then 25");
});

test("malformed JSON gets one bounded repair; a second failure is a final invalid record", async () => {
  const fixed = await configure(["{not json", arrayReply()]).run;
  assert.deepEqual([fixed.status, fixed.localCalls, fixed.repairs, fixed.firstPassValid], ["ready", 2, 1, false]);
  const { model, run } = configure(["{not json", "still not json"]);
  const broken = await run;
  assert.deepEqual([broken.status, broken.localCalls, broken.repairs, broken.claudeCalls], ["invalid", 2, 1, 0]);
  assert.match(broken.validationErrors[0], /not valid JSON/);
  assert.match(model.requests[1].user, /IT FAILED THESE CHECKS:\n- the reply is not valid JSON/, "the repair names the problem");
  assert.equal(model.requests.length, 2, "never more than one repair");
});

test("module-owned checks reject impossible challenges and unsound settings", async () => {
  // Binary search on unsorted values: the module's own validation refuses it, twice.
  const unsorted = arrayReply({ settings: { algorithm: "binary-search", values: [9, 3, 7], target: 3 } });
  const r = await configure([unsorted, unsorted]).run;
  assert.equal(r.status, "invalid");
  assert.match(r.validationErrors.join("\n"), /module fixture-array-trace: settings.values: binary search needs the values in ascending order/);
  // An unreachable projectile target: v = 5 m/s gives at most 2.55 m, the target is at 40 m.
  const far = JSON.stringify({ fits: true, objective: "projectile range depends on the launch angle", settings: { speed: 5, minAngle: 10, maxAngle: 80, gravity: 9.81, targetDistance: 40, targetWidth: 1 }, assetIds: ["fixture-ball"], assessmentId: "hit-target", predictionQuestion: "Which launch angle lands the ball on the target?", hint: "Think about which angle gives the longest range.", missingOperation: "" });
  const p = await configureActivity({ request: req({ objective: "projectile range depends on the launch angle", sourceRefs: [{ path: "fixture", contentHash: "f", excerpt: "The range of a projectile depends on its launch angle and speed." }] }), conceptId: "c/proj", candidates: [PROJECTILE], assets: ASSETS, registry: adaptRegistry(makeFixtureRegistry() as any), model: scriptedModel([far, far]), catalogVersion: "c", trigger: "explicit" });
  assert.equal(p.status, "invalid");
  assert.match(p.validationErrors.join("\n"), /target cannot be reached: the furthest landing point is 2\.55 m/);
});

test("ids outside the shortlist, code, links and answer-giving hints are refused", () => {
  const reg = adaptRegistry(makeFixtureRegistry() as any);
  const check = (over: Record<string, unknown>) => checkConfiguration(arrayReply(over), req(), ARRAY_TRACE, [], reg).errors.join("\n");
  assert.match(check({ assetIds: ["fixture-ball"] }), /assetIds/, "the array trace has no approved assets");
  assert.match(check({ assessmentId: "invented-checker" }), /assessmentId/);
  assert.match(check({ hint: "Use (v) => v.indexOf(25) to check" }), /looks like code/);
  assert.match(check({ predictionQuestion: "Open https://example.com and count the steps?" }), /link or file path/);
  assert.match(check({ hint: "The answer is 2." }), /appears to state the answer/);
  assert.match(check({ settings: { algorithm: "binary-search", values: [1, 2, 3], target: 2, checker: "x" } }), /unexpected field "checker"/);
  assert.match(check({ objective: "learn about volcano eruptions", predictionQuestion: "How tall is a volcano?" }), /share no content words/);
  assert.equal(check({}), "");
  // Prose that quotes a command in backticks, or says "only = ...", is not code (seen in the benchmark).
  assert.equal(check({ hint: "Think about what `binary search` checks first, only after the middle one." }), "");
  assert.match(check({ hint: "Click <a onclick=x>here</a> to see the middle element." }), /looks like code/);
});

test("an unsupported capability is a structured record, from code or from the local model's fit check", async () => {
  const none = await configureActivity({ request: req({ objective: "Process states: ready, running and blocked" }), conceptId: "c/ps", candidates: [], assets: [], registry: adaptRegistry(makeFixtureRegistry() as any), model: scriptedModel([]), catalogVersion: "c", trigger: "explicit" });
  assert.deepEqual([none.status, none.localCalls], ["unsupported", 0], "nothing matched, so no model was asked");
  assert.equal(none.missingCapability!.kind, "simulation");
  const pipe = await configure([JSON.stringify({ fits: false, missingOperation: "circular buffer with wrapping read and write indices" })]).run;
  assert.deepEqual([pipe.status, pipe.localCalls, pipe.claudeCalls], ["unsupported", 1, 0]);
  assert.equal(pipe.missingCapability!.operation, "circular buffer with wrapping read and write indices");
  // A server that is down is a transient failure: reported, not cached as a verdict.
  const down = await configure([new LocalModelError("unreachable", "Ollama is not reachable")]).run;
  assert.deepEqual([down.status, down.transient], ["invalid", true]);
  assert.match(down.reason, /not reachable/);
  // Local configuration switched off: transient too, and no model is called.
  const off = await configureActivity({ request: req(), conceptId: "c", candidates: [ARRAY_TRACE], assets: [], registry: adaptRegistry(makeFixtureRegistry() as any), model: null, catalogVersion: "c", trigger: "explicit" });
  assert.deepEqual([off.status, off.transient, off.localCalls], ["invalid", true, 0]);
});

test("the cache key covers sources, module, schema, model, prompt and catalogue versions", () => {
  const base = { conceptId: "c", objective: "o", kind: "simulation" as const, moduleId: "m", moduleVersion: "1", catalogVersion: "k", model: "qwen2.5:3b", sourceRefs: [{ path: "p", contentHash: "h", excerpt: "e" }] };
  const k = activityKey(base);
  assert.equal(activityKey({ ...base, sourceRefs: [{ path: "p", contentHash: "h", excerpt: "another excerpt" }] }), k, "the excerpt text is not part of the key; the source hash is");
  for (const over of [{ moduleVersion: "2" }, { catalogVersion: "k2" }, { model: "qwen3:1.7b" }, { sourceRefs: [{ path: "p", contentHash: "h2", excerpt: "e" }] }, { kind: "game" as const }, { objective: "o2" }]) assert.notEqual(activityKey({ ...base, ...over }), k, JSON.stringify(over));
});

test("the schema sent to Ollama is closed and never has an empty enum; local validation re-checks bounds", () => {
  const s = outputSchema(ARRAY_TRACE, []);
  const sent = ollamaSchema(s) as any;
  assert.deepEqual(sent.properties.assetIds, { type: "array", items: { type: "string" }, maxItems: 0 });
  assert.equal(sent.additionalProperties, false);
  assert.equal(sent.properties.settings.additionalProperties, false);
  assert.deepEqual(ollamaSchema({ type: "object", properties: { x: { type: "string", enum: [] } } }).properties, { x: { type: "null" } });
  assert.deepEqual(validateJson({ a: 5, b: [1, 2, 3, 4] }, { type: "object", properties: { a: { type: "integer", maximum: 4 }, b: { type: "array", maxItems: 3 } }, required: ["a", "c"] }), ["$: is missing \"c\"", "$.a: must be at most 4", "$.b: must have at most 3 items"]);
});

test("the Ollama client sends a bounded structured request to loopback only and reads Ollama's timings", async () => {
  const sent: any[] = [];
  const transport = async (method: string, url: string, body: string | null) => {
    sent.push({ method, url, body: body ? JSON.parse(body) : null });
    return { status: 200, body: JSON.stringify({ model: "qwen2.5:3b", message: { content: '{"fits":true}' }, done_reason: "stop", load_duration: 6.7e9, prompt_eval_count: 159, prompt_eval_duration: 1.7e9, eval_count: 166, eval_duration: 16.3e9, total_duration: 20.1e9 }) };
  };
  const c = new OllamaClient({ transport });
  const r = await c.chatJson({ system: "s", user: "u", schema: outputSchema(ARRAY_TRACE, []) });
  assert.equal(sent[0].url, "http://127.0.0.1:11434/api/chat");
  assert.deepEqual([sent[0].body.stream, sent[0].body.options.temperature, sent[0].body.options.num_predict, sent[0].body.model], [false, 0.1, 400, "qwen2.5:3b"]);
  assert.equal(sent[0].body.format.properties.assetIds.maxItems, 0);
  assert.deepEqual([r.timing.loadMs, r.timing.promptTokens, r.timing.evalTokens, r.timing.evalMs], [6700, 159, 166, 16300]);
  assert.equal(isLoopback("http://192.168.1.4:11434"), false);
  await assert.rejects(new OllamaClient({ baseUrl: "http://192.168.1.4:11434", transport }).chatJson({ system: "", user: "", schema: {} }), /local Ollama/);
  const missing = new OllamaClient({ transport: async () => ({ status: 404, body: JSON.stringify({ error: "model 'qwen2.5:3b' not found, try pulling it first" }) }) });
  await assert.rejects(missing.chatJson({ system: "", user: "", schema: {} }), (e: any) => e instanceof LocalModelError && e.kind === "model-missing" && /ollama pull qwen2\.5:3b/.test(e.message));
});

// ---------- the engine: presentation in real study turns, Claude stubbed and counted ----------

test("an explicit request for a supported activity opens with zero Claude calls, and the answer after it counts as helped", async () => {
  const t = await setup({ local: [arrayReply()] });
  await t.focus(2, { 1: 3, 2: 2 });
  const chat = await t.chatIn("auto");
  t.replies.push(`Try one.\n\nWhich element does binary search compare with first in [3, 8, 12]?\n${session({ pendingQuestion: "Which element does binary search compare with first in [3, 8, 12]?" })}`);
  await t.engine.study(t.dir, chat, "");
  assert.equal(t.calls.length, 1);

  const r = await t.engine.study(t.dir, chat, "can you show me a simulation of this?");
  assert.equal(t.calls.length, 1, "no Claude call for an existing module");
  assert.equal(r.local, true);
  assert.deepEqual([r.presentation!.decision.status, r.presentation!.decision.trigger, r.presentation!.calls], ["configure", "explicit", { local: 1, claude: 0 }]);
  assert.equal(r.presentation!.lesson!.moduleId, "fixture-array-trace");
  assert.match(r.reply, /\*\*Simulation\*\* · You asked for a simulation[\s\S]*How many comparisons will binary search make/);
  // The configuration is saved with the plugin's files, with provenance; learner work is not in it.
  const saved = await t.store.loadActivities(t.dir);
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].sourceRefs.map((s) => s.path), ["Software/Search notes.md"]);
  assert.equal(saved[0].sourceRefs[0].contentHash, F.contentHash(saved[0].sourceRefs[0].excerpt));
  assert.match(saved[0].sourceRefs[0].contentHash, /^[0-9a-f]{64}$/, "SHA-256, as the contract requires");
  assert.match(saved[0].sourceRefs[0].excerpt, /halves the range/);
  assert.ok(t.fs.files.has(`${t.dir}/activities.md`) && t.fs.files.has(`${t.dir}/activity-log.md`));
  // The request is help with the open question, which stays open.
  const record = JSON.parse(String((await t.store.loadChat(chat)).fm.session));
  assert.equal(record.pendingQuestion, "Which element does binary search compare with first in [3, 8, 12]?");
  assert.match(record.helpGiven.join(" "), /simulation/);

  t.replies.push(`Right.\n<attempt>{"skill":2,"result":"correct","assisted":false,"transfer":false,"task_type":"application"}</attempt>\n${session({ pendingQuestion: "", completedStep: true })}`);
  const answered = await t.engine.study(t.dir, chat, "8");
  assert.equal(answered.attempt!.result, "correct");
  assert.equal(answered.attempt!.assisted, true, "an answer given after opening the activity is helped work");
  assert.match(answered.attempt!.assistance.join(" "), /simulation/);
  assert.equal(skillEvidence(answered.state.attempts, 2).independent, 0);
});

test("saved activities are reused with no model at all; a changed source note or catalogue is a miss", async () => {
  const t = await setup({ local: [arrayReply(), arrayReply({ objective: "binary search on the new notes" })] });
  await t.focus(2, { 1: 3, 2: 2 });
  const first = await t.engine.requestActivity(t.dir, { kind: "simulation" });
  assert.deepEqual([first.cacheHit, first.calls.local, t.local.requests.length], [false, 1, 1]);
  const again = await t.engine.requestActivity(t.dir, { kind: "simulation" });
  assert.deepEqual([again.decision.status, again.cacheHit, again.calls.local, t.local.requests.length, t.calls.length], ["cached", true, 0, 1, 0]);
  // Reopening by id, and a code-made variant checked by the module: no model either.
  const reopened = await t.engine.openActivity(t.dir, again.activity!.id, { variantSeed: 3 });
  assert.equal(t.local.requests.length, 1);
  const v = reopened.lesson!.settings.values as number[];
  assert.deepEqual(v, [...v].sort((a, b) => a - b), "the variant is still a valid binary-search array");
  assert.notDeepEqual(v, [3, 8, 12, 19, 25, 31, 40]);
  // An unrelated paragraph is added: the passage the activity rests on is unchanged, so it is reused.
  t.notes["Search notes"] += "\n\nThis note was revised for the midterm in week six.";
  assert.equal((await t.engine.requestActivity(t.dir, { kind: "simulation" })).cacheHit, true);
  // The passage itself changes: the old configuration no longer matches its source hash.
  t.notes["Search notes"] = t.notes["Search notes"].replace("halves the range", "halves the remaining range each time");
  const changed = await t.engine.requestActivity(t.dir, { kind: "simulation" });
  assert.deepEqual([changed.cacheHit, changed.calls.local, t.local.requests.length], [false, 1, 2]);
  assert.equal((await t.store.loadActivities(t.dir)).length, 2, "the old record stays on disk");
  assert.equal(t.calls.length, 0, "Claude was never called");
});

test("an unsupported request falls back to the compiled worked lesson with no Claude call, and the gap is recorded once", async () => {
  const notFit = JSON.stringify({ fits: false, objective: "how a pipe's circular buffer wraps", settings: { algorithm: "linear-search", values: [1, 2, 3], target: 1 }, assetIds: [], assessmentId: "predict-comparisons", predictionQuestion: "What happens next?", hint: "Look at the end.", missingOperation: "circular buffer with wrapping read and write indices" });
  const t = await setup({ local: [notFit] });
  await t.focus(3, { 1: 3, 3: 1 });
  const chat = await t.chatIn("tutor");
  const r = await t.engine.study(t.dir, chat, "show me a simulation of the pipe buffer");
  assert.equal(t.calls.length, 0);
  assert.equal(r.presentation!.activity!.status, "unsupported");
  assert.match(r.reply, /No simulation for this yet[\s\S]*worked example from your course[\s\S]*write index wraps to slot 0/);
  const caps = await t.store.loadCapabilities();
  assert.deepEqual(caps.map((c) => [c.operation, c.count]), [["circular buffer with wrapping read and write indices", 1]]);
  // Asked again: the saved verdict is reused. No local call, no Claude call.
  await t.engine.study(t.dir, chat, "show me a simulation of the pipe buffer");
  assert.deepEqual([t.local.requests.length, t.calls.length], [1, 0]);
  // With no modules installed at all, the same request is declined in code.
  const bare = await setup({ registry: null });
  await bare.focus(3, { 1: 3, 3: 1 });
  const out = await bare.engine.requestActivity(bare.dir, { kind: "simulation" });
  assert.deepEqual([out.activity!.status, out.calls.local, bare.local.requests.length], ["unsupported", 0, 0]);
});

test("repeated configuration failure is cached and never retried silently, by either model", async () => {
  const t = await setup({ local: ["{broken", "{still broken"] });
  await t.focus(2, { 1: 3, 2: 2 });
  const chat = await t.chatIn("quiz");
  const r = await t.engine.study(t.dir, chat, "show me a simulation");
  assert.deepEqual([r.presentation!.activity!.status, r.presentation!.activity!.repairs, r.presentation!.calls.local], ["invalid", 1, 2]);
  assert.equal(t.calls.length, 0, "a failed configuration does not fall back to Claude");
  assert.match(r.reply, /worked example from your course[\s\S]*the middle 12 is below 25/);
  await t.engine.study(t.dir, chat, "show me a simulation");
  assert.deepEqual([t.local.requests.length, t.calls.length], [2, 0], "the same input and versions are not tried again");
});

test("a sufficient text explanation adds nothing; opening a chat never starts an activity", async () => {
  const t = await setup({ local: [] });
  await t.focus(2, { 1: 3, 2: 2 });
  const chat = await t.chatIn("auto");
  t.replies.push(`Which element is compared first in [3, 8, 12]?\n${session({ pendingQuestion: "Which element is compared first in [3, 8, 12]?" })}`);
  const opened = await t.engine.study(t.dir, chat, "");
  assert.equal(opened.presentation, undefined, "opening an eligible concept generates nothing");
  t.replies.push(`Right.\n<attempt>{"skill":2,"result":"correct","assisted":false}</attempt>\n${session({ pendingQuestion: "", completedStep: true })}`);
  const answered = await t.engine.study(t.dir, chat, "8");
  assert.equal(answered.presentation, undefined);
  assert.equal(t.local.requests.length, 0);
  assert.ok(!t.fs.files.has(`${t.dir}/activities.md`));
  // Asking for words: one ordinary turn, told to keep to text.
  t.replies.push(`Binary search keeps the half that can still hold the target.\n${session({ pendingQuestion: "", completedStep: true })}`);
  const words = await t.engine.study(t.dir, chat, "just explain it in words");
  assert.equal(words.presentation!.decision.status, "text");
  assert.match(t.calls[t.calls.length - 1].input, /Presentation: the learner wants this in words/);
  assert.equal(t.local.requests.length, 0);
});

test("a repeated, diagnosed difficulty offers an activity beside the reply; it is configured only if opened", async () => {
  const t = await setup({ local: [arrayReply()] });
  const wrong = (id: string, at: string) => att({ id, result: "incorrect", errorType: "conceptual", timestamp: at });
  await t.focus(2, { 1: 3, 2: 2 }, [wrong("w1", "2026-11-13T10:00:00.000Z"), wrong("w2", "2026-11-13T11:00:00.000Z")], ["binary search works on unsorted arrays"]);
  const chat = await t.chatIn("tutor");
  t.replies.push(`Look again.\n${session({ pendingQuestion: "Does binary search work on [9, 3, 7]?" })}`);
  const r = await t.engine.study(t.dir, chat, "I think it works on any list");
  assert.deepEqual([r.presentation!.decision.status, r.presentation!.decision.trigger], ["offer", "difficulty"]);
  assert.equal(t.local.requests.length, 0, "offered, not generated");
  assert.match(t.calls[0].input, /Presentation: an interactive simulation on this is offered/);
  const log = await t.store.loadActivityLog(t.dir);
  assert.deepEqual(log.map((e) => e.event), ["offered"]);
  let report = await t.engine.activityReport(t.dir);
  assert.deepEqual([report.offered, report.unopened, report.generated], [1, 1, 0], "an offer never opened is counted as unnecessary");
  // Opened from the interface: configured now, still no Claude call.
  const opened = await t.engine.requestActivity(t.dir, { kind: "simulation", chatPath: chat });
  assert.deepEqual([opened.lesson!.moduleId, t.calls.length], ["fixture-array-trace", 1]);
  report = await t.engine.activityReport(t.dir);
  assert.deepEqual([report.generated, report.unopened, report.claudeCalls], [1, 0, 0]);
});

test("the tutor may propose an interactive in a reply it writes anyway; the field is stripped and only an offer results", async () => {
  const t = await setup({ local: [] });
  await t.focus(2, { 1: 3, 2: 2 });
  const chat = await t.chatIn("tutor");
  t.replies.push(`Trace it step by step.\n<present>{"kind":"simulation","reason":"watch the range halve"}</present>\n${session({ pendingQuestion: "Which half is kept?" })}`);
  const r = await t.engine.study(t.dir, chat, "why does it halve?");
  assert.ok(!/<present>/.test(r.reply));
  assert.deepEqual([r.presentation!.decision.status, r.presentation!.decision.trigger], ["offer", "tutor"]);
  assert.match(t.calls[0].input, /you may add <present>/, "the field is described only where a module could exist");
  assert.equal(t.local.requests.length, 0);
  // With no modules, the rule is not sent at all.
  const bare = await setup({ registry: null });
  await bare.focus(2, { 1: 3, 2: 2 });
  bare.replies.push(`ok\n${session({ pendingQuestion: "" })}`);
  await bare.engine.study(bare.dir, await bare.chatIn("tutor"), "why does it halve?");
  assert.ok(!/<present>/.test(bare.calls[0].input));
});

test("an answer inside an activity is assessed by module code and recorded as helped work, apart from the activity cache", async () => {
  const t = await setup({ local: [arrayReply()] });
  await t.focus(2, { 1: 3, 2: null });
  const out = await t.engine.requestActivity(t.dir, { kind: "simulation" });
  const res = await t.engine.recordActivityResult(t.dir, out.activity!.id, { answer: 3, hintsUsed: true });
  assert.equal(res.assessment.correct, true, "three comparisons, by the module's own trace");
  assert.deepEqual([res.attempt!.assisted, res.attempt!.taskType, res.attempt!.grading, res.attempt!.transfer], [true, "interactive", "deterministic", false]);
  assert.match(res.attempt!.assistance.join(" "), /hint was opened/);
  const s = await t.store.loadState(t.dir, 4);
  assert.equal(s.levels[2], 2, "helped work can show 'can follow along'");
  assert.equal(skillEvidence(s.attempts, 2).independent, 0, "never unaided evidence");
  const wrong = await t.engine.recordActivityResult(t.dir, out.activity!.id, { answer: 5 });
  assert.equal(wrong.attempt!.result, "incorrect");
  const unanswered = await t.engine.recordActivityResult(t.dir, out.activity!.id, {});
  assert.equal(unanswered.attempt, null, "nothing to assess, nothing recorded");
  assert.deepEqual((await t.store.loadActivityLog(t.dir)).map((e) => e.event), ["generated", "assessed", "assessed", "assessed"]);
  assert.ok(!(await t.store.loadActivities(t.dir))[0].hasOwnProperty("attempts"), "learner attempts are not kept with the configuration");
  assert.equal(t.calls.length, 0);
});

// ---------- 0.6 evidence and policy ----------

test("helped work does not renew retention or move the next delayed check", () => {
  const unaided = [att({ id: "a", timestamp: "2026-11-01T10:00:00.000Z" }), att({ id: "b", timestamp: "2026-11-02T10:00:00.000Z" })];
  const e = skillEvidence(unaided, 2);
  assert.deepEqual([e.streakDays, e.nextCheck, e.lastIndependent?.slice(0, 10)], [2, "2026-11-05", "2026-11-02"]);
  const helped = skillEvidence([...unaided, att({ id: "c", assisted: true, timestamp: "2026-11-04T10:00:00.000Z" })], 2);
  assert.deepEqual([helped.nextCheck, helped.lastIndependent?.slice(0, 10), helped.last?.slice(0, 10)], ["2026-11-05", "2026-11-02", "2026-11-04"]);
  assert.equal(checkDue(helped, "2026-11-05"), true);
  const failed = skillEvidence([...unaided, att({ id: "d", result: "incorrect", timestamp: "2026-11-05T10:00:00.000Z" })], 2);
  assert.equal(failed.nextCheck, "2026-11-06", "a failed check comes back the next day");
});

test("question families decide transfer: a familiar family is not a transfer, a fresh one on a later day is", () => {
  const first = att({ id: "1", family: "halving", taskType: "application", timestamp: "2026-11-01T10:00:00.000Z" });
  const second = att({ id: "2", family: "halving", taskType: "application", timestamp: "2026-11-01T11:00:00.000Z" });
  const familiar = att({ id: "3", family: "halving", taskType: "application", transfer: true, timestamp: "2026-11-03T10:00:00.000Z" });
  assert.equal(skillEvidence([first, second, familiar], 2).delayedTransfer, false, "the tutor's transfer flag cannot make a known family new");
  const fresh = att({ id: "4", family: "halving-transfer", taskType: "application", timestamp: "2026-11-03T10:00:00.000Z" });
  const e = skillEvidence([first, second, fresh], 2);
  assert.equal(e.delayedTransfer, true);
  assert.equal(supportedLevel(e), 4);
  assert.equal(e.families, 2);
  // Attempts without families keep the 0.5 rule: the transfer flag decides.
  assert.equal(skillEvidence([att({ id: "x" }), att({ id: "y" }), att({ id: "z", transfer: true, timestamp: "2026-11-12T10:00:00.000Z" })], 2).delayedTransfer, true);
});

const sk = (over: Partial<SkillInput> & { n: number }): SkillInput => ({ name: `S${over.n}`, level: null, prerequisites: [], dependents: 0, priority: 1, taught: false, supported: 0, independent: 0, independentCorrect: 0, recentFailures: 0, lapse: false, daysSince: null, bankLeft: 0, ...over });
const pin = (over: Partial<PolicyInput>): PolicyInput => ({ mode: "auto", target: 4, focus: null, skills: [], pending: false, completedStep: false, intent: "none", misconceptions: 0, minutes: 25, weights: DEFAULT_WEIGHTS, placementReady: false, external: [], checked: [], ...over });

test("delayed checks are part of Adaptive study, and a transfer is never set on the day it cannot count", () => {
  const atTarget = sk({ n: 1, level: 4, supported: 4, independent: 3, independentCorrect: 3, checkDue: true, nextCheck: "2026-11-10" });
  const d = decide(pin({ skills: [atTarget] }));
  assert.deepEqual([d.action, d.focus], ["retrieval", 1]);
  assert.match(d.constraint, /delayed independent check/);
  // Two unaided successes today: a transfer today would be on the same day, so it is parked
  // and another concept is chosen.
  const sameDay = sk({ n: 1, level: 3, supported: 3, independent: 2, independentCorrect: 2, transferReady: false });
  const other = sk({ n: 2, level: 2, supported: 2 });
  const pick = decide(pin({ skills: [sameDay, other], focus: 1 }));
  assert.deepEqual([pick.action, pick.focus], ["guided-practice", 2]);
  // With nothing else to do it says so, and still does not set a transfer.
  const alone = decide(pin({ skills: [sameDay], focus: 1 }));
  assert.equal(alone.action, "independent-practice");
  assert.match(alone.reason, /due from tomorrow.*cannot raise the level/);
  // The next day the transfer is set, and doubles as the delayed check.
  assert.equal(decide(pin({ skills: [{ ...sameDay, transferReady: true, checkDue: true }] })).action, "transfer");
});

test("level 5 asks for a teach-back and an edge case; Learn mode never examines", () => {
  const held = sk({ n: 1, level: 4, supported: 4, independent: 3, independentCorrect: 3, needsTeachBack: true, needsEdgeCase: true });
  assert.equal(decide(pin({ target: 5, skills: [held] })).action, "teach-back");
  assert.equal(decide(pin({ target: 5, skills: [{ ...held, needsTeachBack: false }] })).action, "edge-case");
  assert.equal(decide(pin({ target: 5, skills: [{ ...held, needsTeachBack: false, needsEdgeCase: false }] })).action, "transfer");
  const learn = decide(pin({ mode: "teach", target: 5, skills: [held] }));
  assert.deepEqual([learn.action, learn.suggestIndependent], ["guided-practice", true]);
});

test("prerequisites in other topics are checked one by one, by id and outcome, and a failed one is taught", () => {
  const s = sk({ n: 2, level: 2, supported: 2 });
  const ext = [
    { skill: 2, name: "Pointers", topic: "C", level: null, id: "c/pointers" },
    { skill: 2, name: "Memory", topic: "C", level: 1, id: "c/memory" },
  ];
  const first = decide(pin({ skills: [s], focus: 2, external: ext }));
  assert.deepEqual([first.action, first.assesses], ["diagnose-prerequisite", "c/pointers"]);
  // After one check, the next unresolved prerequisite is checked; the destination is not "done".
  const second = decide(pin({ skills: [s], focus: 2, external: ext, prereqChecks: { "c/pointers": "correct" } }));
  assert.deepEqual([second.action, second.assesses], ["diagnose-prerequisite", "c/memory"]);
  // A failed check is explained before going on, as exposure to that prerequisite.
  const failed = decide(pin({ skills: [s], focus: 2, external: ext, prereqChecks: { "c/pointers": "correct", "c/memory": "incorrect" } }));
  assert.deepEqual([failed.action, failed.teaches, failed.assesses], ["explain", "c/memory", undefined]);
  assert.match(failed.reason, /Memory from C, and the check on it was not answered correctly/);
  // Once taught and every check resolved, study of the concept itself goes on.
  assert.equal(decide(pin({ skills: [s], focus: 2, external: ext, prereqChecks: { "c/pointers": "correct", "c/memory": "taught" } })).action, "guided-practice");
  // A learner who already answered the dependent concept without help has shown the prerequisite in use.
  assert.equal(decide(pin({ skills: [{ ...s, independent: 1, independentCorrect: 1 }], focus: 2, external: ext })).action, "guided-practice");
});

test("Home suggests exactly what Adaptive study does first, through the same decision", async () => {
  const t = await setup();
  await t.focus(2, { 1: 3, 2: 2 }, [att({ id: "w", skill: 1, result: "incorrect", timestamp: "2026-11-13T10:00:00.000Z" }), att({ id: "w2", skill: 1, result: "incorrect", timestamp: "2026-11-13T11:00:00.000Z" }), att({ id: "ok", skill: 1, timestamp: "2026-11-12T10:00:00.000Z" })]);
  const home = await t.engine.recommendTopic(t.dir);
  const chat = await t.chatIn("auto");
  const plan = await t.engine.plan(t.dir, await t.store.loadChat(chat), "auto", "");
  assert.deepEqual([home.decision.action, home.decision.focus], [plan.action, plan.focus]);
  assert.deepEqual([home.step.action, home.step.subskill, home.step.title], ["auto", plan.focus, "Guided practice"], "the unfinished focus is kept, as Adaptive keeps it");
  // Due flashcards wait behind a pressing step, and come first otherwise.
  assert.equal(homeStep({ ...home.decision, action: "diagnose-error" }, { due: 3, atTarget: false }).action, "auto");
  assert.equal(homeStep({ ...home.decision, action: "guided-practice", constraint: "" }, { due: 3, atTarget: false }).action, "review");
});

test("prerequisite outcomes are stored in the chat by id when the answer is recorded in the other topic", async () => {
  const t = await setup();
  const other = await t.store.saveCompiled({ title: "C basics", fm: { subject: "none" }, topicBody: "# C basics\n\n## Overview\nC.\n\n## Subskills\n\n### 1. Pointers\nprerequisites: none\n- A pointer holds an address.\n", questionsBody: "", target: 4 });
  const pointer = (await t.store.loadGraph(other)).concepts[0].id;
  const mine = (await t.store.loadGraph(t.dir)).concepts.find((c) => c.n === 1)!.id;
  await t.store.addRelation({ from: mine, to: pointer, type: "requires" });
  await t.focus(1, { 1: 2, 2: 3, 3: 3 });
  const chat = await t.chatIn("auto");
  t.replies.push(`Quick check: what does a pointer hold?\n${session({ pendingQuestion: "What does a pointer hold?" })}`);
  const asked = await t.engine.study(t.dir, chat, "");
  assert.deepEqual([asked.decision!.action, asked.decision!.assesses], ["diagnose-prerequisite", pointer]);
  assert.deepEqual(JSON.parse(String((await t.store.loadChat(chat)).fm.prereq_checks)), { [pointer]: "asked" });
  t.replies.push(`Not quite.\n<attempt>{"skill":1,"result":"incorrect","assisted":false}</attempt>\n${session({ pendingQuestion: "", completedStep: true })}`);
  await t.engine.study(t.dir, chat, "a value");
  assert.deepEqual(JSON.parse(String((await t.store.loadChat(chat)).fm.prereq_checks)), { [pointer]: "incorrect" });
  assert.equal((await t.store.loadState(other, 4)).attempts.length, 1, "the answer is evidence about the prerequisite, in its own topic");
  t.replies.push(`A pointer stores the address of a value.\n${session({ pendingQuestion: "", completedStep: true })}`);
  const taught = await t.engine.study(t.dir, chat, "");
  assert.deepEqual([taught.decision!.action, taught.decision!.teaches], ["explain", pointer]);
  const there = await t.store.loadState(other, 4);
  assert.equal(there.levels[1], 1, "the explanation is exposure to the prerequisite");
  assert.equal((await t.store.loadState(t.dir, 4)).taught[1], undefined, "and not to the concept being studied");
  assert.equal(JSON.parse(String((await t.store.loadChat(chat)).fm.prereq_checks))[pointer], "taught");
});

// ---------- the course package and partial refresh ----------

test("the course package maps objectives to lessons and questions, keeps citations, families and rubrics, and shows gaps", async () => {
  const t = await setup();
  const topic = await t.store.loadTopic(t.dir);
  const qs = await t.store.loadQuestions(t.dir);
  const state = await t.store.loadState(t.dir, 4);
  const pkg = buildPackage({ topic, questions: qs, concepts: state.concepts, sources: { "Search notes": "h1" }, previous: null, at: "2026-11-14T10:00:00Z", mode: "notes", research: false });
  assert.equal(pkg.objectivesFrom, "card");
  assert.deepEqual(pkg.objectives.map((o) => [o.id, o.subskills, o.covered]), [["O1", [1], true], ["O2", [2], true], ["O3", [3], true], ["O4", [], false]]);
  assert.deepEqual(pkg.coverage.missing, ["O4"]);
  assert.equal(pkg.coverage.complete, false, "an uncovered objective keeps the package incomplete");
  assert.deepEqual(pkg.lessons.map((l) => [l.n, !!l.worked, l.visual?.kind ?? null]), [[1, true, null], [2, true, "simulation"], [3, true, "simulation"]]);
  assert.ok(pkg.citations.includes("[[Search notes]]"));
  assert.deepEqual(pkg.families.filter((f) => f.reserved).map((f) => f.id), ["halving-transfer"], "the transfer family is kept for assessment");
  assert.deepEqual(pkg.rubrics.map((r) => r.question), ["Q5"]);
  assert.deepEqual([qs[3].family, qs[3].task, qs[0].difficulty], ["halving-transfer", "transfer", 1]);
});

test("a refresh costs nothing when no note changed and rewrites only the subskills a changed note reaches", async () => {
  const t = await setup();
  const material = Object.entries(NOTES).map(([name, text]) => ({ name, text }));
  const req = { title: "Searching", mode: "notes" as const, goal: "", material, fm: {}, existingDir: t.dir };
  const topic0 = await t.store.loadTopic(t.dir);
  const state0 = await t.store.loadState(t.dir, 4);
  await t.store.savePackage(t.dir, buildPackage({ topic: topic0, questions: await t.store.loadQuestions(t.dir), concepts: state0.concepts, sources: Object.fromEntries(material.map((m) => [m.name, F.contentHash(m.text)])), previous: null, at: "t", mode: "notes", research: false }));
  state0.levels[3] = 2;
  state0.cards.Q1 = { due: "2026-11-20", interval: 6, ease: 2.5, reps: 2, lapses: 0 };
  state0.attempts = [att({ id: "keep", skill: 3 })];
  await t.store.saveState(t.dir, state0);

  const same = await t.engine.refresh(req);
  assert.deepEqual([same.refresh, same.usage.calls, t.calls.length], ["unchanged", 0, 0]);

  const changed = material.map((m) => (m.name === "Pipe notes" ? { ...m, text: m.text + "\n\nA full pipe blocks the writer." } : m));
  t.replies.push(`### 3. Pipe buffer\nprerequisites: 1\nobjectives: O3\nvisual: simulation | the read and write indices wrap around the array\n- A pipe is a fixed-size circular buffer; a full pipe blocks the writer ([[Pipe notes]]).\nworked example:\nWith 4 slots full, the writer waits until slot 0 is read.\n\n=====QUESTIONS=====\n\n### Q1\nsubskill: 3\ntype: short\nfamily: full-pipe\ntask: application\nquestion: What happens to a writer when the pipe is full?\nanswer: it blocks\nexplanation: No free slot.`);
  const r = await t.engine.refresh({ ...req, material: changed });
  assert.deepEqual([r.refresh, r.subskillsRefreshed, t.calls.length], ["partial", [3], 1]);
  assert.match(t.calls[0].input, /REFRESH: 3/);
  assert.match(t.calls[0].input, /MATERIAL \(the changed notes only\):\n## \[\[Pipe notes\]\]/);
  assert.ok(!/Binary search works on a sorted array only/.test(t.calls[0].input), "unchanged notes are not sent");
  const topic = await t.store.loadTopic(t.dir);
  assert.equal(topic.subskills.find((s) => s.n === 2)!.section, topic0.subskills.find((s) => s.n === 2)!.section, "other subskills are kept byte for byte");
  assert.match(topic.subskills.find((s) => s.n === 3)!.section, /a full pipe blocks the writer/);
  const qs = await t.store.loadQuestions(t.dir);
  assert.deepEqual(qs.map((q) => [q.id, q.subskill]), [["Q1", 1], ["Q2", 1], ["Q3", 2], ["Q4", 2], ["Q6", 3]], "the old question on 3 is replaced and the new one takes a fresh id");
  const after = await t.store.loadState(t.dir, 4);
  assert.deepEqual([after.levels[3], after.attempts.map((a) => a.id), after.cards.Q1?.interval], [2, ["keep"], 6], "levels, evidence and untouched review schedules are kept");
  const pkg = (await t.store.loadPackage(t.dir))!;
  assert.deepEqual([pkg.revision, pkg.refreshed.map((x) => x.subskills)], [2, [[3]]]);
  assert.equal(pkg.sources["Pipe notes"], F.contentHash(changed[1].text));

  // A new note cannot be placed by a partial refresh.
  t.replies.push("# Searching\n## Overview\nx\n## Subskills\n### 1. A\nprerequisites: none\n- a\n### 2. B\nprerequisites: none\n- b\n=====QUESTIONS=====\n### Q1\nsubskill: 1\ntype: short\nquestion: q?\nanswer: a\nexplanation: e");
  const full = await t.engine.refresh({ ...req, material: [...changed, { name: "Hash tables", text: "Hashing maps keys to slots." }] });
  assert.equal(full.refresh, "full");
  assert.match(full.why!, /new notes \(Hash tables\)/);
});

test("refresh output is merged only for the listed subskills, and source changes reach only subskills that cite them", () => {
  const pkg: any = { sources: { A: "1", B: "2" }, lessons: [{ n: 1, citations: ["[[A]]"] }, { n: 2, citations: ["[[B|bee]]"] }] };
  assert.deepEqual(sourceChanges(pkg, { A: "1", B: "3" }), { changed: ["B"], removed: [], added: [], subskills: [2] });
  assert.deepEqual(sourceChanges(pkg, { A: "1" }).subskills, [2], "a removed note reaches what cited it");
  const merged = mergeRefresh({ topicBody: "# T\n\n## Subskills\n\n### 1. A\n- a\n\n### 2. B\n- b", questionsBody: "### Q1\nsubskill: 1\nquestion: a\nanswer: a\n\n### Q2\nsubskill: 2\nquestion: b\nanswer: b", sections: new Map([[2, "### 2. B\n- b2"], [1, "### 1. A\n- hacked"]]), questions: "### Q1\nsubskill: 2\nquestion: b2\nanswer: b2\n\n### Q2\nsubskill: 1\nquestion: stray\nanswer: x", subskills: [2] });
  assert.match(merged.topicBody, /### 1\. A\n- a\n/, "a section the refresh was not asked for is never replaced");
  assert.match(merged.topicBody, /### 2\. B\n- b2/);
  assert.deepEqual(F.parseQuestions(merged.questionsBody).map((q) => [q.id, q.question]), [["Q1", "a"], ["Q3", "b2"]]);
});

test("source hashes are SHA-256, matching known vectors, with line endings normalised", () => {
  assert.equal(F.sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(F.sha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(F.sha256("a".repeat(1000)), "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
  assert.equal(F.sha256("π ≈ 3.14159"), require("crypto").createHash("sha256").update("π ≈ 3.14159", "utf8").digest("hex"));
  assert.equal(F.contentHash("a\r\nb"), F.contentHash("a\nb"));
});

test("in Practise, a request about the open bank question configures that question's concept, and its answer counts as helped", async () => {
  const t = await setup({ local: [arrayReply()] });
  await t.focus(1, { 1: 3, 3: 3 });
  const chat = await t.chatIn("quiz");
  const asked = await t.engine.study(t.dir, chat, "");
  assert.match(asked.reply, /What does binary search compare the target with\?/, "the weakest concept's bank question is open");
  const r = await t.engine.study(t.dir, chat, "show me a simulation of this");
  assert.equal(t.calls.length, 0);
  assert.equal(r.presentation!.activity!.conceptId, (await t.store.loadState(t.dir, 4)).concepts[2], "the open question's concept, not the focus");
  const answered = await t.engine.study(t.dir, chat, "B");
  assert.deepEqual([answered.attempt!.result, answered.attempt!.assisted, answered.attempt!.questionId], ["correct", true, "Q3"]);
  assert.equal(t.calls.length, 0, "the bank answer is still marked by code");
});

test("a module's own question template replaces the local model's wording; vague missing-capability text is replaced by code", async () => {
  const templated = { ...ARRAY_TRACE, questionTemplates: { "predict-comparisons": "How many comparisons will {algorithm} make to find {target} in {values}?" } };
  const r = await configureActivity({ request: req(), conceptId: "c", candidates: [templated], assets: [], registry: adaptRegistry(makeFixtureRegistry({ modules: [templated] }) as any), model: scriptedModel([arrayReply({ predictionQuestion: "What is the value after the first pass?" })]), catalogVersion: "c", trigger: "explicit" });
  assert.equal(r.lesson!.predictionQuestion, "How many comparisons will binary-search make to find 25 in [3, 8, 12, 19, 25, 31, 40]?", "the question asks what the assessment checks");
  const vague = await configure([JSON.stringify({ fits: false, objective: "how a pipe wraps around", settings: { algorithm: "linear-search", values: [1, 2, 3], target: 1 }, assetIds: [], assessmentId: "predict-comparisons", predictionQuestion: "What next?", hint: "Look again.", missingOperation: "insertion-sort" })]).run;
  assert.equal(vague.missingCapability!.operation, "a simulation of: compares the target with the middle element", "a module value or a 'none' is not a description of what is missing");
  const none = await configureActivity({ request: req({ objective: "Process states: running, ready and blocked" }), conceptId: "c", candidates: [], assets: [], registry: adaptRegistry(makeFixtureRegistry() as any), model: null, catalogVersion: "c", trigger: "explicit" });
  assert.equal(none.missingCapability!.operation, "a simulation of: running, ready and blocked");
});

test("the concept's own name decides which supported objective matched", () => {
  const algorithm = { ...ARRAY_TRACE, id: "algorithm", supportedObjectives: ["Zero-based numeric array indexing", "Linear search (first match)", "Binary search on sorted numbers (one matching index)"] };
  const text = "Linear search: compares each numeric array element with a target, from index 0, and stops at the first match.";
  assert.equal(matchModules(text, "simulation", [algorithm], undefined, "Linear search")[0].phrase, "Linear search (first match)");
  assert.equal(matchModules("Zero-based numeric array indexing: a[0] is the first element of the array.", "simulation", [algorithm], undefined, "Zero-based numeric array indexing")[0].phrase, "Zero-based numeric array indexing");
});

test("an answer in a numeric variant is assessed against that variant, and a lesson that is not the saved activity is refused", async () => {
  const t = await setup({ local: [arrayReply()] });
  await t.focus(2, { 1: 3, 2: null });
  const out = await t.engine.requestActivity(t.dir, { kind: "simulation" });
  const variant = await t.engine.openActivity(t.dir, out.activity!.id, { variantSeed: 4 });
  const expected = trace(variant.lesson!.settings).comparisons;
  const res = await t.engine.recordActivityResult(t.dir, out.activity!.id, { answer: expected }, { lesson: variant.lesson });
  assert.equal(res.assessment.correct, true, "checked against the variant's own trace");
  await assert.rejects(t.engine.recordActivityResult(t.dir, out.activity!.id, { answer: 1 }, { lesson: { ...variant.lesson, objective: "something else entirely" } }), /does not match the saved one/);
  assert.equal(t.calls.length + t.local.requests.length, 1, "only the first configuration used a model");
});
