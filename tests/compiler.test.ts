import assert from "node:assert/strict";
import test from "node:test";
import { CompileCancelled, STAGE_VERSIONS, checkpointKey, compileCourse, type CompilerCache } from "../src/compiler";
import { canonicalPage, publicIPv4, readablePage, type ResearchProvider } from "../src/compile-research";
import { indexSource, passageWindow } from "../src/compile-sources";
import { Engine, type EngineSettings } from "../src/engine";
import { answeringModel, zeroUsage } from "../src/claude";
import { CodexTurn } from "../src/codex-cli";
import { modelIdentity } from "../src/model-provider";
import { LocalModelError, OllamaClient, type ChatJsonOptions, type LocalModel, type LocalModelInfo, type LocalReply } from "../src/ollama";
import { neutraliseRemote } from "../src/safemd";
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
          questions: [{ type: "short", question: "What is T(0,3)?", options: [], answer: "0", explanation: "T returns the first coordinate.", rubric: "", task: "application", family: "compute-kernel", difficulty: 2, generator: "" }],
        })),
      };
      if (options.synth) structured = options.synth(input, structured);
    } else if (props.rows) {
      structured = { rows: input.objectives.map((o: any, i: number) => ({ objective: o.id, sources: options.uncovered ? ["invented-passage"] : input.packet[i].passages.map((p: any) => p.id), teaching: true, questions: options.uncovered ? ["Q999"] : [input.questions[i].id], gap: "" })) };
      if (options.audit) structured = options.audit(input, structured);
    } else if (props.matches) {
      structured = { matches: input.objectives.map((o: any) => ({ objective: o.id, passage: input.passages[0].id, uncertain: false })) };
    } else assert.fail("unexpected compile stage");
    return { structured, text: "", usage: { ...zeroUsage(), calls: 1, input: 10, output: 2 } };
  };
}

function run(over: Partial<Options> = {}) {
  return compileCourse({ title: "Linear maps", goal: "Understand kernels", mode: "notes", material,
    subjects: [], skill: "compile exercises", model: "fixture", singlePassWords: 600, cache: memory(), call: fake(), ...over });
}

type Stage = "plan" | "select" | "review" | "synth" | "audit";
const stageOf = (system: string): Stage => system.startsWith("Write structured teaching units") ? "synth" : system.startsWith("Audit every supplied objective") ? "audit"
  : system.startsWith("Inventory the learning objectives") ? "plan" : system.startsWith("Select passages") ? "select" : "review";
/** Counts model calls by the stage prompt they carry, and keeps their inputs. */
function counted(call: Model = fake()) {
  const n: Record<Stage, number> = { plan: 0, select: 0, review: 0, synth: 0, audit: 0 };
  const inputs: Record<Stage, any[]> = { plan: [], select: [], review: [], synth: [], audit: [] };
  const counting: Model = o => {
    const stage = stageOf(o.system);
    n[stage]++;
    inputs[stage].push(JSON.parse(o.input));
    return call(o);
  };
  return { n, inputs, call: counting };
}

/**
 * A scripted Ollama model that answers every stage the way `call` would, and reports where it
 * runs. It counts its requests by stage, and how often it was asked where it runs.
 */
function localFrom(call: Model = fake(), name = "qwen2.5:7b", where: Partial<LocalModelInfo> = {}) {
  const n: Record<Stage, number> = { plan: 0, select: 0, review: 0, synth: 0, audit: 0 };
  const model = {
    model: name, n, described: 0, requests: [] as ChatJsonOptions[],
    describe: async (): Promise<LocalModelInfo> => { model.described++; return { model: name, runs: "local", digest: "sha256:aaa111bbb222ccc333", detail: "scripted", ...where }; },
    chatJson: async (o: ChatJsonOptions): Promise<LocalReply> => {
      model.requests.push(o);
      n[stageOf(o.system)]++;
      const r = await call({ model: name, system: o.system, input: o.user, jsonSchema: o.schema });
      return { text: JSON.stringify(r.structured), model: name, doneReason: "stop", timing: { wallMs: 1, loadMs: 0, promptTokens: 1, promptMs: 0, evalTokens: 1, evalMs: 0, totalMs: 1 } };
    },
  };
  return model;
}
const noMainProvider: Model = async o => assert.fail(`the main provider was called for ${stageOf(o.system)}`);
const entry = (cache: { data: Map<string, unknown> }, prefix: string) => [...cache.data].find(([k]) => k.startsWith(prefix))![1] as { model: string; value: unknown };

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

