// Draws a validated DiagramBlueprint as SVG: a state machine, a row of slots, a ring, or rows in
// tables joined by pointers. The simulations draw each of their frames through the same code,
// from diagrams that trusted code builds. Geometry is computed here from the data; every string
// is set with textContent, never parsed. Colours come from the player's CSS variables, so the
// drawing follows the light and dark themes.

import type { DiagramBlueprint, DiagramEdge, DiagramNode } from "./blueprints";
import { el, svgEl } from "./dom";

export interface DrawOptions {
  /** Pointer tables only: group ids stacked in each column, left to right. Default: one group per column. */
  columns?: string[][];
  /** Nodes already visited on a walk, and the node the walk is at. */
  visited?: string[];
  current?: string | null;
  /** The edge just followed or applied, drawn emphasised. */
  activeEdge?: { from: string; to: string } | null;
  /** Nodes drawn muted, such as an empty slot. */
  muted?: string[];
}
interface Box { x: number; y: number; w: number; h: number }

let sequence = 0;
const charW = (size: number) => size * 0.58;
const clampW = (min: number, max: number, v: number) => Math.max(min, Math.min(max, Math.ceil(v)));
const centre = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
/** Where the ray from a box's centre towards (tx, ty) leaves the box. */
function exit(b: Box, tx: number, ty: number, pad = 2) {
  const c = centre(b);
  const dx = tx - c.x, dy = ty - c.y;
  if (!dx && !dy) return c;
  const t = Math.min((b.w / 2 + pad) / Math.abs(dx || 1e-9), (b.h / 2 + pad) / Math.abs(dy || 1e-9));
  return { x: c.x + dx * t, y: c.y + dy * t };
}

/** A short text description of the diagram for screen readers. */
export function describeDiagram(b: DiagramBlueprint): string {
  const label = (id: string) => b.nodes.find((n) => n.id === id)?.label ?? id;
  const parts: string[] = [b.title + "."];
  if (b.layout === "state-machine") {
    parts.push(`States: ${b.nodes.map((n) => n.label + (n.note ? ` (${n.note})` : "")).join(", ")}.`);
    parts.push(`Transitions: ${b.edges.map((e) => `${label(e.from)} to ${label(e.to)}${e.label ? ` on ${e.label}` : ""}`).join("; ")}.`);
  } else if (b.layout === "pointer-tables") {
    for (const g of b.groups) parts.push(`${g.label}: ${b.nodes.filter((n) => n.group === g.id).map((n) => n.label + (n.note ? ` ${n.note}` : "")).join(", ")}.`);
    if (b.edges.length) parts.push(`Pointers: ${b.edges.map((e) => `${label(e.from)} to ${label(e.to)}`).join("; ")}.`);
  } else {
    parts.push(`${b.layout === "ring" ? "Ring" : "Slots"} in index order: ${b.nodes.map((n, i) => `[${i}] ${n.label}`).join(", ")}.`);
  }
  if (b.markers.length) parts.push(`Markers: ${b.markers.map((m) => `${m.label} at ${label(m.at)}`).join(", ")}.`);
  return parts.join(" ");
}

