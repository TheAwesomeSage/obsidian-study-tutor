import assert from "node:assert/strict";
import test from "node:test";
import { CompileCancelled, compileCourse, type CompilerCache } from "../src/compiler";
import { canonicalPage, publicIPv4, readablePage, type ResearchProvider } from "../src/compile-research";
import { indexSource, passageWindow } from "../src/compile-sources";
import { Engine, type EngineSettings } from "../src/engine";
import { zeroUsage } from "../src/claude";
import type { LocalModel } from "../src/ollama";
import { Store } from "../src/store";
import { expansionRequest } from "../src/expansion";
import { courseExpansions, courseLessons, courseSources } from "../src/tutoring-adapters";
import { MemFS } from "./memfs";

const material = [{ name: "Working notes", path: "Math/Working notes.md", text: "# Linear maps\n\nThe kernel consists of x for which T(x) = 0.\n" }];
const hit = "https://university.example/linear-maps";
const researchText = "# Kernel\n\nFor T(x, y) = x, the kernel is all pairs (0, y), with y arbitrary.";
type Options = Parameters<typeof compileCourse>[0];
type Model = Options["call"];

function memory(): CompilerCache & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return { data, read: async <T>(key: string) => (data.get(key) as T | undefined) ?? null, write: async (key, v) => { data.set(key, JSON.parse(JSON.stringify(v))); } };
}

function fake(options: {
  omit?: string; uncovered?: boolean; review?: (input: any) => unknown; seen?: any[];
  /** Replace the synthesis or audit reply; each receives the input and the default reply. */
  synth?: (input: any, reply: any) => unknown; audit?: (input: any, reply: any) => unknown;
} = {}): Model {
  return async o => {
    const input = JSON.parse(o.input);
    options.seen?.push(input);
    assert.equal("tools" in o, false, "Claude has no direct tools in compilation");
    const props = (o.jsonSchema as { properties: Record<string, unknown> }).properties;
    let structured: unknown;
    if (props.objectives) {
      const lines = input.passages.filter((p: any) => !p.text.startsWith("#") && !p.text.includes(options.omit ?? "_not_omitted_"));
      structured = { objectives: lines.length ? lines.map((p: any) => ({ text: p.text.trim().slice(0, 120), references: [p.id], search: `linear maps kernel ${p.line}` })) : input.mode === "subject" ? [{ text: "Compute a kernel", references: [], search: "linear maps kernel" }] : [] };
    } else if (props.fetch) {
      structured = options.review?.(input) ?? { fetch: input.candidates.slice(0, 1).map((h: any) => ({ objective: h.objective, url: h.url })), searches: [], inspect: [] };
    } else if (props.units) {
      structured = { overview: "The kernel identifies where information is lost.", subject: "none",
        units: input.objectives.map((o: any, i: number) => ({ objective: o.id, name: `Kernel example ${o.id}`, prerequisites: [], claims: ["T sends vectors in the kernel to zero."], example: "T(0, 3) = 0, so (0,3) is in the kernel.", misconceptions: [], details: "For T(x,y)=x, solve T(x,y)=0 by setting x=0. The coordinate y is arbitrary. That gives the kernel {(0,y)}.",
          passages: input.packet[i].passages.map((p: any) => p.id), visualKind: "", visualReason: "",
          questions: [{ type: "short", question: "What is T(0,3)?", options: [], answer: "0", explanation: "T returns the first coordinate.", rubric: "", task: "application", family: "compute-kernel", difficulty: 2 }],
        })),
      };
      if (options.synth) structured = options.synth(input, structured);
    } else if (props.rows) {
      structured = { rows: input.objectives.map((o: any, i: number) => ({ objective: o.id, sources: options.uncovered ? ["invented-passage"] : input.packet[i].passages.map((p: any) => p.id), teaching: true, questions: options.uncovered ? ["Q999"] : [input.questions[i].id], gap: "" })) };
      if (options.audit) structured = options.audit(input, structured);
    } else assert.fail("unexpected compile stage");
    return { structured, text: "", usage: { ...zeroUsage(), calls: 1, input: 10, output: 2 } };
  };
}

