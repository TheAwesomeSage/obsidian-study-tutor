// Positions for the knowledge graph. Plain arithmetic with no DOM, so it can be tested and timed
// in Node.
//
// The layout is a small force simulation with three properties that matter here:
//   - it is deterministic: the same graph always gives the same picture;
//   - it is stable: concepts that already have a saved position keep it, and only new ones are
//     placed, so the map stays familiar as topics are added;
//   - it stays fast with thousands of nodes, because repulsion only looks at nearby nodes
//     through a grid instead of comparing every pair.
// Topics form clusters, and within a cluster foundations sit low and what builds on them rises.

export interface LayoutNode {
  id: string;
  /** Cluster key: the topic the concept belongs to. */
  group: string;
}
export interface LayoutEdge {
  from: string;
  to: string;
  /** True for `requires`: `from` rests on `to`, which orders the two vertically. */
  orders: boolean;
}
export type Positions = Record<string, [number, number]>;

const SPACING = 30;
const LAYER = 34;
const CELL = 64;

/** A number in [0, 1) from a string, the same every time. */
function unit(s: string, salt = 0): number {
  let h = 0x811c9dc5 ^ salt;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** Depth of each node in the prerequisite order: 0 rests on nothing. A loop is cut where it closes. */
export function depths(nodes: LayoutNode[], edges: LayoutEdge[]): Record<string, number> {
  const pre = new Map<string, string[]>();
  for (const e of edges) if (e.orders) pre.set(e.from, [...(pre.get(e.from) ?? []), e.to]);
  const depth: Record<string, number> = {};
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    if (id in depth) return depth[id];
    if (visiting.has(id)) return -1;
    visiting.add(id);
    let d = 0;
    for (const p of pre.get(id) ?? []) d = Math.max(d, visit(p) + 1);
    visiting.delete(id);
    return (depth[id] = d);
  };
  // An explicit stack would be needed for chains thousands deep; study topics are nowhere near that.
  for (const n of nodes) visit(n.id);
  return depth;
}

/**
 * Lays the graph out. `saved` holds positions from an earlier layout: nodes found there are
 * pinned where they were, and everything else is placed around them. With nothing saved, the
 * whole graph is laid out from scratch.
 */
