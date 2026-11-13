// The knowledge graph screen: every concept from every topic on one map, with search, filters,
// colour modes and a details panel.
//
// Two layers are kept apart. The course graph (concepts and typed relations) comes from each
// topic's graph.md and holds nothing about the learner. The learner layer (levels, attempts,
// estimates) comes from the state and evidence files and only decides how nodes are coloured
// and what the panel reports.

import { Notice } from "obsidian";
import { Course, CourseConcept, CourseEdge, RELATIONS, RELATION_TEXT, Relation, neighbourhood } from "./course";
import { MIN_CALIBRATION_N, MIN_ESTIMATE_N, PREDICTION_TARGET, gradingLabel, missingFor } from "./evidence";
import { mastery } from "./formats";
import { GEdge, GGroup, GNode, GraphCanvas, GraphColors } from "./graphcanvas";
import { layoutGraph } from "./graphlayout";
import { ago } from "./overview";
import { ACTION_LABEL, Decision } from "./policy";
import type { Screen, TutorView } from "./view";
import { button, chip, emptyState, iconButton, levelPips, pct } from "./ui";

type ColourMode = "topic" | "level" | "estimate" | "recency" | "calibration";
const MODES: [ColourMode, string][] = [
  ["topic", "Topic"],
  ["level", "Demonstrated level"],
  ["estimate", "Estimated success"],
  ["recency", "Last practised"],
  ["calibration", "Confidence against results"],
];
const REL_LABEL: Record<Relation, string> = { requires: "Requires", supports: "Supports", applies_to: "Applies to", contrasts_with: "Contrasts with", derived_from: "Derived from" };

export class GraphScreen implements Screen {
  private el: HTMLElement | null = null;
  private canvas: GraphCanvas | null = null;
  private course: Course | null = null;
  private mode: ColourMode = "topic";
  private topicFilter = "";
  private relations = new Set<Relation>(RELATIONS);
  private onlyNear = false;
  private query = "";
  private selected: string | null = null;
  private stage!: HTMLElement;
  private panel!: HTMLElement;
  private legend!: HTMLElement;
  private live!: HTMLElement;
  private results!: HTMLElement;
  private bar!: HTMLElement;
  private observer: ResizeObserver | null = null;
  private nodes: GNode[] = [];
  private advice = new Map<string, Decision>();
  private fitted = false;

  constructor(private view: TutorView) {}