function run(over: Partial<Options> = {}) {
  return compileCourse({ title: "Linear maps", goal: "Understand kernels", mode: "notes", material,
    subjects: [], skill: "compile exercises", model: "fixture", singlePassWords: 600, cache: memory(), call: fake(), ...over });
}

type Stage = "plan" | "review" | "synth" | "audit";
/** Counts model calls by the stage prompt they carry, and keeps their inputs. */
function counted(call: Model = fake()) {
  const n: Record<Stage, number> = { plan: 0, review: 0, synth: 0, audit: 0 };
  const inputs: Record<Stage, any[]> = { plan: [], review: [], synth: [], audit: [] };
  const counting: Model = o => {
    const stage: Stage = o.system.startsWith("Write structured teaching units") ? "synth" : o.system.startsWith("Audit every supplied objective") ? "audit" : o.system.startsWith("Inventory the learning objectives") ? "plan" : "review";
    n[stage]++;
    inputs[stage].push(JSON.parse(o.input));
    return call(o);
  };
  return { n, inputs, call: counting };
}

// Eight objectives in two notes with no shared terms: lesson group 1 is the kernel note, group 2 the eigenvalue note.
const kernelNote = { name: "Kernel notes", path: "Math/Kernel notes.md", text: ["shear", "projection", "dilation", "reflection", "zero map", "identity map"].map((m, i) => `A${i + 1}: Compute the kernel of the ${m}.`).join("\n\n") };
const eigenNote = (extra = "") => ({ name: "Eigen notes", path: "Math/Eigen notes.md", text: `B1: Find eigenvalues of a rotation.\n\nB2: Find eigenvalues of a triangular matrix.${extra}` });
const twoGroups = [kernelNote, eigenNote()];

test("source revisions keep original code, equations, headings and surrounding text", () => {
  const text = "# Section\r\n\r\nA definition.\r\n\r\n~~~js\r\nif (x) {\r\n  return x;\r\n}\r\n~~~\r\n\r\n$$\r\nT(x)=0\r\n$$";
  const a = indexSource({ name: "Notes", path: "Folder/Notes.md", text });
  const b = indexSource({ name: "Notes", path: "Other/Notes.md", text });
  assert.equal(a.text, text);
  assert.notEqual(a.sourceId, b.sourceId);
  const code = a.passages.find(p => p.text.startsWith("~~~"))!;
  assert.equal(code.heading, "Section");
  assert.ok(code.text.includes("\r\n  return x;\r\n"));
  assert.equal(passageWindow([a], code.id, 1).at(-1)?.text, "$$\r\nT(x)=0\r\n$$");
  assert.equal(indexSource({ name: "Notes", path: "Folder/Notes.md", text }).passages[2].id, code.id);
});

