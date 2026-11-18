// The player's stage for the Software Systems modules. Each frame is computed by trusted code in
// src/visuals/systems.ts and drawn as SVG (src/visuals/draw.ts) or as plain DOM, with text set
// through textContent only. The board keeps keyboard focus across frames: with it focused, the
// right arrow key takes the next step, the same as the Step button.

import type { Json, JsonObject, VisualLesson } from "./contracts";
import { PROCESS_STATES, walkDiagram, type DescriptorBlueprint, type DiagramBlueprint, type DiagramNode, type ProcessBlueprint, type RaceBlueprint, type RingBlueprint } from "./blueprints";
import { PROCESS_TRANSITIONS, entryOf, ringContents, ringTail, runDescriptors, runProcesses, runRace, runRing, type DescriptorFrame, type RaceFrame } from "./systems";
import { DIAGRAM_MODULE } from "./systems-modules";
import { drawDiagram, type DrawOptions } from "./draw";
import { el } from "./dom";

export interface AnswerSpec {
  label: string;
  /** A fixed set of answers, shown as a select. */
  choices?: string[];
  /** Shown when the text cannot be read as an answer. */
  help: string;
  parse(raw: string): Json | undefined;
}
export interface SystemsView {
  steps: number;
  render(position: number): void;
  reset(): void;
  lock(): void;
  response(): JsonObject;
  answer: AnswerSpec;
}
export interface SystemsHooks { step(): void; settings(): void }

const number: AnswerSpec["parse"] = (raw) => { const t = raw.trim(); const n = Number(t); return t && Number.isFinite(n) ? n : undefined; };
const numbers: AnswerSpec["parse"] = (raw) => {
  const t = raw.trim().replace(/^\[|\]$/g, "").trim();
  if (!t) return [];
  const parts = t.split(/[\s,]+/).map(Number);
  return parts.every(Number.isFinite) ? parts : undefined;
};
const choice: AnswerSpec["parse"] = (raw) => (raw.trim() ? raw.trim() : undefined);
const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const node = (id: string, label: string, group = "", note = ""): DiagramNode => ({ id, label, group, note });