test("hybrid: an Ollama that is not running falls back to original source passages, with no escalation", async () => {
  for (const failure of [new LocalModelError("unreachable", "Ollama is not reachable"), new LocalModelError("model-missing", "not installed"), new Error("offline")]) {
    let localCalls = 0;
    const local: LocalModel = { model: "fixture:model", chatJson: async () => { localCalls++; throw failure; } };
    const seen: any[] = [];
    const c = counted(fake({ seen }));
    const r = await run({ singlePassWords: 2, local, call: c.call });
    const packet = seen.find(x => x.packet).packet[0].passages;
    assert.deepEqual([localCalls, c.n.select, r.staged.metrics.localEscalations], [1, 0, 0], failure.message);
    assert.equal(r.staged.metrics.strategy, "hybrid", "hybrid is the default: the split used before strategies existed");
    assert.ok(r.staged.issues.some(x => /deterministic passages/.test(x)));
    assert.ok(packet.some((x: any) => x.text.includes("T(x) = 0") && x.uncertain));
  }
});

test("hybrid: a local selection that fails its checks escalates to the main provider, recorded in metrics and issues", async () => {
  const local: LocalModel = { model: "fixture:model", chatJson: async () => ({ model: "fixture:model", doneReason: "stop", text: '{"matches":[{"passage":"made-up","objective":"made-up","uncertain":false}]}', timing: {} } as any) };
  const seen: any[] = [];
  const c = counted(fake({ seen }));
  const progress: string[] = [];
  // Two notes, so selection runs in several batches: only the first asks Ollama.
  const r = await run({ singlePassWords: 2, local, material: twoGroups, call: c.call, progress: s => progress.push(s) });
  assert.equal(c.n.select, 3, "the failed batch and both later ones went to the main provider");
  assert.equal(r.staged.metrics.localEscalations, 3);
  assert.equal(r.staged.metrics.rejected, 1);
  assert.ok(r.staged.issues.some(x => /Ollama's passage selection failed its checks \(the local reply named an invalid passage or objective ID\)/.test(x)));
  assert.ok(progress.some(s => /asking the main provider instead/.test(s)));
  const packet = seen.find(x => x.packet).packet[0].passages;
  assert.ok(packet.every((x: any) => x.id !== "made-up" && !x.uncertain), "the main provider's selection is used");
  assert.equal(r.staged.status, "complete");
});

test("hybrid: a model Ollama runs in the cloud is used but labelled as cloud inference", async () => {
  const local = localFrom(fake(), "glm-4.6:cloud");
  const r = await run({ singlePassWords: 2, local });
  assert.equal(local.n.select, 1);
  assert.equal(local.described, 0, "the name settles it");
  assert.deepEqual([r.staged.metrics.localRuns, r.staged.metrics.localModel], ["cloud", "glm-4.6:cloud"]);
  assert.ok(r.staged.issues.some(x => /^Cloud inference: glm-4\.6:cloud is an Ollama cloud model/.test(x)));
  const proven = await run({ singlePassWords: 2, local: localFrom() });
  assert.deepEqual([proven.staged.metrics.localRuns, proven.staged.metrics.localModel], ["local", "qwen2.5:7b@aaa111bbb222"]);
});

test("main: the configured provider does every stage, passage selection included, and Ollama is never asked", async () => {
  const local = localFrom();
  const c = counted();
  const r = await run({ strategy: "main", singlePassWords: 2, local, call: c.call });
  assert.deepEqual([local.requests.length, local.described], [0, 0]);
  assert.deepEqual([c.n.plan, c.n.select, c.n.synth, c.n.audit], [1, 1, 1, 1]);
  assert.deepEqual([r.staged.metrics.strategy, r.staged.metrics.localModel, r.staged.metrics.localCalls], ["main", undefined, 0]);
  assert.equal(r.staged.status, "complete");
});

test("local: Ollama does every stage and the main provider is never called; checkpoints carry the model's digest", async () => {
  const cache = memory();
  const unsafe = " See ![diagram](https://example.org/pixel.png).";
  const local = localFrom(fake({ synth: (_input, reply: any) => ({ ...reply, units: reply.units.map((u: any) => ({ ...u, details: u.details + unsafe })) }) }));
  const r = await run({ strategy: "local", singlePassWords: 2, local, cache, call: noMainProvider });
  assert.deepEqual([r.calls, r.usage.calls, r.staged.status], [0, 0, "complete"]);
  assert.deepEqual([local.n.plan, local.n.select, local.n.synth, local.n.audit], [1, 1, 1, 1]);
  assert.deepEqual([r.staged.metrics.strategy, r.staged.metrics.localRuns, r.staged.metrics.localCalls, r.staged.metrics.mainModel], ["local", "local", 4, undefined]);
  assert.ok(local.requests.filter(o => !o.system.startsWith("Select passages")).every(o => o.numCtx! >= 16_384), "the lesson stages get a context window for a group's packet");
  // Local lesson prose is saved into notes, so it is made safe like a main provider's reply.
  assert.notEqual(neutraliseRemote(unsafe), unsafe);
  assert.ok(r.staged.lessons[0].text.endsWith(neutraliseRemote(unsafe).trim()));
  assert.equal(entry(cache, "synth-").model, "ollama:qwen2.5:7b@sha256:aaa111bbb222ccc333");
  const again = localFrom();
  await run({ strategy: "local", singlePassWords: 2, local: again, cache, call: noMainProvider });
  assert.equal(again.requests.length, 0, "the same build reuses every checkpoint");
  const repulled = localFrom(fake(), "qwen2.5:7b", { digest: "sha256:ddd444" });
  await run({ strategy: "local", singlePassWords: 2, local: repulled, cache, call: noMainProvider });
  assert.deepEqual([repulled.n.plan, repulled.n.select, repulled.n.synth, repulled.n.audit], [1, 1, 1, 1], "a re-pulled model with another digest misses");
});

test("local: a stage the local model cannot do is an explicit coverage gap, never sent to the main provider", async () => {
  const base = fake();
  const local = localFrom(o => o.system.startsWith("Write structured teaching units") ? Promise.reject(new LocalModelError("timeout", "The local model took longer than 240s and was stopped.")) : base(o));
  const r = await run({ strategy: "local", singlePassWords: 2, local, call: noMainProvider });
  assert.equal(r.staged.status, "partial");
  assert.equal(r.calls, 0);
  assert.ok(r.staged.issues.some(x => /^Lesson synthesis for group 1 was not done: The local model took longer than 240s.*does not send it to the main provider\.$/.test(x)));
  assert.deepEqual(r.staged.availability[0].gaps, ["lesson synthesis: the local model could not do this stage, and the local compile strategy does not send it to the main provider"]);
  const audit = localFrom(fake({ audit: () => ({ rows: "not rows" }) }));
  const r2 = await run({ strategy: "local", singlePassWords: 2, local: audit, call: noMainProvider });
  assert.equal(r2.staged.status, "partial");
  assert.ok(r2.staged.availability[0].gaps.some(g => g.startsWith("coverage audit: the local model could not do this stage")));
});

test("local: a cloud model is refused, by its name or by Ollama's own description, and so is one not proven local", async () => {
  const byName = localFrom(fake(), "gpt-oss:20b-cloud");
  const r = await run({ strategy: "local", singlePassWords: 2, local: byName, call: noMainProvider });
  assert.deepEqual([byName.requests.length, r.calls, r.staged.status, r.staged.metrics.localRuns], [0, 0, "partial", "cloud"]);
  assert.ok(r.staged.issues.some(x => /^The local compile strategy did not compile this topic: gpt-oss:20b-cloud is not proven to run on this computer \(gpt-oss:20b-cloud is an Ollama cloud model/.test(x)));
  // A name that does not say so, on a loopback server that forwards it to ollama.com.
  const sent: string[] = [];
  const forwarding = new OllamaClient({ model: "big-model", transport: async (_method, url) => {
    sent.push(url);
    if (url.endsWith("/api/show")) return { status: 200, body: JSON.stringify({ remote_model: "gpt-oss:120b", remote_host: "https://ollama.com:443", details: { family: "gptoss" } }) };
    if (url.endsWith("/api/tags")) return { status: 200, body: JSON.stringify({ models: [{ name: "big-model:latest", digest: "sha256:eee555", remote_host: "https://ollama.com:443" }] }) };
    return assert.fail(`unexpected request to ${url}`);
  } });
  const shown = await run({ strategy: "local", singlePassWords: 2, local: forwarding, call: noMainProvider });
  assert.ok(!sent.some(u => u.endsWith("/api/chat")), "no prompt reaches the cloud model");
  assert.equal(shown.staged.metrics.localRuns, "cloud");
  assert.ok(shown.staged.issues.some(x => /Ollama reports that big-model runs on https:\/\/ollama\.com:443/.test(x)));
  const unknown = await run({ strategy: "local", singlePassWords: 2, call: noMainProvider,
    local: new OllamaClient({ transport: async () => { throw new LocalModelError("unreachable", "Ollama is not reachable at http://127.0.0.1:11434 (ECONNREFUSED)."); } }) });
  assert.equal(unknown.staged.metrics.localRuns, "unknown");
  assert.ok(unknown.staged.issues.some(x => /not proven to run on this computer \(could not ask Ollama where qwen2\.5:3b runs: Ollama is not reachable/.test(x)));
  const none = await run({ strategy: "local", call: noMainProvider });
  assert.ok(none.staged.issues.some(x => /did not compile this topic: no Ollama model is set up for compilation/.test(x)));
  assert.equal(none.staged.status, "partial");
});

test("the engine passes the strategy through, and the local strategy compiles a topic with no main-provider call", async () => {
  const fs = new MemFS(), store = new Store(fs, "Tutor");
  const settings: EngineSettings = { claudePath: "", chatModel: "fixture", compileModel: "fixture", utilityModel: "fixture", effort: "low", targetLevel: 4,
    maxChatWords: 600, maxTopicWords: 2000, singlePassWords: 2, smartRouting: false, hardEffort: "high", compileStrategy: "local" };
  const engine = new Engine(store, () => settings);
  (engine as unknown as { call: Model }).call = noMainProvider;
  engine.compilationLocal = localFrom();
  const r = await engine.compile({ title: "Linear maps", goal: "", material, mode: "notes", fm: {} });
  assert.deepEqual([r.status, r.agents, r.metrics?.strategy, r.metrics?.localRuns], ["complete", 0, "local", "local"]);
  settings.compileStrategy = "main";
  const local = localFrom();
  engine.compilationLocal = local;
  (engine as unknown as { call: Model }).call = fake();
  const main = await engine.compile({ title: "Linear maps 2", goal: "", material, mode: "notes", fm: {} });
  assert.deepEqual([main.metrics?.strategy, local.requests.length, local.described], ["main", 0, 0]);
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
  assert.deepEqual(n, { plan: 0, select: 0, review: 0, synth: 0, audit: 0 });
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

test("Claude Code reports the concrete model in modelUsage; Codex reports none, so its configured identity is kept", () => {
  // The shape of Claude Code 2.1.311's JSON result: per-model totals keyed by the model id the API was called with.
  const result = { type: "result", is_error: false, result: "OK", total_cost_usd: 0.004, usage: { input_tokens: 3, output_tokens: 520 },
    modelUsage: {
      "claude-haiku-4-5-20251001": { inputTokens: 40, outputTokens: 8, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.0001, contextWindow: 200000, maxOutputTokens: 64000 },
      "claude-sonnet-4-5-20250929": { inputTokens: 3, outputTokens: 520, cacheReadInputTokens: 1000, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.004, contextWindow: 200000, maxOutputTokens: 64000 },
    } };
  assert.equal(answeringModel(result.modelUsage), "claude-sonnet-4-5-20250929", "the main reply writes most of the output");
  assert.equal(answeringModel({ "us.anthropic.claude-sonnet-4-5-20250929-v1:0": { outputTokens: 4 } }), "us.anthropic.claude-sonnet-4-5-20250929-v1:0");
  for (const none of [undefined, {}, [], "claude-sonnet", { "bad id\n": { outputTokens: 9 } }]) assert.equal(answeringModel(none), undefined);
  const turn = new CodexTurn();
  turn.read(JSON.stringify({ type: "thread.started", thread_id: "t1" }));
  turn.read(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "OK" } }));
  turn.read(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } }));
  assert.equal(turn.result(0, "").model, undefined);
  const base = { claudePath: "", chatModel: "sonnet", compileModel: "", utilityModel: "haiku" };
  assert.deepEqual([modelIdentity(base, "chatModel"), modelIdentity(base, "compileModel"), modelIdentity({ ...base, modelProvider: "codex", codexCompileModel: " gpt-5 " }, "compileModel"), modelIdentity({ ...base, modelProvider: "codex" }, "chatModel")],
    ["sonnet", "claude:default", "codex:gpt-5", "codex:default"]);
});