test("the page adapter discards executable and hidden content and blocks non-public targets", () => {
  const r = readablePage("<title>Course</title><nav>Ignore</nav><main><h2>Kernel</h2><p>x &lt; y</p><script>alert(1)</script><p hidden>secret</p><pre> a\n  b</pre><math><mi>x</mi><mo>+</mo><mi>y</mi></math></main>");
  assert.equal(r.title, "Course");
  assert.match(r.text, /## Kernel[\s\S]*x < y[\s\S]*~~~\n a\n  b\n~~~/);
  assert.match(r.text, /<math><mi>x<\/mi><mo>\+<\/mo><mi>y<\/mi><\/math>/);
  assert.doesNotMatch(r.text, /alert|Ignore|secret/);
  assert.deepEqual(["127.4.0.1", "169.254.169.254", "100.96.1.2", "10.0.0.1", "172.16.0.2"].map(publicIPv4), [false, false, false, false, false]);
  assert.equal(publicIPv4("1.1.1.1"), true);
  for (const url of ["http://2130706433", "http://localhost", "http://[::1]", "https://a.example:3000/", "file:///C:/note.md", "https://a:b@a.example/"]) assert.throws(() => canonicalPage(url), url);
  assert.equal(canonicalPage("https://university.example/map?utm_campaign=track&unit=2#intro"), "https://university.example/map?unit=2");
});

test("specs are read in full when short; long specs preserve omitted clauses and separate coverage", async () => {
  const seen: any[] = [];
  const spec = "# Specification\n\nA1: Determine the kernel.\n\nA2: Explain its role.";
  const s = await run({ mode: "spec", material: [{ name: "Spec", text: spec }], call: fake({ seen }) });
  assert.equal(seen[0].materialInFull[0].text, spec);
  assert.equal(s.staged.status, "complete");
  const long = Array.from({ length: 34 }, (_, i) => `A${i + 1}: ${i === 33 ? "UNMAPPED last clause" : `Explain example ${i + 1}.`}`).join("\n\n");
  const log: any[] = [];
  const before = await run({ mode: "spec", singlePassWords: 20, material: [{ name: "Spec", text: long }], call: fake({ omit: "UNMAPPED", uncovered: true, seen: log }) });
  assert.equal(log.filter(x => x.passages).length, 2);
  assert.ok(!log[0].materialInFull);
  assert.equal(before.staged.inventory.length, 34);
  assert.match(before.staged.inventory.find(x => x.unmapped)!.text, /UNMAPPED last clause/);
  assert.equal(before.staged.status, "partial");
  assert.ok(before.staged.availability.some(x => x.lessons.length && !x.sources.length && !x.questions.length));
  assert.equal(before.questionsBody, "");
});

test("invalid or missing Ollama falls back to original source passages", async () => {
  for (const missing of [false, true]) {
    let localCalls = 0;
    const local: LocalModel = { model: "fixture:model", chatJson: async () => {
      localCalls++;
      if (missing) throw new Error("offline");
      return { model: "fixture:model", doneReason: "stop", text: '{"matches":[{"passage":"made-up","objective":"made-up","uncertain":false}]}', timing: {} } as any;
    } };
    const seen: any[] = [];
    const r = await run({ singlePassWords: 2, local, call: fake({ seen }) });
    const packet = seen.find(x => x.packet).packet[0].passages;
    assert.equal(localCalls, 1);
    assert.ok(r.staged.issues.some(x => /deterministic passages/.test(x)));
    assert.ok(packet.some((x: any) => x.text.includes("T(x) = 0") && x.uncertain));
    assert.ok(packet.every((x: any) => x.id !== "made-up"));
  }
});

test("research is metered across follow-ups, reviews fetched evidence, and reuses completed pages", async () => {
  const searched: string[] = [], fetched: string[] = [];
  const source = indexSource({ name: "Reference", url: hit, text: researchText });
  const provider: ResearchProvider = { search: async q => {
    searched.push(q);
    return [{ url: hit + "?utm_source=test#section", title: "Reference" }, { url: hit, title: "Duplicate" }, { url: "https://example.edu/blocked", title: "Other candidate" }];
  }, fetch: async url => { fetched.push(url); return source; } };
  const cache = memory();
  const log: any[] = [];
  const params = { mode: "subject" as const, material: [], research: true, provider, cache, limits: { searches: 2, pages: 1 }, call: fake({
    seen: log,
    review: x => ({ fetch: x.candidates.map((c: any) => ({ objective: c.objective, url: c.url })), searches: [{ objective: x.objectives[0].id, query: `a gap ${x.searched.length}` }], inspect: [] }),
  }) };
  const first = await run(params);
  assert.deepEqual([first.staged.metrics.searches, first.staged.metrics.pages, searched.length], [2, 1, 2]);
  assert.deepEqual(fetched, [hit]);
  assert.ok(log.some(x => x.candidates && x.objectives[0].evidence.some((e: any) => e.url === hit)));
  assert.equal(first.staged.status, "complete");
  const repeat = await run(params);
  assert.equal(fetched.filter(url => url === hit).length, 1, "reused pages do not consume another request; a different page can use the free slot");
  assert.ok(repeat.staged.metrics.cacheHits >= 2);
  assert.deepEqual(repeat.staged.inventory.map(o => o.id), first.staged.inventory.map(o => o.id));
});

test("a failed fetch and unavailable search cannot be counted as objective evidence", async () => {
  for (const provider of [null, { search: async () => [{ url: hit, title: "Reference" }], fetch: async () => { throw new Error("unsupported content"); } }]) {
    const result = await run({ mode: "subject", material: [], research: true, provider });
    assert.equal(result.staged.status, "partial");
    assert.ok(result.staged.issues.some(x => /Web search unavailable|unsupported content/.test(x)));
    assert.equal(result.staged.availability[0].sources.length, 0);
    assert.equal(result.staged.availability[0].lessons.length, 1);
  }
});

test("a large specification can raise the normal budget for a named gap, up to its ceiling", async () => {
  const progress: string[] = [];
  let searchCalls = 0, fetched = 0;
  const provider: ResearchProvider = {
    search: async () => [{ url: `https://university.example/lesson-${++searchCalls}`, title: "Course chapter" }],
    fetch: async url => { fetched++; return indexSource({ name: "Course chapter", url, text: researchText }); },
  };
  const result = await run({ mode: "spec", singlePassWords: 1, research: true, provider,
    limits: { searches: 1, pages: 1, largeSearches: 2, largePages: 2 },
    progress: s => progress.push(s), call: fake({ review: x => ({
      fetch: x.candidates.slice(0, 1).map((h: any) => ({ objective: h.objective, url: h.url })),
      searches: [{ objective: x.objectives[0].id, query: `alternate explanation ${x.searched.length}` }], inspect: [],
    }) }),
  });
  assert.deepEqual([searchCalls, fetched], [2, 2]);
  assert.match(result.staged.metrics.escalated, /Evidence still needed for O1/);
  assert.ok(progress.some(s => s.startsWith("Expanded research budget:")));
});

test("cancellation stops Claude and keeps completed source work for another run", async () => {
  const ctrl = new AbortController(), cache = memory();
  const source = indexSource({ name: "Reference", url: hit, text: researchText });
  let count = 0, killed = false;
  const provider: ResearchProvider = { search: async () => [{ url: hit, title: "Reference" }], fetch: async () => { count++; return source; } };
  const call = fake();
  await assert.rejects(run({ mode: "subject", material: [], research: true, provider, cache, signal: ctrl.signal, call: async o => {
    if (count) {
      o.onSpawn?.(() => { killed = true; });
      ctrl.abort();
    }
    return call(o);
  } }), CompileCancelled);
  assert.ok(killed);
  assert.equal(count, 1);
  const repeat = await run({ mode: "subject", material: [], research: true, provider, cache });
  assert.equal(repeat.staged.status, "complete");
  assert.equal(count, 1);
});

test("a repeated compile reuses lesson and audit checkpoints and gives the same course", async () => {
  const cache = memory(), progress: string[] = [];
  const first = await run({ cache });
  assert.deepEqual([first.staged.metrics.groups, first.staged.metrics.groupsReused, first.staged.metrics.stageCacheHits, first.staged.metrics.rejected], [1, 0, 0, 0]);
  assert.ok([...cache.data.keys()].some(k => /^synth-[a-f\d]{64}$/.test(k)) && [...cache.data.keys()].some(k => /^audit-[a-f\d]{64}$/.test(k)));
  const { n, call } = counted();
  const repeat = await run({ cache, call, progress: s => progress.push(s) });
  assert.deepEqual(n, { plan: 0, review: 0, synth: 0, audit: 0 });
  assert.equal(repeat.calls, 0);
  assert.deepEqual([repeat.topicBody, repeat.questionsBody, repeat.staged.status], [first.topicBody, first.questionsBody, first.staged.status]);
  assert.deepEqual(repeat.staged.availability, first.staged.availability);
  assert.deepEqual([repeat.staged.metrics.groupsReused, repeat.staged.metrics.stageCacheHits], [1, 2]);
  assert.ok(progress.includes("Lesson group 1/1 reused from a saved checkpoint."));
});

test("changing one lesson group's evidence reruns only that group's synthesis and audit", async () => {
  const cache = memory();
  const first = counted();
  const before = await run({ cache, material: twoGroups, call: first.call });
  assert.equal(before.staged.inventory.length, 8);
  assert.deepEqual([first.n.synth, first.n.audit, before.staged.metrics.groups], [2, 2, 2]);
  assert.ok(first.inputs.synth[0].packet.every((x: any) => x.passages.every((k: any) => k.path === kernelNote.path)), "group 1 only sees the kernel note");
  const again = counted();
  const after = await run({ cache, material: [kernelNote, eigenNote(" Use the characteristic polynomial.")], call: again.call });
  assert.deepEqual([again.n.synth, again.n.audit], [1, 1]);
  assert.ok(again.inputs.synth[0].objectives.every((o: any) => o.text.startsWith("B")));
  assert.deepEqual([after.staged.metrics.groupsReused, after.staged.metrics.stageCacheHits], [1, 2]);
  assert.equal(after.staged.status, "complete");
  assert.deepEqual(after.staged.lessons.slice(0, 6), before.staged.lessons.slice(0, 6));
});

test("a different model identity does not reuse checkpoints", async () => {
  const cache = memory();
  await run({ cache, modelKey: "claude:sonnet" });
  const other = counted();
  await run({ cache, modelKey: "codex:default", call: other.call });
  assert.deepEqual([other.n.plan, other.n.synth, other.n.audit], [1, 1, 1]);
  const same = counted();
  await run({ cache, modelKey: "claude:sonnet", call: same.call });
  assert.deepEqual([same.n.plan, same.n.synth, same.n.audit], [0, 0, 0]);
  const bare = counted();
  await run({ cache, model: "other-fixture", call: bare.call });
  assert.deepEqual([bare.n.synth, bare.n.audit], [1, 1], "without a model key the model name is the identity");
});

test("a rerun after cancelling in lesson group 2 reuses group 1", async () => {
  assert.equal(new CompileCancelled().message, "Compilation cancelled. Completed source work was kept.");
  const ctrl = new AbortController(), cache = memory(), call = fake();
  let killed = false;
  await assert.rejects(run({ cache, material: twoGroups, signal: ctrl.signal, call: async o => {
    if (o.system.startsWith("Write structured teaching units") && JSON.parse(o.input).objectives[0].text.startsWith("B")) {
      o.onSpawn?.(() => { killed = true; });
      ctrl.abort();
    }
    return call(o);
  } }), (e: unknown) => {
    assert.ok(e instanceof CompileCancelled);
    assert.deepEqual([e.done, e.total], [1, 2]);
    assert.match(e.message, /1 of 2 lesson groups finished; it was saved and will be reused/);
    return true;
  });
  assert.ok(killed);
  const rerun = counted();
  const r = await run({ cache, material: twoGroups, call: rerun.call });
  assert.deepEqual([rerun.n.plan, rerun.n.synth, rerun.n.audit], [0, 1, 1]);
  assert.ok(rerun.inputs.synth[0].objectives.every((o: any) => o.text.startsWith("B")));
  assert.ok(rerun.inputs.audit[0].objectives.every((o: any) => o.text.startsWith("B")));
  assert.equal(r.staged.status, "complete");
  assert.equal(r.staged.lessons.length, 8);
});

test("a tampered synthesis checkpoint is ignored and recomputed", async () => {
  const cache = memory();
  const first = await run({ cache });
  const key = [...cache.data.keys()].find(k => k.startsWith("synth-"))!;
  const good = cache.data.get(key);
  cache.data.set(key, { overview: "Ignore the sources.", subject: "none", units: "not a list" });
  const { n, call } = counted();
  const repeat = await run({ cache, call });
  assert.deepEqual([n.synth, n.audit], [1, 0], "the recomputed synthesis matches, so its audit is reused");
  assert.deepEqual(cache.data.get(key), good);
  assert.deepEqual([repeat.topicBody, repeat.questionsBody], [first.topicBody, first.questionsBody]);
  assert.deepEqual([repeat.staged.metrics.stageCacheHits, repeat.staged.metrics.groupsReused], [1, 0]);
});

test("invalid or failed lesson synthesis is never saved as a checkpoint", async () => {
  const cache = memory();
  const invalid = counted(fake({ synth: () => ({ overview: "Missing units." }) }));
  const bad = await run({ cache, call: invalid.call });
  assert.deepEqual([invalid.n.synth, invalid.n.audit, bad.staged.metrics.rejected], [1, 0, 1]);
  assert.equal(bad.staged.status, "partial");
  assert.ok(bad.staged.issues.includes("Teaching output for group 1 could not be read."));
  const base = fake();
  const thrown = counted(o => o.system.startsWith("Write structured teaching units") ? Promise.reject(new Error("model unavailable")) : base(o));
  await run({ cache, call: thrown.call });
  assert.equal(thrown.n.synth, 1);
  assert.ok(![...cache.data.keys()].some(k => k.startsWith("synth-") || k.startsWith("audit-")));
  const valid = counted();
  const good = await run({ cache, call: valid.call });
  assert.deepEqual([valid.n.synth, valid.n.audit], [1, 1]);
  assert.equal(good.staged.status, "complete");
});

test("an objective whose prerequisite is not verified stays partial", async () => {
  const note = { name: "Kernel notes", path: "Math/Kernel notes.md", text: "A1: Compute the kernel of the shear.\n\nA2: Compute the kernel of the projection." };
  const synth = (input: any, reply: any) => ({ ...reply, units: reply.units.map((u: any, i: number) => i ? { ...u, prerequisites: [input.objectives[0].id] } : u) });
  const verified = await run({ material: [note], call: fake({ synth }) });
  assert.equal(verified.staged.status, "complete");
  assert.match(verified.topicBody, /### 2\. [^\n]*\nprerequisites: 1\n/);
  const audit = (_: any, reply: any) => ({ rows: reply.rows.map((r: any, i: number) => i ? r : { ...r, gap: "The worked example skips a step." }) });
  const r = await run({ material: [note], call: fake({ synth, audit }) });
  const [first, second] = r.staged.inventory.map(o => r.staged.availability.find(a => a.objective === o.id)!);
  assert.deepEqual(first.gaps, ["The worked example skips a step."]);
  assert.deepEqual(second.gaps, [`prerequisite ${first.objective} is not verified`]);
  assert.equal(second.lessons.length, 1, "the dependent lesson is kept");
  assert.equal(r.staged.status, "partial");
});

test("saved courses reopen, unchanged refresh costs nothing, and expansion leaves the original learner state alone", async () => {
  const fs = new MemFS(), store = new Store(fs, "Tutor");
  const settings: EngineSettings = { claudePath: "", chatModel: "fixture", compileModel: "fixture", utilityModel: "fixture", effort: "low", targetLevel: 4,
    maxChatWords: 600, maxTopicWords: 2000, singlePassWords: 600, smartRouting: false, hardEffort: "high" };
  const engine = new Engine(store, () => settings);
  (engine as unknown as { call: Model }).call = fake();
  const req = { title: "Linear maps", goal: "", material, mode: "notes" as const, fm: {} };
  const complete = await engine.compile(req);
  assert.equal(complete.status, "complete");
  const pkg = (await store.loadPackage(complete.dir))!;
  const original = pkg.staged!.inventory[0].references[0];
  assert.match((await store.compiledPassage(complete.dir, original))[0].text, /T\(x\) = 0/);
  engine.sources = courseSources(store, async () => null);
  engine.material = courseLessons(store);
  engine.expander = courseExpansions(store, engine.expandCourse.bind(engine));
  const quoted = await engine.tools.run<{ passages: { id: string }[] }>("vault.source", { dir: complete.dir, skill: 1, query: "How is the kernel defined?" });
  assert.ok(quoted.output?.passages.some(p => p.id === original));
  const passage = await engine.tools.run<{ found: boolean; text: string }>("vault.passage", { id: original, topic: complete.dir });
  assert.ok(passage.output?.found);
  assert.match(passage.output.text, /T\(x\) = 0/);
  assert.equal(await engine.sources.passage(original, 1, "Tutor/Topics/Other"), null);
  const lesson = await engine.tools.run<{ from: string; text: string }>("course.lesson", { dir: complete.dir, skill: 1 });
  assert.equal(lesson.output?.from, "compiled");
  assert.match(lesson.output.text, /coordinate y is arbitrary/);
  const scripted = fake();
  (engine as unknown as { call: Model }).call = o => o.jsonSchema ? scripted(o) : Promise.resolve({
    text: "The map uses only the first coordinate. What does it return for (0,3)?", usage: zeroUsage(),
  });
  const chat = await store.newChat(complete.dir, "Linear maps", "tutor");
  const explained = await engine.turn(complete.dir, chat, "Why does the kernel include every value of y?");
  assert.equal(explained.state.focus, 1);
  assert.ok(explained.tools?.some(tool => tool.tool === "vault.source" && tool.ok));
  assert.ok(explained.tools?.some(tool => tool.tool === "course.lesson" && tool.ok));
  const unchanged = await engine.refresh({ ...req, existingDir: complete.dir });
  assert.deepEqual([unchanged.refresh, unchanged.usage.calls], ["unchanged", 0]);
  const state = await store.loadState(complete.dir, 4);
  state.levels[1] = 3;
  await store.saveState(complete.dir, state);
  const saved = await fs.read(`${complete.dir}/state.md`);
  const pending = await engine.requestExpansion(complete.dir, expansionRequest({
    kind: "extension", topicDir: complete.dir, conceptId: state.concepts[1], conceptName: state.names[1],
    application: "Kernel of a projection", evidence: [], at: "2026-11-16",
  }));
  assert.equal(pending.status, "pending");
  const extension = await engine.expansionSettled(pending.request.id);
  assert.equal(extension?.status, "complete");
  const linked = extension.result?.linked[0];
  assert.ok(linked && linked.topicDir !== complete.dir);
  assert.equal((await store.loadPackage(linked.topicDir))?.staged?.expansion?.kind, "extension");
  const graph = await store.loadGraph(complete.dir);
  assert.ok(graph.edges.some(edge => edge.from === state.concepts[1] && edge.to === linked.conceptId && edge.type === "applies_to"));
  assert.equal(await fs.read(`${complete.dir}/state.md`), saved);
  assert.equal((await store.loadPackage(complete.dir))?.revision, pkg.revision);
  // The same model would replay the complete course from its checkpoints; another model reaches the uncovered reply.
  (engine as unknown as { call: Model }).call = fake({ uncovered: true });
  settings.compileModel = "fixture-2";
  const partial = await engine.compile({ ...req, existingDir: complete.dir });
  assert.equal(partial.status, "partial");
  assert.equal(partial.preservedCourse, complete.dir);
  assert.notEqual(partial.dir, complete.dir);
  assert.equal(await fs.read(`${complete.dir}/state.md`), saved);
});