/** Builds the stage for a valid Software Systems lesson. */
export function mountSystems(stage: HTMLElement, controls: HTMLElement, lesson: VisualLesson, hooks: SystemsHooks): SystemsView {
  const heading = el(stage, "p", "", "stv-equation");
  const board = el(stage, "div", "", "stv-sys-board");
  board.tabIndex = 0;
  board.setAttribute("role", "group");
  board.setAttribute("aria-label", "Model view. Press the right arrow key to take the next step.");
  board.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") { e.preventDefault(); hooks.step(); }
  });
  const detail = el(stage, "p", "", "stv-trace-line");
  detail.setAttribute("aria-live", "polite");
  const result = el(stage, "p", "", "stv-sys-result");
  const list = el(stage, "ol", "", "stv-sys-steps");
  list.setAttribute("aria-label", "Steps the model applies, in order");
  el(stage, "p", "Every step is applied by the module's own code from the saved blueprint. Focus the view and press → to step.", "stv-caption");
  const steps = (labels: string[]) => {
    list.replaceChildren();
    return labels.map((t) => el(list, "li", t));
  };
  const mark = (items: HTMLLIElement[], pos: number) => items.forEach((li, i) => {
    li.className = i < pos - 1 ? "is-done" : i === pos - 1 ? "is-current" : "";
    if (i === pos - 1) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
  });
  const draw = (b: DiagramBlueprint, o: DrawOptions = {}) => { board.replaceChildren(); drawDiagram(board, b, o); };
  const telemetry = (cells: [string, string][]) => {
    const box = el(board, "div", "", "stv-telemetry stv-sys-telemetry");
    for (const [k, v] of cells) { const cell = el(box, "div"); el(cell, "span", k); el(cell, "strong", v); }
  };
  const s = lesson.settings as unknown;

  if (lesson.moduleId === DIAGRAM_MODULE) {
    const b = s as DiagramBlueprint;
    const walk = walkDiagram(b).visited;
    const label = (id: string) => b.nodes.find((n) => n.id === id)?.label ?? id;
    const items = steps(b.path.map((p) => `follow “${p}”`));
    return {
      steps: b.path.length,
      render(pos) {
        heading.textContent = `${b.title} · step ${pos} / ${b.path.length}`;
        draw(b, { visited: walk.slice(0, pos), current: walk[pos], activeEdge: pos ? { from: walk[pos - 1], to: walk[pos] } : null });
        detail.textContent = pos ? `Followed “${b.path[pos - 1]}”: ${label(walk[pos - 1])} → ${label(walk[pos])}` : `Start at ${label(b.start)}. Predict where the path ends, then step along it.`;
        result.textContent = pos === b.path.length ? `The path ends at ${label(walk[pos])}.` : "";
        mark(items, pos);
      },
      reset() {}, lock() {},
      response: () => ({ reached: label(walk[walk.length - 1]) }),
      answer: { label: "Where does the path end?", choices: [...new Set(b.nodes.map((n) => n.label))], help: "Choose where the path ends.", parse: choice },
    };
  }

  if (lesson.moduleId === "process-states") {
    const b = s as ProcessBlueprint;
    const frames = runProcesses(b).frames;
    const order = ["new", "ready", "running", "terminated", "waiting"] as const;
    const edges = Object.entries(PROCESS_TRANSITIONS).map(([event, t]) => ({ from: t.from, to: t.to, label: event }));
    const items = steps(b.steps.map((x) => `${x.pid} ${x.event}`));
    return {
      steps: b.steps.length,
      render(pos) {
        const f = frames[pos];
        heading.textContent = `Scheduler trace · step ${pos} / ${b.steps.length}`;
        const into = f.pid ? f.states[f.pid] : null;
        const t = f.event ? PROCESS_TRANSITIONS[f.event] : null;
        draw({
          layout: "state-machine", title: "Five-state process model", groups: [], markers: [], start: "new", path: ["admit"],
          nodes: order.map((st) => node(st, title(st), "", Object.keys(f.states).filter((p) => f.states[p] === st).join(" "))),
          edges, highlights: [],
        }, { current: into, activeEdge: t ? { from: t.from, to: t.to } : null, muted: order.filter((st) => !Object.values(f.states).includes(st)) });
        telemetry(b.processes.map((p) => [p.id, f.states[p.id]] as [string, string]));
        detail.textContent = f.detail;
        result.textContent = pos === b.steps.length ? `${b.focus} ends ${f.states[b.focus]}.` : "";
        mark(items, pos);
      },
      reset() {}, lock() {},
      response: () => ({ state: frames[frames.length - 1].states[b.focus] }),
      answer: { label: `Final state of ${b.focus}`, choices: [...PROCESS_STATES], help: "Choose a state.", parse: choice },
    };
  }

  if (lesson.moduleId === "race-condition") {
    const b = s as RaceBlueprint;
    const initial = b.lock;
    const [ta, tb] = b.threads;
    let run = runRace(b);
    const label = el(controls, "label", "", "stv-sys-check");
    const box = el(label, "input");
    box.type = "checkbox";
    box.checked = b.lock;
    el(label, "span", "Guard each update with a lock");
    box.onchange = () => { b.lock = box.checked; run = runRace(b); view.render(0); hooks.settings(); };
    const plan = (f: RaceFrame) => f.op === "add" ? `add ${b.threads.find((t) => t.id === f.thread)?.delta}` : f.op === "acquire" ? "lock" : f.op === "release" ? "unlock" : f.op === "blocked" ? "wait for lock" : f.op;
    const done = (f: RaceFrame) => f.op === "read" ? `read ${f.regs[f.thread as string]}` : f.op === "add" ? `add → ${f.regs[f.thread as string]}` : f.op === "write" ? `write ${f.value}` : f.op === "acquire" ? "takes lock" : f.op === "release" ? "releases lock" : f.op === "blocked" ? "waits" : f.op;
    const view: SystemsView = {
      get steps() { return run.frames.length - 1; },
      render(pos) {
        const f = run.frames[pos];
        const n = run.frames.length - 1;
        heading.textContent = `${b.variable} = ${b.variable} + delta in two threads · step ${pos} / ${n}`;
        board.replaceChildren();
        telemetry([[b.variable, String(f.value)], [`${ta.id} register`, f.regs[ta.id] === null ? "—" : String(f.regs[ta.id])], [`${tb.id} register`, f.regs[tb.id] === null ? "—" : String(f.regs[tb.id])], ["Lock", b.lock ? f.holder ? `held by ${f.holder}` : "free" : "none"]]);
        const scroll = el(board, "div", "", "stv-sys-scroll");
        const table = el(scroll, "table", "", "stv-sys-timeline");
        el(table, "caption", `Interleaving${b.lock ? " with the lock" : ""}: each row is one step by one thread`, "stv-sr-only");
        const head = el(el(table, "thead"), "tr");
        for (const h of ["#", `Thread ${ta.id}`, `Thread ${tb.id}`, b.variable]) el(head, "th", h).setAttribute("scope", "col");
        const body = el(table, "tbody");
        let after = false;
        run.frames.slice(1).forEach((x, i) => {
          if (!x.scheduled && !after) { after = true; const tr = el(body, "tr", "", "stv-sys-after"); const td = el(tr, "td", "Then the steps left over run, first thread first"); td.colSpan = 4; }
          const k = i + 1;
          const tr = el(body, "tr", "", k < pos ? "is-done" : k === pos ? "is-current" : "is-future");
          if (k === pos) tr.setAttribute("aria-current", "step");
          el(tr, "td", String(k));
          for (const t of [ta, tb]) el(tr, "td", x.thread === t.id ? (k <= pos ? done(x) : plan(x)) : "");
          el(tr, "td", k <= pos ? String(x.value) : "?");
        });
        detail.textContent = f.detail;
        result.className = "stv-sys-result";
        if (pos === n) {
          const lost = run.final !== run.expected;
          result.textContent = lost ? `Lost update: one after the other the updates give ${run.expected}, this interleaving gives ${run.final}.` : `No update lost: ${b.variable} ends at ${run.final}, as if the updates ran one after the other.`;
          if (lost) result.classList.add("is-warn");
        } else result.textContent = "";
      },
      reset() { b.lock = initial; box.checked = initial; box.disabled = false; run = runRace(b); },
      lock() { box.disabled = true; },
      response: () => ({ final: run.final, expected: run.expected, lock: b.lock }),
      answer: { label: `Final value of ${b.variable} for the current lock setting (a number)`, help: "Enter a whole number.", parse: number },
    };
    steps([]);
    list.hidden = true;
    return view;
  }

  if (lesson.moduleId === "circular-buffer") {
    const b = s as RingBlueprint;
    const frames = runRing(b).frames;
    const items = steps(b.steps.map((x) => (x.op === "push" ? `push ${x.value}` : "pop")));
    const contents = lesson.assessmentId === "ring-contents";
    return {
      steps: b.steps.length,
      render(pos) {
        const f = frames[pos];
        const tail = ringTail(f);
        const full = f.count === b.capacity, empty = f.count === 0;
        heading.textContent = `Ring of ${b.capacity} · step ${pos} / ${b.steps.length}`;
        draw({
          layout: "ring", title: `${f.count} of ${b.capacity}${full ? " · FULL" : empty ? " · EMPTY" : ""}`, groups: [], edges: [], start: "s0", path: ["next"],
          nodes: f.slots.map((v, i) => node(`s${i}`, v === null ? "·" : String(v))),
          markers: [{ label: "head", at: `s${f.head}` }, { label: "tail", at: `s${tail}` }],
          highlights: [],
        }, { current: f.slot === null ? null : `s${f.slot}`, muted: f.slots.map((v, i) => (v === null ? `s${i}` : "")).filter(Boolean) });
        telemetry([["Head", String(f.head)], ["Tail", String(tail)], ["Count", `${f.count} of ${b.capacity}`], ["State", full ? "full: head = tail" : empty ? "empty: head = tail" : "partly full"]]);
        detail.textContent = f.detail;
        result.className = `stv-sys-result${f.op === "overflow" || f.op === "underflow" || f.op === "overwrite" ? " is-warn" : ""}`;
        result.textContent = pos === b.steps.length ? `Holds ${f.count}: [${ringContents(f).join(", ")}] oldest first${f.rejected ? `; ${f.rejected} push${f.rejected === 1 ? "" : "es"} refused` : ""}.` : f.op === "overflow" ? "Overflow: the ring is full." : f.op === "underflow" ? "Underflow: the ring is empty." : "";
        mark(items, pos);
      },
      reset() {}, lock() {},
      response: () => { const f = frames[frames.length - 1]; return { count: f.count, contents: ringContents(f), rejected: f.rejected }; },
      answer: contents ? { label: "Items at the end, oldest first (such as 4, 7)", help: "Enter numbers separated by commas, or [] for none.", parse: numbers } : { label: "Items in the ring at the end (a number)", help: "Enter a whole number.", parse: number },
    };
  }

  const b = s as DescriptorBlueprint;
  const frames = runDescriptors(b).frames;
  const items = steps(b.steps.map((x) => x.op === "open" ? `${x.pid}: open ${x.path}` : x.op === "fork" ? `${x.pid}: fork → ${x.child}` : x.op === "dup2" ? `${x.pid}: dup2(${x.fd}, ${x.to})` : x.op === "read" || x.op === "write" ? `${x.pid}: ${x.op} ${x.bytes} bytes via fd ${x.fd}` : `${x.pid}: ${x.op}(${x.fd})`));
  const offset = lesson.assessmentId === "shared-offset";
  const tables = (f: DescriptorFrame): DiagramBlueprint => {
    const nodes: DiagramNode[] = [];
    const edges: DiagramBlueprint["edges"] = [];
    for (const p of f.procs) {
      const fds = Object.keys(p.fds).map(Number).sort((x, y) => x - y);
      if (!fds.length) nodes.push(node(`p${p.pid}-none`, "no files open", `p${p.pid}`));
      for (const fd of fds) { nodes.push(node(`p${p.pid}-fd${fd}`, `fd ${fd}`, `p${p.pid}`, `→ #${p.fds[fd]}`)); edges.push({ from: `p${p.pid}-fd${fd}`, to: `e${p.fds[fd]}`, label: "" }); }
    }
    if (!f.entries.length) nodes.push(node("e-none", "no open files", "files"));
    for (const e of f.entries) { nodes.push(node(`e${e.id}`, `#${e.id} ${e.path}`, "files", `offset ${e.offset} · refs ${e.refs}`)); edges.push({ from: `e${e.id}`, to: `i${e.inode}`, label: "" }); }
    for (const i of f.inodes) nodes.push(node(`i${i.inode}`, `inode ${i.inode}`, "inodes", `${i.path} · refs ${i.refs}`));
    return { layout: "pointer-tables", title: "Descriptor tables", groups: [...f.procs.map((p) => ({ id: `p${p.pid}`, label: `Process ${p.pid} fds` })), { id: "files", label: "Open-file table" }, { id: "inodes", label: "Inode table" }], nodes, edges, markers: [], highlights: [], start: nodes[0].id, path: [""] };
  };
  return {
    steps: b.steps.length,
    render(pos) {
      const f = frames[pos];
      heading.textContent = `Descriptor tables · step ${pos} / ${b.steps.length}`;
      const touched = [...f.touched.fds.map((fd) => `p${f.touched.pid}-fd${fd}`), ...f.touched.entries.map((id) => `e${id}`)];
      draw(tables(f), { columns: [f.procs.map((p) => `p${p.pid}`), ["files"], ["inodes"]], visited: touched, muted: ["e-none", ...f.procs.map((p) => `p${p.pid}-none`)] });
      const e = entryOf(f, b.focusPid, b.focusFd);
      telemetry([["Question", `fd ${b.focusFd} of ${b.focusPid}`], ["Entry", e ? `#${e.id} ${e.path}` : "not open"], ["References", e ? String(e.refs) : "—"], ["Offset", e ? String(e.offset) : "—"]]);
      detail.textContent = f.detail;
      result.textContent = pos === b.steps.length && e ? `fd ${b.focusFd} of ${b.focusPid} shares entry #${e.id} with ${e.refs - 1} other descriptor${e.refs === 2 ? "" : "s"}; its offset is ${e.offset}.` : "";
      mark(items, pos);
    },
    reset() {}, lock() {},
    response: () => { const e = entryOf(frames[frames.length - 1], b.focusPid, b.focusFd); return { refs: e?.refs ?? null, offset: e?.offset ?? null }; },
    answer: { label: offset ? `File offset behind fd ${b.focusFd} of ${b.focusPid} at the end (a number)` : `Descriptors sharing that open-file entry at the end (a number)`, help: "Enter a whole number.", parse: number },
  };
}