  async mount(el: HTMLElement): Promise<void> {
    this.el = el;
    const v = this.view;
    const root = el.createDiv({ cls: "st-graph-screen" });
    if (!v.topics.length) {
      const box = emptyState(root, { icon: "git-fork", title: "The graph is empty", text: "Concepts appear here once a topic has been compiled. Each topic becomes a cluster, and prerequisites link them." });
      button(box, { label: "New topic", icon: "plus", tone: "primary", onClick: () => v.plugin.openNewTopic() });
      return;
    }
    this.bar = root.createDiv({ cls: "st-graph-bar" });
    const body = root.createDiv({ cls: "st-graph-body" });
    this.stage = body.createDiv({ cls: "st-graph-stage" });
    const canvasEl = this.stage.createEl("canvas", { cls: "st-graph-canvas", attr: { tabindex: "0", role: "application", "aria-label": "Knowledge graph. Arrow keys move between concepts, plus and minus zoom, zero fits the graph, Escape clears the selection. The search box lists every concept." } });
    this.legend = this.stage.createDiv({ cls: "st-graph-legend" });
    this.stage.createDiv({ cls: "st-graph-hint", text: "Drag to pan · scroll to zoom · click a concept" });
    this.live = this.stage.createDiv({ cls: "st-sr-only", attr: { "aria-live": "polite" } });
    this.panel = body.createEl("aside", { cls: "st-graph-panel", attr: { "aria-label": "Concept details" } });
    this.fitted = false;
    this.canvas = new GraphCanvas(canvasEl, {
      select: (id) => this.select(id),
      hover: () => {},
      key: (e) => {
        if (e.key === "/") {
          e.preventDefault();
          (this.bar.querySelector(".st-search") as HTMLInputElement | null)?.focus();
          return true;
        }
        if (e.key === "Enter" && this.selected) {
          this.onlyNear = !this.onlyNear;
          this.apply();
          this.renderBar();
          return true;
        }
        if (e.key === "Escape" && v.contentEl.hasClass("is-graph-expanded") && !this.selected) {
          this.expand(false);
          return true;
        }
        return false;
      },
    });
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => this.onResize());
      this.observer.observe(this.stage);
    }
    this.stage.createDiv({ cls: "st-loading st-graph-loading", text: "Laying out the graph…" });
    await this.load();
  }

  unmount(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.canvas = null;
    this.el = null;
    this.expand(false);
  }

  async refresh(): Promise<void> {
    if (this.el) await this.load();
  }

  onResize(): void {
    if (!this.canvas || !this.stage) return;
    this.canvas.resize(this.stage.clientWidth, this.stage.clientHeight);
    if (!this.fitted && this.stage.clientWidth > 2 && this.nodes.length) {
      this.fitted = true;
      this.canvas.fit();
      if (this.selected) this.canvas.centreOn(this.selected, Math.max(1.3, this.canvas.cam.k));
    }
  }

  // ---------- data ----------

  private async load(): Promise<void> {
    const v = this.view;
    try {
      this.course = await v.plugin.store.loadCourse();
    } catch (e) {
      new Notice(`Study Tutor: the graph could not be read. ${(e as Error).message}`);
      return;
    }
    if (!this.el) return;
    const concepts = [...this.course.concepts.values()];
    const saved = v.plugin.data.graphLayout;
    const known = concepts.filter((c) => saved[c.id]).length;
    // Positions already on the map are kept; only concepts that are new are placed.
    const pos = layoutGraph(
      concepts.map((c) => ({ id: c.id, group: c.topic })),
      this.course.edges.filter((e) => e.status !== "rejected").map((e) => ({ from: e.from, to: e.to, orders: e.type === "requires" })),
      known ? saved : {},
    );
    if (known !== concepts.length || Object.keys(saved).length !== concepts.length) {
      v.plugin.data.graphLayout = pos;
      void v.plugin.save();
    }
    const degree = new Map<string, number>();
    for (const e of this.course.edges) {
      if (e.status === "rejected") continue;
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }
    this.nodes = concepts.map((c) => ({ id: c.id, label: c.name, group: c.topic, x: pos[c.id][0], y: pos[c.id][1], degree: degree.get(c.id) ?? 0, color: "", hollow: false, weak: false }));
    if (v.graphFocus && this.course.concepts.has(v.graphFocus)) this.selected = v.graphFocus;
    v.graphFocus = null;
    if (this.selected && !this.course.concepts.has(this.selected)) this.selected = null;
    this.stage.querySelector(".st-graph-loading")?.remove();
    this.advice.clear();
    this.renderBar();
    this.apply();
    this.renderPanel();
    this.onResize();
  }

  private conceptState(c: CourseConcept) {
    const info = this.view.overview.find((t) => t.dir === c.topic);
    return info ? { info, m: mastery(info.state, c.n) } : null;
  }

  private cssColors(): { get: (name: string) => string; colors: GraphColors } {
    const style = window.getComputedStyle(this.view.contentEl);
    const get = (name: string) => style.getPropertyValue(name).trim();
    return { get, colors: { text: get("--st-g-text") || "#ddd", muted: get("--st-g-muted") || "#aaa", faint: get("--st-g-faint") || "#777", surface: get("--st-g-surface") || "#1e1e1e", edge: get("--st-g-edge") || "#888", accent: get("--st-g-accent") || "#8a5cf5", pre: get("--st-cat-1") || "#3987e5", dep: get("--st-cat-2") || "#d95926", font: get("--st-g-font") || "sans-serif" } };
  }

  /** Recolours and refilters the nodes for the current controls, and hands them to the canvas. */
  private apply(): void {
    const course = this.course;
    if (!course || !this.canvas) return;
    const v = this.view;
    const { get, colors } = this.cssColors();
    const topics = v.topics.map((t) => t.dir);
    const seq = (i: number) => get(`--st-seq-${Math.max(1, Math.min(6, i))}`) || colors.accent;
    for (const n of this.nodes) {
      const c = course.concepts.get(n.id)!;
      const st = this.conceptState(c);
      const e = st?.m.evidence;
      n.hollow = false;
      n.weak = false;
      if (this.mode === "topic") {
        const i = topics.indexOf(c.topic);
        // Eight validated hues in a fixed order. Topics past the eighth share a neutral, and are told apart by their labels.
        n.color = i >= 0 && i < 8 ? get(`--st-cat-${i + 1}`) : get("--st-cat-other");
      } else if (this.mode === "level") {
        if (!st || st.m.level === null) n.hollow = true;
        else {
          n.color = seq(st.m.level + 1);
          n.weak = !st.m.backed;
        }
      } else if (this.mode === "estimate") {
        // A probability is only shown with enough unaided answers behind it.
        if (!e || e.independent < MIN_ESTIMATE_N || e.estimate === null) n.hollow = true;
        else n.color = seq(2 + Math.min(4, Math.floor(e.estimate * 5)));
      } else if (this.mode === "recency") {
        if (!e?.last) n.hollow = true;
        else {
          const days = Math.max(0, Math.round((Date.parse(v.today) - Date.parse(e.last.slice(0, 10))) / 86400000));
          n.color = seq(days <= 2 ? 6 : days <= 7 ? 5 : days <= 14 ? 4 : days <= 30 ? 3 : 2);
        }
      } else {
        if (!e || e.rated < MIN_CALIBRATION_N || e.calibrationGap === null) n.hollow = true;
        else n.color = e.calibrationGap > 0.3 ? get("--st-div-pos-2") : e.calibrationGap > 0.12 ? get("--st-div-pos-1") : e.calibrationGap < -0.3 ? get("--st-div-neg-2") : e.calibrationGap < -0.12 ? get("--st-div-neg-1") : get("--st-div-mid");
      }
      if (!n.color) n.color = colors.accent;
    }
    const edges: GEdge[] = course.edges.filter((e) => this.relations.has(e.type)).map((e) => ({ from: e.from, to: e.to, type: e.type, status: e.status }));

    let visible: Set<string> | null = null;
    if (this.topicFilter) visible = new Set(this.nodes.filter((n) => n.group === this.topicFilter).map((n) => n.id));
    const hood = this.selected ? neighbourhood(course, this.selected) : null;
    if (this.onlyNear && this.selected && hood) {
      const near = new Set<string>([this.selected, ...hood.ancestors, ...hood.descendants]);
      for (const e of hood.related) {
        near.add(e.from);
        near.add(e.to);
      }
      visible = near;
    }
    const q = this.query.trim().toLowerCase();
    const groups: GGroup[] = v.topics.map((t) => {
      const mine = this.nodes.filter((n) => n.group === t.dir);
      return { id: t.dir, title: t.title, x: mine.reduce((a, n) => a + n.x, 0) / Math.max(1, mine.length), y: Math.min(...mine.map((n) => n.y), 0) - 34 };
    }).filter((g) => this.nodes.some((n) => n.group === g.id) && (!visible || this.nodes.some((n) => n.group === g.id && visible!.has(n.id))));

    this.canvas.selected = this.selected;
    this.canvas.visible = visible;
    this.canvas.matches = new Set(q ? this.nodes.filter((n) => n.label.toLowerCase().includes(q)).map((n) => n.id) : []);
    this.canvas.setColors(colors);
    this.canvas.setData(this.nodes, edges, groups);
    this.canvas.setHighlight(hood?.ancestors ?? [], hood?.descendants ?? []);
    this.renderLegend();
  }

  private select(id: string | null): void {
    this.selected = id;
    if (!id) this.onlyNear = false;
    this.apply();
    this.renderBar();
    this.renderPanel();
    const c = id ? this.course?.concepts.get(id) : null;
    this.live?.setText(c ? `Selected ${c.name}, in ${c.topicTitle}.` : "Selection cleared.");
  }

  private expand(on: boolean): void {
    this.view.contentEl.toggleClass("is-graph-expanded", on);
    window.setTimeout(() => this.onResize(), 30);
  }

  // ---------- controls ----------

  private renderBar(): void {
    const bar = this.bar;
    const v = this.view;
    const hadFocus = bar.contains(document.activeElement) && (document.activeElement as HTMLElement).classList.contains("st-search");
    bar.empty();
    const find = bar.createDiv({ cls: "st-graph-find" });
    const search = find.createEl("input", { type: "search", cls: "st-search", attr: { placeholder: "Find a concept  ( / )", "aria-label": "Find a concept", role: "combobox", "aria-expanded": "false", "aria-autocomplete": "list" } });
    search.value = this.query;
    this.results = find.createDiv({ cls: "st-graph-results", attr: { role: "listbox", "aria-label": "Matching concepts" } });
    const list = () => {
      this.results.empty();
      const q = this.query.trim().toLowerCase();
      const hits = q ? this.nodes.filter((n) => n.label.toLowerCase().includes(q)).slice(0, 8) : [];
      search.setAttribute("aria-expanded", String(hits.length > 0));
      this.results.toggleClass("is-open", hits.length > 0 || !!q);
      if (q && !hits.length) this.results.createDiv({ cls: "st-meta st-graph-result-none", text: "No concept matches." });
      for (const n of hits) {
        const b = this.results.createEl("button", { cls: "st-graph-result", attr: { role: "option" } });
        b.createSpan({ text: n.label });
        b.createSpan({ cls: "st-meta", text: this.course?.concepts.get(n.id)?.topicTitle ?? "" });
        b.onclick = () => {
          this.query = "";
          search.value = "";
          this.results.removeClass("is-open");
          this.select(n.id);
          this.canvas?.centreOn(n.id, Math.max(1.5, this.canvas.cam.k));
        };
      }
    };
    search.oninput = () => {
      this.query = search.value;
      this.apply();
      list();
    };
    search.onkeydown = (e) => {
      if (e.key === "Enter") (this.results.querySelector(".st-graph-result") as HTMLElement | null)?.click();
      else if (e.key === "ArrowDown") {
        e.preventDefault();
        (this.results.querySelector(".st-graph-result") as HTMLElement | null)?.focus();
      } else if (e.key === "Escape") {
        this.query = "";
        search.value = "";
        this.apply();
        list();
      }
    };
    this.results.onkeydown = (e) => {
      const cur = document.activeElement as HTMLElement | null;
      if (e.key === "ArrowDown") (cur?.nextElementSibling as HTMLElement | null)?.focus();
      else if (e.key === "ArrowUp") ((cur?.previousElementSibling as HTMLElement | null) ?? search).focus();
      else if (e.key === "Escape") search.focus();
      else return;
      e.preventDefault();
    };
    list();
    if (hadFocus) search.focus();

    const colour = bar.createEl("label", { cls: "st-field" });
    colour.createSpan({ cls: "st-field-label", text: "Colour" });
    const sel = colour.createEl("select", { cls: "dropdown", attr: { "aria-label": "Colour concepts by" } });
    const course = this.course;
    const all = course ? [...course.concepts.values()].map((c) => this.conceptState(c)?.m.evidence) : [];
    const enough: Record<ColourMode, boolean> = { topic: true, level: true, estimate: all.some((e) => e && e.independent >= MIN_ESTIMATE_N), recency: all.some((e) => e?.last), calibration: all.some((e) => e && e.rated >= MIN_CALIBRATION_N) };
    for (const [value, text] of MODES) {
      const o = sel.createEl("option", { value, text: enough[value] ? text : `${text} (needs more answers)` });
      o.disabled = !enough[value];
    }
    if (!enough[this.mode]) this.mode = "topic";
    sel.value = this.mode;
    sel.onchange = () => {
      this.mode = sel.value as ColourMode;
      this.apply();
    };

    if (v.topics.length > 1) {
      const topic = bar.createEl("label", { cls: "st-field" });
      topic.createSpan({ cls: "st-field-label", text: "Show" });
      const ts = topic.createEl("select", { cls: "dropdown", attr: { "aria-label": "Show topics" } });
      ts.createEl("option", { value: "", text: "All topics" });
      for (const t of v.topics) ts.createEl("option", { value: t.dir, text: t.title });
      ts.value = this.topicFilter;
      ts.onchange = () => {
        this.topicFilter = ts.value;
        this.apply();
        this.canvas?.fit();
      };
    }

    const rels = bar.createDiv({ cls: "st-graph-rels", attr: { role: "group", "aria-label": "Relations shown" } });
    for (const r of RELATIONS) {
      const b = rels.createEl("button", { cls: "st-toggle" + (this.relations.has(r) ? " is-on" : ""), attr: { "aria-pressed": String(this.relations.has(r)) } });
      b.createSpan({ cls: `st-line is-${r}` });
      b.createSpan({ text: REL_LABEL[r] });
      b.onclick = () => {
        if (this.relations.has(r)) this.relations.delete(r);
        else this.relations.add(r);
        this.apply();
        this.renderBar();
      };
    }

    const end = bar.createDiv({ cls: "st-graph-end" });
    const near = button(end, { label: "Neighbourhood", icon: "focus", tone: "ghost", title: "Show only the selected concept, what it rests on and what rests on it", cls: this.onlyNear ? "is-on" : "" });
    near.disabled = !this.selected;
    near.setAttribute("aria-pressed", String(this.onlyNear));
    near.onclick = () => {
      this.onlyNear = !this.onlyNear;
      this.apply();
      this.renderBar();
      this.canvas?.fit();
    };
    iconButton(end, "maximize", "Fit the graph to the view", () => this.canvas?.fit());
    iconButton(end, "zoom-in", "Zoom in", () => this.canvas?.zoomAt(1.3));
    iconButton(end, "zoom-out", "Zoom out", () => this.canvas?.zoomAt(1 / 1.3));
    iconButton(end, "shuffle", "Lay the graph out again from scratch", async () => {
      v.plugin.data.graphLayout = {};
      await this.load();
      this.canvas?.fit();
    });
    const expanded = v.contentEl.hasClass("is-graph-expanded");
    iconButton(end, expanded ? "minimize-2" : "maximize-2", expanded ? "Leave full view" : "Expand the graph to fill the pane", () => {
      this.expand(!expanded);
      this.renderBar();
    });
  }

  private renderLegend(): void {
    const l = this.legend;
    const v = this.view;
    l.empty();
    const sw = (cls: string, text: string, style = "") => {
      const row = l.createDiv({ cls: "st-legend-row" });
      row.createSpan({ cls: `st-swatch ${cls}`, attr: style ? { style } : {} });
      row.createSpan({ text });
    };
    const ramp = (from: string, to: string, steps: number[]) => {
      const row = l.createDiv({ cls: "st-legend-row" });
      row.createSpan({ cls: "st-meta", text: from });
      for (const i of steps) row.createSpan({ cls: "st-swatch", attr: { style: `background:var(--st-seq-${i})` } });
      row.createSpan({ cls: "st-meta", text: to });
    };
    if (this.mode === "topic") {
      const shown = v.topics.filter((t) => this.nodes.some((n) => n.group === t.dir));
      shown.slice(0, 8).forEach((t, i) => sw("", t.title.length > 30 ? t.title.slice(0, 29) + "…" : t.title, `background:var(--st-cat-${v.topics.indexOf(t) + 1 <= 8 ? v.topics.indexOf(t) + 1 : "other"})`));
      if (v.topics.length > 8) sw("", "Other topics", "background:var(--st-cat-other)");
    } else if (this.mode === "level") {
      ramp("Level 0", "5", [1, 2, 3, 4, 5, 6]);
      sw("is-hollow", "Not placed yet");
      sw("is-weak", "Level not yet backed by unaided answers");
    } else if (this.mode === "estimate") {
      ramp("Lower", "higher", [2, 3, 4, 5, 6]);
      l.createDiv({ cls: "st-meta st-legend-note", text: `Provisional estimate that ${PREDICTION_TARGET}.` });
      sw("is-hollow", `Fewer than ${MIN_ESTIMATE_N} unaided answers: no estimate`);
    } else if (this.mode === "recency") {
      ramp("Over a month", "this week", [2, 3, 4, 5, 6]);
      sw("is-hollow", "Never practised");
    } else {
      const row = l.createDiv({ cls: "st-legend-row" });
      row.createSpan({ cls: "st-meta", text: "Under" });
      for (const name of ["neg-2", "neg-1", "mid", "pos-1", "pos-2"]) row.createSpan({ cls: "st-swatch", attr: { style: `background:var(--st-div-${name})` } });
      row.createSpan({ cls: "st-meta", text: "overconfident" });
      sw("is-hollow", `Fewer than ${MIN_CALIBRATION_N} answers with a confidence`);
    }
    if (this.selected) {
      const row = l.createDiv({ cls: "st-legend-row" });
      row.createSpan({ cls: "st-line is-pre" });
      row.createSpan({ text: "rests on" });
      row.createSpan({ cls: "st-line is-dep" });
      row.createSpan({ text: "builds on it" });
    }
  }

  // ---------- details ----------

  private renderPanel(): void {
    const p = this.panel;
    const course = this.course;
    const v = this.view;
    p.empty();
    const c = this.selected && course ? course.concepts.get(this.selected) : null;
    p.toggleClass("is-empty", !c);
    if (!c || !course) {
      p.createDiv({ cls: "st-kicker", text: "Knowledge graph" });
      const total = course ? course.concepts.size : 0;
      p.createDiv({ cls: "st-card-text", text: `${total} concept${total === 1 ? "" : "s"} across ${v.topics.length} topic${v.topics.length === 1 ? "" : "s"}. Select a concept to see what it rests on, what builds on it, and the evidence behind its level.` });
      p.createDiv({ cls: "st-meta", text: "The map shows the course. Your progress only changes the colours." });
      return;
    }
    const st = this.conceptState(c);
    const name = (id: string) => course.concepts.get(id)?.name ?? id;
    const jump = (parent: HTMLElement, id: string) => {
      const other = course.concepts.get(id);
      const b = parent.createEl("button", { cls: "st-link st-ellipsis", text: other ? other.name : id });
      if (other && other.topic !== c.topic) b.createSpan({ cls: "st-meta", text: ` · ${other.topicTitle}` });
      b.onclick = () => {
        this.select(id);
        this.canvas?.centreOn(id);
      };
      return b;
    };

    const head = p.createDiv({ cls: "st-panel-head" });
    const title = head.createDiv({ cls: "st-grow" });
    title.createEl("h3", { cls: "st-graph-title", text: c.name });
    const topicBtn = title.createEl("button", { cls: "st-link st-meta", text: c.topicTitle, attr: { "aria-label": `Open the topic ${c.topicTitle}` } });
    topicBtn.onclick = async () => {
      await v.selectTopic(c.topic);
      v.go("topic");
    };
    iconButton(head, "x", "Close details", () => this.select(null));

    if (st) {
      const m = st.m;
      const e = m.evidence;
      const s = st.info.state;
      const lv = p.createDiv({ cls: "st-meta-row" });
      levelPips(lv, m.level, s.target, m.backed || m.level === null);
      lv.createSpan({ text: m.level === null ? "Not placed yet" : `Level ${m.level} of ${s.target} target` });
      if (s.focus === c.n) chip(lv, "Focus", "accent");
      if (e.lapse) chip(lv, "Slipped", "warn", "alert-triangle");
      if (m.level !== null && !m.backed) p.createDiv({ cls: "st-meta st-warn-text", text: `Recorded at level ${m.level}; your answers support level ${m.supported} so far.` });

      // The suggested activity, with its reason. Asked of the same policy the study screen uses.
      const next = p.createDiv({ cls: "st-graph-next" });
      next.createDiv({ cls: "st-kicker", text: "Suggested next" });
      const adviceEl = next.createDiv({ cls: "st-card-text", text: "…" });
      const show = (d: Decision) => {
        const on = d.focus !== null && d.focus !== c.n ? ` on ${s.names[d.focus] ?? "another concept"}` : "";
        adviceEl.setText(`${ACTION_LABEL[d.action]}${on}. ${d.reason}`);
      };
      const cached = this.advice.get(c.id);
      if (cached) show(cached);
      else
        void v.plugin.engine.advise(c.topic, c.n).then(
          (d) => {
            this.advice.set(c.id, d);
            if (this.selected === c.id) show(d);
          },
          () => adviceEl.setText("No suggestion is available for this concept."),
        );
      button(next, { label: "Study this", icon: "play", tone: "primary", onClick: () => void v.startStudy({ dir: c.topic, mode: "auto", focus: c.n }) });

      const ev = p.createEl("section", { cls: "st-graph-section" });
      ev.createEl("h4", { text: "Evidence" });
      if (!e.graded && !e.ungraded) ev.createDiv({ cls: "st-meta", text: "No answers have been marked on this concept yet." });
      else {
        const dl = ev.createEl("dl", { cls: "st-dl" });
        const row = (k: string, val: string) => {
          dl.createEl("dt", { text: k });
          dl.createEl("dd", { text: val });
        };
        row("Unaided", `${e.independentCorrect} of ${e.independent} correct`);
        row("Estimate", e.independent >= MIN_ESTIMATE_N && e.estimate !== null ? `${pct(e.estimate)}, provisional, from ${e.independent} unaided answers` : `not shown: ${e.independent} of ${MIN_ESTIMATE_N} unaided answers needed`);
        row("Assistance", [`${e.assistedCount} with help`, `${e.exposedCount} after seeing the answer`, `${e.selfCount} self-rated`].join(" · "));
        if (e.rated >= MIN_CALIBRATION_N && e.calibrationGap !== null && e.brier !== null) row("Confidence", `${Math.abs(Math.round(e.calibrationGap * 100))} points ${e.calibrationGap > 0.02 ? "above" : e.calibrationGap < -0.02 ? "below" : "from"} your results · Brier ${e.brier.toFixed(2)} over ${e.rated} answers (lower is better)`);
        else if (e.rated) row("Confidence", `${e.rated} of ${MIN_CALIBRATION_N} rated answers needed to compare`);
        const errs = Object.entries(e.errors).sort((a, b) => b[1] - a[1]);
        if (errs.length) row("Errors", errs.map(([t, k]) => `${k} ${t}`).join(" · "));
        if (e.ungraded || e.disputed) row("Not counted", [`${e.ungraded} unmarked`, `${e.disputed} disputed`].join(" · "));
        if (e.independent >= MIN_ESTIMATE_N) ev.createDiv({ cls: "st-meta", text: `The estimate is the chance that ${PREDICTION_TARGET}. Your own confidence is kept separate and never changes a level.` });
        if (m.level !== null && m.level < 5 && m.backed) {
          const need = missingFor(e, m.level + 1, c.n in s.taught);
          if (need) ev.createDiv({ cls: "st-meta", text: `For level ${m.level + 1}: ${need}.` });
        }
      }

      const attempts = s.attempts.filter((a) => a.skill === c.n).slice(-5).reverse();
      if (attempts.length) {
        const sec = p.createEl("section", { cls: "st-graph-section" });
        sec.createEl("h4", { text: "Latest answers" });
        for (const a of attempts) {
          const row = sec.createDiv({ cls: "st-attempt" });
          const tone = a.verification === "disputed" || a.result === "ungraded" ? "" : a.result === "correct" ? "good" : a.result === "partial" ? "warn" : "bad";
          chip(row, a.verification === "disputed" ? "disputed" : a.result, tone);
          const t = row.createDiv({ cls: "st-grow" });
          t.createDiv({ cls: "st-clamp", text: a.question.replace(/\s+/g, " ").slice(0, 120) });
          const bits = [ago(a.timestamp, v.today), a.activity.replace(/-/g, " "), gradingLabel(a)];
          if (a.assisted) bits.push("with help");
          if (a.confidence !== null) bits.push(`confidence ${Math.round(a.confidence * 100)}%`);
          if (a.errorType) bits.push(`${a.errorType} error`);
          t.createDiv({ cls: "st-meta", text: bits.join(" · ") });
          if (a.note) t.createDiv({ cls: "st-meta st-clamp", text: a.note });
        }
      }
      const changes = s.changes.filter((x) => x.skill === c.n).slice(-3).reverse();
      if (changes.length) {
        const sec = p.createEl("section", { cls: "st-graph-section" });
        sec.createEl("h4", { text: "Level changes" });
        for (const x of changes) sec.createDiv({ cls: "st-meta", text: `${x.from ?? "unset"} → ${x.to ?? "unset"}, ${ago(x.t, v.today)}: ${x.note}.` });
      }
    }

    // ----- relations: the course layer -----
    const hood = neighbourhood(course, c.id);
    const rejected = course.edges.filter((e) => e.status === "rejected" && (e.from === c.id || e.to === c.id));
    const relSection = (title: string, edges: CourseEdge[], other: (e: CourseEdge) => string, describe: (e: CourseEdge) => string) => {
      if (!edges.length) return;
      const sec = p.createEl("section", { cls: "st-graph-section" });
      sec.createEl("h4", { text: title });
      for (const e of edges) {
        const row = sec.createDiv({ cls: "st-rel" });
        const t = row.createDiv({ cls: "st-grow" });
        const top = t.createDiv({ cls: "st-rel-top" });
        const text = describe(e);
        if (text) top.createSpan({ cls: "st-meta", text });
        jump(top, other(e));
        const os = course.concepts.get(other(e));
        const ost = os ? this.conceptState(os) : null;
        t.createDiv({ cls: "st-meta", text: [ost ? (ost.m.level === null ? "not placed" : `level ${ost.m.level}`) : "", e.status === "reviewed" ? "reviewed by you" : e.status === "rejected" ? "rejected by you" : "inferred, not yet reviewed", `from ${e.source}`].filter(Boolean).join(" · ") });
        const act = async (status: "reviewed" | "rejected" | "inferred") => {
          try {
            await v.plugin.store.setRelationStatus(e, status);
            await v.stateChanged();
            await this.load();
          } catch (err) {
            new Notice((err as Error).message);
          }
        };
        if (e.status !== "reviewed") iconButton(row, "check", `Confirm that ${name(e.from)} ${RELATION_TEXT[e.type].out} ${name(e.to)}`, () => void act("reviewed"));
        if (e.status !== "rejected") iconButton(row, "x", `Reject this relation. It will no longer order study.`, () => void act("rejected"));
      }
    };
    relSection("Rests on", hood.prerequisites, (e) => e.to, () => "");
    relSection("Builds on it", hood.dependents, (e) => e.from, () => "");
    relSection("Other relations", hood.related.filter((e) => e.status !== "rejected"), (e) => (e.from === c.id ? e.to : e.from), (e) => `${e.from === c.id ? RELATION_TEXT[e.type].out : RELATION_TEXT[e.type].back} `);
    relSection("Rejected", rejected, (e) => (e.from === c.id ? e.to : e.from), (e) => `${e.from === c.id ? RELATION_TEXT[e.type].out : RELATION_TEXT[e.type].back} `);
    if (hood.ancestors.size > hood.prerequisites.length) p.createDiv({ cls: "st-meta", text: `${hood.ancestors.size} concepts in all lie beneath this one, through its prerequisites.` });

    // ----- add a relation, and the study priority: secondary, so tucked away -----
    const more = p.createEl("details", { cls: "st-graph-more" });
    more.createEl("summary", { text: "Add a relation or set priority" });
    const form = more.createDiv({ cls: "st-form" });
    const type = form.createEl("select", { cls: "dropdown", attr: { "aria-label": "Kind of relation" } });
    for (const r of RELATIONS) type.createEl("option", { value: r, text: `This ${RELATION_TEXT[r].out}…` });
    const target = form.createEl("select", { cls: "dropdown", attr: { "aria-label": "The other concept" } });
    target.createEl("option", { value: "", text: "Choose a concept" });
    for (const t of v.topics) {
      const group = target.createEl("optgroup", { attr: { label: t.title } });
      for (const o of course.concepts.values()) if (o.topic === t.dir && o.id !== c.id) group.createEl("option", { value: o.id, text: o.name });
    }
    button(form, {
      label: "Add relation",
      icon: "plus",
      onClick: async () => {
        if (!target.value) return;
        try {
          await v.plugin.store.addRelation({ from: c.id, to: target.value, type: type.value as Relation });
          await v.stateChanged();
          await this.load();
        } catch (err) {
          new Notice((err as Error).message);
        }
      },
    });
    more.createDiv({ cls: "st-meta", text: "Only \"requires\" orders study, and a loop of prerequisites is refused." });
    if (st) {
      const s = st.info.state;
      const row = more.createEl("label", { cls: "st-field" });
      row.createSpan({ cls: "st-field-label", text: "Study priority (0.1 to 5)" });
      const pr = row.createEl("input", { type: "number", cls: "st-number", attr: { min: "0.1", max: "5", step: "0.1" } });
      pr.value = String(s.priorities[c.n] ?? 1);
      pr.onchange = async () => {
        const value = Number(pr.value);
        if (!Number.isFinite(value) || value < 0.1 || value > 5) {
          pr.value = String(s.priorities[c.n] ?? 1);
          return;
        }
        // Re-read before writing, so a priority change cannot overwrite an answer marked meanwhile.
        const fresh = await v.plugin.store.loadState(c.topic, v.plugin.opts.targetLevel);
        fresh.priorities = { ...fresh.priorities, [c.n]: value };
        await v.plugin.store.saveState(c.topic, fresh);
        this.advice.delete(c.id);
        await v.stateChanged(c.topic === v.dir ? fresh : undefined);
        this.renderPanel();
      };
      more.createDiv({ cls: "st-meta", text: "Priority shifts what is suggested next. It never changes a level." });
    }
    if (c.sources.length) {
      const sec = p.createEl("section", { cls: "st-graph-section" });
      sec.createEl("h4", { text: "Sources" });
      v.md(sec.createDiv({ cls: "st-text st-meta" }), c.sources.join(" · "));
    }
  }
}

