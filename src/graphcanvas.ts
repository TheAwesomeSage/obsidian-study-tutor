// Draws the knowledge graph on a canvas and handles pointer and keyboard input.
//
// Canvas was chosen over SVG because one element stays responsive with thousands of nodes
// where thousands of DOM nodes would not. It needs no library: the plugin has no runtime
// dependencies and this keeps it that way. Everything is drawn on demand, never on a timer,
// and only what is on screen is drawn.

import type { EdgeStatus, Relation } from "./course";

export interface GNode {
  id: string;
  label: string;
  group: string;
  x: number;
  y: number;
  degree: number;
  /** Fill colour, already resolved from the theme. */
  color: string;
  /** No data for the current colour mode: drawn as an empty ring. */
  hollow: boolean;
  /** Little unaided evidence behind what the colour shows: drawn with a dashed outline. */
  weak: boolean;
}

export interface GEdge {
  from: string;
  to: string;
  type: Relation;
  status: EdgeStatus;
}

export interface GGroup {
  id: string;
  title: string;
  x: number;
  y: number;
}

export interface GraphColors {
  text: string;
  muted: string;
  faint: string;
  surface: string;
  edge: string;
  accent: string;
  /** What the selected concept rests on, and what rests on it. */
  pre: string;
  dep: string;
  font: string;
}

/** Maps with this many concepts or fewer label every concept at any zoom. */
const SMALL_MAP = 40;
const DASH: Record<Relation, number[]> = { synoptic: [10, 4, 3, 4], requires: [], supports: [7, 4], applies_to: [2, 4], contrasts_with: [9, 3, 2, 3], derived_from: [1, 3] };

export class GraphCanvas {
  /** Null where there is no canvas support (a test environment): everything but drawing still works. */
  private ctx: CanvasRenderingContext2D | null;
  private nodes: GNode[] = [];
  private byId = new Map<string, GNode>();
  private edges: GEdge[] = [];
  private groups: GGroup[] = [];
  private colors: GraphColors = { text: "#ddd", muted: "#aaa", faint: "#666", surface: "#1e1e1e", edge: "#888", accent: "#8a5cf5", pre: "#3987e5", dep: "#d95926", font: "sans-serif" };
  /** World point at the centre of the canvas, and pixels per world unit. */
  cam = { x: 0, y: 0, k: 1 };
  /** The view is still the whole-graph fit: nothing has panned, zoomed or centred it since. */
  showsFit = false;
  selected: string | null = null;
  hover: string | null = null;
  /** Search matches, ringed and labelled. */
  matches = new Set<string>();
  /** When set, only these nodes are drawn (a filter, or a neighbourhood). */
  visible: Set<string> | null = null;
  /** Highlight sets for the selected node. */
  private anc = new Set<string>();
  private desc = new Set<string>();
  private near = new Set<string>();
  private w = 0;
  private h = 0;
  private dpr = 1;
  private frame = 0;
  private drag: { x: number; y: number; cx: number; cy: number; moved: boolean; id: number } | null = null;
  private pinch = new Map<number, { x: number; y: number }>();

  constructor(
    private canvas: HTMLCanvasElement,
    private on: { select(id: string | null): void; hover(id: string | null): void; key?(e: KeyboardEvent): boolean },
  ) {
    this.ctx = canvas.getContext("2d");
    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("pointermove", (e) => this.move(e));
    canvas.addEventListener("pointerup", (e) => this.up(e));
    canvas.addEventListener("pointercancel", () => ((this.drag = null), this.pinch.clear()));
    canvas.addEventListener("pointerleave", () => this.setHover(null));
    canvas.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    canvas.addEventListener("dblclick", (e) => {
      const n = this.pick(e.offsetX, e.offsetY);
      if (n) this.centreOn(n.id, Math.max(this.cam.k, 1.8));
      else this.zoomAt(1.6, e.offsetX, e.offsetY);
    });
    canvas.addEventListener("keydown", (e) => this.key(e));
  }

  // ---------- data ----------

  setData(nodes: GNode[], edges: GEdge[], groups: GGroup[]): void {
    this.nodes = nodes;
    this.byId = new Map(nodes.map((n) => [n.id, n]));
    this.edges = edges.filter((e) => this.byId.has(e.from) && this.byId.has(e.to));
    this.groups = groups;
    if (this.selected && !this.byId.has(this.selected)) this.selected = null;
    this.setHighlight();
    this.redraw();
  }

  setColors(c: GraphColors): void {
    this.colors = c;
    this.redraw();
  }

  /** Sets which nodes the selection lights up: everything it rests on, and everything resting on it. */
  setHighlight(ancestors: Iterable<string> = [], descendants: Iterable<string> = []): void {
    this.anc = new Set(ancestors);
    this.desc = new Set(descendants);
    this.near = new Set();
    if (this.selected) for (const e of this.edges) if (e.from === this.selected || e.to === this.selected) this.near.add(e.from === this.selected ? e.to : e.from);
    this.redraw();
  }

