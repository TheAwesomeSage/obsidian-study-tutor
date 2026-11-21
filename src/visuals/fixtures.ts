import type { VisualLesson } from "./contracts";
import { systemsQuestion } from "./systems-modules";
/** Engineering fixtures, never presented as generated from the learner's vault. */
const base = { schemaVersion: 1 as const, moduleVersion:"1.0.0", sourceRefs:[{path:"fixtures/engineering-example.md",contentHash:"b8f7297b274987869d9a923a1ec3f1cb10fbdfe8e67bafa3eb05c040f107c9b1",excerpt:"Synthetic engineering fixture. Not a learner note or a real-note benchmark."}], assetIds:[],hint:"Use the model's individual steps to justify the result." };
export const FIXTURES:Record<string,VisualLesson>={
  projectile:{...base,moduleId:"projectile",assetIds:["kenney.physics.flag-blue"],objective:"Predict where the projectile will land",settings:{speed:10,angle:45,gravity:9.81,speedRange:[8,12],angleRange:[20,70],target:10.2,tolerance:0.35},assessmentId:"range-prediction",predictionQuestion:"How far will it travel, and why does horizontal velocity stay constant?"},
  plot:{...base,moduleId:"function-plotter",objective:"Connect a curve to its changing slope",settings:{family:"polynomial",coefficients:[0,0,1],scale:1,shiftX:0,shiftY:0,domain:[-4,4],viewport:[-4,10,4,-2],pointX:1},assessmentId:"slope-at-point",predictionQuestion:"What happens to the tangent slope as the point moves to the right?"},
  algorithm:{...base,moduleId:"algorithm",objective:"Trace how bubble sort orders an array",settings:{algorithm:"bubble-sort",values:[7,3,9,2,5],target:9,index:2},assessmentId:"trace-result",predictionQuestion:"Which pair will swap first, and what will the final array contain?"},
  external:{...base,moduleId:"phet-external",objective:"Explain the independence of horizontal and vertical motion",settings:{simulation:"projectile-motion",question:"With no air resistance, compare the time to land at two horizontal launch speeds. Explain using the source's independence of components."},assessmentId:"external-reflection",predictionQuestion:"Will a greater horizontal speed change the landing time from the same height?"},
};

// Software Systems blueprints. The question is the module's own, written by code from the blueprint.
const systems = (moduleId: string, assessmentId: string, objective: string, settings: VisualLesson["settings"], hint: string): VisualLesson => {
  const lesson: VisualLesson = { ...base, moduleId, assessmentId, objective, settings, hint, predictionQuestion: "" };
  return { ...lesson, predictionQuestion: systemsQuestion(lesson) ?? "" };
};
const state = (id: string, label: string) => ({ id, label, group: "", note: "" });
const row = (id: string, label: string, group: string, note = "") => ({ id, label, group, note });
Object.assign(FIXTURES, {
  process: systems("process-states", "final-state", "Follow processes through the scheduler's state transitions", {
    model: "process-states",
    processes: [{ id: "P1", state: "running" }, { id: "P2", state: "ready" }, { id: "P3", state: "new" }],
    steps: [{ event: "wait", pid: "P1" }, { event: "dispatch", pid: "P2" }, { event: "admit", pid: "P3" }, { event: "timeout", pid: "P2" }, { event: "wake", pid: "P1" }, { event: "dispatch", pid: "P3" }, { event: "exit", pid: "P3" }, { event: "dispatch", pid: "P1" }],
    focus: "P2",
  }, "Only one process runs at a time; a timeout sends the running process back to the ready queue."),
  race: systems("race-condition", "final-value", "See how an interleaving loses an update to a shared counter", {
    model: "race", variable: "counter", initial: 0,
    threads: [{ id: "A", delta: 1, times: 1 }, { id: "B", delta: 1, times: 1 }],
    schedule: ["A", "B", "A", "B", "A", "B"], lock: false,
  }, "Each thread adds to the value it read, not to the value in memory when it writes."),
  ring: systems("circular-buffer", "ring-count", "Track head, tail and count as a ring buffer fills, empties and wraps", {
    model: "ring-buffer", capacity: 4, head: 2, values: [7, 3], overflow: "reject",
    steps: [{ op: "push", value: 5 }, { op: "push", value: 8 }, { op: "push", value: 1 }, { op: "pop" }, { op: "pop" }, { op: "pop" }, { op: "pop" }, { op: "pop" }, { op: "push", value: 6 }],
  }, "Head equals tail both when the ring is full and when it is empty; the count tells them apart."),
  descriptors: systems("descriptor-tables", "shared-refcount", "Follow descriptors into the open-file and inode tables through dup, fork and dup2", {
    model: "descriptor-tables",
    files: [{ path: "/tmp/log.txt", inode: 4021 }, { path: "/tmp/data.csv", inode: 4022 }],
    pids: [100],
    steps: [{ op: "open", pid: 100, path: "/tmp/log.txt" }, { op: "dup", pid: 100, fd: 3 }, { op: "fork", pid: 100, child: 101 }, { op: "write", pid: 101, fd: 3, bytes: 120 }, { op: "open", pid: 101, path: "/tmp/data.csv" }, { op: "dup2", pid: 101, fd: 5, to: 3 }, { op: "close", pid: 100, fd: 4 }],
    focusPid: 100, focusFd: 3,
  }, "dup and fork copy pointers to an open-file entry; they do not open the file again."),
  diagram: systems("systems-diagram", "follow-path", "Read the five-state process model as a state machine", {
    layout: "state-machine", title: "Five-state process model", groups: [],
    nodes: [state("new", "New"), state("ready", "Ready"), state("running", "Running"), state("terminated", "Terminated"), state("waiting", "Waiting")],
    edges: [{ from: "new", to: "ready", label: "admit" }, { from: "ready", to: "running", label: "dispatch" }, { from: "running", to: "ready", label: "timeout" }, { from: "running", to: "waiting", label: "wait" }, { from: "waiting", to: "ready", label: "wake" }, { from: "running", to: "terminated", label: "exit" }],
    markers: [], highlights: ["running"], start: "ready", path: ["dispatch", "timeout", "dispatch", "wait"],
  }, "Each event leaves a state by exactly one arrow."),
  diagramRing: systems("systems-diagram", "follow-path", "Read a ring buffer's head and tail", {
    layout: "ring", title: "Pipe buffer", groups: [],
    nodes: [state("s0", "5"), state("s1", "8"), state("s2", "empty"), state("s3", "7")],
    edges: [], markers: [{ label: "head", at: "s3" }, { label: "tail", at: "s2" }], highlights: ["s3", "s0", "s1"], start: "s3", path: ["next", "next"],
  }, "The slot after the last one is slot 0."),
  diagramTables: systems("systems-diagram", "follow-path", "Follow a descriptor to its open file and inode", {
    layout: "pointer-tables", title: "Descriptor, open-file and inode tables",
    groups: [{ id: "fds", label: "Process 100 fds" }, { id: "open", label: "Open-file table" }, { id: "inodes", label: "Inode table" }],
    nodes: [row("fd3", "fd 3", "fds"), row("fd4", "fd 4", "fds"), row("e1", "entry 1", "open", "offset 120"), row("i1", "inode 4021", "inodes", "/tmp/log.txt")],
    edges: [{ from: "fd3", to: "e1", label: "file" }, { from: "fd4", to: "e1", label: "file" }, { from: "e1", to: "i1", label: "inode" }],
    markers: [], highlights: ["e1"], start: "fd4", path: ["file", "inode"],
  }, "Two descriptors can share one open-file entry."),
});
