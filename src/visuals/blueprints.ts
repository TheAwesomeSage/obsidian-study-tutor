// Blueprints: plain data a model may propose once for a Software Systems visual, which trusted
// code then checks, draws and runs as often as the learner likes. There are two kinds, with
// separate types, schemas and validators:
//
//   DiagramBlueprint    a static picture: a state machine, a row of slots, a ring, or rows in
//                       tables joined by pointers. Nodes, edges, labels, markers, highlights,
//                       and one path through it that the learner predicts the end of.
//   SimulationBlueprint an initial state and a bounded list of steps that code applies: a
//                       scheduler trace, a two-thread race, a ring buffer, descriptor tables.
//
// A blueprint is never code. The schemas below constrain a model while it writes (Ollama's
// `format`, or the main provider's JSON reply), and the validators check everything again:
// structure and bounds first, then every string, then the references and the rules of the
// model it describes. Any string that carries markup, a link, an escape or a template is
// refused, and so is any string src/safemd.ts would change. Renderers set text with
// textContent only. Pure, no DOM, no Obsidian imports.

import { stringsIn, validateJson, type Schema } from "../jsonschema";
import { neutraliseRemote } from "../safemd";
import type { ValidationError } from "./contracts";
import { runDescriptors, runProcesses, runRace } from "./systems";

export type BlueprintCheck<T> = { valid: true; blueprint: T } | { valid: false; errors: ValidationError[] };

// ---------- static diagrams ----------

export const DIAGRAM_LAYOUTS = ["state-machine", "slots", "ring", "pointer-tables"] as const;
export type DiagramLayout = (typeof DIAGRAM_LAYOUTS)[number];
export interface DiagramGroup { id: string; label: string }
/** A state, a slot (in index order) or a table row (in its group). */
export interface DiagramNode { id: string; label: string; group: string; note: string }
export interface DiagramEdge { from: string; to: string; label: string }
/** A named pointer to one node, such as head or tail. */
export interface DiagramMarker { label: string; at: string }
export interface DiagramBlueprint {
  layout: DiagramLayout;
  title: string;
  groups: DiagramGroup[];
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  markers: DiagramMarker[];
  highlights: string[];
  /** The path the learner predicts the end of: start at `start`, follow each label in `path`. */
  start: string;
  path: string[];
}
export const DIAGRAM_LIMITS = { nodes: 24, edges: 24, groups: 4, rowsPerGroup: 8, markers: 6, highlights: 12, path: 8, title: 80, label: 24, note: 40, id: 16 } as const;

// ---------- simulations ----------

export const PROCESS_STATES = ["new", "ready", "running", "waiting", "terminated"] as const;
export type ProcessState = (typeof PROCESS_STATES)[number];
export const PROCESS_EVENTS = ["admit", "dispatch", "timeout", "wait", "wake", "exit"] as const;
export type ProcessEvent = (typeof PROCESS_EVENTS)[number];
export interface ProcessBlueprint {
  model: "process-states";
  processes: { id: string; state: ProcessState }[];
  steps: { event: ProcessEvent; pid: string }[];
  /** The process whose final state the learner predicts. */
  focus: string;
}
export interface RaceBlueprint {
  model: "race";
  /** The shared variable's name, an identifier. */
  variable: string;
  initial: number;
  /** Exactly two threads; each adds `delta` to the variable `times` times (read, add, write). */
  threads: { id: string; delta: number; times: number }[];
  /** Which thread takes its next step, in order. Steps left over run after it, first thread first. */
  schedule: string[];
  /** Whether each read-add-write is guarded by one mutex. The learner may switch it. */
  lock: boolean;
}
export interface RingBlueprint {
  model: "ring-buffer";
  capacity: number;
  /** The slot of the oldest item; `values` start there, oldest first. */
  head: number;
  values: number[];
  /** A push onto a full ring is refused, or replaces the oldest item. */
  overflow: "reject" | "overwrite";
  steps: { op: "push" | "pop"; value?: number }[];
}
export const DESCRIPTOR_OPS = ["open", "read", "write", "dup", "dup2", "fork", "close"] as const;
export type DescriptorOp = (typeof DESCRIPTOR_OPS)[number];
export interface DescriptorStep { op: DescriptorOp; pid: number; path?: string; fd?: number; to?: number; child?: number; bytes?: number }
export interface DescriptorBlueprint {
  model: "descriptor-tables";
  /** Files that may be opened, each with its own inode number. */
  files: { path: string; inode: number }[];
  /** Processes at the start, each with no files open (0–2 are the standard streams, not drawn). */
  pids: number[];
  steps: DescriptorStep[];
  /** The descriptor whose open-file entry the learner predicts something about. */
  focusPid: number;
  focusFd: number;
}
export type SimulationBlueprint = ProcessBlueprint | RaceBlueprint | RingBlueprint | DescriptorBlueprint;
export type SimulationModel = SimulationBlueprint["model"];
export const SIMULATION_MODELS: SimulationModel[] = ["process-states", "race", "ring-buffer", "descriptor-tables"];
export const SIMULATION_LIMITS = { processes: 4, processSteps: 20, raceSchedule: 30, raceTimes: 3, raceDelta: 9, ringCapacity: 12, ringSteps: 24, files: 4, startPids: 2, descriptorSteps: 16, maxPids: 4, firstFd: 3, lastFd: 15 } as const;

