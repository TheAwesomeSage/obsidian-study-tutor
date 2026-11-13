// The concept graph: a topic's subskills laid out by what depends on what, coloured by level.
// Built from the topic card and the learner state alone, so drawing it costs no tokens.
// No Obsidian imports: the layout is plain arithmetic and the drawing is plain SVG.

import { LearnerState, Prereqs, Topic, prereqMap, weakPrereqs } from "./formats";

export interface GraphNode {
  n: number;
  name: string;
  level: number | null;
  /** Depth in the dependency order: 0 needs nothing, 1 needs only depth-0 subskills, and so on. */
  layer: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The name, wrapped to fit the box. */
  lines: string[];
  prerequisites: number[];
  /** Subskills that list this one as a prerequisite. */
  unlocks: number[];
  /** Prerequisites the learner has not yet reached level 2 in. */
  blockedBy: number[];
  /** Not started, and something it depends on is not learned yet. */
  locked: boolean;
  atTarget: boolean;
  focus: boolean;
}

export interface GraphEdge {
  from: number;
  to: number;
  /** SVG path from the prerequisite down to the subskill that needs it. */
  d: string;
  /** The learner is further along in the dependent subskill than in its prerequisite. */
  lagging: boolean;
}

export interface Graph {
  width: number;
  height: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Level a prerequisite must reach before the subskill built on it counts as unlocked. */
export const UNLOCK_LEVEL = 2;

const PAD = 10;
const GAP_X = 12;
const GAP_Y = 30;
const LINE_H = 13;
const HEAD_H = 20;
const CHAR_W = 5.9;
const MAX_LINES = 3;

function wrap(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let cur = "";
  // A line may also break after a hyphen, so "time-invariant" need not be cut short.
  for (const word of text.split(/\s+|(?<=-)/).filter(Boolean)) {
    const joined = cur.endsWith("-") ? cur + word : cur + " " + word;
    if (!cur) cur = word;
    else if (joined.length <= maxChars) cur = joined;
    else {
      out.push(cur);
      cur = word;
    }
  }
  if (cur) out.push(cur);
  // A single word wider than the box is cut; so is anything past the last line.
  const cut = (l: string) => (l.length > maxChars ? l.slice(0, Math.max(1, maxChars - 1)) + "…" : l);
  if (out.length > MAX_LINES) {
    const kept = out.slice(0, MAX_LINES);
    kept[MAX_LINES - 1] = cut(kept[MAX_LINES - 1] + " " + out.slice(MAX_LINES).join(" "));
    return kept.map(cut);
  }
  return out.map(cut);
}

/**
 * Depth of every subskill: one more than its deepest prerequisite. A prerequisite loop
 * (a card edited by hand can contain one) is broken at the point where it closes.
 */
export function layers(pre: Prereqs): Record<number, number> {
  const depth: Record<number, number> = {};
  const visiting = new Set<number>();
  const visit = (n: number): number => {
    if (n in depth) return depth[n];
    if (visiting.has(n)) return -1;
    visiting.add(n);
    let d = 0;
    for (const p of pre[n] ?? []) d = Math.max(d, visit(p) + 1);
    visiting.delete(n);
    return (depth[n] = d);
  };
  for (const n of Object.keys(pre).map(Number)) visit(n);
  return depth;
}

/** Positions every subskill: prerequisites above, what they unlock below, at most `perRow` side by side. */
export function layoutGraph(topic: Topic, s: LearnerState, opts: { width?: number } = {}): Graph {
  const width = Math.max(240, Math.min(760, Math.round(opts.width || 340)));
  const pre = prereqMap(topic);
  const depth = layers(pre);
  const ns = topic.subskills.map((k) => k.n);
  const perRow = width >= 600 ? 4 : width >= 300 ? 3 : 2;

  // Order within a layer: under the average position of its prerequisites, so edges cross less.
  const byLayer = new Map<number, number[]>();
  for (const n of ns) byLayer.set(depth[n], [...(byLayer.get(depth[n]) ?? []), n]);
  const order: Record<number, number> = {};
  const layerKeys = [...byLayer.keys()].sort((a, b) => a - b);
  for (const l of layerKeys) {
    const row = byLayer.get(l)!;
    const bary = (n: number) => {
      const ps = (pre[n] ?? []).filter((p) => p in order);
      return ps.length ? ps.reduce((a, p) => a + order[p], 0) / ps.length : Infinity;
    };
    row.sort((a, b) => bary(a) - bary(b) || a - b);
    row.forEach((n, i) => (order[n] = (i + 0.5) / row.length));
  }

  const widest = Math.min(perRow, Math.max(...layerKeys.map((l) => byLayer.get(l)!.length)));
  const nodeW = Math.min(176, Math.floor((width - 2 * PAD - GAP_X * (widest - 1)) / widest));
  const maxChars = Math.max(6, Math.floor((nodeW - 16) / CHAR_W));

  const nodes: GraphNode[] = [];
  const at: Record<number, GraphNode> = {};
  let y = PAD;
  for (const l of layerKeys) {
    const all = byLayer.get(l)!;
    for (let i = 0; i < all.length; i += perRow) {
      const row = all.slice(i, i + perRow);
      const rowW = row.length * nodeW + (row.length - 1) * GAP_X;
      let x = Math.round((width - rowW) / 2);
      let rowH = 0;
      for (const n of row) {
        const sk = topic.subskills.find((k) => k.n === n)!;
        const lines = wrap(sk.name, maxChars);
        const level = s.levels[n] ?? null;
        const blockedBy = weakPrereqs(s, pre, n, UNLOCK_LEVEL);
        const node: GraphNode = {
          n,
          name: sk.name,
          level,
          layer: l,
          x,
          y,
          w: nodeW,
          h: HEAD_H + lines.length * LINE_H + 8,
          lines,
          prerequisites: pre[n] ?? [],
          unlocks: ns.filter((m) => (pre[m] ?? []).includes(n)),
          blockedBy,
          locked: (level ?? 0) < UNLOCK_LEVEL && blockedBy.length > 0,
          atTarget: level !== null && level >= s.target,
          focus: s.focus === n,
        };
        nodes.push(node);
        at[n] = node;
        rowH = Math.max(rowH, node.h);
        x += nodeW + GAP_X;
      }
      // Boxes in one row share a height, so their edges leave from one line.
      for (const n of row) at[n].h = rowH;
      y += rowH + GAP_Y;
    }
  }

  const edges: GraphEdge[] = [];
  for (const to of nodes) {
    for (const p of to.prerequisites) {
      const from = at[p];
      if (!from || from.y >= to.y) continue; // an edge that closes a loop is not drawn
      // Spread the arrow heads along the top of the box so several prerequisites stay distinct.
      const k = to.prerequisites.indexOf(p);
      const x2 = to.x + (to.w * (k + 1)) / (to.prerequisites.length + 1);
      const x1 = from.x + from.w / 2;
      const y1 = from.y + from.h;
      const y2 = to.y - 5;
      const mid = (y1 + y2) / 2;
      const r = (v: number) => Math.round(v * 10) / 10;
      edges.push({
        from: p,
        to: to.n,
        d: `M${r(x1)} ${r(y1)} C${r(x1)} ${r(mid)}, ${r(x2)} ${r(mid)}, ${r(x2)} ${r(y2)}`,
        lagging: to.level !== null && to.level > 0 && (from.level ?? 0) < to.level,
      });
    }
  }
  return { width, height: Math.max(PAD * 2, y - GAP_Y + PAD), nodes, edges };
}

const SVG = "http://www.w3.org/2000/svg";

function el(doc: Document, tag: string, attrs: Record<string, string | number>, text?: string): SVGElement {
  const e = doc.createElementNS(SVG, tag) as SVGElement;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
}

export const levelLabel = (level: number | null): string => (level === null ? "not placed" : `level ${level}`);

/** One line describing a node, for the hover tooltip and for screen readers. */
export function describeNode(n: GraphNode, names: Record<number, string>, target: number): string {
  const parts = [`${n.n}. ${n.name}: ${levelLabel(n.level)} of ${target}${n.atTarget ? " (at target)" : ""}`];
  if (n.prerequisites.length) parts.push(`Builds on ${n.prerequisites.map((p) => `${p}. ${names[p] ?? "?"}`).join(", ")}`);
  if (n.locked) parts.push(`Learn ${n.blockedBy.map((p) => names[p] ?? p).join(", ")} first`);
  return parts.join(". ") + ".";
}

/**
 * Draws the graph as SVG inside `parent`. Colours come from CSS classes (st-g-l0 … st-g-l5,
 * st-g-unset), so the theme decides them. Clicking or pressing Enter on a box calls `onSelect`.
 */
export function drawGraph(parent: HTMLElement, g: Graph, s: LearnerState, selected: number | null, onSelect: (n: number) => void): SVGElement {
  const doc = parent.ownerDocument;
  const svg = el(doc, "svg", { class: "st-graph", width: g.width, height: g.height, viewBox: `0 0 ${g.width} ${g.height}`, role: "group", "aria-label": "Concept graph: subskills by prerequisite, coloured by level" });
  const defs = el(doc, "defs", {});
  for (const [id, cls] of [
    ["st-arrow", "st-g-arrow"],
    ["st-arrow-lag", "st-g-arrow is-lagging"],
  ]) {
    const marker = el(doc, "marker", { id, viewBox: "0 0 10 10", refX: 5, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto" });
    marker.appendChild(el(doc, "path", { d: "M1 1 L9 5 L1 9 z", class: cls }));
    defs.appendChild(marker);
  }
  svg.appendChild(defs);

  for (const e of g.edges) {
    const touches = selected !== null && (e.from === selected || e.to === selected);
    const path = el(doc, "path", { d: e.d, class: "st-g-edge" + (e.lagging ? " is-lagging" : "") + (touches ? " is-selected" : ""), "marker-end": `url(#${e.lagging ? "st-arrow-lag" : "st-arrow"})` });
    if (e.lagging) path.appendChild(el(doc, "title", {}, `${s.names[e.from] ?? e.from} is behind ${s.names[e.to] ?? e.to}, which builds on it.`));
    svg.appendChild(path);
  }

  for (const n of g.nodes) {
    const cls = ["st-g-node", n.level === null ? "st-g-unset" : `st-g-l${n.level}`, n.locked ? "is-locked" : "", n.focus ? "is-focus" : "", n.n === selected ? "is-selected" : ""].filter(Boolean).join(" ");
    const group = el(doc, "g", { class: cls, transform: `translate(${n.x} ${n.y})`, tabindex: 0, role: "button", "aria-label": describeNode(n, s.names, s.target), "aria-pressed": n.n === selected ? "true" : "false" });
    group.appendChild(el(doc, "title", {}, describeNode(n, s.names, s.target)));
    group.appendChild(el(doc, "rect", { class: "st-g-box", x: 0.5, y: 0.5, width: n.w - 1, height: n.h - 1, rx: 8 }));
    group.appendChild(el(doc, "text", { class: "st-g-num", x: 8, y: 14 }, n.focus ? `${n.n} · focus` : String(n.n)));
    group.appendChild(el(doc, "text", { class: "st-g-level", x: n.w - 8, y: 14, "text-anchor": "end" }, n.level === null ? "–" : `L${n.level}${n.atTarget ? " ✓" : ""}`));
    n.lines.forEach((line, i) => group.appendChild(el(doc, "text", { class: "st-g-name", x: 8, y: HEAD_H + 10 + i * LINE_H }, line)));
    group.addEventListener("click", () => onSelect(n.n));
    group.addEventListener("keydown", (ev) => {
      const key = (ev as KeyboardEvent).key;
      if (key === "Enter" || key === " ") {
        ev.preventDefault();
        onSelect(n.n);
      }
    });
    svg.appendChild(group);
  }
  parent.appendChild(svg);
  return svg;
}
