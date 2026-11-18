import { test } from "node:test";
import assert from "node:assert/strict";
import { assessLesson, createVariant, listModuleDescriptors, validateLesson } from "../src/visuals/registry";
import { evaluate, formula, projectile, rangeBounds, traceAlgorithm, numericVariant, plotSegments, type PlotSettings, type ProjectileSettings, type AlgorithmSettings } from "../src/visuals/models";
import { FIXTURES } from "../src/visuals/fixtures";
import { ASSETS } from "../src/visuals/assets";
import { readFileSync } from "node:fs";
import * as registryModule from "../src/visuals/registry";
import { questionFor } from "../src/visuals/registry";
import { DIAGRAM_SCHEMA, SIMULATION_SCHEMAS, unsafeText, validateDiagramBlueprint, validateSimulationBlueprint, walkDiagram, type DescriptorBlueprint, type DiagramBlueprint, type ProcessBlueprint, type RaceBlueprint, type RingBlueprint } from "../src/visuals/blueprints";
import { entryOf, ringContents, ringTail, runDescriptors, runProcesses, runRace, runRing } from "../src/visuals/systems";
import { SYSTEMS_DESCRIPTORS } from "../src/visuals/systems-modules";
import { adaptRegistry } from "../src/visualcontract";
import { CONFIG_PROMPT_VERSION, configureActivity, providerModel } from "../src/configure";
import { validateJson, ollamaSchema } from "../src/jsonschema";
import { matchModules, choosePresentation } from "../src/presentation";
import { Engine } from "../src/engine";
import { Store } from "../src/store";
import * as F from "../src/formats";
import { MemFS } from "./memfs";
import { scriptedModel } from "./fixtures/visual-modules";
const copy = (id: string) => structuredClone(FIXTURES[id]);
const near = (a: number, b: number, tolerance=1e-8) => assert.ok(Math.abs(a-b)<tolerance, `${a} != ${b}`);
test("all engineering fixtures validate, descriptors are isolated copies",()=>{
  Object.values(FIXTURES).forEach(l=>assert.deepEqual(validateLesson(l),{valid:true,lesson:l}));
  const d=listModuleDescriptors();d[0].id="tampered";assert.equal(listModuleDescriptors()[0].id,"function-plotter");
});
test("untrusted lesson/config fields, versions, assets, domains and numeric bounds are rejected",()=>{
  for(const raw of [null,[],"oops",{...copy("plot"),schemaVersion:2},{...copy("plot"),moduleId:"eval"},{...copy("plot"),moduleVersion:"9"},{...copy("plot"),assessmentId:"invented"},{...copy("plot"),assetIds:["https://evil.example/x"]},{...copy("plot"),sourceRefs:[]},{...copy("plot"),code:"alert(1)"}])assert.equal(validateLesson(raw).valid,false);
  for(const patch of [{coefficients:[NaN]},{coefficients:[Infinity]},{coefficients:Array(100).fill(1)},{domain:[3,1]},{viewport:[1,2,1,-2]},{pointX:500},{family:"javascript"},{script:"return 1"},{scale:"2"},{family:"log",domain:[-4,-1]}])assert.equal(validateLesson({...copy("plot"),settings:{...copy("plot").settings,...patch}}).valid,false,JSON.stringify(patch));
});
test("validation returns a defensive clone; model objects cannot mutate stored data",()=>{
  const input=copy("plot"),v=validateLesson(input);assert.ok(v.valid);v.lesson.settings.scale=9;assert.equal(input.settings.scale,1);
});
test("polynomial values, transforms and derivatives use ascending coefficients",()=>{
  const s={...copy("plot").settings,coefficients:[2,-3,4],scale:2,shiftX:1,shiftY:5} as unknown as PlotSettings;
  assert.deepEqual(evaluate(s,3),{y:29,slope:26});assert.match(formula(s),/4·\(x − 1\)\^2/);
});
test("elementary derivatives agree with independent finite differences away from singularities",()=>{
  for(const family of ["sin","cos","exp","log","sqrt","reciprocal","abs"] as const){
    const s={...copy("plot").settings,family,scale:1.7,shiftX:0.3,shiftY:-2} as unknown as PlotSettings;
    const x=1.3,h=1e-5;near(evaluate(s,x).slope!, (evaluate(s,x+h).y!-evaluate(s,x-h).y!)/(2*h),1e-7);
  }
});
test("discontinuities and undefined slopes are explicit; reciprocal curves never bridge the pole",()=>{
  const s=copy("plot").settings as unknown as PlotSettings;
  assert.deepEqual(evaluate({...s,family:"reciprocal"},0),{y:null,slope:null});
  assert.deepEqual(evaluate({...s,family:"abs"},0),{y:0,slope:null});
  assert.deepEqual(evaluate({...s,family:"sqrt"},0),{y:0,slope:null});
  assert.deepEqual(evaluate({...s,family:"log"},-1),{y:null,slope:null});
  assert.deepEqual(evaluate(s,5),{y:null,slope:null});
  const pieces=plotSegments({...s,family:"reciprocal"});assert.equal(pieces.length,2);assert.ok(pieces[0][1]<0&&pieces[1][0]>0);
});
test("projectile matches independent reference to eight decimal places",()=>{
  const p=projectile({speed:10,angle:45,gravity:9.81});near(p.range,10.19367992);near(p.flight,1.44160404);near(p.height,2.54841998);
  near(p.vx,Math.sqrt(50));near(p.ay,-9.81);assert.equal(p.ax,0);
});
test("landing is clamped exactly, and model does not depend on frame history",()=>{
  const s=copy("projectile").settings as unknown as ProjectileSettings;
  for(const hz of [15,30,60,144]){const end=projectile(s,1000);for(let t=0;t<end.flight;t+=1/hz)projectile(s,t);assert.equal(end.y,0);near(end.x,end.range);near(end.t,end.flight);}
  assert.deepEqual(projectile(s,.712),projectile(s,.712));assert.equal(projectile(s,-1).t,0);
});
test("reachability accounts for restricted angles, speed bounds and target width",()=>{
  const l=copy("projectile");l.settings={...l.settings,speedRange:[10,10],angleRange:[5,10],angle:8,target:10,tolerance:.1};assert.equal(validateLesson(l).valid,false);
  const s=l.settings as unknown as ProjectileSettings;near(rangeBounds(s)[1],100*Math.sin(20*Math.PI/180)/9.81);
  l.settings.target=rangeBounds(s)[1]+.1;assert.equal(validateLesson(l).valid,true);
  l.settings.speed=11;assert.equal(validateLesson(l).valid,false);
});
test("actual sorting trace has comparisons, both writes, swaps and a correct final state",()=>{
  const s=copy("algorithm").settings as unknown as AlgorithmSettings;
  const trace=traceAlgorithm(s);assert.deepEqual(trace[trace.length-1].result,[2,3,5,7,9]);
  const first=trace.findIndex(e=>e.type==="swap");assert.deepEqual(trace.slice(first-2,first+1).map(e=>e.type),["write","write","swap"]);
  assert.deepEqual(trace[first].values,[3,7,9,2,5]);assert.deepEqual(s.values,[7,3,9,2,5]);assert.deepEqual(traceAlgorithm(s),trace);
  for(let seed=0;seed<30;seed++) {const values=numericVariant(seed),t=traceAlgorithm({...s,values});assert.deepEqual(t[t.length-1].result,[...values].sort((a,b)=>a-b));}
});
test("index and search traces have correct hit/miss/duplicate semantics",()=>{
  const s={algorithm:"index",values:[1,3,3,8],index:2,target:3} as AlgorithmSettings;
  const result=(settings:AlgorithmSettings)=>{const t=traceAlgorithm(settings);return t[t.length-1].result;};
  assert.equal(result(s),3);assert.equal(result({...s,algorithm:"linear-search"}),1);assert.equal(result({...s,algorithm:"binary-search"}),1);
  assert.equal(result({...s,algorithm:"binary-search",target:7}),-1);assert.equal(result({...s,algorithm:"linear-search",target:7}),-1);
  const l=copy("algorithm");l.settings={...l.settings,algorithm:"binary-search"};assert.equal(validateLesson(l).valid,false);
  l.settings={...l.settings,values:[1,2],index:2};assert.equal(validateLesson(l).valid,false);
});
test("variants are deterministic, integer and bounded",()=>{
  assert.deepEqual(numericVariant(17),numericVariant(17));assert.notDeepEqual(numericVariant(17),numericVariant(18));assert.ok(numericVariant(42,16).every(n=>Number.isInteger(n)&&n>=0&&n<100));assert.throws(()=>numericVariant(1,10000));
});
test("module-owned assessment never awards independent mastery, including correct hits",()=>{
  const l=copy("projectile");const r=assessLesson(l,{answer:10.19367992,explanation:"No horizontal force."});assert.equal(r.status,"correct");assert.equal(r.independentMastery,false);
  assert.equal(assessLesson(l,{answer:"10.19367992"}).status,"incorrect");
  assert.equal(assessLesson(copy("plot"),{answer:2}).status,"correct");
  assert.equal(assessLesson(copy("algorithm"),{answer:[2,3,5,7,9]}).status,"correct");
  assert.equal(assessLesson(copy("external"),{answer:"I won"}).status,"ungraded");
});
test("asset catalog matches actual PNG dimensions and carries CC0 provenance",()=>{
  for(const a of ASSETS){const b=readFileSync(a.path);assert.equal(b.readUInt32BE(16),a.width);assert.equal(b.readUInt32BE(20),a.height);assert.equal(a.license,"CC0-1.0");assert.match(a.source,/^https:\/\/kenney.nl\/assets\//);}
});
test("backend assessment follows allowed learner controls and refuses changed equations",()=>{
  const l=copy("projectile");const settings={...l.settings,speed:12};
  const expected=projectile(settings as unknown as ProjectileSettings).range;
  assert.equal(assessLesson(l,{answer:expected,settings}).status,"correct");
  assert.equal(assessLesson(l,{answer:expected,settings:{...settings,gravity:1}}).status,"invalid");
  assert.equal(assessLesson(l,{answer:expected,settings:{...settings,speed:100}}).status,"invalid");
  const p=copy("plot");assert.equal(assessLesson(p,{answer:4,settings:{...p.settings,pointX:2}}).status,"correct");
  const corrupted=copy("plot");corrupted.sourceRefs[0].excerpt="changed";assert.equal(validateLesson(corrupted).valid,false);
});
test("numeric variants are made and validated by module code, deterministically, with the question rewritten", () => {
  for (const id of ["projectile", "plot", "algorithm"]) {
    const a = createVariant(copy(id), 7), b = createVariant(copy(id), 7), c = createVariant(copy(id), 8);
    assert.ok(a && validateLesson(a).valid, `${id} variant validates`);
    assert.deepEqual(a, b, `${id}: the same seed gives the same variant`);
    assert.notDeepEqual(a!.settings, c!.settings, `${id}: another seed gives other numbers`);
    for (const k of ["moduleId", "moduleVersion", "assessmentId", "objective", "sourceRefs", "assetIds"] as const) assert.deepEqual(a![k], copy(id)[k], `${id}: ${k} unchanged`);
  }
  const p = createVariant(copy("projectile"), 11)!, s = p.settings as unknown as ProjectileSettings;
  const [lo, hi] = rangeBounds(s);
  assert.ok(s.target >= lo - s.tolerance && s.target <= hi + s.tolerance, "the new target is reachable with the allowed controls");
  assert.match(p.predictionQuestion, new RegExp(`speed ${s.speed} m/s, angle ${s.angle} degrees`), "the question states the new settings");
  const bin = createVariant({ ...copy("algorithm"), settings: { ...copy("algorithm").settings, algorithm: "binary-search", values: [1, 3, 5, 7, 9] } }, 5)!;
  const v = (bin.settings as unknown as AlgorithmSettings).values;
  assert.deepEqual(v, [...new Set(v)].sort((x, y) => x - y), "binary-search variants stay sorted and distinct");
  assert.equal(createVariant(copy("external"), 3), null, "external activities have no numeric variants");
  assert.equal(createVariant({ schemaVersion: 1 }, 3), null);
});

// ---------- Software Systems blueprints ----------

const SYSTEMS = ["process", "race", "ring", "descriptors", "diagram", "diagramRing", "diagramTables"];
const settingsOf = <T>(id: string) => copy(id).settings as unknown as T;
const lessonWith = (id: string, patch: Record<string, unknown>) => { const l = copy(id); l.settings = { ...l.settings, ...patch } as typeof l.settings; return l; };
const invalid = (id: string, patch: Record<string, unknown>, pattern: RegExp) => {
  const v = validateLesson(lessonWith(id, patch));
  assert.equal(v.valid, false, `${id} ${JSON.stringify(patch).slice(0, 120)}`);
  if (!v.valid) assert.match(v.errors.map((e) => `${e.path}: ${e.message}`).join("\n"), pattern);
};

test("systems fixtures validate as lessons, match their schemas, and ask the module's own question", () => {
  for (const id of SYSTEMS) {
    const l = copy(id);
    assert.ok(validateLesson(l).valid, id);
    const d = SYSTEMS_DESCRIPTORS.find((x) => x.id === l.moduleId)!;
    assert.deepEqual(validateJson(l.settings, d.settingsSchema), [], `${id} matches the schema sent to a model`);
    assert.equal(questionFor(l), l.predictionQuestion, `${id}: the question is written by code`);
    assert.match(l.predictionQuestion, /\?$/);
  }
  assert.equal(questionFor(copy("projectile")), null, "other modules keep their own wording");
  assert.equal(questionFor({ ...copy("race"), settings: {} }), null, "no question for an invalid lesson");
  const ids = listModuleDescriptors().map((d) => d.id);
  for (const id of ["systems-diagram", "process-states", "race-condition", "circular-buffer", "descriptor-tables"]) assert.ok(ids.includes(id), id);
  assert.equal(registryModule.catalogVersion(), "visuals-v1.2.0/kenney-2026-11-14", "a new catalogue invalidates saved activities");
  // The schemas a model writes to are closed all the way down and survive Ollama's converter.
  for (const s of [DIAGRAM_SCHEMA, ...Object.values(SIMULATION_SCHEMAS)]) {
    const sent = ollamaSchema(s) as { additionalProperties: boolean; properties: Record<string, { items?: { additionalProperties?: boolean } }> };
    assert.equal(sent.additionalProperties, false);
    for (const p of Object.values(sent.properties)) if (p.items && "additionalProperties" in p.items) assert.equal(p.items.additionalProperties, false);
  }
});

test("diagram and simulation blueprints are distinct types with distinct validators", () => {
  const diagram = settingsOf<DiagramBlueprint>("diagram"), race = settingsOf<RaceBlueprint>("race");
  assert.ok(validateDiagramBlueprint(diagram).valid);
  assert.ok(validateSimulationBlueprint(race).valid);
  assert.equal(validateSimulationBlueprint(diagram).valid, false, "a diagram is not a simulation");
  assert.equal(validateDiagramBlueprint(race).valid, false, "a simulation is not a diagram");
  assert.equal(validateSimulationBlueprint(race, "ring-buffer").valid, false, "a module runs only its own model");
  invalid("ring", race as unknown as Record<string, unknown>, /settings\.model: this module runs ring-buffer, not race/);
  const v = validateDiagramBlueprint(diagram);
  assert.ok(v.valid && v.blueprint !== diagram, "validation returns a defensive copy");
});

test("blueprints over their bounds or with unknown fields are refused", () => {
  const d = settingsOf<DiagramBlueprint>("diagram");
  const nodes = Array.from({ length: 25 }, (_, i) => ({ id: `n${i}`, label: `S${i}`, group: "", note: "" }));
  invalid("diagram", { nodes }, /settings\.nodes: must have at most 24 items/);
  invalid("diagram", { title: "x".repeat(81) }, /settings\.title: must be at most 80 characters/);
  invalid("diagram", { path: Array(9).fill("dispatch") }, /settings\.path: must have at most 8 items/);
  invalid("diagram", { nodes: [{ ...d.nodes[0], label: "y".repeat(25) }, ...d.nodes.slice(1)] }, /settings\.nodes\[0\]\.label: must be at most 24/);
  invalid("diagram", { script: "alert(1)" }, /unexpected field "script"/);
  invalid("diagram", { nodes: [{ ...d.nodes[0], onclick: "x" }, ...d.nodes.slice(1)] }, /settings\.nodes\[0\]: has an unexpected field "onclick"/);
  invalid("diagramRing", { nodes: Array.from({ length: 17 }, (_, i) => ({ id: `s${i}`, label: "1", group: "", note: "" })), markers: [], highlights: [], start: "s0" }, /a ring needs 2–16 slots/);
  invalid("race", { schedule: Array(31).fill("A") }, /settings\.schedule: must have at most 30 items/);
  invalid("race", { threads: [{ id: "A", delta: 1, times: 9 }, { id: "B", delta: 1, times: 1 }] }, /times: must be at most 3/);
  invalid("race", { threads: [{ id: "A", delta: 1, times: 1 }, { id: "B", delta: 1, times: 1 }, { id: "C", delta: 1, times: 1 }] }, /threads: must have at most 2 items/);
  invalid("race", { lock: "yes" }, /settings\.lock: must be boolean/);
  invalid("ring", { capacity: 50 }, /settings\.capacity: must be at most 12/);
  invalid("ring", { steps: [{ op: "push", value: 1, slot: 2 }] }, /unexpected field "slot"/);
  invalid("descriptors", { steps: Array(17).fill({ op: "open", pid: 100, path: "/tmp/log.txt" }) }, /settings\.steps: must have at most 16 items/);
  invalid("process", { processes: [{ id: "P1", state: "zombie" }] }, /settings\.processes\[0\]\.state: must be one of/);
  invalid("process", { model: "process-states", eval: "1" }, /unexpected field "eval"/);
});

test("blueprint text that carries markup, scripts, links or escapes is refused; plain labels pass", () => {
  const d = settingsOf<DiagramBlueprint>("diagram");
  for (const label of ["<img src=x onerror=alert(1)>", "<script>x</script>", "javascript:alert(1)", "![x](https://evil.example/p.png)", "a&#60;b", "${constructor}", "`code`", "see //evil.example", "x onload=go", "C:\\Windows"]) {
    assert.ok(unsafeText(label), label);
    invalid("diagram", { nodes: [{ ...d.nodes[0], label: label.slice(0, 24) }, ...d.nodes.slice(1)] }, /settings\.nodes\[0\]\.label: (contains markup|would load)/);
  }
  invalid("diagram", { title: "Process <b>states</b>" }, /settings\.title: contains markup/);
  invalid("race", { variable: "x<script>" }, /settings\.variable: contains markup/);
  invalid("descriptors", { files: [{ path: "https://evil.example/x", inode: 1 }] }, /settings\.files\[0\]\.path/);
  invalid("descriptors", { files: [{ path: "/tmp/../etc/passwd", inode: 1 }] }, /settings\.files\[0\]\.path: use a short file name/);
  invalid("diagramTables", { groups: [{ id: "fds", label: "fds onerror=1" }, ...settingsOf<DiagramBlueprint>("diagramTables").groups.slice(1)] }, /settings\.groups\[0\]\.label: contains markup/);
  for (const ok of ["fd 3 → #1", "P1 wait", "read/write", "offset 120 · refs 2", "data: 42", "/tmp/log.txt", "Ready (queue)"]) assert.equal(unsafeText(ok), null, ok);
});

test("inconsistent blueprints are refused: missing nodes, slots, threads, processes and descriptors", () => {
  const d = settingsOf<DiagramBlueprint>("diagram");
  invalid("diagram", { edges: [...d.edges, { from: "ready", to: "zombie", label: "kill" }] }, /settings\.edges\[6\]\.to: zombie is not a node/);
  invalid("diagram", { highlights: ["nowhere"] }, /settings\.highlights\[0\]: nowhere is not a node/);
  invalid("diagram", { markers: [{ label: "start", at: "nowhere" }] }, /settings\.markers\[0\]\.at: nowhere is not a node/);
  invalid("diagram", { start: "limbo" }, /settings\.start: limbo is not a node/);
  invalid("diagram", { path: ["dispatch", "dispatch"] }, /settings\.path\[1\]: no edge "dispatch" leaves running/);
  invalid("diagram", { edges: [...d.edges, { from: "ready", to: "terminated", label: "Dispatch" }] }, /already has an edge labelled "Dispatch"/);
  invalid("diagram", { nodes: [...d.nodes, { ...d.nodes[0] }] }, /repeats the id new/);
  invalid("diagramRing", { edges: [{ from: "s0", to: "s1", label: "next" }] }, /leave edges empty/);
  invalid("diagramRing", { start: "s3", path: ["next", "sideways"] }, /no edge "sideways" leaves s0/);
  invalid("diagramTables", { nodes: [...settingsOf<DiagramBlueprint>("diagramTables").nodes, { id: "x", label: "x", group: "heap", note: "" }] }, /heap is not one of the tables/);
  invalid("process", { steps: [{ event: "dispatch", pid: "P1" }] }, /settings\.steps\[0\]: P1 cannot dispatch while running/);
  invalid("process", { steps: [{ event: "wake", pid: "P9" }] }, /settings\.steps\[0\]\.pid: P9 is not one of the processes/);
  invalid("process", { processes: [{ id: "P1", state: "running" }, { id: "P2", state: "running" }], steps: [{ event: "exit", pid: "P1" }], focus: "P1" }, /at most one process may start running/);
  invalid("process", { steps: [{ event: "admit", pid: "P3" }, { event: "dispatch", pid: "P3" }] }, /settings\.steps\[1\]: P3 cannot be dispatched while P1 is running/);
  invalid("process", { focus: "P7" }, /settings\.focus: P7 is not one of the processes/);
  invalid("race", { schedule: ["A", "C"] }, /settings\.schedule\[1\]: C is not one of the threads/);
  invalid("race", { schedule: ["A", "A", "A", "A"] }, /settings\.schedule\[3\]: A has no steps left/);
  invalid("race", { threads: [{ id: "A", delta: 1, times: 1 }, { id: "A", delta: 2, times: 1 }] }, /different ids/);
  invalid("ring", { head: 4 }, /settings\.head: slot 4 does not exist in a ring of 4/);
  invalid("ring", { values: [1, 2, 3, 4], capacity: 3 }, /4 items do not fit in 3 slots/);
  invalid("ring", { steps: [{ op: "push" }] }, /settings\.steps\[0\]\.value: a push needs a value/);
  invalid("ring", { steps: [{ op: "pop", value: 3 }] }, /settings\.steps\[0\]\.value: a pop takes no value/);
  const steps = settingsOf<DescriptorBlueprint>("descriptors").steps;
  invalid("descriptors", { steps: [steps[0], { op: "close", pid: 100, fd: 7 }] }, /settings\.steps\[1\]: fd 7 is not open in process 100/);
  invalid("descriptors", { steps: [{ op: "open", pid: 100, path: "/etc/shadow" }] }, /\/etc\/shadow is not one of the files/);
  invalid("descriptors", { steps: [steps[0], { op: "fork", pid: 100, child: 100 }] }, /process 100 already exists/);
  invalid("descriptors", { steps: [{ op: "dup", pid: 100, fd: 3, path: "/tmp/log.txt" }] }, /settings\.steps\[0\]\.path: dup takes no path/);
  invalid("descriptors", { steps: [{ op: "dup2", pid: 100, fd: 3 }] }, /settings\.steps\[0\]\.to: dup2 needs to/);
  invalid("descriptors", { steps: [steps[0], { op: "close", pid: 100, fd: 3 }] }, /settings\.focusFd: fd 3 of process 100 is not open at the end/);
  invalid("descriptors", { files: [{ path: "/tmp/a", inode: 7 }, { path: "/tmp/b", inode: 7 }] }, /its own inode number/);
});

test("simulations are deterministic: lost update, lock, ring full and empty, refcounts after fork and dup", () => {
  // Race: read, read, add, add, write, write loses one update; the lock removes the race.
  const race = settingsOf<RaceBlueprint>("race");
  const open = runRace(race);
  assert.deepEqual([open.final, open.expected], [1, 2]);
  assert.deepEqual(open.frames.slice(1).map((f) => `${f.thread}:${f.op}`), ["A:read", "B:read", "A:add", "B:add", "A:write", "B:write"]);
  assert.deepEqual(runRace(race), open, "the same blueprint gives the same run");
  const locked = runRace(race, true);
  assert.equal(locked.final, 2);
  assert.ok(locked.frames.some((f) => f.op === "blocked" && f.thread === "B"), "B waits while A holds the lock");
  assert.equal(runRace({ ...race, schedule: ["A", "A", "A", "B", "B", "B"] }).final, 2, "one after the other loses nothing");
  const mixed = runRace({ ...race, threads: [{ id: "A", delta: 1, times: 2 }, { id: "B", delta: -1, times: 1 }], schedule: ["A", "B", "A", "A", "B", "B"] });
  assert.deepEqual([mixed.final, mixed.expected], [0, 1], "B's stale write erases A's first update; A's second runs afterwards");
  // Ring: full and empty both have head = tail; the count tells them apart.
  const ring = runRing(settingsOf<RingBlueprint>("ring")).frames;
  const full = ring[2], empty = ring[7];
  assert.deepEqual([full.count, full.head, ringTail(full), full.op], [4, 2, 2, "push"]);
  assert.deepEqual([ring[3].op, ring[3].rejected, ring[3].count], ["overflow", 1, 4]);
  assert.deepEqual([empty.count, empty.head, ringTail(empty), empty.op], [0, 2, 2, "pop"]);
  assert.equal(ring[8].op, "underflow");
  assert.deepEqual(ringContents(ring[9]), [6]);
  assert.deepEqual(ringContents(ring[2]), [7, 3, 5, 8]);
  const over = runRing({ ...settingsOf<RingBlueprint>("ring"), overflow: "overwrite" }).frames[3];
  assert.deepEqual([over.op, ringContents(over)], ["overwrite", [3, 5, 8, 1]]);
  // Descriptors: dup and fork share one open-file entry, so its offset and references are shared.
  const b = settingsOf<DescriptorBlueprint>("descriptors");
  const f = runDescriptors(b).frames;
  assert.deepEqual(entryOf(f[3], 100, 3), { id: 1, path: "/tmp/log.txt", inode: 4021, offset: 0, refs: 4 }, "open, dup, fork: four descriptors, one entry");
  assert.equal(entryOf(f[4], 100, 4)?.offset, 120, "the child's write moves the parent's offset");
  assert.deepEqual([entryOf(f[6], 101, 3)?.id, entryOf(f[6], 101, 3)?.refs, entryOf(f[6], 100, 3)?.refs], [2, 2, 3], "dup2 closes the old fd 3 first");
  assert.deepEqual([entryOf(f[7], 100, 3)?.refs, entryOf(f[7], 100, 3)?.offset], [2, 120]);
  assert.deepEqual(f[7].inodes.map((i) => i.refs), [1, 1], "one open-file entry per inode");
  // Processes: the scheduler trace ends with P1 running, P2 ready, P3 terminated.
  const p = runProcesses(settingsOf<ProcessBlueprint>("process"));
  assert.equal(p.error, null);
  assert.deepEqual(p.frames[p.frames.length - 1].states, { P1: "running", P2: "ready", P3: "terminated" });
  // Diagrams: the walk follows labelled edges, and next/prev around a ring.
  assert.deepEqual(walkDiagram(settingsOf<DiagramBlueprint>("diagram")).visited, ["ready", "running", "ready", "running", "waiting"]);
  assert.deepEqual(walkDiagram(settingsOf<DiagramBlueprint>("diagramRing")).visited, ["s3", "s0", "s1"], "the slot after the last is slot 0");
});

test("systems answers are computed by module code; the race's lock is the only learner control", () => {
  const ok = (id: string, answer: unknown, extra: Record<string, unknown> = {}) => assessLesson(copy(id), { answer: answer as never, ...extra });
  assert.equal(ok("process", "ready").status, "correct");
  assert.equal(ok("process", "running").status, "incorrect");
  assert.equal(ok("race", 1).status, "correct");
  assert.equal(ok("race", 2).status, "incorrect");
  assert.equal(ok("race", 2, { settings: { ...copy("race").settings, lock: true } }).status, "correct", "with the lock the answer is 2");
  assert.equal(ok("race", 2, { settings: { ...copy("race").settings, initial: 1 } }).status, "invalid", "the start value is not a learner control");
  assert.equal(ok("ring", 1).status, "correct");
  assert.equal(assessLesson({ ...copy("ring"), assessmentId: "ring-contents" }, { answer: [6] }).status, "correct");
  assert.equal(ok("descriptors", 2).status, "correct");
  assert.equal(assessLesson({ ...copy("descriptors"), assessmentId: "shared-offset" }, { answer: 120 }).status, "correct");
  assert.equal(ok("diagram", "  waiting ").status, "correct", "labels ignore case and spacing");
  assert.equal(ok("diagramTables", "inode 4021").status, "correct");
  assert.equal(ok("diagramRing", "8").status, "correct");
  for (const id of SYSTEMS) assert.equal(ok(id, 0).independentMastery, false);
});

// A race blueprint as a model would write it, with every lesson field the configuration asks for.
const raceReply = (settings: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => JSON.stringify({ fits: true, objective: "See how two threads lose an update to a shared counter", settings: { ...copy("race").settings, ...settings }, assetIds: [], assessmentId: "final-value", predictionQuestion: "What will the counter hold when both threads finish?", hint: "Each thread adds to the value it read earlier.", missingOperation: "", ...over });
const RACE_EXCERPT = "Two threads that read, add and write a shared counter can lose an update unless a lock guards the update.";
const raceRequest = { version: 1 as const, kind: "simulation" as const, reason: "You asked for a simulation.", objective: "Race conditions: two threads update a shared counter", sourceRefs: [{ path: "Systems/Threads.md", contentHash: F.contentHash(RACE_EXCERPT), excerpt: RACE_EXCERPT }] };
const raceDescriptor = SYSTEMS_DESCRIPTORS.find((d) => d.id === "race-condition")!;
const realRegistry = () => adaptRegistry(registryModule as unknown as Record<string, unknown>);
const plan = (model: ReturnType<typeof scriptedModel>, over: Record<string, unknown> = {}) => configureActivity({ request: raceRequest, conceptId: "c/race", candidates: [raceDescriptor], assets: [], registry: realRegistry(), model, catalogVersion: registryModule.catalogVersion(), trigger: "explicit", ...over });

test("a blueprint is proposed once, validated by code, repaired at most once, and otherwise recorded as invalid", async () => {
  // Valid the first time: one call, and the question is the module's, not the model's.
  const first = scriptedModel([raceReply()]);
  const r = await plan(first);
  assert.deepEqual([r.status, r.localCalls, r.repairs, r.firstPassValid, r.claudeCalls, r.provider], ["ready", 1, 0, true, 0, "local"], r.validationErrors.join("; "));
  assert.equal(r.lesson!.predictionQuestion, questionFor(r.lesson!));
  assert.match(r.lesson!.predictionQuestion, /What is the final value of counter\?$/);
  assert.equal(first.requests[0].maxTokens, raceDescriptor.outputTokens, "a blueprint gets a larger output allowance");
  assert.match(first.requests[0].user, /^MODULE race-condition v1\.0\.0/);
  assert.match(first.requests[0].user, /- schedule: array, 1–30 items of string\. thread ids in the order/);
  assert.equal(r.promptVersion, CONFIG_PROMPT_VERSION);
  // Invalid, then repaired: the repair carries the validation errors.
  const fixed = scriptedModel([raceReply({ schedule: ["A", "C"] }), raceReply()]);
  const r2 = await plan(fixed);
  assert.deepEqual([r2.status, r2.localCalls, r2.repairs, r2.firstPassValid], ["ready", 2, 1, false]);
  assert.match(fixed.requests[1].user, /IT FAILED THESE CHECKS:\n- module race-condition: settings\.schedule\[1\]: C is not one of the threads/);
  // Invalid twice: exactly two calls, then a final invalid record that says why.
  const broken = scriptedModel([raceReply({ schedule: ["A", "C"] }), raceReply({ variable: "<b>x</b>" })]);
  const r3 = await plan(broken);
  assert.deepEqual([r3.status, r3.localCalls, r3.repairs, broken.requests.length], ["invalid", 2, 1, 2]);
  assert.match(r3.reason, /failed its checks after one repair\. A simpler explanation is used instead\./);
  assert.match(r3.validationErrors.join("\n"), /settings\.variable: contains markup/);
  // Script in the model's text never reaches a lesson.
  const scripted = await plan(scriptedModel([raceReply({}, { hint: "<script>alert(1)</script>" }), raceReply({}, { hint: "<script>alert(1)</script>" })]));
  assert.equal(scripted.status, "invalid");
});

test("the main provider can plan a blueprint the same way, counted as a main-provider call", async () => {
  const sent: string[] = [];
  const model = providerModel("claude:sonnet", async (o) => { sent.push(o.user); return sent.length === 1 ? raceReply({ schedule: ["Z"] }) : raceReply(); });
  const r = await configureActivity({ request: raceRequest, conceptId: "c/race", candidates: [raceDescriptor], assets: [], registry: realRegistry(), model, catalogVersion: "k", trigger: "compile", provider: "main" });
  assert.deepEqual([r.status, r.provider, r.claudeCalls, r.localCalls, r.repairs, r.model], ["ready", "main", 2, 0, 1, "claude:sonnet"]);
  assert.match(sent[1], /Z is not one of the threads/);
});

test("the gate offers the systems modules: simulations by topic, and a diagram for a difficulty the course marked", () => {
  const ds = listModuleDescriptors();
  const best = (text: string, kind: "simulation" | "diagram") => matchModules(text, kind, ds)[0]?.descriptor.id;
  assert.equal(best("A process moves from running to ready when the scheduler preempts it", "simulation"), "process-states");
  assert.equal(best("Two threads update a shared counter; without a lock an interleaving loses an update", "simulation"), "race-condition");
  assert.equal(best("A pipe is a circular buffer whose head and tail indices wrap around", "simulation"), "circular-buffer");
  assert.equal(best("After fork the child shares the parent's open file descriptors; dup2 redirects one", "simulation"), "descriptor-tables");
  assert.equal(best("Draw the process state diagram: ready, running and waiting", "diagram"), "systems-diagram");
  const g = { mode: "auto" as const, action: "re-explain", message: "I still think it goes straight back to running", objective: "Process states: ready, running, waiting", context: "A waiting process becomes ready when its I/O completes; the scheduler dispatches it later.", recentFailures: 2, errorType: "conceptual", misconception: false, eligibility: { kind: "diagram", reason: "the states and transitions" }, descriptors: ds, saved: [] };
  const offer = choosePresentation(g, null);
  assert.deepEqual([offer.status, offer.kind, offer.moduleId], ["offer", "diagram", "systems-diagram"]);
  assert.equal(choosePresentation({ ...g, descriptors: [] }, null).status, "text", "with no diagram module the tutor draws one");
});

const CARD = `# Systems

## Overview
How an operating system schedules processes and shares data between threads.

## Objectives
- O1: Trace a process through its states ([[Process notes]])
- O2: Explain how a race loses an update ([[Thread notes]])

## Subskills

### 1. Process states
prerequisites: none
objectives: O1
visual: simulation | watching processes move between states
- A process moves between ready, running and waiting as the scheduler dispatches and preempts it ([[Process notes]]).
worked example:
A process that requests a disk read moves from running to waiting; when the read completes it becomes ready.

### 2. Race conditions
prerequisites: 1
objectives: O2
visual: simulation | stepping through an interleaving
- Two threads that read, add and write a shared counter can lose an update unless a lock guards it ([[Thread notes]]).
worked example:
A reads 0, B reads 0, both add 1 and write 1: one update is lost, so the counter ends at 1, not 2.
`;
const processReply = (over: Record<string, unknown> = {}) => JSON.stringify({ fits: true, objective: "Follow processes as the scheduler moves them between states", settings: copy("process").settings, assetIds: [], assessmentId: "final-state", predictionQuestion: "Which state does P2 end in?", hint: "Only one process can be running at a time.", missingOperation: "", ...over });

test("in the engine: a saved blueprint is reused with no model call, and a failed one falls back to the worked example", async () => {
  const fs = new MemFS();
  const store = new Store(fs, "Tutor", () => "2026-11-18");
  const settings = { claudePath: "", chatModel: "sonnet", compileModel: "sonnet", utilityModel: "haiku", effort: "low", targetLevel: 4, maxChatWords: 6000, maxTopicWords: 4000, singlePassWords: 6000, smartRouting: false, hardEffort: "high", bankQuiz: true, codePlacement: false } as unknown as ReturnType<Engine["settings"]>;
  const engine = new Engine(store, () => settings, () => "2026-11-18");
  const dir = await store.saveCompiled({ title: "Systems", fm: { subject: "none" }, topicBody: F.parseCompileOutput(CARD).topicBody, questionsBody: "", target: 4 });
  const notes: Record<string, string> = {
    "Process notes": "A process is ready, running or waiting. The scheduler dispatches a ready process and preempts it when its time slice ends; a process that waits for I/O becomes ready again when the I/O completes.",
    "Thread notes": "Two threads that read, add and write a shared counter can interleave so that one update is lost. A lock around the read, add and write removes the race.",
  };
  engine.readSource = async (name) => (name in notes ? { path: `Systems/${name}.md`, text: notes[name] } : null);
  engine.visuals = realRegistry();
  let claude = 0;
  (engine as unknown as { call: () => Promise<never> }).call = async () => { claude++; throw new Error("no main provider in this path"); };
  const local = scriptedModel([processReply(), raceReply({ schedule: ["A", "C"] }), raceReply({ schedule: ["A", "C"] })]);
  engine.local = local;
  const made = await engine.requestActivity(dir, { kind: "simulation", concept: 1 });
  assert.equal(made.lesson?.moduleId, "process-states");
  assert.deepEqual([made.cacheHit, made.calls.local, local.requests.length], [false, 1, 1]);
  const again = await engine.requestActivity(dir, { kind: "simulation", concept: 1 });
  assert.deepEqual([again.cacheHit, again.lesson?.moduleId, local.requests.length], [true, "process-states", 1], "reused with zero model calls");
  assert.deepEqual(again.lesson, made.lesson);
  const reopened = await engine.openActivity(dir, made.activity!.id);
  assert.deepEqual([reopened.lesson, local.requests.length], [made.lesson, 1]);
  // Invalid twice: the worked example is offered and the reason is saved with the record.
  const failed = await engine.requestActivity(dir, { kind: "simulation", concept: 2 });
  assert.deepEqual([failed.lesson, failed.activity?.status, failed.activity?.moduleId, local.requests.length], [null, "invalid", "race-condition", 3]);
  assert.match(failed.fallback, /one update is lost/);
  assert.match(failed.activity!.validationErrors.join("\n"), /C is not one of the threads/);
  const saved = (await store.loadActivities(dir)).find((a) => a.id === failed.activity!.id)!;
  assert.match(saved.reason, /after one repair/);
  const retried = await engine.requestActivity(dir, { kind: "simulation", concept: 2 });
  assert.deepEqual([retried.cacheHit, retried.activity?.status, local.requests.length], [true, "invalid", 3], "a saved failure is not tried again");
  assert.equal(claude, 0);
});