// ---------- schemas (the subset src/jsonschema.ts checks and Ollama's converter accepts) ----------

const text = (maxLength: number, minLength = 1, description?: string): Schema => ({ type: "string", minLength, maxLength, ...(description ? { description } : {}) });
const id = (maxLength: number = DIAGRAM_LIMITS.id): Schema => ({ type: "string", minLength: 1, maxLength });
const int = (minimum: number, maximum: number, description?: string): Schema => ({ type: "integer", minimum, maximum, ...(description ? { description } : {}) });
const list = (items: Schema, minItems: number, maxItems: number, description: string): Schema => ({ type: "array", items, minItems, maxItems, description });
const closed = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({ type: "object", additionalProperties: false, required, properties });

export const DIAGRAM_SCHEMA: Schema = closed({
  layout: { type: "string", enum: [...DIAGRAM_LAYOUTS], description: "state-machine: states joined by labelled transitions; slots: an array in index order; ring: a circular buffer in index order; pointer-tables: rows in 2–4 tables with pointers between rows" },
  title: text(DIAGRAM_LIMITS.title, 1, "what the diagram shows"),
  groups: list(closed({ id: id(), label: text(DIAGRAM_LIMITS.label) }), 0, DIAGRAM_LIMITS.groups, "pointer-tables only: each {id, label} is a table, left to right; empty for other layouts"),
  nodes: list(closed({ id: id(), label: text(DIAGRAM_LIMITS.label), group: text(DIAGRAM_LIMITS.id, 0), note: text(DIAGRAM_LIMITS.note, 0) }), 1, DIAGRAM_LIMITS.nodes, "each {id, label, group, note}: a state, a slot in index order, or a table row; group is the row's table id (else empty); note is a short second line or empty"),
  edges: list(closed({ from: id(), to: id(), label: text(DIAGRAM_LIMITS.label, 0) }), 0, DIAGRAM_LIMITS.edges, "each {from, to, label}: a transition labelled by its event, or a pointer between rows; empty for slots and ring"),
  markers: list(closed({ label: text(12), at: id() }), 0, DIAGRAM_LIMITS.markers, "each {label, at}: a named pointer such as head or tail at a node id"),
  highlights: list(id(), 0, DIAGRAM_LIMITS.highlights, "node ids drawn emphasised"),
  start: { ...id(), description: "the node id the question starts from" },
  path: list(text(DIAGRAM_LIMITS.label), 1, DIAGRAM_LIMITS.path, "edge labels to follow from start in order; for slots and ring each is next or prev"),
});

