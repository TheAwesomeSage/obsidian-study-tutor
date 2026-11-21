// The home screen: where a study sitting starts. It puts the unfinished session first, then one
// suggested next step, then the ways in. Topics and past sessions sit below, and everything
// else is one click further away.

import { Notice, setIcon } from "obsidian";
import { ago, recommend, workloadForecast, workloadLine } from "./overview";
import { ACTION_LABEL, Action } from "./policy";
import type { Screen, TutorView } from "./view";
import { button, chip, confirmAction, emptyState, iconButton, modeInfo, panel, progressBar, stampLabel } from "./ui";

const MINUTES = [10, 25, 45];

export class HomeScreen implements Screen {
  private el: HTMLElement | null = null;
  private filter = "";
  /** What is typed in the Ask anything box, not yet sent. */
  private asking = "";

  constructor(private view: TutorView) {}

  mount(el: HTMLElement): void {
    this.el = el;
    this.render();
  }

  unmount(): void {
    this.el = null;
  }

  refresh(): void {
    this.render();
  }

  /** A card under Suggested next for the first topic with a cold probe due. It appears once the statuses are read. */
  private async showProbeDue(now: HTMLElement): Promise<void> {
    const v = this.view;
    for (const t of v.overview) {
      let st;
      try {
        st = await v.plugin.engine.probeStatus(t.dir);
      } catch {
        continue;
      }
      if (this.el === null || !now.isConnected) return;
      if (!st.due) continue;
      const card = now.createEl("section", { cls: "st-card st-probe-due", attr: { "aria-label": `Cold probe due: ${t.title}` } });
      card.createEl("h2", { cls: "st-card-title", text: `${t.title}: Cold probe due · ${st.count} question${st.count === 1 ? "" : "s"} · ${st.why}` });
      button(card.createDiv({ cls: "st-actions" }), { label: "Start", icon: "arrow-right", onClick: () => void v.startProbe(t.dir) });
      return;
    }
  }

