// Software Systems models: trusted code that applies a simulation blueprint's steps, one frame
// per step, so a renderer can show any step and the assessment can check the end. Every run is
// deterministic and bounded by the blueprint's limits. A step the model cannot take (a dispatch
// while another process runs, a close of a descriptor that is not open) is reported with its
// index, and the validator refuses the blueprint. Pure, no DOM.

import type { DescriptorBlueprint, DescriptorOp, ProcessBlueprint, ProcessEvent, ProcessState, RaceBlueprint, RingBlueprint } from "./blueprints";

export interface StepError { index: number; message: string }

// ---------- process states ----------

/** The five-state model: each event moves a process from exactly one state to another. */
export const PROCESS_TRANSITIONS: Record<ProcessEvent, { from: ProcessState; to: ProcessState; meaning: string }> = {
  admit: { from: "new", to: "ready", meaning: "admitted to the ready queue" },
  dispatch: { from: "ready", to: "running", meaning: "the scheduler gives it the CPU" },
  timeout: { from: "running", to: "ready", meaning: "preempted when its time slice ends" },
  wait: { from: "running", to: "waiting", meaning: "blocks until its I/O or event completes" },
  wake: { from: "waiting", to: "ready", meaning: "its I/O or event completed" },
  exit: { from: "running", to: "terminated", meaning: "it has finished" },
};
export interface ProcessFrame { states: Record<string, ProcessState>; event: ProcessEvent | null; pid: string | null; detail: string }

export function runProcesses(b: ProcessBlueprint): { frames: ProcessFrame[]; error: StepError | null } {
  const states: Record<string, ProcessState> = Object.fromEntries(b.processes.map((p) => [p.id, p.state]));
  const frames: ProcessFrame[] = [{ states: { ...states }, event: null, pid: null, detail: `Start: ${b.processes.map((p) => `${p.id} ${p.state}`).join(", ")}` }];
  for (let i = 0; i < b.steps.length; i++) {
    const s = b.steps[i];
    const t = PROCESS_TRANSITIONS[s.event];
    const now = states[s.pid];
    if (now === undefined) return { frames, error: { index: i, message: `${s.pid} is not one of the processes` } };
    if (now !== t.from) return { frames, error: { index: i, message: `${s.pid} cannot ${s.event} while ${now}: ${s.event} moves a process from ${t.from}` } };
    const running = Object.keys(states).find((p) => states[p] === "running");
    if (s.event === "dispatch" && running) return { frames, error: { index: i, message: `${s.pid} cannot be dispatched while ${running} is running on the one CPU` } };
    states[s.pid] = t.to;
    frames.push({ states: { ...states }, event: s.event, pid: s.pid, detail: `${s.pid} ${s.event}: ${t.from} → ${t.to}, ${t.meaning}` });
  }
  return { frames, error: null };
}

// ---------- a race on a shared variable ----------

export type RaceOp = "start" | "acquire" | "blocked" | "read" | "add" | "write" | "release" | "idle";
export interface RaceFrame {
  value: number;
  /** Each thread's private register; null before its first read. */
  regs: Record<string, number | null>;
  holder: string | null;
  thread: string | null;
  op: RaceOp;
  detail: string;
  /** False for steps taken after the written order ran out. */
  scheduled: boolean;
}

/** One thread's steps: read, add, write for each update, inside acquire and release with the lock. */
export function raceProgram(t: RaceBlueprint["threads"][number], lock: boolean): RaceOp[] {
  const one: RaceOp[] = lock ? ["acquire", "read", "add", "write", "release"] : ["read", "add", "write"];
  return Array.from({ length: t.times }, () => one).flat();
}