  private shown(id: string): boolean {
    return !this.visible || this.visible.has(id);
  }

  // ---------- camera ----------

  resize(width: number, height: number): void {
    if (width < 2 || height < 2) return;
    this.dpr = Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
    this.w = width;
    this.h = height;
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.redraw();
  }

  private sx(x: number): number {
    return (x - this.cam.x) * this.cam.k + this.w / 2;
  }
  private sy(y: number): number {
    return (y - this.cam.y) * this.cam.k + this.h / 2;
  }

  /** Fits everything that is shown, or the given nodes, into the canvas. False when there was nothing to fit yet. */
  fit(ids?: Iterable<string>): boolean {
    const list = ids ? [...ids].map((id) => this.byId.get(id)).filter((n): n is GNode => !!n) : this.nodes.filter((n) => this.shown(n.id));
    if (!list.length || !this.w) return false;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of list) {
      x0 = Math.min(x0, n.x);
      y0 = Math.min(y0, n.y);
      x1 = Math.max(x1, n.x);
      y1 = Math.max(y1, n.y);
    }
    const pad = 56;
    const k = Math.min((this.w - 2 * pad) / Math.max(1, x1 - x0), (this.h - 2 * pad) / Math.max(1, y1 - y0));
    this.cam = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, k: Math.max(0.08, Math.min(2.4, k)) };
    this.showsFit = !ids;
    this.redraw();
    return true;
  }

  zoomAt(factor: number, px = this.w / 2, py = this.h / 2): void {
    this.showsFit = false;
    const k = Math.max(0.05, Math.min(6, this.cam.k * factor));
    // Keep the world point under the cursor where it is.
    const wx = (px - this.w / 2) / this.cam.k + this.cam.x;
    const wy = (py - this.h / 2) / this.cam.k + this.cam.y;
    this.cam = { x: wx - (px - this.w / 2) / k, y: wy - (py - this.h / 2) / k, k };
    this.redraw();
  }

  centreOn(id: string, k = this.cam.k): void {
    const n = this.byId.get(id);
    if (!n) return;
    this.showsFit = false;
    this.cam = { x: n.x, y: n.y, k };
    this.redraw();
  }

  // ---------- input ----------

  private radius(n: GNode): number {
    return (3.6 + Math.min(3.2, Math.sqrt(n.degree) * 0.9)) * Math.max(0.75, Math.min(1.9, Math.pow(this.cam.k, 0.45)));
  }

  private pick(px: number, py: number): GNode | null {
    let best: GNode | null = null;
    let bestD = Infinity;
    for (const n of this.nodes) {
      if (!this.shown(n.id)) continue;
      const dx = this.sx(n.x) - px;
      const dy = this.sy(n.y) - py;
      const d = dx * dx + dy * dy;
      // The hit target is larger than the dot, so small nodes are still easy to click.
      const r = this.radius(n) + 7;
      if (d <= r * r && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  }

  private setHover(id: string | null): void {
    if (this.hover === id) return;
    this.hover = id;
    this.canvas.style.cursor = id ? "pointer" : this.drag ? "grabbing" : "grab";
    this.on.hover(id);
    this.redraw();
  }

  private down(e: PointerEvent): void {
    this.canvas.focus({ preventScroll: true });
    this.pinch.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (this.pinch.size === 1) this.drag = { x: e.offsetX, y: e.offsetY, cx: this.cam.x, cy: this.cam.y, moved: false, id: e.pointerId };
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* not every environment supports capture */
    }
  }

  private move(e: PointerEvent): void {
    const prev = this.pinch.get(e.pointerId);
    if (prev && this.pinch.size === 2) {
      // Two fingers: zoom about their midpoint.
      const other = [...this.pinch.entries()].find(([id]) => id !== e.pointerId)![1];
      const before = Math.hypot(prev.x - other.x, prev.y - other.y);
      const after = Math.hypot(e.offsetX - other.x, e.offsetY - other.y);
      this.pinch.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (before > 0) this.zoomAt(after / before, (e.offsetX + other.x) / 2, (e.offsetY + other.y) / 2);
      this.drag = null;
      return;
    }
    if (this.drag && this.drag.id === e.pointerId) {
      const dx = e.offsetX - this.drag.x;
      const dy = e.offsetY - this.drag.y;
      if (!this.drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      this.drag.moved = true;
      this.showsFit = false;
      this.canvas.style.cursor = "grabbing";
      this.cam = { ...this.cam, x: this.drag.cx - dx / this.cam.k, y: this.drag.cy - dy / this.cam.k };
      this.redraw();
      return;
    }
    this.setHover(this.pick(e.offsetX, e.offsetY)?.id ?? null);
  }

  private up(e: PointerEvent): void {
    this.pinch.delete(e.pointerId);
    const d = this.drag;
    this.drag = null;
    this.canvas.style.cursor = this.hover ? "pointer" : "grab";
    if (!d || d.moved || d.id !== e.pointerId) return;
    const n = this.pick(e.offsetX, e.offsetY);
    this.on.select(n ? (n.id === this.selected ? null : n.id) : null);
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    // A trackpad pinch arrives as a wheel event with ctrl held, in finer steps.
    const step = e.ctrlKey ? 0.02 : 0.0016;
    this.zoomAt(Math.exp(-e.deltaY * step * (e.deltaMode === 1 ? 16 : 1)), e.offsetX, e.offsetY);
  }

  /** Arrow keys walk the graph, plus and minus zoom, 0 fits, Escape clears the selection. */
  private key(e: KeyboardEvent): void {
    if (this.on.key?.(e)) return;
    const dir: Record<string, [number, number]> = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] };
    if (dir[e.key]) {
      e.preventDefault();
      const [ux, uy] = dir[e.key];
      const from = this.selected ? this.byId.get(this.selected) : null;
      const ox = from ? from.x : this.cam.x;
      const oy = from ? from.y : this.cam.y;
      let best: GNode | null = null;
      let bestScore = Infinity;
      for (const n of this.nodes) {
        if (n === from || !this.shown(n.id)) continue;
        const dx = n.x - ox;
        const dy = n.y - oy;
        const along = dx * ux + dy * uy;
        // With nothing selected, the first press takes the node nearest the centre.
        if (from && along <= 1) continue;
        const across = Math.abs(dx * uy - dy * ux);
        const score = from ? along + across * 2.2 : dx * dx + dy * dy;
        if (score < bestScore) {
          best = n;
          bestScore = score;
        }
      }
      if (best) {
        this.on.select(best.id);
        // Keep the walked-to node in view.
        const px = this.sx(best.x);
        const py = this.sy(best.y);
        if (px < 40 || py < 40 || px > this.w - 40 || py > this.h - 40) this.centreOn(best.id);
      }
      return;
    }
    if (e.key === "+" || e.key === "=") this.zoomAt(1.3);
    else if (e.key === "-" || e.key === "_") this.zoomAt(1 / 1.3);
    else if (e.key === "0") this.fit();
    else if (e.key === "Escape" && this.selected) this.on.select(null);
    else if (e.key === "Home") this.fit();
    else return;
    e.preventDefault();
  }

  // ---------- drawing ----------

  redraw(): void {
    if (this.frame || !this.w) return;
    const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number;
    this.frame = raf(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private draw(): void {
    const { ctx, w, h, colors } = this;
    if (!ctx) return;
    const k = this.cam.k;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const sel = this.selected;
    const focus = sel ? new Set<string>([sel, ...this.anc, ...this.desc, ...this.near]) : null;
    const on = (x: number, y: number, pad = 30) => x > -pad && y > -pad && x < w + pad && y < h + pad;

    // ----- edges: thin and quiet, so the nodes read first -----
    ctx.lineCap = "round";
    const many = this.edges.length > 1500;
    for (const pass of [0, 1]) {
      for (const e of this.edges) {
        if (e.status === "rejected" || !this.shown(e.from) || !this.shown(e.to)) continue;
        const a = this.byId.get(e.from)!;
        const b = this.byId.get(e.to)!;
        const lit = !!sel && ((e.from === sel || this.anc.has(e.from)) && (e.to === sel || this.anc.has(e.to)) ? "pre" : (e.to === sel || this.desc.has(e.to)) && (e.from === sel || this.desc.has(e.from)) ? "dep" : e.from === sel || e.to === sel ? "near" : "");
        // Unlit edges are drawn first, lit ones on top.
        if ((pass === 1) !== !!lit) continue;
        const ax = this.sx(a.x), ay = this.sy(a.y), bx = this.sx(b.x), by = this.sy(b.y);
        if (!on(ax, ay, 0) && !on(bx, by, 0) && !(Math.min(ax, bx) < w && Math.max(ax, bx) > 0 && Math.min(ay, by) < h && Math.max(ay, by) > 0)) continue;
        const ordering = e.type === "requires";
        ctx.globalAlpha = lit ? (lit === "near" ? 0.75 : 0.9) : sel ? 0.07 : (ordering ? 0.3 : 0.22) * (e.status === "inferred" ? 0.8 : 1);
        ctx.strokeStyle = lit === "pre" ? colors.pre : lit === "dep" ? colors.dep : lit === "near" ? colors.text : colors.edge;
        ctx.lineWidth = (lit ? 1.7 : e.status === "reviewed" ? 1.1 : 0.8) * Math.max(0.7, Math.min(1.5, Math.sqrt(k)));
        ctx.setLineDash(ordering || (many && !lit) ? [] : DASH[e.type]);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        // A slight bow keeps parallel edges apart and gives the map its woven look.
        const mx = (ax + bx) / 2 + (by - ay) * 0.12;
        const my = (ay + by) / 2 - (bx - ax) * 0.12;
        ctx.quadraticCurveTo(mx, my, bx, by);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // ----- nodes -----
    const labels: { n: GNode; px: number; py: number; r: number; rank: number }[] = [];
    for (const n of this.nodes) {
      if (!this.shown(n.id)) continue;
      const px = this.sx(n.x);
      const py = this.sy(n.y);
      if (!on(px, py)) continue;
      const r = this.radius(n);
      const dim = !!focus && !focus.has(n.id);
      const isSel = n.id === sel;
      ctx.globalAlpha = dim ? 0.16 : 1;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      // A ring of the surface colour keeps overlapping dots distinct.
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = colors.surface;
      ctx.stroke();
      if (n.hollow) {
        ctx.fillStyle = colors.surface;
        ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = colors.faint;
        ctx.stroke();
      } else {
        ctx.fillStyle = n.color;
        ctx.fill();
        if (n.weak) {
          ctx.beginPath();
          ctx.arc(px, py, r + 2.4, 0, Math.PI * 2);
          ctx.setLineDash([2, 2.5]);
          ctx.lineWidth = 1;
          ctx.strokeStyle = colors.muted;
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      if (isSel || n.id === this.hover || this.matches.has(n.id)) {
        ctx.beginPath();
        ctx.arc(px, py, r + (isSel ? 4.5 : 3.5), 0, Math.PI * 2);
        ctx.lineWidth = isSel ? 2 : 1.5;
        ctx.strokeStyle = isSel ? colors.text : this.matches.has(n.id) ? colors.accent : colors.muted;
        ctx.stroke();
      }
      // Labels appear progressively: always for what is selected, hovered, found or adjacent;
      // for well-connected concepts at medium zoom; for everything when zoomed in, or when the
      // map is small enough that every name fits.
      const rank = isSel ? 0 : n.id === this.hover ? 1 : this.matches.has(n.id) ? 2 : sel && this.near.has(n.id) ? 3 : sel && (this.anc.has(n.id) || this.desc.has(n.id)) ? 4 : k >= 1.5 || this.nodes.length <= SMALL_MAP ? 6 : k >= 0.85 && n.degree >= 3 ? 5 : -1;
      if (rank >= 0 && !(dim && rank > 4)) labels.push({ n, px, py, r, rank });
    }
    ctx.globalAlpha = 1;

    // ----- topic names, when zoomed out far enough for clusters to read as shapes -----
    ctx.textBaseline = "middle";
    const placed: [number, number, number, number][] = [];
    const fits = (x: number, y: number, tw: number, th: number) => {
      for (const [bx, by, bw, bh] of placed) if (x < bx + bw && x + tw > bx && y < by + bh && y + th > by) return false;
      placed.push([x, y, tw, th]);
      return true;
    };
    if (k < 1.15 && this.groups.length > 1) {
      ctx.font = `600 12px ${colors.font}`;
      ctx.textAlign = "center";
      for (const g of this.groups) {
        const px = this.sx(g.x);
        const py = this.sy(g.y);
        if (!on(px, py, 80)) continue;
        const text = g.title.length > 34 ? g.title.slice(0, 33) + "…" : g.title;
        const tw = ctx.measureText(text).width + 12;
        if (!fits(px - tw / 2, py - 10, tw, 20)) continue;
        ctx.globalAlpha = sel ? 0.45 : 0.9;
        ctx.lineWidth = 4;
        ctx.strokeStyle = colors.surface;
        ctx.strokeText(text, px, py);
        ctx.fillStyle = colors.muted;
        ctx.fillText(text, px, py);
      }
      ctx.globalAlpha = 1;
    }

    // ----- concept labels, most important first, skipping any that would overlap -----
    ctx.font = `11px ${colors.font}`;
    ctx.textAlign = "left";
    labels.sort((a, b) => a.rank - b.rank || b.n.degree - a.n.degree);
    let drawn = 0;
    for (const l of labels) {
      if (drawn > 260) break;
      const text = l.n.label.length > 38 ? l.n.label.slice(0, 37) + "…" : l.n.label;
      const tw = ctx.measureText(text).width;
      const x = l.px + l.r + 5;
      const y = l.py;
      if (!fits(x - 2, y - 8, tw + 4, 16) && l.rank > 1) continue;
      drawn++;
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = colors.surface;
      ctx.strokeText(text, x, y);
      ctx.fillStyle = l.rank <= 2 ? colors.text : colors.muted;
      ctx.fillText(text, x, y);
    }
  }
}
