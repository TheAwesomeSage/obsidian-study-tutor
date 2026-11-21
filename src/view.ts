// The Study Tutor view: one pane in the main workspace with a fixed navigation bar and five
// screens beneath it (home, topic, study, review, graph). The view owns the data the screens
// share (the topic list, the active topic and chat) and moves between screens without
// discarding any of it, so going Home never loses the session in progress.

import { Component, ItemView, MarkdownRenderer, Menu, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import { dropRemote, neutraliseRemote } from "./safemd";
import { Usage, zeroUsage } from "./claude";
import { Chat, LearnerState, Mode, NextStep, Prereqs, SrStats, Topic, fmStr, ymd } from "./formats";
import { GraphScreen } from "./graphscreen";
import { HomeScreen } from "./home";
import type StudyTutorPlugin from "./main";
import { TopicInfo, topicInfo } from "./overview";
import { DEFAULT_WEIGHTS, V1_WEIGHTS, replay } from "./policy";
import { ReviewScreen } from "./review";
import { ChatRef, TopicRef } from "./store";
import { isAskChat } from "./engine-ask";
import { StudyScreen } from "./study";
import { TopicScreen } from "./topicscreen";
import { MODE_INFO, iconButton } from "./ui";
import type { PresentationRequest, PlayerEvent } from "./visuals/contracts";
import { presentActivity } from "./visuals/obsidian";

export const VIEW_TYPE = "study-tutor-view";

export type ScreenName = "home" | "topic" | "study" | "review" | "graph";

/** A screen builds its DOM in `mount` and is told when the shared data changed. It keeps its own state between visits. */
export interface Screen {
  mount(el: HTMLElement): void | Promise<void>;
  unmount?(): void;
  /** The view's shared data changed (another topic, a finished turn). */
  refresh?(): void | Promise<void>;
  onResize?(): void;
  /** The theme or a CSS snippet changed. Screens that paint with computed colours repaint. */
  onThemeChange?(): void;
}

const NAV: { screen: ScreenName; label: string; icon: string }[] = [
  { screen: "home", label: "Home", icon: "home" },
  { screen: "study", label: "Study", icon: "message-square" },
  { screen: "review", label: "Review", icon: "layers" },
  { screen: "graph", label: "Graph", icon: "git-fork" },
];

export class TutorView extends ItemView {
  topics: TopicRef[] = [];
  /** Progress and the suggested step for every topic, for the home screen and the graph. */
  overview: TopicInfo[] = [];
  recent: ChatRef[] = [];
  dir: string | null = null;
  topic: Topic | null = null;
  state: LearnerState | null = null;
  pre: Prereqs = {};
  /** Flashcard counts from the Spaced Repetition plugin's note, when that plugin does the reviewing. */
  sr: SrStats | null = null;
  chatPath: string | null = null;
  chat: Chat | null = null;
  mode: Mode = "auto";
  screen: ScreenName = "home";
  sessionUsage: Usage = zeroUsage();
  /** A concept to select when the graph next opens. */
  graphFocus: string | null = null;

  private navEl!: HTMLElement;
  private mainEl!: HTMLElement;
  private screens!: Record<ScreenName, Screen>;
  private mounted: Screen | null = null;
  /** Owns everything the markdown renderer creates, so it can be released with the screen. */
  private rendered: Component | null = null;
  private loading = true;

  constructor(
    leaf: WorkspaceLeaf,
    public plugin: StudyTutorPlugin,
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

  get today(): string {
    return ymd();
  }
  get info(): TopicInfo | null {
    return this.overview.find((t) => t.dir === this.dir) ?? null;
  }
  get study(): StudyScreen {
    return this.screens.study as StudyScreen;
  }
  /** The open chat is a free question, which belongs to no topic and needs none. */
  get free(): boolean {
    return isAskChat(this.chat);
  }

  /** Backend gate/explicit request only. Topic and graph navigation never call this. */
  presentActivity(lesson: unknown, request: PresentationRequest, onEvent?: (event: PlayerEvent) => void): void {
    presentActivity(this.app, lesson, request, { onEvent });
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("study-tutor");
    this.navEl = this.contentEl.createEl("header", { cls: "st-nav" });
    this.mainEl = this.contentEl.createEl("main", { cls: "st-main" });
    this.screens = { home: new HomeScreen(this), topic: new TopicScreen(this), study: new StudyScreen(this), review: new ReviewScreen(this), graph: new GraphScreen(this) };
    // Rendered [[links]] do nothing in a custom view unless the view opens them itself.
    this.registerDomEvent(this.contentEl, "click", (e: MouseEvent) => {
      const link = (e.target as HTMLElement | null)?.closest?.("a.internal-link") as HTMLElement | null;
      const href = link?.getAttribute("data-href") ?? link?.getAttribute("href");
      if (!link || !href) return;
      e.preventDefault();
      void this.app.workspace.openLinkText(href, this.chatPath ?? "", e.ctrlKey || e.metaKey);
    });
    this.registerEvent(this.app.workspace.on("css-change", () => this.mounted?.onThemeChange?.()));
    this.renderNav();
    this.mainEl.createDiv({ cls: "st-loading", text: "Loading your topics…" });
    await this.reload();
  }

  async onClose(): Promise<void> {
    this.screens?.study && this.study.stop();
    this.mounted?.unmount?.();
  }

  onResize(): void {
    this.mounted?.onResize?.();
  }

  // ---------- data ----------

  /** Re-reads the topic list and the active topic from the vault. */
  async reload(): Promise<void> {
    this.loading = true;
    try {
      this.topics = await this.plugin.store.listTopics();
    } catch {
      this.topics = [];
    }
    const wanted = this.plugin.data.activeTopic;
    const dir = this.topics.find((t) => t.dir === wanted)?.dir ?? this.topics[0]?.dir ?? null;
    await this.loadTopic(dir);
    await this.loadOverview();
    this.loading = false;
    this.show(this.screen);
  }

  /**
   * Re-reads the topic list and progress while a free chat stays open, for example when a course it
   * grew into has just been compiled. A reply still being written is left alone; the chat is
   * reread only when none is.
   */
  async refreshAround(chatPath: string): Promise<void> {
    try {
      this.topics = await this.plugin.store.listTopics();
    } catch {
      this.topics = [];
    }
    await this.loadOverview();
    if (this.chatPath === chatPath && !this.study.busy) await this.openChat(chatPath).catch(() => undefined);
    this.renderNav();
    await this.mounted?.refresh?.();
  }

  /** Progress for every topic and the recent chats. One topic that cannot be read does not hide the others. */
  async loadOverview(): Promise<void> {
    const store = this.plugin.store;
    const infos: TopicInfo[] = [];
    for (const ref of this.topics) {
      try {
        const topic = await store.loadTopic(ref.dir);
        const state = ref.dir === this.dir && this.state ? this.state : await store.loadState(ref.dir, this.plugin.opts.targetLevel);
        const pre = await store.prereqs(ref.dir, topic);
        const sr = this.plugin.usesSr() ? await store.flashcardStats(ref.dir).catch(() => null) : null;
        // Home suggests what Adaptive study would do first, from the same policy decision.
        const policy = await this.plugin.engine.recommendTopic(ref.dir, sr ? sr.due : undefined).catch(() => undefined);
        infos.push(topicInfo(ref.dir, ref.title, state, pre, this.today, sr ? sr.due : undefined, policy));
      } catch (e) {
        console.error("Study Tutor: could not read topic", ref.dir, e);
      }
    }
    this.overview = infos;
    try {
      this.recent = await store.recentChats(8);
    } catch {
      this.recent = [];
    }
  }

  async loadState(): Promise<void> {
    if (!this.dir) return;
    const store = this.plugin.store;
    this.state = await store.loadState(this.dir, this.plugin.opts.targetLevel);
    this.pre = await store.prereqs(this.dir, this.topic ?? undefined);
    this.sr = null;
    if (this.plugin.usesSr()) {
      // The schedule lives in the flashcard note that Spaced Repetition maintains. Create the
      // note the first time; after that only read it, so its review history is never disturbed.
      try {
        this.sr = (await store.flashcardStats(this.dir)) ?? (await store.exportFlashcards(this.dir), await store.flashcardStats(this.dir));
      } catch {
        this.sr = null;
      }
    }
  }

  private async loadTopic(dir: string | null): Promise<void> {
    this.dir = dir;
    this.topic = null;
    this.state = null;
    this.chat = null;
    this.chatPath = null;
    this.pre = {};
    if (!dir) return;
    try {
      this.topic = await this.plugin.store.loadTopic(dir);
      await this.loadState();
      const chats = await this.plugin.store.listChats(dir);
      const remembered = this.plugin.data.activeChat[dir];
      const path = remembered && chats.includes(remembered) ? remembered : chats[chats.length - 1];
      if (path) await this.openChat(path, false);
      // A finished cold probe is not the chat a topic reopens on. (openChat set the chat, which TypeScript cannot see.)
      const opened = this.chat as Chat | null;
      if (opened && (fmStr(opened.fm, "probe_done") || fmStr(opened.fm, "assess_done"))) {
        this.chat = null;
        this.chatPath = null;
      }
      if (this.plugin.data.activeTopic !== dir) {
        this.plugin.data.activeTopic = dir;
        await this.plugin.save();
      }
    } catch (e) {
      new Notice(`Study Tutor: could not open the topic. ${(e as Error).message}`);
      this.dir = null;
      this.topic = null;
    }
  }

  /** Makes another topic the active one. The current screen stays where it is. */
  async selectTopic(dir: string | null): Promise<void> {
    if (dir === this.dir) return;
    if (this.study.busy) {
      new Notice("Wait for the current reply, or stop it, before changing topic.");
      this.renderNav();
      return;
    }
    await this.loadTopic(dir);
    this.renderNav();
    await this.mounted?.refresh?.();
  }

  async openChat(path: string, remember = true): Promise<void> {
    this.chat = await this.plugin.store.loadChat(path);
    this.chatPath = path;
    // A free question has no study mode and is never a topic's chat, so it is not remembered as one.
    if (this.free) return;
    const m = fmStr(this.chat.fm, "mode", "tutor") as Mode;
    this.mode = MODE_INFO.some((p) => p.mode === m) ? m : "tutor";
    // A finished cold probe or outcome check can be reread, but it is no longer the topic's chat.
    const done = !!fmStr(this.chat.fm, "probe_done") || !!fmStr(this.chat.fm, "assess_done");
    if (done && this.dir && this.plugin.data.activeChat[this.dir] === path) {
      delete this.plugin.data.activeChat[this.dir];
      await this.plugin.save();
    } else if (remember && !done && this.dir && this.plugin.data.activeChat[this.dir] !== path) {
      this.plugin.data.activeChat[this.dir] = path;
      await this.plugin.save();
    }
  }

  /**
   * Deletes a chat session (all its parts and session notes) and forgets its draft and its place
   * as a topic's remembered chat. If it is the open chat, nothing is open afterwards.
   */
  async deleteChat(path: string): Promise<void> {
    const removed = await this.plugin.store.deleteChat(path);
    for (const p of removed) delete this.plugin.data.drafts[p];
    for (const [dir, remembered] of Object.entries(this.plugin.data.activeChat)) if (removed.includes(remembered)) delete this.plugin.data.activeChat[dir];
    await this.plugin.save();
    if (this.chatPath && removed.includes(this.chatPath)) {
      this.chat = null;
      this.chatPath = null;
    }
    await this.loadOverview();
    this.renderNav();
  }

  /** Starts a new chat in a mode, reusing the current chat when it is still empty. */
  async newChat(mode: Mode): Promise<void> {
    if (!this.dir || !this.topic) return;
    this.mode = mode;
    if (this.chat && this.chatPath && !this.free && !this.chat.messages.length && !this.chat.summary) {
      this.chat.fm.mode = mode;
      await this.plugin.store.saveChat(this.chatPath, this.chat);
    } else await this.openChat(await this.plugin.store.newChat(this.dir, this.topic.title, mode));
  }

  /**
   * Opens the study screen. With `chatPath` it reopens that chat as it was left; with `mode` it
   * continues the current chat when it is already in that mode and otherwise starts a new one.
   */
  async startStudy(o: { dir?: string; mode?: Mode; chatPath?: string; focus?: number; begin?: boolean } = {}): Promise<void> {
    if (this.study.busy) {
      this.show("study");
      return;
    }
    try {
      if (o.dir && o.dir !== this.dir) await this.loadTopic(o.dir);
      if (!this.dir || !this.topic) {
        this.show("home");
        return;
      }
      if (o.focus && this.state && o.focus in this.state.names && this.state.focus !== o.focus) {
        this.state.focus = o.focus;
        await this.plugin.store.saveState(this.dir, this.state);
      }
      // A cold probe is in quiz mode too, but is never continued as practice; a free question is never continued as study.
      const probe = !!this.chat && (fmStr(this.chat.fm, "probe") === "yes" || fmStr(this.chat.fm, "assess") === "outcome" || this.free);
      if (o.chatPath) await this.openChat(o.chatPath);
      else if (o.mode && !(this.chat && !probe && this.mode === o.mode && !o.focus)) await this.newChat(o.mode);
      else if (!this.chat || this.free) await this.newChat(o.mode ?? this.mode);
    } catch (e) {
      new Notice(`Study Tutor: ${(e as Error).message}`);
    }
    this.show("study");
    if (o.begin && this.chat && !this.chat.messages.length && this.mode !== "expert") void this.study.send("");
  }

  /** Opens an outcome check on a topic (a new one, or the one not marked yet). */
  async startAssessment(dir: string): Promise<void> {
    try {
      const chatPath = await this.plugin.engine.startAssessment(dir);
      if (chatPath) {
        await this.startStudy({ dir, chatPath });
        return;
      }
      new Notice("This topic has no outcome yet. Recompile it to plan one.");
    } catch (e) {
      new Notice(`Study Tutor: ${(e as Error).message}`);
    }
  }

  /** Starts a cold probe on a topic and opens it. When nothing is ready any more, the screen is only redrawn. */
  async startProbe(dir: string): Promise<void> {
    try {
      const made = await this.plugin.engine.startProbe(dir);
      if (made) {
        await this.startStudy({ dir, chatPath: made.chatPath });
        return;
      }
    } catch (e) {
      new Notice(`Study Tutor: ${(e as Error).message}`);
    }
    this.screens[this.screen].refresh?.();
  }

  /**
   * Asks a free question from Home: a new chat in the Ask folder, opened on the study screen with
   * the message sent as its first turn. It needs no topic, and the open topic stays as it was.
   */
  async startAsk(message: string): Promise<boolean> {
    const text = message.trim();
    if (!text) return false;
    if (this.study.busy) {
      new Notice("Wait for the current reply, or stop it, before asking another question.");
      return false;
    }
    try {
      const path = await this.plugin.engine.startAsk(text);
      await this.openChat(path);
    } catch (e) {
      new Notice(`Study Tutor: ${(e as Error).message}`);
      return false;
    }
    this.show("study");
    void this.study.send(text);
    return true;
  }

  /** Reopens a free question from Home's Recent questions, as it was left. */
  async openAsk(path: string): Promise<void> {
    if (this.study.busy) {
      new Notice("Wait for the current reply, or stop it, before opening another question.");
      return;
    }
    try {
      await this.openChat(path);
    } catch (e) {
      new Notice(`Study Tutor: ${(e as Error).message}`);
      return;
    }
    this.show("study");
    this.study.refresh();
  }

  /** Acts on a suggested step: the review screen, or a chat in the right mode on the right concept. */
  async follow(step: NextStep, dir?: string): Promise<void> {
    if (step.action === "done") return;
    if (step.action === "review") {
      if (dir && dir !== this.dir) await this.selectTopic(dir);
      this.show("review");
      return;
    }
    await this.startStudy({ dir, mode: step.action, focus: step.subskill });
  }

  /** Called when a turn or a review changed the learner state, so every screen shows the same thing. */
  async stateChanged(state?: LearnerState): Promise<void> {
    if (state) this.state = state;
    else await this.loadState();
    await this.loadOverview();
    this.renderNav();
  }

  md(el: HTMLElement, text: string): void {
    // Everything shown here is a model's words, a web page's, or a chat saved by an earlier version.
    void MarkdownRenderer.render(this.app, neutraliseRemote(text), el, this.chatPath ?? this.dir ?? "", this.rendered ?? this).then(() => dropRemote(el));
  }

  // ---------- navigation ----------

  go(screen: ScreenName): void {
    this.show(screen);
  }

  /** Kept for the "Review due flashcards" command. */
  async showTab(tab: "review" | "chat" | "map"): Promise<void> {
    this.show(tab === "review" ? "review" : tab === "map" ? "graph" : "study");
  }

  private show(screen: ScreenName): void {
    if (this.loading) {
      this.screen = screen;
      return;
    }
    // Study, review and the topic page need a topic, except a free question on the study screen. Without one, home explains what to do.
    if (!this.dir && ((screen === "study" && !this.free) || screen === "review" || screen === "topic")) screen = "home";
    this.mounted?.unmount?.();
    if (this.rendered) this.removeChild(this.rendered);
    this.rendered = this.addChild(new Component());
    this.screen = screen;
    this.contentEl.setAttribute("data-screen", screen);
    this.renderNav();
    this.mainEl.empty();
    this.mounted = this.screens[screen];
    void this.mounted.mount(this.mainEl);
  }

  renderNav(): void {
    const nav = this.navEl;
    nav.empty();
    // No logo or name here: the pane's own tab already says Study Tutor, and Home is the first tab.
    // The <nav> has no aria-label: Obsidian turns every aria-label into a hover tooltip, and one on
    // the whole bar covered the graph's view buttons while the pointer rested on the tabs.
    const tabs = nav.createEl("nav", { cls: "st-nav-tabs" });
    const due = this.info?.due ?? 0;
    for (const item of NAV) {
      const active = this.screen === item.screen || (item.screen === "home" && this.screen === "topic");
      const b = tabs.createEl("button", { cls: "st-nav-tab" + (active ? " is-active" : ""), attr: active ? { "aria-current": "page" } : {} });
      setIcon(b.createSpan({ cls: "st-nav-icon" }), item.icon);
      b.createSpan({ cls: "st-nav-label", text: item.label });
      if (item.screen === "review" && due) b.createSpan({ cls: "st-badge", text: String(due), attr: { "aria-label": `${due} due` } });
      b.disabled = !this.dir && ((item.screen === "study" && !this.free) || item.screen === "review");
      b.onclick = () => this.show(item.screen);
    }

    const end = nav.createDiv({ cls: "st-nav-end" });
    if (this.topics.length) {
      const sel = end.createEl("select", { cls: "dropdown st-topic-select", attr: { "aria-label": "Current topic" } });
      for (const t of this.topics) sel.createEl("option", { text: t.title, value: t.dir });
      if (this.dir) sel.value = this.dir;
      sel.onchange = () => void this.selectTopic(sel.value || null);
    }
    iconButton(end, "plus", "New topic", () => this.plugin.openNewTopic());
    iconButton(end, "settings", "Study Tutor settings", () => this.plugin.openSettings());
    iconButton(end, "more-horizontal", "More tools", (e) => this.moreMenu(e));
  }

  /** Secondary and advanced tools, kept out of the way in one menu that is in the same place on every screen. */
  private moreMenu(e: MouseEvent): void {
    const menu = new Menu();
    const open = (path: string) => void this.app.workspace.openLinkText(path, "", true);
    const dir = this.dir;
    if (dir) {
      menu.addItem((i) => i.setTitle("Topic overview").setIcon("list").onClick(() => this.show("topic")));
      menu.addItem((i) => i.setTitle("Open topic card").setIcon("file-text").onClick(() => open(`${dir}/topic.md`)));
      menu.addItem((i) => i.setTitle("Open question bank").setIcon("help-circle").onClick(() => open(`${dir}/questions.md`)));
      menu.addItem((i) => i.setTitle("Open evidence log").setIcon("clipboard-list").onClick(() => open(`${dir}/evidence.md`)));
      menu.addSeparator();
    }
    menu.addItem((i) => i.setTitle("How levels and choices are decided").setIcon("scale").onClick(() => open(`${this.plugin.store.skillsDir}/policy.md`)));
    menu.addItem((i) => i.setTitle("Compare policy with logged decisions").setIcon("git-compare").onClick(() => void this.comparePolicy()));
    menu.addItem((i) => i.setTitle("Edit teaching instructions").setIcon("pencil").onClick(() => open(`${this.plugin.store.skillsDir}/core.md`)));
    menu.addItem((i) => i.setTitle("Reload from vault").setIcon("refresh-cw").onClick(() => void this.reload()));
    menu.showAtMouseEvent(e);
  }

  /** Replays the logged decisions through other weights and writes what would have changed. */
  private async comparePolicy(): Promise<void> {
    const cases = await this.plugin.store.loadDecisions();
    if (!cases.length) {
      new Notice("No decisions are logged yet. Study in Adaptive or Learn mode first.");
      return;
    }
    const mine = this.plugin.opts.weights ?? DEFAULT_WEIGHTS;
    const table = (name: string, r: ReturnType<typeof replay>) => [`## ${name}`, "", `${r.same} of ${r.total} logged decisions would be the same.`, "", ...(r.changed.length ? ["| When | Topic | Was | Would be |", "| --- | --- | --- | --- |", ...r.changed.slice(-40).map((c) => `| ${c.t.slice(0, 16).replace("T", " ")} | ${c.topic} | ${c.was} | ${c.now} |`)] : []), ""];
    const lines = ["# Policy comparison", "", `Written ${this.today}. ${cases.length} logged decisions were replayed through the current policy code with three sets of weights. A decision counts as changed when the action or the concept differs from what was logged.`, "", ...table("Your current weights", replay(cases, mine)), ...table("Default weights", replay(cases, DEFAULT_WEIGHTS)), ...table("Version 1 weights (priority and distance from target only)", replay(cases, V1_WEIGHTS))];
    const path = await this.plugin.store.writeNote("_logs/Policy comparison.md", lines.join("\n"));
    void this.app.workspace.openLinkText(path, "", true);
  }
}
