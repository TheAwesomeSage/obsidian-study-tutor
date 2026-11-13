import { recordAttempt, skillEvidence } from "./evidence";
import { Component, ItemView, MarkdownRenderer, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { Usage, addUsage, usageLine, zeroUsage } from "./claude";
import { Material, TurnResult } from "./engine";
import { Chat, Grade, LearnerState, Mode, NextStep, Question, SrStats, Topic, answerText, dueCount, fmStr, mcqLetter, nextStep, prereqMap, progress, reviewQueue, sameShortAnswer, schedule, splitFrontmatter, stepFor, ymd } from "./formats";
import { drawGraph, layoutGraph, levelLabel } from "./graph";
import type StudyTutorPlugin from "./main";
import { TopicRef } from "./store";

export const VIEW_TYPE = "study-tutor-view";

type Tab = "chat" | "review" | "map";

/** The modes in the order of the guided path: learn it, practise it, master it; ask at any time. */
const PATH: { mode: Mode; label: string; who: string; icon: string; step: string; start: string; hint: string }[] = [
  { mode: "auto", label: "Adaptive", who: "Study guide", icon: "compass", step: "", start: "Start session", hint: "The guide chooses teaching, diagnosis and practice while preserving your current task." },
  { mode: "teach", label: "Learn", who: "Teacher", icon: "book-open", step: "1", start: "Start lesson", hint: "Lessons for material you have not met: why it matters, the idea, a worked example, a diagram where it helps, then a problem to try." },
  { mode: "quiz", label: "Practise", who: "Quizzer", icon: "zap", step: "2", start: "Start quiz", hint: "Strict questions on your weakest subskills, from the question bank first. The plugin marks most answers itself, so most turns use no tokens." },
  { mode: "tutor", label: "Master", who: "Tutor", icon: "target", step: "3", start: "Start", hint: "Socratic tutoring: one question at a time, and a level only goes up when you have shown it. The most thorough mode, and the one that uses the most tokens." },
  { mode: "expert", label: "Ask", who: "Expert", icon: "message-circle", step: "", start: "", hint: "Ask anything about this topic and get a direct explanation grounded in your notes. Short look-up questions are answered by the cheaper model." },
];
const byMode = (m: Mode) => PATH.find((p) => p.mode === m) ?? PATH[2];
const ROUTE_NOTE: Record<string, string> = { simple: "cheaper model", standard: "chat model", complex: "chat model, extra thinking" };

export class TutorView extends ItemView {
  private topics: TopicRef[] = [];
  private dir: string | null = null;
  private topic: Topic | null = null;
  private state: LearnerState | null = null;
  private chatPath: string | null = null;
  private chat: Chat | null = null;
  private mode: Mode = "auto";
  private confidence: number | null = null;
  private graphColour: "level" | "evidence" = "level";
  private tab: Tab = "chat";
  private busy = false;
  private kill: (() => void) | null = null;
  private attach = false;
  private draft = "";
  private lastUsage: Usage | null = null;
  private lastRoute = "";
  /** What SymPy did on the last turn, for the usage line. */
  private lastMaths = "";
  /** The subskill picked in the concept graph. */
  private picked: number | null = null;
  private sessionUsage = zeroUsage();
  private lastError = "";
  private lastChanges: string[] = [];
  private bodyEl!: HTMLElement;
  private headEl!: HTMLElement;
  /** Owns everything the markdown renderer creates for the current render, so it can be released. */
  private rendered: Component | null = null;
  /** Flashcard counts from the Spaced Repetition plugin's note, when that plugin does the reviewing. */
  private sr: SrStats | null = null;
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

  /** The concept graph is laid out to the sidebar's width, so it is redrawn when that changes. */
  onResize(): void {
    if (this.tab === "map" && this.bodyEl && Math.abs(this.bodyEl.clientWidth - this.graphWidth) > 24) this.render();
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
    if (!this.dir) return;
    this.state = await this.plugin.store.loadState(this.dir, this.plugin.opts.targetLevel);
    this.sr = null;
    if (this.plugin.usesSr()) {
      // The schedule lives in the flashcard note that Spaced Repetition maintains. Create the
      // note the first time; after that only read it, so its review history is never disturbed.
      try {
        this.sr = (await this.plugin.store.flashcardStats(this.dir)) ?? (await this.plugin.store.exportFlashcards(this.dir), await this.plugin.store.flashcardStats(this.dir));
      } catch {
        this.sr = null;
      }
    }
  }

  private async selectTopic(dir: string | null): Promise<void> {
    this.dir = dir;
    this.topic = null;
    this.state = null;
    this.chat = null;
    this.chatPath = null;
    this.lastError = "";
    this.lastChanges = [];
    this.lastRoute = "";
    this.lastMaths = "";
    this.picked = null;
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
    const m = fmStr(this.chat.fm, "mode", "tutor") as Mode;
    this.mode = PATH.some((p) => p.mode === m) ? m : "tutor";
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
      const empty = this.bodyEl.createDiv({ cls: "st-empty st-welcome" });
      setIcon(empty.createDiv({ cls: "st-welcome-icon" }), "graduation-cap");
      empty.createEl("p", { text: "No topics yet. A topic is compiled once from your notes, a spec, or just a subject name. After that, each chat turn loads only the compiled card." });
      empty.createEl("button", { text: "New topic", cls: "mod-cta" }).onclick = () => this.plugin.openNewTopic();
      return;
    }
    if (this.tab === "chat") this.renderChat();
    else if (this.tab === "review") this.renderReview();
    else this.renderMap();
  }

  private iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLButtonElement {
    const b = parent.createEl("button", { cls: "st-icon-btn clickable-icon", attr: { "aria-label": label } });
    setIcon(b, icon);
    b.onclick = onClick;
    return b;
  }

  private renderHead(): void {
    const h = this.headEl;
    h.empty();
    const row = h.createDiv({ cls: "st-row" });
    const sel = row.createEl("select", { cls: "dropdown st-grow st-topic-select", attr: { "aria-label": "Topic" } });
    if (!this.topics.length) sel.createEl("option", { text: "No topics", value: "" });
    for (const t of this.topics) sel.createEl("option", { text: t.title, value: t.dir });
    if (this.dir) sel.value = this.dir;
    sel.disabled = this.busy;
    sel.onchange = () => void this.selectTopic(sel.value || null);
    this.iconButton(row, "plus", "New topic", () => this.plugin.openNewTopic());

    if (!this.dir || !this.state) return;
    const s = this.state;
    const pct = progress(s);
    const due = this.sr ? this.sr.due : dueCount(s, this.today);

    // Progress ring and the suggested next step.
    const hero = h.createDiv({ cls: "st-hero" });
    const ring = hero.createDiv({ cls: "st-ring", attr: { style: `--st-p:${pct}`, "aria-label": `${pct}% of the way to target level ${s.target}` } });
    ring.createDiv({ cls: "st-ring-num", text: `${pct}` });
    const next = nextStep(s, this.today, this.sr ? this.sr.due : undefined, this.topic ? prereqMap(this.topic) : {});
    const info = hero.createDiv({ cls: "st-grow st-hero-info" });
    info.createDiv({ cls: "st-hero-kicker", text: `Next step · ${next.title}` });
    info.createDiv({ cls: "st-hero-detail", text: next.detail });
    if (next.action !== "done") {
      const go = hero.createEl("button", { text: "Do this", cls: "mod-cta st-go" });
      go.disabled = this.busy;
      go.onclick = () => void this.follow(next);
    }

    const tabs = h.createDiv({ cls: "st-tabs" });
    const labels: [Tab, string][] = [
      ["chat", "Chat"],
      ["review", due ? `Review (${due} due)` : "Review"],
      ["map", `Skill map ${pct}%`],
    ];
    for (const [tab, label] of labels) {
      const b = tabs.createEl("button", { text: label, cls: "st-tab" + (this.tab === tab ? " is-active" : "") });
      b.onclick = () => void this.showTab(tab);
    }
  }

  /** Acts on the suggested next step: opens the right tab, or a fresh chat in the right mode. */
  private async follow(step: NextStep): Promise<void> {
    if (step.action === "review") return this.showTab("review");
    if (step.action === "done") return;
    // The step names a subskill: make it the focus, so the lesson or the tutor starts there.
    if (step.subskill && this.dir && this.state && step.subskill in this.state.names && this.state.focus !== step.subskill) {
      this.state.focus = step.subskill;
      await this.plugin.store.saveState(this.dir, this.state);
    }
    this.tab = "chat";
    const sameMode = this.chat && this.mode === step.action;
    this.mode = step.action;
    if (!sameMode) await this.newChat();
    else this.render();
  }

  private md(el: HTMLElement, text: string): void {
    void MarkdownRenderer.render(this.app, text, el, this.chatPath ?? this.dir ?? "", this.rendered ?? this);
  }

  // ---------- chat ----------

  private renderChat(): void {
    const body = this.bodyEl;
    const here = byMode(this.mode);

    // The guided path doubles as the mode switch.
    const path = body.createDiv({ cls: "st-path" });
    for (const p of PATH) {
      const b = path.createEl("button", { cls: "st-step" + (p.mode === this.mode ? " is-active" : "") + (p.step ? "" : " is-side"), attr: { "aria-label": p.hint } });
      setIcon(b.createSpan({ cls: "st-step-icon" }), p.icon);
      b.createSpan({ cls: "st-step-label", text: p.label });
      b.disabled = this.busy;
      b.onclick = () => void this.setMode(p.mode);
    }

    const bar = body.createDiv({ cls: "st-row st-toolbar" });
    bar.createDiv({ cls: "st-grow st-mode-name", text: here.who });
    if (this.chat?.fm.orchestration) body.createDiv({ cls: "st-usage", text: String(this.chat.fm.orchestration) });
    const bankQuiz = this.mode === "quiz" && this.plugin.opts.bankQuiz;
    const chat = this.chat;
    const last = chat?.messages[chat.messages.length - 1];
    if (bankQuiz && chat && last?.role === "tutor" && !fmStr(chat.fm, "card")) {
      const bank = bar.createEl("button", { text: "Bank question", attr: { "aria-label": "Ask the next question from the bank, marked without tokens" } });
      bank.disabled = this.busy;
      bank.onclick = () => void this.send("");
    }
    // Icon names are ones Obsidian has shipped for years; a newer name would draw nothing on older versions.
    this.iconButton(bar, "message-square-plus", "New chat", () => void this.newChat()).disabled = this.busy;
    if (this.chatPath) this.iconButton(bar, "file-text", "Open this chat as a note", () => void this.app.workspace.openLinkText(this.chatPath!, "", true));

    const list = body.createDiv({ cls: "st-messages" });
    if (chat && chat.summary) {
      const sum = list.createEl("details", { cls: "st-summary" });
      sum.createEl("summary", { text: `Summary of earlier parts (part ${fmStr(chat.fm, "part", "1")})` });
      this.md(sum.createDiv(), chat.summary);
    }
    if (!chat || !chat.messages.length) {
      const hint = list.createDiv({ cls: "st-empty st-welcome" });
      setIcon(hint.createDiv({ cls: "st-welcome-icon" }), here.icon);
      hint.createEl("p", { text: here.hint });
      if (here.start && !this.busy) hint.createEl("button", { text: here.start, cls: "mod-cta" }).onclick = () => void this.send("");
    }
    for (const m of chat?.messages ?? []) {
      const el = list.createDiv({ cls: `st-msg st-${m.role}` });
      el.createDiv({ cls: "st-who", text: m.role === "you" ? "You" : here.who });
      this.md(el.createDiv({ cls: "st-text" }), m.text);
    }
    if (chat && last?.role === "tutor" && fmStr(chat.fm, "placement") === "done" && last.text.startsWith("**Placement done") && !this.busy) {
      list.createEl("button", { text: "Continue", cls: "mod-cta st-continue" }).onclick = () => void this.send("");
    }
    if (this.lastChanges.length) list.createDiv({ cls: "st-note st-chip", text: "Skill map updated: " + this.lastChanges.join("; ") });
    if (this.busy) {
      const t = list.createDiv({ cls: "st-note st-thinking" });
      t.createSpan({ cls: "st-dots" });
      t.createSpan({ text: "Thinking…" });
    }
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
    const row = composer.createDiv({ cls: "st-row st-composer-row" });
    const label = row.createEl("label", { cls: "st-grow st-attach" });
    const box = label.createEl("input", { type: "checkbox" });
    box.checked = this.attach;
    box.onchange = () => (this.attach = box.checked);
    label.appendText(" Attach the open note");
    const confidence = row.createEl("select", { attr: { "aria-label": "Confidence before checking" } });
    confidence.createEl("option", { value: "", text: "Confidence�" });
    for (const value of [0, 25, 50, 75, 100]) confidence.createEl("option", { value: String(value), text: `${value}%` });
    confidence.value = this.confidence === null ? "" : String(this.confidence * 100);
    confidence.onchange = () => { this.confidence = confidence.value === "" ? null : Number(confidence.value) / 100; };
    const sendBtn = row.createEl("button", { text: this.busy ? "Stop" : "Send", cls: this.busy ? "mod-warning st-send" : "mod-cta st-send" });
    sendBtn.onclick = () => {
      if (this.busy) this.kill?.();
      else if (input.value.trim()) void this.send(input.value);
    };

    const usage = body.createDiv({ cls: "st-usage st-meter" });
    const session = `Session: ${usageLine(this.sessionUsage)} over ${this.sessionUsage.calls} calls.`;
    if (this.lastUsage && this.lastUsage.calls === 0) usage.setText(`Last turn: marked by the plugin, no tokens used. ${session}`);
    else if (this.lastUsage) usage.setText(`Last turn: ${usageLine(this.lastUsage)}${this.lastRoute ? ` · ${this.lastRoute}` : ""}${this.lastMaths ? ` · ${this.lastMaths}` : ""}. ${session}`);
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
    if (this.chat && this.chatPath && !this.chat.messages.length && !this.chat.summary) {
      // The current chat is still empty: reuse it instead of leaving an empty file behind.
      this.chat.fm.mode = this.mode;
      await this.plugin.store.saveChat(this.chatPath, this.chat);
    } else await this.openChat(await this.plugin.store.newChat(this.dir, this.topic.title, this.mode));
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

  /** Runs one turn through the cheapest path that can handle it: plain code first, then the model. */
  private async runTurn(dir: string, chatPath: string, message: string, attached: Material | undefined): Promise<TurnResult> {
    const engine = this.plugin.engine;
    const opts = { attached, onSpawn: (kill: () => void) => (this.kill = kill) };
    const chat = this.chat;
    // Placement can only begin on an empty chat, and continues while the chat is marked as placing.
    if (this.mode === "tutor" && this.plugin.opts.codePlacement && chat && (!chat.messages.length || fmStr(chat.fm, "placement") === "on")) {
      const placed = await engine.placementTurn(dir, chatPath, message);
      if (placed) return placed;
    }
    if (this.mode === "quiz" && this.plugin.opts.bankQuiz) return engine.quizTurn(dir, chatPath, message, opts);
    return engine.turn(dir, chatPath, message, opts);
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
      this.chat!.fm.confidence = this.confidence === null ? "" : this.confidence;
      await this.plugin.store.saveChat(chatPath, this.chat!);
      this.confidence = null;
      const attached = await this.attachedNote();
      this.attach = false;
      // Start the turn first: it decides its path from the chat as it stood before this message.
      const turn = this.runTurn(dir, chatPath, message, attached);
      if (message.trim()) {
        this.chat!.messages.push({ role: "you", text: message.trim() });
        this.draft = "";
      }
      this.render();
      const r = await turn;
      const used = r.rotationUsage ? addUsage(r.usage, r.rotationUsage) : r.usage;
      this.lastUsage = used;
      this.lastRoute = r.route && this.plugin.opts.smartRouting ? ROUTE_NOTE[r.route.route] : "";
      const m = r.maths;
      this.lastMaths = m && (m.computed || m.checked) ? `SymPy ${[m.computed ? `computed ${m.computed}` : "", m.checked ? `checked ${m.checked}` : ""].filter(Boolean).join(", ")}${m.corrected ? ", one draft rewritten" : ""}` : "";
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
    s.attempts = recordAttempt(s.attempts ?? [], {
      id: `review:${q.id}:${Date.now()}`, skill: q.subskill, question: q.question, answer: "Self-rated review",
      timestamp: new Date().toISOString(), mode: "review", result: grade === "again" ? "incorrect" : grade === "hard" ? "partial" : "correct",
      confidence: null, assisted: true, transfer: false, source: "self", error: "",
    });
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
        if (grade === "good" || grade === "easy") b.right += 1;
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

  /** Review handed to the Spaced Repetition plugin: show its counts and start its review on this topic's note. */
  private renderSrReview(): void {
    const body = this.bodyEl;
    const dir = this.dir;
    if (!dir) return;
    const sr = this.sr ?? { total: 0, due: 0, fresh: 0 };
    const card = body.createDiv({ cls: "st-card st-question" });
    card.createDiv({ cls: "st-who", text: "Flashcards · Spaced Repetition" });
    const counts = card.createDiv({ cls: "st-counts" });
    for (const [n, label] of [
      [sr.due, "due"],
      [sr.fresh, "new"],
      [sr.total, "cards"],
    ] as [number, string][]) {
      const c = counts.createDiv({ cls: "st-count" });
      c.createDiv({ cls: "st-count-num", text: String(n) });
      c.createDiv({ cls: "st-count-label", text: label });
    }
    card.createEl("p", { cls: "st-usage", text: "This topic's question bank is kept as a flashcard note. Spaced Repetition schedules it alongside your other decks, and reviewing there uses no tokens." });
    const row = body.createDiv({ cls: "st-row st-wrap" });
    const go = row.createEl("button", { text: "Review this topic", cls: "mod-cta" });
    go.disabled = !sr.total;
    go.onclick = () => void this.plugin.reviewInSr(dir);
    row.createEl("button", { text: "Open flashcard note" }).onclick = async () => {
      void this.app.workspace.openLinkText(await this.plugin.store.exportFlashcards(dir), "", true);
    };
    row.createEl("button", { text: "Refresh counts" }).onclick = () => void this.showTab("review");
    if (!sr.total) body.createDiv({ cls: "st-usage", text: "The question bank is empty. Recompile the topic from the Skill map tab." });
  }

  private renderReview(): void {
    if (this.plugin.usesSr()) return this.renderSrReview();
    const body = this.bodyEl;
    const q = this.queue[0];
    if (!q || !this.state) {
      const done = body.createDiv({ cls: "st-empty st-welcome" });
      setIcon(done.createDiv({ cls: "st-welcome-icon" }), "check");
      done.createEl("p", { text: this.reviewed ? `Done. ${this.reviewed} cards reviewed without using any tokens.` : "Nothing is due today." });
      done.createEl("p", { cls: "st-usage", text: "Cards come from this topic's question bank. Due cards and a few new ones appear here each day." });
      return;
    }
    const total = this.reviewed + this.queue.length;
    const bar = body.createDiv({ cls: "st-bar st-review-bar" });
    bar.createDiv({ cls: "st-bar-fill", attr: { style: `width:${total ? Math.round((100 * this.reviewed) / total) : 0}%` } });
    const card = body.createDiv({ cls: "st-card st-question" });
    card.createDiv({ cls: "st-who", text: `${this.queue.length} left · ${this.state.names[q.subskill] ?? "General"}` });
    this.md(card.createDiv({ cls: "st-text" }), q.question);
    const answerArea = body.createDiv({ cls: "st-answer" });

    const reveal = (verdict: string, typed: string, auto?: Grade) => {
      answerArea.empty();
      if (verdict) answerArea.createDiv({ cls: "st-note st-chip" + (/^Correct/.test(verdict) ? " is-good" : /^Incorrect/.test(verdict) ? " is-bad" : ""), text: verdict });
      const a = answerArea.createDiv({ cls: "st-card st-reveal" });
      a.createDiv({ cls: "st-who", text: "Answer" });
      this.md(a.createDiv({ cls: "st-text" }), answerText(q) + (q.explanation ? `\n\n${q.explanation}` : ""));
      const row = answerArea.createDiv({ cls: "st-row st-grades" });
      if (auto) {
        row.createEl("button", { text: "Next", cls: "mod-cta" }).onclick = () => void this.recordGrade(q, auto);
        return;
      }
      for (const g of ["again", "hard", "good", "easy"] as Grade[]) {
        row.createEl("button", { text: g[0].toUpperCase() + g.slice(1), cls: `st-grade st-grade-${g}` + (g === "good" ? " mod-cta" : "") }).onclick = () => void this.recordGrade(q, g);
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
    check.onclick = async () => {
      const typed = input.value;
      if (q.type === "short" && sameShortAnswer(typed, q.answer)) return reveal("Correct.", typed, "good");
      if (q.type === "short" && typed.trim()) {
        // Another form of the same expression (1/2 for 0.5): SymPy can tell, with no model call.
        check.disabled = true;
        const same = await this.plugin.engine.mathEquivalent(q.answer, typed).catch(() => null);
        if (this.queue[0] !== q) return;
        if (same !== null) return reveal(same ? "Correct. SymPy confirms your answer equals the expected one." : "Incorrect. SymPy finds your answer is not equal to the expected one.", typed, same ? "good" : "again");
      }
      reveal(q.type === "short" && typed.trim() ? "That does not match exactly. Compare and grade yourself." : "", typed);
    };
    input.focus();
  }

  // ---------- skill map ----------

  private graphWidth = 0;

  /** The concept graph: prerequisites above what they unlock, each box coloured by level. Drawn by plain code. */
  private renderGraph(body: HTMLElement, s: LearnerState, topic: Topic): void {
    if (!topic.subskills.length) return;
    const card = body.createDiv({ cls: "st-card st-graph-card" });
    const head = card.createDiv({ cls: "st-row" });
    head.createDiv({ cls: "st-who st-grow", text: "Concept graph" });
    const colours = head.createEl("select", { attr: { "aria-label": "Graph colour" } });
    colours.createEl("option", { value: "level", text: "Skill level" });
    colours.createEl("option", { value: "evidence", text: "Estimated success" });
    colours.value = this.graphColour;
    colours.onchange = () => { this.graphColour = colours.value as "level" | "evidence"; this.render(); };
    const legend = head.createDiv({ cls: "st-g-legend", attr: { "aria-label": "Colour shows level, from not placed to level 5" } });
    legend.createSpan({ cls: "st-g-legend-text", text: "new" });
    for (const l of ["unset", "l0", "l1", "l2", "l3", "l4", "l5"]) legend.createSpan({ cls: `st-g-swatch st-g-${l}`, attr: { "aria-label": l === "unset" ? "not placed" : `level ${l[1]}` } });
    legend.createSpan({ cls: "st-g-legend-text", text: "5" });

    this.graphWidth = body.clientWidth;
    const holder = card.createDiv({ cls: "st-graph-holder" });
    // Laid out to the width actually available (jsdom and a hidden pane report none).
    const graph = layoutGraph(topic, s, { width: holder.clientWidth || 312 });
    if (this.picked !== null && !(this.picked in s.names)) this.picked = null;
    drawGraph(holder, graph, s, this.picked, (n) => {
      this.picked = this.picked === n ? null : n;
      this.render();
    }, this.graphColour);

    const node = graph.nodes.find((x) => x.n === this.picked);
    const info = card.createDiv({ cls: "st-g-info" });
    if (!node) {
      const lagging = graph.edges.filter((e) => e.lagging);
      info.createDiv({ cls: "st-usage", text: lagging.length ? `Dashed arrows: ${lagging.length === 1 ? "a prerequisite is" : `${lagging.length} prerequisites are`} behind what is built on ${lagging.length === 1 ? "it" : "them"}. Select a box for details.` : "Arrows run from a prerequisite to what builds on it. Select a box for details." });
      return;
    }
    const evidence = skillEvidence(s.attempts ?? [], node.n);
    info.createDiv({ cls: "st-usage", text: `Independent questions: ${evidence.count}. Correct: ${evidence.correct}. Estimated success: ${evidence.estimate === null ? "unknown" : Math.round(evidence.estimate * 100) + "% (provisional)"}. Delayed transfer: ${evidence.delayedTransfer ? "demonstrated" : "awaiting evidence"}.` });
    if (evidence.brier !== null) info.createDiv({ cls: "st-usage", text: `Confidence calibration (Brier): ${evidence.brier.toFixed(3)}. Lower is better.` });
    const name = (n: number) => `${n}. ${s.names[n] ?? "?"} (${levelLabel(s.levels[n] ?? null)})`;
    info.createDiv({ cls: "st-g-title", text: `${node.n}. ${node.name}` });
    info.createDiv({ cls: "st-usage", text: `${node.level === null ? "Not placed yet" : `Level ${node.level} of ${s.target}`}${node.atTarget ? ", at target" : ""}${node.focus ? " · current focus" : ""}` });
    if (node.prerequisites.length) info.createDiv({ cls: "st-usage", text: `Builds on: ${node.prerequisites.map(name).join("; ")}` });
    if (node.unlocks.length) info.createDiv({ cls: "st-usage", text: `Leads to: ${node.unlocks.map(name).join("; ")}` });
    const behind = graph.edges.filter((e) => e.to === node.n && e.lagging).map((e) => s.names[e.from]);
    if (node.locked) info.createDiv({ cls: "st-g-warn", text: `Learn ${node.blockedBy.map((p) => s.names[p]).join(" and ")} first.` });
    else if (behind.length) info.createDiv({ cls: "st-g-warn", text: `${behind.join(" and ")} ${behind.length === 1 ? "is" : "are"} behind this subskill. Strengthening ${behind.length === 1 ? "it" : "them"} will help here.` });
    const priority = info.createEl("input", { type: "number", attr: { min: "0.1", max: "5", step: "0.1", "aria-label": "Study priority weight" } });
    priority.value = String(s.priorities?.[node.n] ?? 1);
    info.createSpan({ text: " Study priority (0.1 to 5)" });
    priority.onchange = async () => {
      const value = Number(priority.value);
      if (!Number.isFinite(value) || value < 0.1 || value > 5 || !this.dir) return;
      s.priorities = { ...s.priorities, [node.n]: value };
      await this.plugin.store.saveState(this.dir, s);
    };
    for (const link of (s.links ?? []).filter(l => l.skill === node.n)) {
      const linkRow = info.createDiv({ cls: "st-row" });
      const open = linkRow.createEl("button", { text: `${this.topics.find(t => t.dir === link.topic)?.title ?? link.topic}: skill ${link.prerequisite}` });
      open.onclick = () => void this.selectTopic(link.topic);
      const remove = linkRow.createEl("button", { text: "Remove link" });
      remove.onclick = async () => { if (!this.dir) return; s.links = (s.links ?? []).filter(l => l !== link); await this.plugin.store.saveState(this.dir, s); this.render(); };
    }
    const links = info.createDiv({ cls: "st-row" });
    const other = links.createEl("select", { attr: { "aria-label": "Prerequisite topic" } });
    other.createEl("option", { value: "", text: "Link prerequisite topic" });
    for (const t of this.topics.filter(t => t.dir !== this.dir)) other.createEl("option", { value: t.dir, text: t.title });
    const skill = links.createEl("select", { attr: { "aria-label": "Prerequisite skill" } });
    other.onchange = async () => {
      skill.empty();
      if (!other.value) return;
      const topic = await this.plugin.store.loadTopic(other.value);
      for (const sub of topic.subskills) skill.createEl("option", { value: String(sub.n), text: sub.name });
    };
    const add = links.createEl("button", { text: "Add link" });
    add.onclick = async () => {
      if (!this.dir || !other.value || !skill.value) return;
      const link = { skill: node.n, topic: other.value, prerequisite: Number(skill.value) };
      if (!(s.links ?? []).some(l => l.skill === link.skill && l.topic === link.topic && l.prerequisite === link.prerequisite)) {
        try {
          await this.plugin.store.addPrerequisite(this.dir, s, link);
          this.render();
        } catch (error) { new Notice((error as Error).message); }
      }
    };
    const row = info.createDiv({ cls: "st-row st-wrap" });
    // Studying a locked subskill starts with what it is missing.
    const target = node.locked ? node.blockedBy[0] : node.n;
    const step = stepFor(s, target);
    const go = row.createEl("button", { text: `${step.action === "teach" ? "Learn" : "Work on"} ${target === node.n ? "this" : s.names[target]}`, cls: "mod-cta" });
    go.disabled = this.busy;
    go.onclick = () => void this.follow(step);
  }

  private renderMap(): void {
    const body = this.bodyEl;
    const s = this.state;
    if (!s || !this.topic || !this.dir) return;
    const dir = this.dir;

    this.renderGraph(body, s, this.topic);

    const table = body.createEl("table", { cls: "st-table" });
    const hr = table.createEl("tr");
    for (const t of ["", "Subskill", "Level", "Cards"]) hr.createEl("th", { text: t });
    for (const n of Object.keys(s.names).map(Number).sort((a, b) => a - b)) {
      const tr = table.createEl("tr", { cls: s.focus === n ? "st-focus" : "" });
      tr.createEl("td", { text: String(n), cls: "st-num" });
      tr.createEl("td", { text: s.names[n] + (s.focus === n ? "  (current focus)" : "") });
      const lvl = s.levels[n];
      const td = tr.createEl("td", { cls: "st-level" });
      const pips = td.createSpan({ cls: "st-pips", attr: { "aria-label": lvl === null ? "Not placed yet" : `Level ${lvl} of 5` } });
      for (let i = 1; i <= 5; i++) pips.createSpan({ cls: "st-pip" + (lvl !== null && i <= lvl ? " is-on" : "") + (i === s.target ? " is-target" : "") });
      td.createSpan({ cls: "st-level-num", text: lvl === null ? " –" : ` ${lvl}` });
      const b = s.bank[n] ?? { right: 0, total: 0 };
      tr.createEl("td", { text: b.total ? `${b.right}/${b.total}` : "–", cls: "st-num" });
    }

    const mis = body.createDiv({ cls: "st-card" });
    mis.createDiv({ cls: "st-who", text: "Misconceptions being tracked" });
    if (s.misconceptions.length) {
      const ul = mis.createEl("ul");
      for (const m of s.misconceptions) ul.createEl("li", { text: m });
    } else mis.createDiv({ cls: "st-usage", text: "None recorded." });

    const row = body.createDiv({ cls: "st-row st-wrap st-actions" });
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
    const sumBtn = row.createEl("button", { text: "Write summary note", attr: { "aria-label": "One model call: writes a revision summary with a concept map into the topic folder" } });
    sumBtn.onclick = async () => {
      sumBtn.disabled = true;
      sumBtn.setText("Writing…");
      try {
        const r = await this.plugin.engine.summarySheet(dir);
        this.sessionUsage = addUsage(this.sessionUsage, r.usage);
        new Notice(`Summary written to ${r.path}.\n${usageLine(r.usage)}`, 8000);
        void this.app.workspace.openLinkText(r.path, "", true);
      } catch (e) {
        new Notice(`Summary failed: ${(e as Error).message}`, 10000);
      }
      sumBtn.disabled = false;
      sumBtn.setText("Write summary note");
    };
    row.createEl("button", { text: "Export flashcards" }).onclick = async () => {
      const p = await this.plugin.store.exportFlashcards(dir);
      new Notice(`Flashcards are up to date in ${p}, in the Spaced Repetition plugin's format. Existing review history was kept.`);
    };
    row.createEl("button", { text: "Recompile from notes" }).onclick = () => {
      if (window.confirm("Recompile this topic from its sources? Levels are kept where subskill names still match. The flashcard schedule starts again.")) void this.plugin.recompile(dir);
    };
    body.createDiv({ cls: "st-usage", text: `Source: ${fmStr(this.topic.fm, "source", "subject")}. Compiled ${fmStr(this.topic.fm, "compiled", "?")}. Subject card: ${fmStr(this.topic.fm, "subject", "none")}. Web research: ${fmStr(this.topic.fm, "research", "no")}.` });
  }
}