export function layoutGraph(nodes: LayoutNode[], edges: LayoutEdge[], saved: Positions = {}, style: "clusters" | "connected" = "clusters"): Positions {
  const connected = style === "connected";
  const n = nodes.length;
  if (!n) return {};
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const depth = depths(nodes, edges);
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const pinned = new Uint8Array(n);
  let anyPinned = false;
  nodes.forEach((node, i) => {
    const s = saved[node.id];
    if (s && Number.isFinite(s[0]) && Number.isFinite(s[1])) {
      x[i] = s[0];
      y[i] = s[1];
      pinned[i] = 1;
      anyPinned = true;
    }
  });

  // ----- clusters: one disc per topic, packed along a spiral so none overlap -----
  const groups = new Map<string, number[]>();
  nodes.forEach((node, i) => groups.set(node.group, [...(groups.get(node.group) ?? []), i]));
  const centre = new Map<string, { x: number; y: number; r: number; mean: number }>();
  const placed: { x: number; y: number; r: number }[] = [];
  const keys = [...groups.keys()].sort();
  for (const key of keys) {
    const members = groups.get(key)!;
    const r = SPACING * 0.95 * Math.sqrt(members.length) + 24;
    const mean = members.reduce((a, i) => a + (depth[nodes[i].id] ?? 0), 0) / members.length;
    const fixed = members.filter((i) => pinned[i]);
    if (fixed.length) {
      // A topic already on the map stays where it is.
      const c = { x: fixed.reduce((a, i) => a + x[i], 0) / fixed.length, y: fixed.reduce((a, i) => a + y[i], 0) / fixed.length, r, mean };
      centre.set(key, c);
      placed.push(c);
    }
  }
  for (const key of keys) {
    if (centre.has(key)) continue;
    const members = groups.get(key)!;
    const r = SPACING * 0.95 * Math.sqrt(members.length) + 24;
    const mean = members.reduce((a, i) => a + (depth[nodes[i].id] ?? 0), 0) / members.length;
    let c = { x: 0, y: 0, r, mean };
    if (placed.length) {
      // Walk out along a golden-angle spiral until the disc fits beside the ones already placed.
      const start = unit(key) * Math.PI * 2;
      for (let step = 1; step < 4000; step++) {
        const a = start + step * 2.39996;
        const d = 14 * Math.sqrt(step) * 3;
        const cx = Math.cos(a) * d;
        const cy = Math.sin(a) * d * 0.8;
        if (placed.every((p) => Math.hypot(p.x - cx, p.y - cy) > p.r + r + 18)) {
          c = { x: cx, y: cy, r, mean };
          break;
        }
      }
    }
    centre.set(key, c);
    placed.push(c);
  }

  // ----- starting points for nodes with no saved position -----
  if (connected && !anyPinned) for (const c of centre.values()) { c.x *= 0.65; c.y *= 0.65; }
  nodes.forEach((node, i) => {
    if (pinned[i]) return;
    const c = centre.get(node.group)!;
    const a = unit(node.id) * Math.PI * 2;
    const d = Math.sqrt(unit(node.id, 7)) * c.r * 0.8;
    x[i] = c.x + Math.cos(a) * d;
    // Foundations low, what builds on them higher (screen y grows downward).
    y[i] = c.y - ((depth[node.id] ?? 0) - c.mean) * LAYER + Math.sin(a) * d * 0.35;
  });

  const links: { a: number; b: number; same: boolean; orders: boolean }[] = [];
  const degree = new Uint16Array(n);
  for (const e of edges) {
    const a = index.get(e.from);
    const b = index.get(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    links.push({ a, b, same: nodes[a].group === nodes[b].group, orders: e.orders });
    degree[a]++;
    degree[b]++;
  }

  const moving = n - pinned.reduce((a, v) => a + v, 0);
  if (!moving) return out();
  const iterations = n <= 300 ? 320 : n <= 1200 ? 220 : 140;
  const fx = new Float64Array(n);
  const fy = new Float64Array(n);
  const grid = new Map<number, number[]>();
  const cell = (v: number) => Math.floor(v / CELL);
  const keyOf = (cx: number, cy: number) => (cx + 32768) * 65536 + (cy + 32768);

  for (let it = 0; it < iterations; it++) {
    const alpha = 1 - it / iterations;
    fx.fill(0);
    fy.fill(0);

    // Repulsion, only between nodes in the same or neighbouring grid cells.
    grid.clear();
    for (let i = 0; i < n; i++) {
      const gk = keyOf(cell(x[i]), cell(y[i]));
      const list = grid.get(gk);
      if (list) list.push(i);
      else grid.set(gk, [i]);
    }
    for (let i = 0; i < n; i++) {
      const cx = cell(x[i]);
      const cy = cell(y[i]);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const list = grid.get(keyOf(cx + ox, cy + oy));
          if (!list) continue;
          for (const j of list) {
            if (j <= i) continue;
            let dx = x[i] - x[j];
            let dy = y[i] - y[j];
            let d2 = dx * dx + dy * dy;
            if (d2 > CELL * CELL) continue;
            if (d2 < 0.01) {
              // Two nodes on the same spot are nudged apart in a fixed direction.
              dx = unit(nodes[i].id, 3) - 0.5 || 0.1;
              dy = unit(nodes[j].id, 5) - 0.5 || 0.1;
              d2 = dx * dx + dy * dy;
            }
            const d = Math.sqrt(d2);
            const push = ((SPACING * SPACING) / d2) * (1 - d / CELL) * 1.6;
            const ux = (dx / d) * push;
            const uy = (dy / d) * push;
            fx[i] += ux;
            fy[i] += uy;
            fx[j] -= ux;
            fy[j] -= uy;
          }
        }
      }
    }

    // Springs along relations: short inside a topic, long and loose between topics.
    for (const l of links) {
      const dx = x[l.b] - x[l.a];
      const dy = y[l.b] - y[l.a];
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const rest = l.same ? SPACING * 1.25 : SPACING * (connected ? 2 : 4);
      const pull = (d - rest) * (l.same ? 0.07 : connected ? 0.045 : 0.012) * (l.orders ? 1 : 0.5);
      const ux = (dx / d) * pull;
      const uy = (dy / d) * pull;
      fx[l.a] += ux;
      fy[l.a] += uy;
      fx[l.b] -= ux;
      fy[l.b] -= uy;
    }

    // Each node is drawn to its topic's centre and to the height its depth gives it.
    for (let i = 0; i < n; i++) {
      const c = centre.get(nodes[i].group)!;
      fx[i] += (c.x - x[i]) * (connected ? 0.003 : 0.035);
      const level = c.y - ((depth[nodes[i].id] ?? 0) - c.mean) * LAYER;
      fy[i] += (level - y[i]) * (connected ? 0.015 : 0.09) + (c.y - y[i]) * (connected ? 0.002 : 0.01);
    }

    const limit = 12 * alpha + 0.4;
    for (let i = 0; i < n; i++) {
      if (pinned[i]) continue;
      const fxi = fx[i] * alpha;
      const fyi = fy[i] * alpha;
      const f = Math.sqrt(fxi * fxi + fyi * fyi);
      const scale = f > limit ? limit / f : 1;
      x[i] += fxi * scale;
      y[i] += fyi * scale;
    }
  }
  return out();

  function out(): Positions {
    const pos: Positions = {};
    // With nothing pinned the picture is centred on the origin; with pins it stays where it was.
    let ox = 0;
    let oy = 0;
    if (!anyPinned) {
      for (let i = 0; i < n; i++) {
        ox += x[i];
        oy += y[i];
      }
      ox /= n;
      oy /= n;
    }
    nodes.forEach((node, i) => (pos[node.id] = [Math.round((x[i] - ox) * 10) / 10, Math.round((y[i] - oy) * 10) / 10]));
    return pos;
  }
}

/** The box that holds every position, with a margin. */
export function bounds(pos: Positions, ids?: Iterable<string>): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const id of ids ?? Object.keys(pos)) {
    const p = pos[id];
    if (!p) continue;
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]);
    y1 = Math.max(y1, p[1]);
  }
  if (!Number.isFinite(x0)) return { x0: -100, y0: -100, x1: 100, y1: 100 };
  return { x0: x0 - 40, y0: y0 - 40, x1: x1 + 40, y1: y1 + 40 };
}