  /**
   * One box for a question or a goal, answered straight away with no topic, placement or setup.
   * The text typed is kept across redraws until it is sent.
   */
  private askBox(parent: HTMLElement): void {
    const v = this.view;
    const box = parent.createEl("section", { cls: "st-ask", attr: { "aria-label": "Ask anything" } });
    box.createEl("h3", { cls: "st-panel-title", text: "Ask anything" });
    const input = box.createEl("textarea", { cls: "st-input st-ask-input", attr: { rows: "2", placeholder: "Ask a question or describe what you want to learn", "aria-label": "Ask a question or describe what you want to learn" } });
    input.value = this.asking;
    const row = box.createDiv({ cls: "st-actions" });
    const submit = () => {
      const text = input.value.trim();
      if (!text) return input.focus();
      // The text stays in the box unless the question was really sent (not while another reply is being written).
      void v.startAsk(text).then((sent) => {
        if (sent) this.asking = "";
      });
    };
    button(row, { label: "Ask", icon: "send", tone: "primary", onClick: submit });
    input.oninput = () => (this.asking = input.value);
    input.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    };
  }

  /** Past free questions, newest first, read from the Ask folder once the page is drawn. Nothing shows until there is one. */
  private async recentQuestions(parent: HTMLElement): Promise<void> {
    const v = this.view;
    let asks: Awaited<ReturnType<typeof v.plugin.store.recentAsks>>;
    try {
      asks = await v.plugin.store.recentAsks(5);
    } catch {
      return;
    }
    if (this.el === null || !parent.isConnected || !asks.length) return;
    const box = parent.createEl("section", { cls: "st-recent-asks", attr: { "aria-label": "Recent questions" } });
    box.createEl("h3", { cls: "st-panel-title", text: "Recent questions" });
    const list = box.createDiv({ cls: "st-list", attr: { role: "list" } });
    for (const a of asks) {
      const row = list.createDiv({ cls: "st-row-item", attr: { role: "listitem" } });
      const main = row.createEl("button", { cls: "st-row-main", attr: { "aria-label": `Reopen the question: ${a.title}` } });
      const top = main.createDiv({ cls: "st-row-top" });
      setIcon(top.createSpan({ cls: "st-row-icon" }), "message-circle");
      top.createSpan({ cls: "st-row-title", text: a.title });
      top.createSpan({ cls: "st-meta st-row-when", text: stampLabel(a.stamp) });
      if (a.unanswered) chip(main, "No reply yet", "accent");
      main.onclick = () => void v.openAsk(a.path);
      iconButton(row, "trash-2", "Delete this question", async () => {
        const ok = await confirmAction(v.app, { title: "Delete this question?", text: `"${a.title}" is moved to the trash. Nothing else changes.`, confirm: "Delete" });
        if (!ok) return;
        try {
          await v.deleteChat(a.path);
          this.render();
        } catch (e) {
          new Notice(`Study Tutor: the question could not be deleted. ${(e as Error).message}`);
        }
      });
    }
  }

  private render(): void {
    const el = this.el;
    if (!el) return;
    const v = this.view;
    el.empty();
    const page = el.createDiv({ cls: "st-page st-home" });

    if (!v.topics.length) {
      const box = emptyState(page, { icon: "graduation-cap", title: "Start with a topic", text: "A topic is compiled once from your notes, a syllabus, or just a subject name. Study Tutor then teaches, quizzes and tracks what you can actually do, one concept at a time. Or just ask: a question or a goal gets an answer straight away." });
      button(box, { label: "New topic", icon: "plus", tone: "primary", onClick: () => v.plugin.openNewTopic() });
      this.askBox(box);
      void this.recentQuestions(box);
      return;
    }

    // ----- now: the session to resume, and the suggested next step -----
    const now = page.createDiv({ cls: "st-now" });
    const open = v.recent.find((c) => c.unfinished);
    if (open) {
      const card = now.createEl("section", { cls: "st-card st-resume", attr: { "aria-label": "Resume session" } });
      card.createDiv({ cls: "st-kicker", text: "Pick up where you left off" });
      const info = modeInfo(open.mode);
      card.createEl("h2", { cls: "st-card-title", text: open.topic });
      const meta = card.createDiv({ cls: "st-meta-row" });
      chip(meta, info.label, "accent", info.icon);
      const action = ACTION_LABEL[open.action as Action];
      if (action) chip(meta, action);
      meta.createSpan({ cls: "st-meta", text: stampLabel(open.stamp) });
      if (open.snippet) card.createDiv({ cls: "st-resume-where", text: open.snippet });
      const row = card.createDiv({ cls: "st-actions" });
      button(row, { label: "Resume session", icon: "play", tone: "primary", onClick: () => void v.startStudy({ dir: open.dir, chatPath: open.path }) });
    }

    const rec = recommend(v.overview, v.dir, v.plugin.opts.minutes);
    const card = now.createEl("section", { cls: "st-card st-next", attr: { "aria-label": "Suggested next step" } });
    card.createDiv({ cls: "st-kicker", text: "Suggested next" });
    if (rec) {
      card.createEl("h2", { cls: "st-card-title", text: `${rec.step.title} · ${rec.info.title}` });
      card.createDiv({ cls: "st-card-text", text: rec.why });
    } else {
      card.createEl("h2", { cls: "st-card-title", text: "You are at target" });
      card.createDiv({ cls: "st-card-text", text: "Every concept in every topic is at its target level, and your unaided answers back that up. Add a topic, or come back when reviews are due." });
    }
    const row = card.createDiv({ cls: "st-actions" });
    if (rec) button(row, { label: rec.step.title === "Review" ? "Start review" : `Start: ${rec.step.title}`, icon: "arrow-right", tone: open ? "secondary" : "primary", onClick: () => void v.follow(rec.step, rec.info.dir) });
    else button(row, { label: "New topic", icon: "plus", onClick: () => v.plugin.openNewTopic() });
    // Time available shapes the suggestion: with little time, quick practice comes before a new lesson.
    const time = row.createDiv({ cls: "st-seg st-time", attr: { role: "group", "aria-label": "Time you have now" } });
    time.createSpan({ cls: "st-seg-label", text: "Time" });
    for (const m of MINUTES) {
      const b = time.createEl("button", { cls: "st-seg-btn" + (v.plugin.opts.minutes === m ? " is-active" : ""), text: `${m} min`, attr: { "aria-pressed": String(v.plugin.opts.minutes === m) } });
      b.onclick = async () => {
        v.plugin.opts.minutes = m;
        await v.plugin.save();
        this.render();
      };
    }

    void this.showProbeDue(now);

    // ----- a question or a goal, answered straight away with no topic needed -----
    const asked = page.createDiv({ cls: "st-ask-wrap" });
    this.askBox(asked);
    void this.recentQuestions(asked);

    // ----- ways in -----
    const ways = page.createEl("section", { cls: "st-ways", attr: { "aria-label": "Study modes" } });
    const head = ways.createDiv({ cls: "st-ways-head" });
    head.createEl("h3", { cls: "st-panel-title", text: "Study" });
    if (v.topic) head.createSpan({ cls: "st-meta st-ellipsis", text: v.topic.title });
    const grid = ways.createDiv({ cls: "st-tiles" });
    const due = v.info?.due ?? 0;
    const tile = (icon: string, label: string, text: string, onClick: () => void, badge = "") => {
      const b = grid.createEl("button", { cls: "st-tile" });
      setIcon(b.createSpan({ cls: "st-tile-icon" }), icon);
      const t = b.createSpan({ cls: "st-tile-text" });
      const name = t.createSpan({ cls: "st-tile-label", text: label });
      if (badge) name.createSpan({ cls: "st-badge", text: badge });
      t.createSpan({ cls: "st-tile-sub", text });
      b.disabled = !v.dir;
      b.onclick = onClick;
    };
    tile("compass", "Adaptive study", "The guide picks each step", () => void v.startStudy({ mode: "auto" }));
    tile("book-open", "Learn", "Lessons with worked examples", () => void v.startStudy({ mode: "teach" }));
    tile("zap", "Practise", "Quiz from the question bank", () => void v.startStudy({ mode: "quiz" }));
    tile("layers", "Review", due ? "Flashcards are due" : "Flashcards, no tokens", () => v.go("review"), due ? String(due) : "");
    tile("message-circle", "Ask about this topic", "Direct answers from this topic's notes", () => void v.startStudy({ mode: "expert" }));
    tile("git-fork", "Knowledge graph", "Concepts and how they connect", () => v.go("graph"));
    const work = workloadForecast(v.overview.map((t) => t.state), v.today, { countCards: !v.plugin.usesSr() });
    ways.createDiv({ cls: "st-meta st-forecast", text: workloadLine(work), attr: { title: work.days.map((d) => `${d.day}: ${d.cards + d.checks} (${d.minutes} min)`).join("\n") } });

    // ----- topics and recent sessions -----
    const cols = page.createDiv({ cls: "st-cols" });
    const topics = panel(cols, "Topics", "st-topics");
    const search = topics.tools.createEl("input", { type: "search", cls: "st-search", attr: { placeholder: "Search topics", "aria-label": "Search topics" } });
    search.value = this.filter;
    button(topics.tools, { label: "New topic", icon: "plus", onClick: () => v.plugin.openNewTopic() });
    const list = topics.body.createDiv({ cls: "st-list", attr: { role: "list" } });
    const draw = () => {
      list.empty();
      const q = this.filter.trim().toLowerCase();
      const shown = v.overview.filter((t) => !q || t.title.toLowerCase().includes(q) || Object.values(t.state.names).some((n) => n.toLowerCase().includes(q)));
      if (!shown.length) {
        list.createDiv({ cls: "st-meta st-list-empty", text: q ? `No topic or concept matches "${this.filter.trim()}".` : "No topics could be read." });
        return;
      }
      for (const t of shown) {
        const row = list.createDiv({ cls: "st-row-item" + (t.dir === v.dir ? " is-current" : ""), attr: { role: "listitem" } });
        const main = row.createEl("button", { cls: "st-row-main", attr: { "aria-label": `Open ${t.title}` } });
        const top = main.createDiv({ cls: "st-row-top" });
        top.createSpan({ cls: "st-row-title", text: t.title });
        top.createSpan({ cls: "st-row-pct", text: `${t.progress}%` });
        progressBar(main, t.progress, `${t.progress}% of the way to target level ${t.state.target}`);
        const bits = [`${t.concepts} concept${t.concepts === 1 ? "" : "s"}`, `${t.secured} secured`];
        if (t.due) bits.push(`${t.due} due`);
        bits.push(`practised ${ago(t.last, v.today)}`);
        const meta = main.createDiv({ cls: "st-meta" });
        meta.setText(bits.join(" · "));
        if (t.unbacked) main.createDiv({ cls: "st-meta st-warn-text", text: `${t.unbacked} level${t.unbacked === 1 ? " is" : "s are"} not yet backed by your answers` });
        main.onclick = async () => {
          await v.selectTopic(t.dir);
          v.go("topic");
        };
        button(row, { label: t.step.title === "At target" ? "Open" : t.step.title, tone: "ghost", title: t.step.detail, onClick: () => (t.step.action === "done" ? void v.selectTopic(t.dir).then(() => v.go("topic")) : void v.follow(t.step, t.dir)) });
      }
    };
    search.oninput = () => {
      this.filter = search.value;
      draw();
    };
    draw();

    const recent = panel(cols, "Recent sessions", "st-recent");
    const rl = recent.body.createDiv({ cls: "st-list", attr: { role: "list" } });
    if (!v.recent.length) rl.createDiv({ cls: "st-meta st-list-empty", text: "Sessions you start will be listed here, each with its full transcript." });
    for (const c of v.recent) {
      const info = modeInfo(c.mode);
      const row = rl.createDiv({ cls: "st-row-item", attr: { role: "listitem" } });
      const main = row.createEl("button", { cls: "st-row-main", attr: { "aria-label": `Reopen ${info.label} session on ${c.topic} from ${stampLabel(c.stamp)}` } });
      const top = main.createDiv({ cls: "st-row-top" });
      setIcon(top.createSpan({ cls: "st-row-icon" }), info.icon);
      top.createSpan({ cls: "st-row-title", text: `${info.label} · ${c.topic}` });
      top.createSpan({ cls: "st-meta st-row-when", text: `${stampLabel(c.stamp)}${c.part > 1 ? ` · part ${c.part}` : ""}` });
      if (c.snippet) main.createDiv({ cls: "st-meta st-clamp", text: c.snippet });
      if (c.unfinished) chip(main, "Unfinished", "accent");
      main.onclick = () => void v.startStudy({ dir: c.dir, chatPath: c.path });
      iconButton(row, "file-text", "Open the transcript as a note", () => void v.app.workspace.openLinkText(c.path, "", true));
      iconButton(row, "trash-2", `Delete this ${info.label} session on ${c.topic}`, async () => {
        const ok = await confirmAction(v.app, { title: "Delete this session?", text: `The ${info.label} session on ${c.topic} from ${stampLabel(c.stamp)}, its earlier parts and its session notes are moved to the trash. Your answers, levels and saved activities are kept.`, confirm: "Delete" });
        if (!ok) return;
        try {
          await v.deleteChat(c.path);
          this.render();
        } catch (e) {
          new Notice(`Study Tutor: the session could not be deleted. ${(e as Error).message}`);
        }
      });
    }
  }
}
