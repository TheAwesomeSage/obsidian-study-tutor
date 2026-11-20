// The Software Systems modules: one static diagram module and four simulations. Each lesson's
// settings are a blueprint (src/visuals/blueprints.ts), checked by that blueprint's validator.
// The question and the expected answer are both written here by code from the blueprint, so
// what the learner is asked is always what the module checks. Pure, no DOM.

import type { Json, JsonObject, ModuleDescriptor, ValidationError, VisualLesson } from "./contracts";
import { DIAGRAM_SCHEMA, SIMULATION_SCHEMAS, diagramAnswer, validateDiagramBlueprint, validateSimulationBlueprint, type DescriptorBlueprint, type DiagramBlueprint, type ProcessBlueprint, type RaceBlueprint, type RingBlueprint, type SimulationModel } from "./blueprints";
import { entryOf, ringContents, runDescriptors, runProcesses, runRace, runRing } from "./systems";

/** Which simulation model each simulation module runs. */
export const SIMULATION_MODULES: Record<string, SimulationModel> = {
  "process-states": "process-states",
  "race-condition": "race",
  "circular-buffer": "ring-buffer",
  "descriptor-tables": "descriptor-tables",
};
export const DIAGRAM_MODULE = "systems-diagram";
export const isSystemsModule = (id: string): boolean => id === DIAGRAM_MODULE || id in SIMULATION_MODULES;
/** Learner controls a module allows: the race's lock. */
export const SYSTEMS_EDITABLE: Record<string, string[]> = { "race-condition": ["lock"] };

const version = "1.0.0";
export const SYSTEMS_DESCRIPTORS: ModuleDescriptor[] = [
  {
    id: DIAGRAM_MODULE, version, kinds: ["diagram"], assetTags: [], assessmentIds: ["follow-path"], settingsSchema: DIAGRAM_SCHEMA as JsonObject, outputTokens: 900,
    supportedObjectives: ["State machine diagrams: states and the events that move between them", "Process state diagram: ready, running, waiting and terminated", "Circular buffer (ring) diagram with head and tail", "Array slots diagram with markers such as head and tail", "Pointer diagram between tables: file descriptors, open files and inodes"],
    summary: "draws one static diagram from a blueprint: a state machine with labelled transitions, a row of slots, a ring of slots, or rows in 2–4 tables joined by pointers; the learner predicts where one path through it ends",
  },
  {
    id: "process-states", version, kinds: ["simulation"], assetTags: [], assessmentIds: ["final-state"], settingsSchema: SIMULATION_SCHEMAS["process-states"] as JsonObject, outputTokens: 700,
    supportedObjectives: ["Process states (ready, running, waiting or blocked, terminated) and the scheduler's transitions"],
    summary: "steps a scheduler trace through the five-state process model (new, ready, running, waiting, terminated) with one CPU; code refuses impossible transitions",
  },
  {
    id: "race-condition", version, kinds: ["simulation"], assetTags: [], assessmentIds: ["final-value"], settingsSchema: SIMULATION_SCHEMAS.race as JsonObject, outputTokens: 600,
    supportedObjectives: ["Race conditions between threads on a shared variable: lost updates, interleavings and locks"],
    summary: "two threads read, add and write one shared variable in a written interleaving; the learner predicts the final value, steps through it, and can add a lock that removes the race",
  },
  {
    id: "circular-buffer", version, kinds: ["simulation"], assetTags: [], assessmentIds: ["ring-count", "ring-contents"], settingsSchema: SIMULATION_SCHEMAS["ring-buffer"] as JsonObject, outputTokens: 600,
    supportedObjectives: ["Circular (ring) buffers: head and tail indices, push and pop, full versus empty, overflow"],
    summary: "a fixed ring of slots with head, tail and count; pushes and pops wrap around, and a full ring refuses or overwrites",
  },
  {
    id: "descriptor-tables", version, kinds: ["simulation"], assetTags: [], assessmentIds: ["shared-refcount", "shared-offset"], settingsSchema: SIMULATION_SCHEMAS["descriptor-tables"] as JsonObject, outputTokens: 900,
    supportedObjectives: ["File descriptor tables: per-process descriptors, the open-file table and inodes, with open, dup, dup2, fork and close"],
    summary: "per-process descriptor tables pointing into the open-file table and the inode table; open, read, write, dup, dup2, fork and close show shared offsets and reference counts",
  },
];