const L = SIMULATION_LIMITS;
export const SIMULATION_SCHEMAS: Record<SimulationModel, Schema> = {
  "process-states": closed({
    model: { type: "string", enum: ["process-states"] },
    processes: list(closed({ id: id(8), state: { type: "string", enum: [...PROCESS_STATES] } }), 1, L.processes, "each {id, state}: a process such as P1 and its state at the start; at most one running"),
    steps: list(closed({ event: { type: "string", enum: [...PROCESS_EVENTS] }, pid: id(8) }), 1, L.processSteps, "the scheduler trace, each {event, pid}: admit new→ready, dispatch ready→running (one CPU), timeout running→ready, wait running→waiting, wake waiting→ready, exit running→terminated"),
    focus: { ...id(8), description: "the process whose final state the learner predicts" },
  }),
  race: closed({
    model: { type: "string", enum: ["race"] },
    variable: text(12, 1, "the shared variable's name, such as counter"),
    initial: int(-999, 999, "its value at the start"),
    threads: list(closed({ id: id(8), delta: int(-L.raceDelta, L.raceDelta), times: int(1, L.raceTimes) }), 2, 2, "exactly two {id, delta, times}: each thread adds delta to the variable times times, by read, add, write"),
    schedule: list(id(8), 1, L.raceSchedule, "thread ids in the order their next step runs; steps left over run afterwards"),
    lock: { type: "boolean", description: "true when one mutex guards each read-add-write" },
  }),
  "ring-buffer": closed({
    model: { type: "string", enum: ["ring-buffer"] },
    capacity: int(2, L.ringCapacity, "number of slots"),
    head: int(0, L.ringCapacity - 1, "slot of the oldest item"),
    values: list(int(-999, 999), 0, L.ringCapacity, "the items at the start, oldest first, from head"),
    overflow: { type: "string", enum: ["reject", "overwrite"], description: "what a push onto a full ring does" },
    steps: list(closed({ op: { type: "string", enum: ["push", "pop"] }, value: int(-999, 999) }, ["op"]), 1, L.ringSteps, "each {op} is push with a value, or pop with no value"),
  }),
  "descriptor-tables": closed({
    model: { type: "string", enum: ["descriptor-tables"] },
    files: list(closed({ path: text(32), inode: int(1, 99999) }), 1, L.files, "each {path, inode}: a file that may be opened, with distinct inode numbers"),
    pids: list(int(1, 32767), 1, L.startPids, "process ids at the start, each with no files open"),
    steps: list(closed({ op: { type: "string", enum: [...DESCRIPTOR_OPS] }, pid: int(1, 32767), path: text(32), fd: int(0, L.lastFd), to: int(L.firstFd, L.lastFd), child: int(1, 32767), bytes: int(1, 65536) }, ["op", "pid"]), 1, L.descriptorSteps, "each step: open {pid, path}; read or write {pid, fd, bytes}; dup {pid, fd}; dup2 {pid, fd, to}; fork {pid, child}; close {pid, fd}. New descriptors take the lowest free number from 3"),
    focusPid: int(1, 32767, "the process that holds the descriptor in the question"),
    focusFd: int(L.firstFd, L.lastFd, "the descriptor in the question; it must still be open at the end"),
  }),
};

// ---------- text and id checks ----------