test("checkpoints record the concrete model that answered, and one from another concrete model is a miss", async () => {
  const reporting = (model: string, call: Model = fake()): Model => async o => ({ ...(await call(o)), model });
  const cache = memory();
  const first = await run({ cache, modelKey: "sonnet", call: reporting("claude-sonnet-4-5-20250929") });
  assert.deepEqual([entry(cache, "plan-").model, entry(cache, "synth-").model, entry(cache, "audit-").model], Array(3).fill("claude-sonnet-4-5-20250929"));
  assert.equal(first.staged.metrics.mainModel, "claude-sonnet-4-5-20250929");
  // A new session: nothing has reported a model yet, so the checkpoints' own identity is trusted.
  const same = counted(reporting("claude-sonnet-4-5-20250929"));
  await run({ cache, modelKey: "sonnet", call: same.call });
  assert.deepEqual([same.n.plan, same.n.synth, same.n.audit], [0, 0, 0]);
  // A chat turn this session reported that "sonnet" now means another model.
  const moved = counted(reporting("claude-sonnet-5-20261101"));
  const r = await run({ cache, modelKey: "sonnet", reportedModel: "claude-sonnet-5-20261101", call: moved.call });
  assert.deepEqual([moved.n.plan, moved.n.synth, moved.n.audit], [1, 1, 1]);
  assert.deepEqual([entry(cache, "synth-").model, r.staged.metrics.mainModel], ["claude-sonnet-5-20261101", "claude-sonnet-5-20261101"]);
  assert.deepEqual([r.topicBody, r.staged.status], [first.topicBody, "complete"]);
  // Within one compile: the first call that reports a new model makes the later checkpoints miss.
  const groupsCache = memory();
  await run({ cache: groupsCache, material: twoGroups, call: reporting("model-a") });
  groupsCache.data.delete([...groupsCache.data.keys()].find(k => k.startsWith("audit-"))!);
  const later = counted(reporting("model-b"));
  const r2 = await run({ cache: groupsCache, material: twoGroups, call: later.call });
  assert.deepEqual([later.n.plan, later.n.synth, later.n.audit], [0, 1, 2], "group 1's audit reports model-b, so group 2's model-a checkpoints are recomputed");
  assert.ok(r2.staged.issues.includes("The main provider now answers fixture with model-b, not model-a; checkpoints saved from model-a are recomputed."));
});