/** The blueprint check for a module's settings, with paths under "settings". */
export function validateSystemsSettings(moduleId: string, settings: unknown): ValidationError[] {
  const r = moduleId === DIAGRAM_MODULE ? validateDiagramBlueprint(settings) : validateSimulationBlueprint(settings, SIMULATION_MODULES[moduleId]);
  return r.valid ? [] : r.errors.map((e) => ({ path: e.path.replace(/^\$/, "settings"), message: e.message }));
}

const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);
const quote = (s: string) => `“${s}”`;

/** The module's own question for a valid lesson, from its blueprint. Null for other modules. */
export function systemsQuestion(lesson: Pick<VisualLesson, "moduleId" | "assessmentId" | "settings">): string | null {
  const s = lesson.settings as unknown;
  switch (lesson.moduleId) {
    case DIAGRAM_MODULE: {
      const b = s as DiagramBlueprint;
      const from = b.nodes.find((n) => n.id === b.start)?.label ?? b.start;
      const end = b.layout === "state-machine" ? "Which state do you end in?" : b.layout === "pointer-tables" ? "Which row do you reach?" : "What is in the slot you reach?";
      return `Start at ${quote(from)} and follow ${b.path.map(quote).join(", then ")}. ${end}`;
    }
    case "process-states": {
      const b = s as ProcessBlueprint;
      return `After the ${b.steps.length} scheduler step${b.steps.length === 1 ? "" : "s"}, which state is ${b.focus} in?`;
    }
    case "race-condition": {
      const b = s as RaceBlueprint;
      const [a, c] = b.threads;
      return `${a.id} adds ${a.delta} to ${b.variable} ${times(a.times)} and ${c.id} adds ${c.delta} ${times(c.times)}, starting from ${b.initial}, in the order shown${b.lock ? ", each update inside the lock" : ", with no lock"}. What is the final value of ${b.variable}?`;
    }
    case "circular-buffer": {
      const b = s as RingBlueprint;
      const rule = b.overflow === "reject" ? "refuses a push when full" : "overwrites its oldest item when full";
      const ask = lesson.assessmentId === "ring-contents" ? "what does it hold, oldest first?" : "how many items does it hold?";
      return `A ring of ${b.capacity} slots ${rule}. After the ${b.steps.length} operations shown, ${ask}`;
    }
    case "descriptor-tables": {
      const b = s as DescriptorBlueprint;
      const ask = lesson.assessmentId === "shared-offset" ? "what is the file offset in the open-file entry" : "how many descriptors refer to the open-file entry";
      return `After the ${b.steps.length} steps, ${ask} behind fd ${b.focusFd} of process ${b.focusPid}?`;
    }
  }
  return null;
}

/** The expected answer, computed by running the blueprint. Settings must already be valid. */
export function systemsAnswer(lesson: Pick<VisualLesson, "moduleId" | "assessmentId" | "settings">): Json {
  const s = lesson.settings as unknown;
  switch (lesson.moduleId) {
    case DIAGRAM_MODULE: return diagramAnswer(s as DiagramBlueprint);
    case "process-states": {
      const b = s as ProcessBlueprint;
      const frames = runProcesses(b).frames;
      return frames[frames.length - 1].states[b.focus];
    }
    case "race-condition": return runRace(s as RaceBlueprint).final;
    case "circular-buffer": {
      const frames = runRing(s as RingBlueprint).frames;
      const end = frames[frames.length - 1];
      return lesson.assessmentId === "ring-contents" ? ringContents(end) : end.count;
    }
    case "descriptor-tables": {
      const b = s as DescriptorBlueprint;
      const frames = runDescriptors(b).frames;
      const e = entryOf(frames[frames.length - 1], b.focusPid, b.focusFd);
      return e ? (lesson.assessmentId === "shared-offset" ? e.offset : e.refs) : null;
    }
  }
  return null;
}

/** Whether a learner's answer matches: labels ignore case and spacing; numbers and lists are exact. */
export function systemsMatches(expected: Json, answer: Json): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  if (typeof expected === "string") return typeof answer === "string" && norm(answer) === norm(expected);
  return JSON.stringify(expected) === JSON.stringify(answer);
}