/** Runs the written order, then any steps left over, first thread first. `lock` overrides the blueprint's. */
export function runRace(b: RaceBlueprint, lock = b.lock): { frames: RaceFrame[]; final: number; expected: number } {
  const progs = b.threads.map((t) => raceProgram(t, lock));
  const pc = b.threads.map(() => 0);
  let value = b.initial;
  let holder: string | null = null;
  const regs: Record<string, number | null> = Object.fromEntries(b.threads.map((t) => [t.id, null]));
  const frames: RaceFrame[] = [{ value, regs: { ...regs }, holder, thread: null, op: "start", detail: `Start: ${b.variable} = ${value}${lock ? ", one lock, free" : ", no lock"}`, scheduled: true }];
  const push = (thread: string | null, op: RaceOp, detail: string, scheduled: boolean) => frames.push({ value, regs: { ...regs }, holder, thread, op, detail, scheduled });
  const blocked = (i: number) => progs[i][pc[i]] === "acquire" && holder !== null && holder !== b.threads[i].id;
  const take = (i: number, scheduled: boolean) => {
    const t = b.threads[i];
    if (pc[i] >= progs[i].length) return push(t.id, "idle", `${t.id} has finished; nothing to run`, scheduled);
    if (blocked(i)) return push(t.id, "blocked", `${t.id} waits: ${holder} holds the lock`, scheduled);
    const op = progs[i][pc[i]++];
    if (op === "acquire") { holder = t.id; return push(t.id, op, `${t.id} takes the lock`, scheduled); }
    if (op === "release") { holder = null; return push(t.id, op, `${t.id} releases the lock`, scheduled); }
    if (op === "read") { regs[t.id] = value; return push(t.id, op, `${t.id} reads ${b.variable} = ${value} into its register`, scheduled); }
    if (op === "add") { regs[t.id] = (regs[t.id] ?? 0) + t.delta; return push(t.id, op, `${t.id} adds ${t.delta}: its register is now ${regs[t.id]}`, scheduled); }
    value = regs[t.id] ?? value;
    return push(t.id, op, `${t.id} writes ${value} to ${b.variable}`, scheduled);
  };
  for (const id of b.schedule) {
    const i = b.threads.findIndex((t) => t.id === id);
    if (i >= 0) take(i, true);
  }
  // Steps left over: the first thread that can move takes the next one. One lock cannot deadlock.
  for (let guard = 0; guard < 200 && pc.some((p, i) => p < progs[i].length); guard++) {
    const i = b.threads.findIndex((_, j) => pc[j] < progs[j].length && !blocked(j));
    if (i < 0) break;
    take(i, false);
  }
  return { frames, final: value, expected: b.initial + b.threads.reduce((a, t) => a + t.delta * t.times, 0) };
}

// ---------- a ring buffer ----------

export interface RingFrame {
  slots: (number | null)[];
  head: number;
  count: number;
  op: "start" | "push" | "pop" | "overflow" | "overwrite" | "underflow";
  detail: string;
  /** The slot this step wrote or read. */
  slot: number | null;
  /** Pushes refused so far. */
  rejected: number;
}
export const ringTail = (f: Pick<RingFrame, "slots" | "head" | "count">): number => (f.head + f.count) % f.slots.length;
/** Items oldest first. */
export const ringContents = (f: Pick<RingFrame, "slots" | "head" | "count">): number[] => Array.from({ length: f.count }, (_, i) => f.slots[(f.head + i) % f.slots.length] as number);