test("checkpoints saved before model identities were recorded stay readable and miss once", async () => {
  const cache = memory();
  const first = await run({ cache, singlePassWords: 2, local: localFrom() });
  // Entries as earlier versions wrote them: the bare reply, with no model identity.
  for (const [k, v] of cache.data) if (/^(plan|select|synth|audit)-/.test(k)) cache.data.set(k, (v as { value: unknown }).value);
  const local = localFrom(), once = counted();
  const r = await run({ cache, singlePassWords: 2, local, call: once.call });
  assert.deepEqual([once.n.plan, local.n.select, once.n.synth, once.n.audit], [1, 1, 1, 1]);
  assert.deepEqual([r.topicBody, r.questionsBody], [first.topicBody, first.questionsBody]);
  const local2 = localFrom(), twice = counted();
  await run({ cache, singlePassWords: 2, local: local2, call: twice.call });
  assert.deepEqual([twice.n.plan, local2.n.select, twice.n.synth, twice.n.audit], [0, 0, 0, 0]);
});

test("a stage version bump invalidates that stage's checkpoints", async () => {
  const cache = memory();
  const sent: Partial<Record<Stage, { system: string; schema: any; input: unknown }>> = {};
  const base = fake();
  await run({ cache, call: o => { sent[stageOf(o.system)] = { system: o.system, schema: o.jsonSchema, input: JSON.parse(o.input) }; return base(o); } });
  for (const stage of ["synth", "audit"] as const) {
    const { system, schema, input } = sent[stage]!;
    const key = checkpointKey(stage, STAGE_VERSIONS[stage], "fixture", system, schema, input);
    assert.ok(cache.data.has(key), `the ${stage} checkpoint is keyed by its stage version`);
    assert.notEqual(checkpointKey(stage, `${STAGE_VERSIONS[stage]}-next`, "fixture", system, schema, input), key);
    // The cache as the previous version of this stage left it: the same reply under that version's key.
    cache.data.set(checkpointKey(stage, `${STAGE_VERSIONS[stage]}-previous`, "fixture", system, schema, input), cache.data.get(key));
    cache.data.delete(key);
    const rerun = counted();
    await run({ cache, call: rerun.call });
    assert.deepEqual([rerun.n.plan, rerun.n.synth, rerun.n.audit], stage === "synth" ? [0, 1, 0] : [0, 0, 1], `only the ${stage} stage reruns`);
    assert.ok(cache.data.has(key));
  }
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

/**
 * A model that writes a probe question only when the synthesis prompt asks for one with task "probe",
 * and an audit that lists every question it is shown, or every one but the probe.
 */
const PROBE_TEXT = "A tap fills a 12 litre bucket at 3 litres a minute. How many minutes does it take?";
function probing(auditProbe = true): Model {
  // The stub lists only ids the audit input names for a lesson, so a probe left out of that input is dropped.
  const call = fake({ audit: (input: any, reply: any) => { const listed = new Set(input.lessons.flatMap((l: any) => [...l.questions, ...(l.probes ?? [])])); return { rows: reply.rows.map((r: any) => ({ ...r, questions: input.questions.filter((q: any) => (auditProbe || q.task !== "probe") && listed.has(q.id)).map((q: any) => q.id) })) }; } });
  return async o => {
    const r = await call(o);
    const units = (r.structured as { units?: any[] } | undefined)?.units;
    if (units && /task "probe"/.test(o.system)) for (const u of units) u.questions.push({ type: "short", question: PROBE_TEXT, options: [], answer: "4", explanation: "12 / 3 = 4.", rubric: "", task: "probe", family: "bucket-rate", difficulty: 3, generator: "" });
    return r;
  };
}

test("cold probes end to end: the staged compile asks for a probe, the audit checks it, saveCompiled seals it, and a probe asks and scores it", async () => {
  const today = "2026-11-17";
  const fs = new MemFS(), store = new Store(fs, "Tutor", () => today);
  const settings: EngineSettings = { claudePath: "", chatModel: "fixture", compileModel: "fixture", utilityModel: "fixture", effort: "low", targetLevel: 4,
    maxChatWords: 600, maxTopicWords: 2000, singlePassWords: 600, smartRouting: false, hardEffort: "high" };
  const engine = new Engine(store, () => settings, () => today);
  (engine as unknown as { call: Model }).call = probing();
  const r = await engine.compile({ title: "Linear maps", goal: "", material, mode: "notes", fm: {} });
  assert.equal(r.status, "complete");
  assert.equal(r.questions, 1, "the notice counts the bank question only");
  assert.ok(await fs.exists(`${r.dir}/sealed.md`), "the compile wrote a sealed question");
  assert.ok((await fs.read(`${r.dir}/sealed.md`)).includes(PROBE_TEXT));
  assert.ok(!(await fs.read(`${r.dir}/questions.md`)).includes(PROBE_TEXT), "questions.md never holds the probe");
  const sealed = await store.loadSealed(r.dir);
  const state = await store.loadState(r.dir, 4);
  assert.deepEqual(sealed.map((q) => [q.task, q.concept]), [["probe", state.concepts[1]]]);
  // A sealed question never counts as assessing its objective.
  const pkg = (await store.loadPackage(r.dir))!;
  const bank = (await store.loadQuestions(r.dir)).map((q) => q.id);
  assert.deepEqual(bank, ["Q1"]);
  assert.deepEqual(pkg.staged!.lessons.map((l) => l.questions), [["Q1"]]);
  assert.deepEqual(pkg.staged!.availability.map((a) => a.questions), [["Q1"]]);
  assert.deepEqual(pkg.objectives.map((o) => o.questions), [["Q1"]]);

  // The concept is ready: level 3, first unaided success before today. The probe asks the sealed question and scores it.
  state.levels[1] = 3;
  for (const [id, day] of [["u1", "2026-11-15"], ["u2", "2026-11-16"]]) state.attempts.push({
    v: 2, id, skill: 1, concept: state.concepts[1], questionId: "Q1", question: "What is T(0,3)?", answer: "0", activity: "independent-practice", mode: "quiz", difficulty: null,
    result: "correct", errorType: "", note: "", confidence: null, assisted: false, assistance: [], answerExposed: false, transfer: false, seconds: null,
    timestamp: `${day}T10:00:00.000Z`, grading: "deterministic", verification: "verified", assumptions: "",
  });
  await store.saveState(r.dir, state);
  const started = await engine.startProbe(r.dir);
  assert.equal(started?.count, 1);
  const turn = await engine.study(r.dir, started!.chatPath, "4");
  assert.match(turn.reply, /1\/1 right/);
  const st = await engine.probeStatus(r.dir);
  assert.deepEqual([st.asked, st.correct, st.sealedTotal, st.count], [1, 1, 1, 0]);
  assert.equal((await store.loadState(r.dir, 4)).levels[1], 3, "levels are unchanged");

  // A probe the audit did not list is dropped like any unchecked question, so nothing is sealed.
  // Another model, so the saved checkpoints of the first compile are not replayed.
  (engine as unknown as { call: Model }).call = probing(false);
  settings.compileModel = "fixture-2";
  const unaudited = await engine.compile({ title: "Linear maps 2", goal: "", material, mode: "notes", fm: {} });
  assert.ok(!(await fs.exists(`${unaudited.dir}/sealed.md`)));
  assert.ok(!(await fs.read(`${unaudited.dir}/questions.md`)).includes(PROBE_TEXT));
});

test("a question's generator is kept only when trusted code checks it and it gives the question's own answer", async () => {
  const { parseQuestions } = await import("../src/formats");
  const gen = (answer: number) => JSON.stringify({ v: 1, params: { x: { min: 0, max: 9 }, y: { min: 1, max: 9 } }, template: "What is T({x},{y})?", answer: "x", tests: [{ params: { x: 0, y: 3 }, answer }] });
  const r = await run({ call: fake({ synth: (_input, reply: any) => {
    const q = reply.units[0].questions[0];
    reply.units[0].questions = [
      { ...q, generator: gen(0) },
      { ...q, question: "What is T(0,3) again?", generator: gen(5) },
      { ...q, question: "And T(0,4)?", generator: '{"v":1,"params":{"x":{"min":0,"max":9}},"template":"{x}","answer":"constructor(1)"}' },
    ];
    return reply;
  } }) });
  const kept = parseQuestions(r.questionsBody).filter((q) => q.generator);
  assert.equal(kept.length, 1, "only the spec that reproduces the stated answer is kept");
  assert.equal(kept[0].generator?.answer, "x");
  assert.deepEqual([r.staged.metrics.generators, r.staged.metrics.generatorsRejected], [1, 2]);
});
