import { Component, ItemView, MarkdownRenderer, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { Usage, addUsage, usageLine, zeroUsage } from "./claude";
import { Material } from "./engine";
import { Chat, Grade, LearnerState, Mode, Question, Topic, answerText, dueCount, fmStr, mcqLetter, progress, reviewQueue, sameShortAnswer, schedule, splitFrontmatter, ymd } from "./formats";
import type StudyTutorPlugin from "./main";
import { TopicRef } from "./store";

export const VIEW_TYPE = "study-tutor-view";

type Tab = "chat" | "review" | "map";
const MODE_LABEL: Record<Mode, string> = { tutor: "Tutor", quiz: "Quizzer", expert: "Expert" };
const MODE_HINT: Record<Mode, string> = {
  tutor: "The tutor teaches by asking one question at a time and only moves you up a level when you have shown it.",
  quiz: "Rapid, strict questions aimed at your weakest subskills.",
  expert: "Ask anything about this topic and get a direct explanation grounded in your notes.",
};

export class TutorView extends ItemView {
  private topics: TopicRef[] = [];
  private dir: string | null = null;
  private topic: Topic | null = null;
  private state: LearnerState | null = null;
  private chatPath: string | null = null;
  private chat: Chat | null = null;
  private mode: Mode = "tutor";
  private tab: Tab = "chat";
  private busy = false;
  private kill: (() => void) | null = null;
  private attach = false;
  private draft = "";
  private lastUsage: Usage | null = null;
  private sessionUsage = zeroUsage();
  private lastError = "";
  private lastChanges: string[] = [];
  private bodyEl!: HTMLElement;
  private headEl!: HTMLElement;
  /** Owns everything the markdown renderer creates for the current render, so it can be released. */
  private rendered: Component | null = null;
  // review session
  private queue: Question[] = [];
  private requeued = new Set<string>();
  private reviewed = 0;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: StudyTutorPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Study Tutor";
  }
  getIcon(): string {
    return "graduation-cap";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("study-tutor");
    this.headEl = this.contentEl.createDiv({ cls: "st-head" });
    this.bodyEl = this.contentEl.createDiv({ cls: "st-body" });
    // Rendered [[links]] do nothing in a custom view unless the view opens them itself.
    this.registerDomEvent(this.contentEl, "click", (e: MouseEvent) => {
      const link = (e.target as HTMLElement | null)?.closest?.("a.internal-link") as HTMLElement | null;
      const href = link?.getAttribute("data-href") ?? link?.getAttribute("href");
      if (!link || !href) return;
      e.preventDefault();
      void this.app.workspace.openLinkText(href, this.chatPath ?? "", e.ctrlKey || e.metaKey);
    });
    await this.reload();
  }

  async onClose(): Promise<void> {
    this.kill?.();
  }

  private get today(): string {
    return ymd();
  }

  /** Re-reads the topic list and the active topic from the vault. */
  async reload(): Promise<void> {
    try {
      this.topics = await this.plugin.store.listTopics();
    } catch {
      this.topics = [];
    }
    const wanted = this.plugin.data.activeTopic;
    const dir = this.topics.find((t) => t.dir === wanted)?.dir ?? this.topics[0]?.dir ?? null;
    await this.selectTopic(dir);
  }

  async showTab(tab: Tab): Promise<void> {
    this.tab = tab;
    if (tab === "review") await this.startReview();
    else if (this.dir) await this.loadState();
    this.render();
  }

  private async loadState(): Promise<void> {
    if (this.dir) this.state = await this.plugin.store.loadState(this.dir, this.plugin.opts.targetLevel);
  }

  private async selectTopic(dir: string | null): Promise<void> {
    this.dir = dir;
    this.topic = null;
    this.state = null;
    this.chat = null;
    this.chatPath = null;
    this.lastError = "";
    this.lastChanges = [];
    if (dir) {
      try {
        this.topic = await this.plugin.store.loadTopic(dir);
        await this.loadState();
        const chats = await this.plugin.store.listChats(dir);
        const remembered = this.plugin.data.activeChat[dir];
        const path = remembered && chats.includes(remembered) ? remembered : chats[chats.length - 1];
        if (path) await this.openChat(path);
        if (this.plugin.data.activeTopic !== dir) {
          this.plugin.data.activeTopic = dir;
          await this.plugin.save();
        }
      } catch (e) {
        new Notice(`Study Tutor: could not open the topic. ${(e as Error).message}`);
        this.dir = null;
      }
    }
    if (this.tab === "review") await this.startReview();
    this.render();
  }

  private async openChat(path: string): Promise<void> {
    this.chat = await this.plugin.store.loadChat(path);
    this.chatPath = path;
    const m = fmStr(this.chat.fm, "mode", "tutor");
    this.mode = m === "quiz" || m === "expert" ? m : "tutor";
    if (this.dir && this.plugin.data.activeChat[this.dir] !== path) {
      this.plugin.data.activeChat[this.dir] = path;
      await this.plugin.save();
    }
  }

  // ---------- rendering ----------

  private render(): void {
    // Release what the last render's markdown created before building the next one.
    if (this.rendered) this.removeChild(this.rendered);
    this.rendered = this.addChild(new Component());
    this.renderHead();
    this.bodyEl.empty();
    if (!this.dir || !this.topic) {
      const empty = this.bodyEl.createDiv({ cls: "st-empty" });
      empty.createEl("p", { text: "No topics yet. A topic is compiled once from your notes, a spec, or just a subject name. After that, each chat turn loads only the compiled card." });
      empty.createEl("button", { text: "New topic", cls: "mod-cta" }).onclick = () => this.plugin.openNewTopic();
      return;
    }
    if (this.tab === "chat") this.renderChat();
    else if (this.tab === "review") this.renderReview();
    else this.renderMap();
  }

  private renderHead(): void {
    const h = this.headEl;
    h.empty();
    const row = h.createDiv({ cls: "st-row" });
    const sel = row.createEl("select", { cls: "dropdown st-grow" });
    if (!this.topics.length) sel.createEl("option", { text: "No topics", value: "" });
    for (const t of this.topics) sel.createEl("option", { text: t.title, value: t.dir });
    if (this.dir) sel.value = this.dir;
    sel.disabled = this.busy;
    sel.onchange = () => void this.selectTopic(sel.value || null);
    row.createEl("button", { text: "New topic" }).onclick = () => this.plugin.openNewTopic();

    if (!this.dir || !this.state) return;
    const tabs = h.createDiv({ cls: "st-tabs" });
    const due = dueCount(this.state, this.today);
    const labels: [Tab, string][] = [
      ["chat", "Chat"],
      ["review", due ? `Review (${due} due)` : "Review"],
      ["map", `Skill map ${progress(this.state)}%`],
    ];
    for (const [tab, label] of labels) {
      const b = tabs.createEl("button", { text: label, cls: "st-tab" + (this.tab === tab ? " is-active" : "") });
      b.onclick = () => void this.showTab(tab);
    }
  }

  private md(el: HTMLElement, text: string): void {
    void MarkdownRenderer.render(this.app, text, el, this.chatPath ?? this.dir ?? "", this.rendered ?? this);
  }

  // ---------- chat ----------

  private renderChat(): void {
    const body = this.bodyEl;
    const bar = body.createDiv({ cls: "st-row" });
    const modeSel = bar.createEl("select", { cls: "dropdown" });
    for (const m of ["tutor", "quiz", "expert"] as Mode[]) modeSel.createEl("option", { text: MODE_LABEL[m], value: m });
    modeSel.value = this.mode;
    modeSel.disabled = this.busy;
    modeSel.onchange = () => void this.setMode(modeSel.value as Mode);
    const newBtn = bar.createEl("button", { text: "New chat" });
    newBtn.disabled = this.busy;
    newBtn.onclick = () => void this.newChat();
    if (this.chatPath) {
      const open = bar.createEl("button", { text: "Open file", attr: { "aria-label": "Open this chat as a note" } });
      open.onclick = () => void this.app.workspace.openLinkText(this.chatPath!, "", true);
    }

    const list = body.createDiv({ cls: "st-messages" });
    const chat = this.chat;
    if (chat && chat.summary) {
      const s = list.createEl("details", { cls: "st-summary" });
      s.createEl("summary", { text: `Summary of earlier parts (part ${fmStr(chat.fm, "part", "1")})` });
      this.md(s.createDiv(), chat.summary);
    }
    if (!chat || !chat.messages.length) {
      const hint = list.createDiv({ cls: "st-empty" });
      hint.createEl("p", { text: MODE_HINT[this.mode] });
      if (this.mode !== "expert" && !this.busy) hint.createEl("button", { text: this.mode === "tutor" ? "Start" : "Start quiz", cls: "mod-cta" }).onclick = () => void this.send("");
    }
    for (const m of chat?.messages ?? []) {
      const el = list.createDiv({ cls: `st-msg st-${m.role}` });
      el.createDiv({ cls: "st-who", text: m.role === "you" ? "You" : MODE_LABEL[this.mode] });
      this.md(el.createDiv({ cls: "st-text" }), m.text);
    }
    if (this.lastChanges.length) list.createDiv({ cls: "st-note", text: "Skill map updated: " + this.lastChanges.join("; ") });
    if (this.busy) list.createDiv({ cls: "st-note st-thinking", text: "Thinking…" });
    if (this.lastError) {
      const err = list.createDiv({ cls: "st-error" });
      err.createSpan({ text: this.lastError + " " });
      if (!this.busy) err.createEl("button", { text: "Retry" }).onclick = () => void this.send("");
    }
    window.setTimeout(() => (list.scrollTop = list.scrollHeight), 30);

    const composer = body.createDiv({ cls: "st-composer" });
    const input = composer.createEl("textarea", { attr: { rows: "3", placeholder: this.mode === "expert" ? "Ask a question…" : "Your answer…  (Enter to send, Shift+Enter for a new line)" } });
    input.value = this.draft;
    input.oninput = () => (this.draft = input.value);
    input.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!this.busy && input.value.trim()) void this.send(input.value);
      }
    };
    const row = composer.createDiv({ cls: "st-row" });
    const label = row.createEl("label", { cls: "st-grow st-attach" });
    const box = label.createEl("input", { type: "checkbox" });
    box.checked = this.attach;
    box.onchange = () => (this.attach = box.checked);
    label.appendText(" Attach the open note to my next message");
    const sendBtn = row.createEl("button", { text: this.busy ? "Stop" : "Send", cls: this.busy ? "mod-warning" : "mod-cta" });
    sendBtn.onclick = () => {
      if (this.busy) this.kill?.();
      else if (input.value.trim()) void this.send(input.value);
    };
    const usage = body.createDiv({ cls: "st-usage" });
    if (this.lastUsage) usage.setText(`Last turn: ${usageLine(this.lastUsage)}. This session: ${usageLine(this.sessionUsage)} over ${this.sessionUsage.calls} calls.`);
    else usage.setText("Token use appears here after each turn.");
    if (!this.busy) input.focus();
  }

  private async setMode(mode: Mode): Promise<void> {
    this.mode = mode;
    if (this.chat && this.chatPath) {
      this.chat.fm.mode = mode;
      await this.plugin.store.saveChat(this.chatPath, this.chat);
    }
    this.render();
  }

  private async newChat(): Promise<void> {
    if (!this.dir || !this.topic) return;
    const path = await this.plugin.store.newChat(this.dir, this.topic.title, this.mode);
    await this.openChat(path);
    this.lastError = "";
    this.lastChanges = [];
    this.render();
  }

  private async attachedNote(): Promise<Material | undefined> {
    if (!this.attach) return undefined;
    const f = this.app.workspace.getActiveFile();
    if (!(f instanceof TFile) || f.extension !== "md" || f.path.startsWith(this.plugin.store.root + "/")) return undefined;
    const text = splitFrontmatter(await this.app.vault.cachedRead(f)).body.trim();
    return text ? { name: f.basename, text: text.split(/\s+/).slice(0, 3000).join(" ") } : undefined;
  }

  /** Sends a message. An empty message starts a chat or retries the last turn. */
  private async send(message: string): Promise<void> {
    if (this.busy || !this.dir || !this.topic) return;
    const dir = this.dir;
    this.busy = true;
    this.lastError = "";
    this.lastChanges = [];
    try {
      if (!this.chatPath || !this.chat) await this.openChat(await this.plugin.store.newChat(dir, this.topic.title, this.mode));
      const chatPath = this.chatPath!;
      if (message.trim()) {
        this.chat!.messages.push({ role: "you", text: message.trim() });
        this.draft = "";
      }
      const attached = await this.attachedNote();
      this.attach = false;
      this.render();
      const r = await this.plugin.engine.turn(dir, chatPath, message, { attached, onSpawn: (kill) => (this.kill = kill) });
      const used = r.rotationUsage ? addUsage(r.usage, r.rotationUsage) : r.usage;
      this.lastUsage = used;
      this.sessionUsage = addUsage(this.sessionUsage, used);
      this.lastChanges = r.changes;
      if (this.dir === dir) {
        this.state = r.state;
        await this.openChat(r.rotatedTo ?? chatPath);
        if (r.rotatedTo) new Notice("This chat was getting long, so it was summarised and continued in a new file to keep turns cheap.", 7000);
      }
    } catch (e) {
      this.lastError = (e as Error).message || String(e);
      if (this.chatPath && this.dir === dir) {
        try {
          this.chat = await this.plugin.store.loadChat(this.chatPath);
        } catch {
          /* keep what is on screen */
        }
      }
    } finally {
      this.busy = false;
      this.kill = null;
      this.render();
    }
  }

  // ---------- review: flashcards from the question bank, graded without any model call ----------

  private async startReview(): Promise<void> {
    this.queue = [];
    this.requeued.clear();
    this.reviewed = 0;
    if (!this.dir) return;
    await this.loadState();
    const qs = await this.plugin.store.loadQuestions(this.dir);
    if (this.state) this.queue = reviewQueue(qs, this.state, this.today, this.plugin.opts.newCardsPerDay);
  }

  private async recordGrade(q: Question, grade: Grade): Promise<void> {
    if (!this.dir || !this.state) return;
    const s = this.state;
    const isNew = !s.cards[q.id];
    s.cards[q.id] = schedule(s.cards[q.id], grade, this.today);
    if (isNew) {
      if (s.newDate !== this.today) {
        s.newDate = this.today;
        s.newCount = 0;
      }
      s.newCount += 1;
    }
    if (!this.requeued.has(q.id)) {
      const b = s.bank[q.subskill] ?? (s.bank[q.subskill] = { right: 0, total: 0 });
      if (q.subskill in s.names) {
        b.total += 1;
        if (grade !== "again") b.right += 1;
      }
    }
    await this.plugin.store.saveState(this.dir, s);
    this.queue.shift();
    this.reviewed += 1;
    if (grade === "again" && !this.requeued.has(q.id)) {
      this.requeued.add(q.id);
      this.queue.push(q);
    }
    this.render();
  }

  private renderReview(): void {
    const body = this.bodyEl;
    const q = this.queue[0];
    if (!q || !this.state) {
      const done = body.createDiv({ cls: "st-empty" });
      done.createEl("p", { text: this.reviewed ? `Done. ${this.reviewed} cards reviewed without using any tokens.` : "Nothing is due today." });
      done.createEl("p", { cls: "st-usage", text: "Cards come from this topic's question bank. Due cards and a few new ones appear here each day." });
      return;
    }
    const card = body.createDiv({ cls: "st-card" });
    card.createDiv({ cls: "st-who", text: `${this.queue.length} left · ${this.state.names[q.subskill] ?? "General"}` });
    this.md(card.createDiv({ cls: "st-text" }), q.question);
    const answerArea = body.createDiv({ cls: "st-answer" });

    const reveal = (verdict: string, typed: string, auto?: Grade) => {
      answerArea.empty();
      if (verdict) answerArea.createDiv({ cls: "st-note", text: verdict });
      const a = answerArea.createDiv({ cls: "st-card" });
      a.createDiv({ cls: "st-who", text: "Answer" });
      this.md(a.createDiv({ cls: "st-text" }), answerText(q) + (q.explanation ? `\n\n${q.explanation}` : ""));
      const row = answerArea.createDiv({ cls: "st-row" });
      if (auto) {
        row.createEl("button", { text: "Next", cls: "mod-cta" }).onclick = () => void this.recordGrade(q, auto);
        return;
      }
      for (const g of ["again", "hard", "good", "easy"] as Grade[]) {
        row.createEl("button", { text: g[0].toUpperCase() + g.slice(1), cls: g === "good" ? "mod-cta" : "" }).onclick = () => void this.recordGrade(q, g);
      }
      if (typed.trim()) {
        const ask = answerArea.createEl("button", { text: "Ask Claude to grade (uses tokens)", cls: "st-linkish" });
        ask.onclick = async () => {
          ask.disabled = true;
          ask.setText("Grading…");
          try {
            const r = await this.plugin.engine.grade(q, typed);
            this.sessionUsage = addUsage(this.sessionUsage, r.usage);
            reveal(`Claude's grade: ${r.grade}. ${r.feedback} (${usageLine(r.usage)})`, "", r.grade);
          } catch (e) {
            ask.disabled = false;
            ask.setText("Ask Claude to grade (uses tokens)");
            new Notice(`Grading failed: ${(e as Error).message}`);
          }
        };
      }
    };

    if (q.type === "mcq") {
      const correct = mcqLetter(q.answer);
      for (const opt of q.options) {
        const b = answerArea.createEl("button", { cls: "st-option" });
        this.md(b, opt);
        b.onclick = () => {
          const right = mcqLetter(opt) === correct;
          reveal(right ? "Correct." : `Incorrect. You chose ${mcqLetter(opt)}.`, "", right ? "good" : "again");
        };
      }
      return;
    }
    const input = answerArea.createEl("textarea", { attr: { rows: q.type === "short" ? "1" : "3", placeholder: q.type === "short" ? "Type your answer" : "Answer in your head or type it here" } });
    const row = answerArea.createDiv({ cls: "st-row" });
    const check = row.createEl("button", { text: q.type === "short" ? "Check" : "Show answer", cls: "mod-cta" });
    check.onclick = () => {
      const typed = input.value;
      if (q.type === "short" && sameShortAnswer(typed, q.answer)) reveal("Correct.", typed, "good");
      else reveal(q.type === "short" && typed.trim() ? "That does not match exactly. Compare and grade yourself." : "", typed);
    };
    input.focus();
  }

  // ---------- skill map ----------

  private renderMap(): void {
    const body = this.bodyEl;
    const s = this.state;
    if (!s || !this.topic || !this.dir) return;
    const dir = this.dir;
    const pct = progress(s);
    const head = body.createDiv({ cls: "st-card" });
    head.createDiv({ cls: "st-who", text: `Overall ${pct}% of target level ${s.target}` });
    head.createDiv({ cls: "st-bar" }).createDiv({ cls: "st-bar-fill", attr: { style: `width:${pct}%` } });

    const table = body.createEl("table", { cls: "st-table" });
    const hr = table.createEl("tr");
    for (const t of ["", "Subskill", "Level", "Cards"]) hr.createEl("th", { text: t });
    for (const n of Object.keys(s.names).map(Number).sort((a, b) => a - b)) {
      const tr = table.createEl("tr", { cls: s.focus === n ? "st-focus" : "" });
      tr.createEl("td", { text: String(n) });
      tr.createEl("td", { text: s.names[n] + (s.focus === n ? "  (current focus)" : "") });
      const lvl = s.levels[n];
      const td = tr.createEl("td");
      const pips = td.createSpan({ cls: "st-pips", attr: { "aria-label": lvl === null ? "Not placed yet" : `Level ${lvl} of 5` } });
      for (let i = 1; i <= 5; i++) pips.createSpan({ cls: "st-pip" + (lvl !== null && i <= lvl ? " is-on" : "") + (i === s.target ? " is-target" : "") });
      td.createSpan({ text: lvl === null ? " –" : ` ${lvl}` });
      const b = s.bank[n] ?? { right: 0, total: 0 };
      tr.createEl("td", { text: b.total ? `${b.right}/${b.total}` : "–" });
    }

    const mis = body.createDiv({ cls: "st-card" });
    mis.createDiv({ cls: "st-who", text: "Misconceptions being tracked" });
    if (s.misconceptions.length) {
      const ul = mis.createEl("ul");
      for (const m of s.misconceptions) ul.createEl("li", { text: m });
    } else mis.createDiv({ cls: "st-usage", text: "None recorded." });

    const row = body.createDiv({ cls: "st-row st-wrap" });
    const targetSel = row.createEl("select", { cls: "dropdown" });
    for (const t of [3, 4, 5]) targetSel.createEl("option", { text: `Target level ${t}`, value: String(t) });
    targetSel.value = String(s.target);
    targetSel.onchange = async () => {
      s.target = Number(targetSel.value);
      await this.plugin.store.saveState(dir, s);
      this.render();
    };
    row.createEl("button", { text: "Topic card" }).onclick = () => void this.app.workspace.openLinkText(`${dir}/topic.md`, "", true);
    row.createEl("button", { text: "Question bank" }).onclick = () => void this.app.workspace.openLinkText(`${dir}/questions.md`, "", true);
    row.createEl("button", { text: "Export flashcards" }).onclick = async () => {
      const p = await this.plugin.store.exportFlashcards(dir);
      new Notice(`Flashcards written to ${p} in the Spaced Repetition plugin's format.`);
    };
    row.createEl("button", { text: "Recompile from notes" }).onclick = () => {
      if (window.confirm("Recompile this topic from its sources? Levels are kept where subskill names still match. The flashcard schedule starts again.")) void this.plugin.recompile(dir);
    };
    body.createDiv({ cls: "st-usage", text: `Source: ${fmStr(this.topic.fm, "source", "subject")}. Compiled ${fmStr(this.topic.fm, "compiled", "?")}. Subject card: ${fmStr(this.topic.fm, "subject", "none")}.` });
  }
}