export function runRing(b: RingBlueprint): { frames: RingFrame[] } {
  const n = b.capacity;
  const slots: (number | null)[] = Array.from({ length: n }, () => null);
  b.values.forEach((v, i) => { slots[(b.head + i) % n] = v; });
  let head = b.head;
  let count = b.values.length;
  let rejected = 0;
  const frames: RingFrame[] = [];
  const push = (op: RingFrame["op"], detail: string, slot: number | null) => frames.push({ slots: [...slots], head, count, op, detail, slot, rejected });
  push("start", `Start: ${count} of ${n} slots used, head ${head}, tail ${(head + count) % n}`, null);
  for (const s of b.steps) {
    const tail = (head + count) % n;
    if (s.op === "push") {
      const v = s.value as number;
      if (count < n) {
        slots[tail] = v;
        count++;
        push("push", `push ${v} into slot ${tail}; tail moves to ${(tail + 1) % n}${count === n ? "; now full: head = tail" : ""}`, tail);
      } else if (b.overflow === "overwrite") {
        const old = slots[head];
        slots[head] = v;
        head = (head + 1) % n;
        push("overwrite", `full: push ${v} replaces the oldest item ${old} in slot ${tail}; head and tail move to ${head}`, tail);
      } else {
        rejected++;
        push("overflow", `full: push ${v} is refused (overflow); nothing changes`, null);
      }
    } else if (count === 0) {
      push("underflow", "empty: pop has nothing to take (underflow); nothing changes", null);
    } else {
      const v = slots[head];
      const from = head;
      slots[head] = null;
      head = (head + 1) % n;
      count--;
      push("pop", `pop takes ${v} from slot ${from}; head moves to ${head}${count === 0 ? "; now empty: head = tail" : ""}`, from);
    }
  }
  return { frames };
}

// ---------- descriptor tables ----------

export interface OpenFileEntry { id: number; path: string; inode: number; offset: number; refs: number }
export interface DescriptorFrame {
  /** Each process's table: descriptor number → open-file entry id. */
  procs: { pid: number; fds: Record<number, number> }[];
  /** The system-wide open-file table, live entries only. */
  entries: OpenFileEntry[];
  /** One row per file: how many open-file entries refer to its inode. */
  inodes: { inode: number; path: string; refs: number }[];
  op: DescriptorOp | "start";
  detail: string;
  touched: { pid: number | null; fds: number[]; entries: number[] };
}