/** Mounts the drawing in a focusable, horizontally scrollable scene and returns the scene. */
export function drawDiagram(host: HTMLElement, b: DiagramBlueprint, o: DrawOptions = {}): HTMLElement {
  const scene = el(host, "div", "", `stv-scene stv-sys-scene is-${b.layout}`);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", describeDiagram(b));
  svg.classList.add("stv-sys-svg");
  scene.append(svg);
  const id = `stv-sys-${++sequence}`;
  const defs = svgEl(svg, "defs", {});
  for (const [suffix, cls] of [["", "stv-sys-head"], ["-on", "stv-sys-head is-on"]] as const) {
    const m = svgEl(defs, "marker", { id: `${id}-arrow${suffix}`, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
    svgEl(m, "path", { d: "M0,0 L10,5 L0,10 z", class: cls });
  }
  const arrow = (on: boolean) => `url(#${id}-arrow${on ? "-on" : ""})`;
  const visited = new Set(o.visited ?? []);
  const on = (n: DiagramNode) => b.highlights.includes(n.id) || visited.has(n.id) || o.current === n.id;
  const nodeClass = (n: DiagramNode, base: string) => `${base}${on(n) ? " is-on" : ""}${o.current === n.id ? " is-current" : ""}${o.muted?.includes(n.id) ? " is-muted" : ""}`;
  const active = (e: DiagramEdge) => !!o.activeEdge && o.activeEdge.from === e.from && o.activeEdge.to === e.to;
  const labelAt = (x: number, y: number, t: string, cls = "stv-sys-edge-label") => {
    if (!t) return;
    const w = t.length * charW(12) + 10;
    svgEl(svg, "rect", { x: x - w / 2, y: y - 10, width: w, height: 18, rx: 4, class: "stv-sys-label-bg" });
    svgEl(svg, "text", { x, y: y + 3, "text-anchor": "middle", class: cls }, t);
  };
  const boxes = new Map<string, Box>();
  const drawBox = (n: DiagramNode, bx: Box, base: string, sub = "") => {
    boxes.set(n.id, bx);
    const g = svgEl(svg, "g", { class: nodeClass(n, base) });
    svgEl(g, "rect", { x: bx.x, y: bx.y, width: bx.w, height: bx.h, rx: base === "stv-sys-row" ? 4 : 10, class: "stv-sys-box" });
    const two = !!(n.note || sub);
    if (base === "stv-sys-row") {
      svgEl(g, "text", { x: bx.x + 10, y: bx.y + bx.h / 2 + 4, class: "stv-sys-label" }, n.label);
      if (n.note) svgEl(g, "text", { x: bx.x + bx.w - 10, y: bx.y + bx.h / 2 + 4, "text-anchor": "end", class: "stv-sys-note" }, n.note);
    } else {
      svgEl(g, "text", { x: bx.x + bx.w / 2, y: bx.y + bx.h / 2 + (two ? -3 : 5), "text-anchor": "middle", class: "stv-sys-label" }, n.label);
      if (two) svgEl(g, "text", { x: bx.x + bx.w / 2, y: bx.y + bx.h / 2 + 14, "text-anchor": "middle", class: "stv-sys-note" }, n.note || sub);
    }
  };
  let width = 0, height = 0;

  if (b.layout === "state-machine") {
    // Columns by distance from the first state; states keep their written order inside a column.
    const depth = new Map<string, number>([[b.nodes[0].id, 0]]);
    const queue = [b.nodes[0].id];
    while (queue.length) {
      const at = queue.shift() as string;
      for (const e of b.edges) if (e.from === at && !depth.has(e.to)) { depth.set(e.to, (depth.get(at) ?? 0) + 1); queue.push(e.to); }
    }
    let extra = Math.max(...depth.values()) + 1;
    for (const n of b.nodes) if (!depth.has(n.id)) depth.set(n.id, extra++);
    const w = clampW(112, 240, Math.max(...b.nodes.map((n) => Math.max(n.label.length * charW(14), n.note.length * charW(11)))) + 24);
    const h = 58, gapX = 96, gapY = 70, left = 24, top = 54;
    const rows = new Map<number, number>();
    for (const n of b.nodes) {
      const col = depth.get(n.id) as number;
      const row = rows.get(col) ?? 0;
      rows.set(col, row + 1);
      drawBox(n, { x: left + col * (w + gapX), y: top + row * (h + gapY), w, h }, "stv-sys-state");
    }
    width = left * 2 + extra * (w + gapX) - gapX;
    height = top + Math.max(...rows.values()) * (h + gapY) - gapY + 70;
    const col = (nodeId: string) => depth.get(nodeId) as number;
    for (const e of b.edges) {
      const A = boxes.get(e.from) as Box, B = boxes.get(e.to) as Box;
      const hot = active(e);
      const cls = `stv-sys-edge${hot ? " is-on" : ""}`;
      if (e.from === e.to) {
        const c = centre(A);
        svgEl(svg, "path", { d: `M${c.x - 16},${A.y} C${c.x - 40},${A.y - 46} ${c.x + 40},${A.y - 46} ${c.x + 16},${A.y}`, class: cls, "marker-end": arrow(hot) });
        labelAt(c.x, A.y - 40, e.label);
        continue;
      }
      const a = centre(A), z = centre(B);
      const dx = z.x - a.x, dy = z.y - a.y, len = Math.hypot(dx, dy) || 1;
      const paired = b.edges.some((x) => x.from === e.to && x.to === e.from);
      const span = Math.abs(col(e.to) - col(e.from));
      let nx = -dy / len, ny = dx / len, bend = 0;
      if (paired) bend = 26;
      else if (span !== 1) {
        bend = span === 0 ? 44 : 38 + 10 * span;
        // Back edges bulge below, forward jumps above, edges inside a column to the right.
        const want = span === 0 ? (nx < 0 ? -1 : 1) : col(e.to) < col(e.from) ? (ny < 0 ? -1 : 1) : (ny > 0 ? -1 : 1);
        nx *= want; ny *= want;
      }
      const cx = (a.x + z.x) / 2 + nx * bend, cy = (a.y + z.y) / 2 + ny * bend;
      const p0 = exit(A, cx, cy), p1 = exit(B, cx, cy, 4);
      svgEl(svg, "path", { d: `M${p0.x},${p0.y} Q${cx},${cy} ${p1.x},${p1.y}`, class: cls, "marker-end": arrow(hot) });
      labelAt(0.25 * p0.x + 0.5 * cx + 0.25 * p1.x, 0.25 * p0.y + 0.5 * cy + 0.25 * p1.y, e.label);
    }
    for (const m of b.markers) {
      const bx = boxes.get(m.at) as Box;
      svgEl(svg, "line", { x1: bx.x - 30, y1: bx.y - 22, x2: bx.x + 4, y2: bx.y + 6, class: "stv-sys-marker", "marker-end": arrow(true) });
      svgEl(svg, "text", { x: bx.x - 32, y: bx.y - 26, class: "stv-sys-marker-label" }, m.label);
    }
  } else if (b.layout === "slots") {
    const per = 8, w = clampW(56, 120, Math.max(...b.nodes.map((n) => Math.max(n.label.length * charW(16), n.note.length * charW(11)))) + 18), h = 58, gap = 10, left = 24, top = 30;
    const marks = (nodeId: string) => b.markers.filter((m) => m.at === nodeId);
    const rowH = h + 30 + 22 * Math.max(1, ...b.nodes.map((n) => marks(n.id).length));
    b.nodes.forEach((n, i) => {
      const bx = { x: left + (i % per) * (w + gap), y: top + Math.floor(i / per) * rowH, w, h };
      drawBox(n, bx, "stv-sys-slot");
      svgEl(svg, "text", { x: bx.x + w / 2, y: bx.y + h + 15, "text-anchor": "middle", class: "stv-sys-index" }, `[${i}]`);
      marks(n.id).forEach((m, k) => {
        const y = bx.y + h + 22 + k * 22;
        svgEl(svg, "text", { x: bx.x + w / 2, y: y + 14, "text-anchor": "middle", class: "stv-sys-marker-label" }, `↑ ${m.label}`);
      });
    });
    width = left * 2 + Math.min(per, b.nodes.length) * (w + gap) - gap;
    height = top + Math.ceil(b.nodes.length / per) * rowH;
  } else if (b.layout === "ring") {
    const n = b.nodes.length, w = clampW(54, 96, Math.max(...b.nodes.map((x) => x.label.length * charW(15))) + 18), h = 44;
    const R = Math.max(92, (n * (w + 14)) / (2 * Math.PI));
    const pad = 96, cx = R + pad + w / 2, cy = R + pad + h / 2;
    width = height = 2 * cx;
    svgEl(svg, "circle", { cx, cy, r: R, class: "stv-sys-track" });
    b.nodes.forEach((node, i) => {
      const t = -Math.PI / 2 + (2 * Math.PI * i) / n;
      const x = cx + R * Math.cos(t), y = cy + R * Math.sin(t);
      drawBox(node, { x: x - w / 2, y: y - h / 2, w, h }, "stv-sys-slot");
      const ix = cx + (R - h / 2 - 16) * Math.cos(t), iy = cy + (R - h / 2 - 16) * Math.sin(t);
      svgEl(svg, "text", { x: ix, y: iy + 4, "text-anchor": "middle", class: "stv-sys-index" }, String(i));
      b.markers.filter((m) => m.at === node.id).forEach((m, k) => {
        const r1 = R + h / 2 + 8, r2 = R + h / 2 + 36 + k * 26;
        svgEl(svg, "line", { x1: cx + r2 * Math.cos(t), y1: cy + r2 * Math.sin(t), x2: cx + r1 * Math.cos(t), y2: cy + r1 * Math.sin(t), class: "stv-sys-marker", "marker-end": arrow(true) });
        svgEl(svg, "text", { x: cx + (r2 + 12) * Math.cos(t), y: cy + (r2 + 12) * Math.sin(t) + 4, "text-anchor": Math.cos(t) > 0.3 ? "start" : Math.cos(t) < -0.3 ? "end" : "middle", class: "stv-sys-marker-label" }, m.label);
      });
    });
    svgEl(svg, "text", { x: cx, y: cy + 5, "text-anchor": "middle", class: "stv-sys-caption" }, b.title.length > 28 ? b.title.slice(0, 27) + "…" : b.title);
  } else {
    const columns = o.columns ?? b.groups.map((g) => [g.id]);
    const w = clampW(160, 320, Math.max(...b.nodes.map((n) => n.label.length * charW(14) + n.note.length * charW(12))) + 44);
    const rowH = 36, headH = 28, gapX = 110, gapGroup = 26, left = 24, top = 24;
    let tallest = 0;
    columns.forEach((ids, c) => {
      let y = top;
      for (const gid of ids) {
        const g = b.groups.find((x) => x.id === gid);
        if (!g) continue;
        const x = left + c * (w + gapX);
        svgEl(svg, "text", { x, y: y + 18, class: "stv-sys-table-title" }, g.label);
        y += headH;
        for (const n of b.nodes.filter((x) => x.group === gid)) { drawBox(n, { x, y, w, h: rowH }, "stv-sys-row"); y += rowH; }
        y += gapGroup;
      }
      tallest = Math.max(tallest, y);
    });
    width = left * 2 + columns.length * (w + gapX) - gapX;
    height = tallest + 10;
    const colOf = (nodeId: string) => columns.findIndex((ids) => ids.includes(b.nodes.find((n) => n.id === nodeId)?.group ?? ""));
    for (const e of b.edges) {
      const A = boxes.get(e.from), B = boxes.get(e.to);
      if (!A || !B) continue;
      const hot = active(e) || ((o.visited?.includes(e.from) ?? false) && (o.visited?.includes(e.to) ?? false));
      const forward = colOf(e.to) > colOf(e.from);
      const x0 = forward ? A.x + A.w : A.x, y0 = A.y + A.h / 2, x1 = B.x - 3, y1 = B.y + B.h / 2;
      const bulge = forward ? Math.max(40, (x1 - x0) / 2) : 46;
      const d = forward ? `M${x0},${y0} C${x0 + bulge},${y0} ${x1 - bulge},${y1} ${x1},${y1}` : `M${x0},${y0} C${x0 - bulge},${y0} ${x1 - bulge},${y1} ${x1},${y1}`;
      svgEl(svg, "path", { d, class: `stv-sys-edge${hot ? " is-on" : ""}`, "marker-end": arrow(hot) });
      svgEl(svg, "circle", { cx: x0, cy: y0, r: 3, class: `stv-sys-dot${hot ? " is-on" : ""}` });
      if (e.label) labelAt((x0 + x1) / 2, (y0 + y1) / 2 - 8, e.label);
    }
    for (const m of b.markers) {
      const bx = boxes.get(m.at) as Box;
      svgEl(svg, "text", { x: bx.x - 6, y: bx.y + bx.h / 2 + 4, "text-anchor": "end", class: "stv-sys-marker-label" }, `${m.label} →`);
    }
  }
  svg.setAttribute("viewBox", `0 0 ${Math.ceil(width)} ${Math.ceil(height)}`);
  // The drawing scales down to the panel; past this width the scene scrolls instead of shrinking text.
  svg.style.minWidth = `${Math.min(Math.ceil(width), b.layout === "ring" ? 300 : 520)}px`;
  // ...and it never grows much past its own size, so a small ring is not blown up to the panel width.
  svg.style.maxWidth = `${Math.ceil(width * 1.15)}px`;
  return scene;
}