/** Markup, escapes, templates, links and handlers. No blueprint string has a use for any of them. */
const UNSAFE = /[<>`{}\\]|&#|&[a-z][a-z0-9]*;|\b(?:javascript|vbscript)\s*:|\b(?:data|file|https?|ftp|blob):(?!\s|$)|\/\/|\bon[a-z]+\s*=|\$\(/i;
const CONTROL = new RegExp(`[\\x00-\\x1f\\x7f${String.fromCharCode(0x2028, 0x2029)}]`);
/** Why a blueprint string is refused, or null when it may be drawn. */
export function unsafeText(s: string): string | null {
  if (CONTROL.test(s)) return "contains control characters";
  if (UNSAFE.test(s)) return "contains markup, code, an escape or a link, which is never accepted";
  if (neutraliseRemote(s, { trustFences: false }) !== s) return "would load something from outside the vault";
  return null;
}
const ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PATH = /^\/?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){0,3}$/;

/** Schema errors ("$.a.b: message") as contract errors. */
function structural(value: unknown, schema: Schema): ValidationError[] {
  return validateJson(value, schema).map((e) => {
    const at = e.indexOf(": ");
    return at > 0 ? { path: e.slice(0, at), message: e.slice(at + 2) } : { path: "$", message: e };
  });
}
/** Every string in the value, checked for safety. */
function textErrors(value: unknown): ValidationError[] {
  return stringsIn(value).flatMap(({ path, text }) => {
    const why = unsafeText(text);
    return why ? [{ path, message: why }] : [];
  });
}
const clone = <T>(v: unknown): T => JSON.parse(JSON.stringify(v)) as T;
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// ---------- diagram validation and the path walk ----------

/** The edges a learner follows: explicit for state machines and tables, next/prev by index for slots and rings. */
export function diagramEdges(b: DiagramBlueprint): DiagramEdge[] {
  if (b.layout === "state-machine" || b.layout === "pointer-tables") return b.edges;
  const n = b.nodes.length;
  const out: DiagramEdge[] = [];
  b.nodes.forEach((node, i) => {
    if (b.layout === "ring" || i + 1 < n) out.push({ from: node.id, to: b.nodes[(i + 1) % n].id, label: "next" });
    if (b.layout === "ring" || i > 0) out.push({ from: node.id, to: b.nodes[(i - 1 + n) % n].id, label: "prev" });
  });
  return out;
}

/** The nodes visited along the question's path, start first; an error when a step is not defined exactly once. */
export function walkDiagram(b: DiagramBlueprint): { visited: string[]; error: ValidationError | null } {
  const edges = diagramEdges(b);
  const visited = [b.start];
  for (let i = 0; i < b.path.length; i++) {
    const at = visited[visited.length - 1];
    const out = edges.filter((e) => e.from === at && same(e.label, b.path[i]));
    if (out.length !== 1) return { visited, error: { path: `$.path[${i}]`, message: out.length ? `"${b.path[i]}" leaves ${at} by more than one edge` : `no edge "${b.path[i]}" leaves ${at}` } };
    visited.push(out[0].to);
  }
  return { visited, error: null };
}

/** The label of the node the question's path ends at: what the learner predicts. */
export function diagramAnswer(b: DiagramBlueprint): string {
  const end = walkDiagram(b).visited.slice(-1)[0];
  return b.nodes.find((n) => n.id === end)?.label ?? "";
}

export function validateDiagramBlueprint(value: unknown): BlueprintCheck<DiagramBlueprint> {
  const errors = structural(value, DIAGRAM_SCHEMA);
  if (errors.length) return { valid: false, errors };
  errors.push(...textErrors(value));
  const b = value as DiagramBlueprint;
  const fail = (path: string, message: string) => errors.push({ path, message });
  const ids = new Set<string>();
  b.nodes.forEach((n, i) => {
    if (!ID.test(n.id)) fail(`$.nodes[${i}].id`, "use letters, digits, - or _, starting with a letter");
    else if (ids.has(n.id)) fail(`$.nodes[${i}].id`, `repeats the id ${n.id}`);
    ids.add(n.id);
  });
  const groups = new Set<string>();
  b.groups.forEach((g, i) => {
    if (!ID.test(g.id) || groups.has(g.id) || ids.has(g.id)) fail(`$.groups[${i}].id`, "needs a distinct id of letters, digits, - or _");
    groups.add(g.id);
  });
  const node = (x: string) => ids.has(x);
  if (b.layout === "pointer-tables") {
    if (b.groups.length < 2) fail("$.groups", "pointer-tables needs 2–4 tables");
    b.nodes.forEach((n, i) => { if (!groups.has(n.group)) fail(`$.nodes[${i}].group`, `${n.group || "(empty)"} is not one of the tables`); });
    for (const g of b.groups) {
      const rows = b.nodes.filter((n) => n.group === g.id).length;
      if (rows < 1 || rows > DIAGRAM_LIMITS.rowsPerGroup) fail("$.groups", `table ${g.id} needs 1–${DIAGRAM_LIMITS.rowsPerGroup} rows, not ${rows}`);
    }
  } else {
    if (b.groups.length) fail("$.groups", `${b.layout} has no tables; leave groups empty`);
    b.nodes.forEach((n, i) => { if (n.group) fail(`$.nodes[${i}].group`, `${b.layout} nodes have no table; leave group empty`); });
  }
  if (b.layout === "state-machine" && (b.nodes.length < 2 || b.nodes.length > 10)) fail("$.nodes", "a state machine needs 2–10 states");
  if (b.layout === "ring" && (b.nodes.length < 2 || b.nodes.length > 16)) fail("$.nodes", "a ring needs 2–16 slots");
  if (b.layout === "slots" && b.nodes.length > 16) fail("$.nodes", "a row of slots has at most 16");
  if ((b.layout === "slots" || b.layout === "ring") && b.edges.length) fail("$.edges", `${b.layout} slots are joined by index; leave edges empty`);
  if (b.layout === "state-machine" && !b.edges.length) fail("$.edges", "a state machine needs at least one transition");
  if (b.layout === "pointer-tables" && !b.edges.length) fail("$.edges", "pointer-tables needs at least one pointer");
  const pairs = new Set<string>();
  b.edges.forEach((e, i) => {
    if (!node(e.from)) fail(`$.edges[${i}].from`, `${e.from} is not a node`);
    if (!node(e.to)) fail(`$.edges[${i}].to`, `${e.to} is not a node`);
    if (b.layout === "pointer-tables" && e.from === e.to) fail(`$.edges[${i}]`, "a pointer joins two different rows");
    const key = `${e.from}\u0000${e.label.trim().toLowerCase()}`;
    if (pairs.has(key)) fail(`$.edges[${i}]`, `${e.from} already has an edge labelled "${e.label}"; the diagram must be deterministic`);
    pairs.add(key);
  });
  const markers = new Set<string>();
  b.markers.forEach((m, i) => {
    if (!node(m.at)) fail(`$.markers[${i}].at`, `${m.at} is not a node`);
    if (markers.has(m.label.toLowerCase())) fail(`$.markers[${i}].label`, "repeats a marker");
    markers.add(m.label.toLowerCase());
  });
  b.highlights.forEach((h, i) => { if (!node(h)) fail(`$.highlights[${i}]`, `${h} is not a node`); });
  if (new Set(b.highlights).size !== b.highlights.length) fail("$.highlights", "repeats a node");
  if (!node(b.start)) fail("$.start", `${b.start} is not a node`);
  else if (!errors.length) {
    const walk = walkDiagram(b);
    if (walk.error) errors.push(walk.error);
  }
  return errors.length ? { valid: false, errors } : { valid: true, blueprint: clone<DiagramBlueprint>(b) };
}

// ---------- simulation validation ----------

/** Checks one simulation blueprint: schema for its model, safe strings, references, then a full run by trusted code. */
export function validateSimulationBlueprint(value: unknown, expected?: SimulationModel): BlueprintCheck<SimulationBlueprint> {
  const model = value && typeof value === "object" && !Array.isArray(value) ? (value as { model?: unknown }).model : undefined;
  if (typeof model !== "string" || !(SIMULATION_MODELS as string[]).includes(model)) return { valid: false, errors: [{ path: "$.model", message: `must be one of ${SIMULATION_MODELS.join(", ")}` }] };
  if (expected && model !== expected) return { valid: false, errors: [{ path: "$.model", message: `this module runs ${expected}, not ${model}` }] };
  const errors = structural(value, SIMULATION_SCHEMAS[model as SimulationModel]);
  if (errors.length) return { valid: false, errors };
  errors.push(...textErrors(value));
  const fail = (path: string, message: string) => errors.push({ path, message });
  const b = value as SimulationBlueprint;
  if (b.model === "process-states") {
    const pids = new Set<string>();
    b.processes.forEach((p, i) => {
      if (!ID.test(p.id) || pids.has(p.id)) fail(`$.processes[${i}].id`, "needs a distinct id of letters and digits, such as P1");
      pids.add(p.id);
    });
    if (b.processes.filter((p) => p.state === "running").length > 1) fail("$.processes", "one CPU: at most one process may start running");
    b.steps.forEach((s, i) => { if (!pids.has(s.pid)) fail(`$.steps[${i}].pid`, `${s.pid} is not one of the processes`); });
    if (!pids.has(b.focus)) fail("$.focus", `${b.focus} is not one of the processes`);
    if (!errors.length) {
      const run = runProcesses(b);
      if (run.error) fail(`$.steps[${run.error.index}]`, run.error.message);
    }
  } else if (b.model === "race") {
    if (!IDENT.test(b.variable)) fail("$.variable", "use an identifier such as counter");
    const [a, c] = b.threads;
    b.threads.forEach((t, i) => {
      if (!ID.test(t.id)) fail(`$.threads[${i}].id`, "use letters and digits, such as A");
      if (t.delta === 0) fail(`$.threads[${i}].delta`, "a thread that adds 0 shows no race");
    });
    if (a.id === c.id) fail("$.threads", "the two threads need different ids");
    b.schedule.forEach((t, i) => { if (t !== a.id && t !== c.id) fail(`$.schedule[${i}]`, `${t} is not one of the threads`); });
    if (!errors.length) {
      // The order as written must be possible without the lock: no step for a thread that has finished.
      const idle = runRace({ ...b, lock: false }).frames.findIndex((f) => f.op === "idle");
      if (idle > 0) fail(`$.schedule[${idle - 1}]`, `${b.schedule[idle - 1]} has no steps left at this point`);
    }
  } else if (b.model === "ring-buffer") {
    if (b.head >= b.capacity) fail("$.head", `slot ${b.head} does not exist in a ring of ${b.capacity}`);
    if (b.values.length > b.capacity) fail("$.values", `${b.values.length} items do not fit in ${b.capacity} slots`);
    b.steps.forEach((s, i) => {
      if (s.op === "push" && s.value === undefined) fail(`$.steps[${i}].value`, "a push needs a value");
      if (s.op === "pop" && s.value !== undefined) fail(`$.steps[${i}].value`, "a pop takes no value");
    });
  } else {
    const paths = new Set<string>();
    const inodes = new Set<number>();
    b.files.forEach((f, i) => {
      if (!PATH.test(f.path) || /(^|\/)\.\.?(\/|$)/.test(f.path)) fail(`$.files[${i}].path`, "use a short file name such as /tmp/log.txt");
      if (paths.has(f.path)) fail(`$.files[${i}].path`, "repeats a file");
      if (inodes.has(f.inode)) fail(`$.files[${i}].inode`, "each file needs its own inode number");
      paths.add(f.path);
      inodes.add(f.inode);
    });
    if (new Set(b.pids).size !== b.pids.length) fail("$.pids", "repeats a process id");
    const need: Record<DescriptorOp, (keyof DescriptorStep)[]> = { open: ["path"], read: ["fd", "bytes"], write: ["fd", "bytes"], dup: ["fd"], dup2: ["fd", "to"], fork: ["child"], close: ["fd"] };
    b.steps.forEach((s, i) => {
      for (const k of need[s.op]) if (s[k] === undefined) fail(`$.steps[${i}].${k}`, `${s.op} needs ${k}`);
      for (const k of ["path", "fd", "to", "child", "bytes"] as const) if (s[k] !== undefined && !need[s.op].includes(k)) fail(`$.steps[${i}].${k}`, `${s.op} takes no ${k}`);
    });
    if (!errors.length) {
      const run = runDescriptors(b);
      if (run.error) fail(`$.steps[${run.error.index}]`, run.error.message);
      else {
        const end = run.frames[run.frames.length - 1];
        const proc = end.procs.find((p) => p.pid === b.focusPid);
        if (!proc) fail("$.focusPid", `process ${b.focusPid} does not exist at the end`);
        else if (proc.fds[b.focusFd] === undefined) fail("$.focusFd", `fd ${b.focusFd} of process ${b.focusPid} is not open at the end`);
      }
    }
  }
  return errors.length ? { valid: false, errors } : { valid: true, blueprint: clone<SimulationBlueprint>(b) };
}