export function runDescriptors(b: DescriptorBlueprint): { frames: DescriptorFrame[]; error: StepError | null } {
  const FIRST = 3, LAST = 15, MAX_PROCS = 4;
  const procs: { pid: number; fds: Record<number, number> }[] = b.pids.map((pid) => ({ pid, fds: {} }));
  const entries: OpenFileEntry[] = [];
  let nextId = 1;
  const frames: DescriptorFrame[] = [];
  const snapshot = (op: DescriptorFrame["op"], detail: string, touched: DescriptorFrame["touched"]) =>
    frames.push({
      procs: procs.map((p) => ({ pid: p.pid, fds: { ...p.fds } })),
      entries: entries.map((e) => ({ ...e })),
      inodes: b.files.map((f) => ({ inode: f.inode, path: f.path, refs: entries.filter((e) => e.inode === f.inode).length })),
      op, detail, touched,
    });
  snapshot("start", `Start: ${procs.map((p) => `process ${p.pid}`).join(" and ")}, no files open (0–2 are the standard streams)`, { pid: null, fds: [], entries: [] });
  const lowest = (p: { fds: Record<number, number> }) => { for (let fd = FIRST; fd <= LAST; fd++) if (p.fds[fd] === undefined) return fd; return -1; };
  const entry = (id: number) => entries.find((e) => e.id === id) as OpenFileEntry;
  const release = (id: number): string => {
    const e = entry(id);
    e.refs--;
    if (e.refs > 0) return `entry #${id} now has ${e.refs} reference${e.refs === 1 ? "" : "s"}`;
    entries.splice(entries.indexOf(e), 1);
    return `entry #${id} has no references left and is freed`;
  };
  for (let i = 0; i < b.steps.length; i++) {
    const s = b.steps[i];
    const err = (message: string) => ({ frames, error: { index: i, message } });
    const proc = procs.find((p) => p.pid === s.pid);
    if (!proc) return err(`process ${s.pid} does not exist at this step`);
    const open = (fd: number | undefined) => fd !== undefined && proc.fds[fd] !== undefined;
    if (s.op === "open") {
      const file = b.files.find((f) => f.path === s.path);
      if (!file) return err(`${s.path} is not one of the files`);
      const fd = lowest(proc);
      if (fd < 0) return err(`process ${s.pid} has no free descriptor`);
      const e: OpenFileEntry = { id: nextId++, path: file.path, inode: file.inode, offset: 0, refs: 1 };
      entries.push(e);
      proc.fds[fd] = e.id;
      snapshot("open", `${s.pid} opens ${file.path}: fd ${fd} → new entry #${e.id} at offset 0 → inode ${file.inode}`, { pid: s.pid, fds: [fd], entries: [e.id] });
    } else if (s.op === "read" || s.op === "write") {
      if (!open(s.fd)) return err(`fd ${s.fd} is not open in process ${s.pid}`);
      const e = entry(proc.fds[s.fd as number]);
      const from = e.offset;
      e.offset += s.bytes as number;
      snapshot(s.op, `${s.pid} ${s.op}s ${s.bytes} bytes through fd ${s.fd}: entry #${e.id} offset ${from} → ${e.offset}${e.refs > 1 ? `, seen by all ${e.refs} descriptors that share it` : ""}`, { pid: s.pid, fds: [s.fd as number], entries: [e.id] });
    } else if (s.op === "dup") {
      if (!open(s.fd)) return err(`fd ${s.fd} is not open in process ${s.pid}`);
      const fd = lowest(proc);
      if (fd < 0) return err(`process ${s.pid} has no free descriptor`);
      const e = entry(proc.fds[s.fd as number]);
      proc.fds[fd] = e.id;
      e.refs++;
      snapshot("dup", `${s.pid} dup(${s.fd}) returns fd ${fd}, which shares entry #${e.id} (${e.refs} references, one offset)`, { pid: s.pid, fds: [s.fd as number, fd], entries: [e.id] });
    } else if (s.op === "dup2") {
      if (!open(s.fd)) return err(`fd ${s.fd} is not open in process ${s.pid}`);
      const to = s.to as number;
      const e = entry(proc.fds[s.fd as number]);
      if (to === s.fd) { snapshot("dup2", `${s.pid} dup2(${s.fd}, ${to}): the same descriptor, nothing changes`, { pid: s.pid, fds: [to], entries: [e.id] }); continue; }
      const closed = proc.fds[to] !== undefined ? ` (fd ${to} was closed first: ${release(proc.fds[to])})` : "";
      proc.fds[to] = e.id;
      e.refs++;
      snapshot("dup2", `${s.pid} dup2(${s.fd}, ${to}): fd ${to} now shares entry #${e.id} (${e.refs} references)${closed}`, { pid: s.pid, fds: [s.fd as number, to], entries: [e.id] });
    } else if (s.op === "fork") {
      const child = s.child as number;
      if (procs.some((p) => p.pid === child)) return err(`process ${child} already exists`);
      if (procs.length >= MAX_PROCS) return err(`at most ${MAX_PROCS} processes are drawn`);
      const fds = { ...proc.fds };
      const shared = [...new Set(Object.values(fds))];
      for (const id of Object.values(fds)) entry(id).refs++;
      procs.push({ pid: child, fds });
      snapshot("fork", `${s.pid} forks ${child}: the child copies the descriptor table, so ${shared.length ? `entr${shared.length === 1 ? "y" : "ies"} ${shared.map((x) => `#${x}`).join(", ")} gain${shared.length === 1 ? "s" : ""} references` : "no entries change"}`, { pid: child, fds: Object.keys(fds).map(Number), entries: shared });
    } else {
      if (!open(s.fd)) return err(`fd ${s.fd} is not open in process ${s.pid}`);
      const id = proc.fds[s.fd as number];
      delete proc.fds[s.fd as number];
      snapshot("close", `${s.pid} closes fd ${s.fd}: ${release(id)}`, { pid: s.pid, fds: [], entries: [id] });
    }
  }
  return { frames, error: null };
}

/** The open-file entry a process's descriptor refers to in a frame, or null. */
export function entryOf(f: DescriptorFrame, pid: number, fd: number): OpenFileEntry | null {
  const id = f.procs.find((p) => p.pid === pid)?.fds[fd];
  return id === undefined ? null : f.entries.find((e) => e.id === id) ?? null;
}
