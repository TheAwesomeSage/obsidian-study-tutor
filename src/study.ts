// The study screen: the conversation, the open question, and the answer area.
//
// The screen is built once and then updated in place. New messages are appended, the composer
// is never rebuilt while you type, and the list only follows the newest message when you were
// already reading the end. The screen object outlives its DOM, so a reply that arrives while
// you are on another screen is waiting when you come back.

import { Notice, setIcon } from "obsidian";
import { addUsage } from "./claude";
import { Material, TurnResult, PresentationOutcome } from "./engine";
import { Attempt, gradingLabel } from "./evidence";
import { Mode, fmStr } from "./formats";
import { ACTION_LABEL, Action, POLICY_VERSION } from "./policy";
import { bktTrace, brierComparison, comparisonLine, mcqOptions, shadowLine } from "./bkt";
import { SessionRecord, openQuestion, sessionFor } from "./session";
import { toolLine } from "./tools";
import { moveLine } from "./tutormove";
import { reasoningLines } from "./reasoning";
import { conclusive, markLine } from "./grading";
import { isBankId } from "./bankvariants";
import { askCourse, askCourseSeed } from "./engine-ask";
import { coverageOf, coverageSummary } from "./coverage";
import { codeRunSummary, codeTestRows } from "./codequestions";
import { expansionLine } from "./expansion";
import { ConfidencePicker, confidenceLabel, DEFAULT_CONFIDENCE } from "./confidence";
export { CONFIDENCE_LEVELS, confidenceLabel } from "./confidence";
import { activityContext, calibrationCue, type ActivityContext } from "./learning-context";
import type { Screen, TutorView } from "./view";
import { chooseAttachment } from "./attachments";
import { CodeWorkspaceModal } from "./codeworkspace-modal";
import { fencedCode, wantsCodeWalkthrough } from "./codewalkthrough";
import {chatAttachment} from './chat-attachment';
import { MODE_INFO, button, chip, confirmAction, iconButton, modeInfo } from "./ui";

const ROUTE_NOTE: Record<string, string> = { simple: "utility model", standard: "chat model", complex: "chat model, extra thinking" };
const k = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
/** A trailing status line the engine appends to a reply when SymPy computed or checked something. */
const SYMPY_LINE = /\n\n(\*SymPy [^\n]*\*|\*\*SymPy disagrees\*\*[^\n]*)\s*$/;

export class StudyScreen implements Screen {
  busy = false;
  private kill: (() => void) | null = null;
  private error = "";
  private stopped = false;
  private last: TurnResult | null = null;
  private activity: { outcome: PresentationOutcome; dir: string; chatPath: string } | null = null;
  private changes: string[] = [];
  /** The attempt marked on the last turn, shown with how it was checked and a way to dispute it. */
  private marked: Attempt | null = null;
  private markedNote = "";
  /** Confidence for the answer being written; defaults to 50%, or null if explicitly cleared. */
  private confidence: number | null = DEFAULT_CONFIDENCE;
  private attachment?: Material;
  private attachmentChatPath?: string | null;
  private lastAttachments = new Map<string, Material>();
  private visualContext: { chatPath: string; value: ActivityContext } | null = null;
  private whyOpen = false;
  private saveDrafts = 0;

  private el: HTMLElement | null = null;
  private headEl!: HTMLElement;
  private whyEl!: HTMLElement;
  private scrollEl!: HTMLElement;
  private listEl!: HTMLElement;
  private tailEl!: HTMLElement;
  private quickEl!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private confEl!: HTMLElement;
  private confPicker!: ConfidencePicker;
  private attachBtn!: HTMLButtonElement;
  private sendBtn!: HTMLButtonElement;
  private diagEl!: HTMLElement;
  private shownPath: string | null = null;
  private shownCount = 0;

  constructor(private view: TutorView) {}

  // ---------- lifecycle ----------

  mount(el: HTMLElement): void {
    this.el = el;
    const v = this.view;
    const page = el.createDiv({ cls: "st-study" });
    this.headEl = page.createDiv({ cls: "st-study-head" });
    this.whyEl = page.createDiv({ cls: "st-why" });
    this.scrollEl = page.createDiv({ cls: "st-scroll", attr: { tabindex: "0", role: "log", "aria-label": "Conversation", "aria-live": "polite" } });
    const column = this.scrollEl.createDiv({ cls: "st-column" });
    this.listEl = column.createDiv({ cls: "st-messages" });
    this.tailEl = column.createDiv({ cls: "st-tail" });

    // A shallow answer box with one compact toolbar below it leaves more room for the chat.
    const dock = page.createDiv({ cls: "st-dock" });
    const inner = dock.createDiv({ cls: "st-column" });
    const composer = inner.createDiv({ cls: "st-composer" });
    this.quickEl = composer.createDiv({ cls: "st-quick st-side", attr: { role: "group", "aria-label": "Help with the open question" } });
    const main = composer.createDiv({ cls: "st-composer-main" });
    const right = composer.createDiv({ cls: "st-side is-right" });
    this.input = main.createEl("textarea", { cls: "st-input", attr: { rows: "1", "aria-label": "Your answer or message" } });
    this.input.oninput = () => this.keepDraft();
    this.input.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!this.busy && this.input.value.trim()) void this.send(this.input.value);
      }
    };
    const foot = main.createDiv({ cls: "st-composer-foot" });

    this.confPicker = new ConfidencePicker(foot, value => { this.confidence = value; });
    this.confEl = this.confPicker.el;

    this.attachBtn = foot.createEl("button", { cls: "st-btn is-ghost st-attach", attr: { "aria-pressed": "false" } });
    setIcon(this.attachBtn.createSpan({ cls: "st-btn-icon" }), "paperclip");
    this.attachBtn.createSpan({ cls: "st-btn-label", text: "Attach note" });
    this.attachBtn.onclick = () => {
      const chatPath = v.chatPath;
      void chooseAttachment(v.app, this.attachmentChatPath === chatPath ? this.attachment : v.chat ? chatAttachment(v.chat) : undefined).then(async material => {
        if (v.chatPath !== chatPath) return;
        if (material === null && v.chat && chatPath) {
          const previous = v.chat.fm.attachment;
          delete v.chat.fm.attachment;
          try { await v.plugin.store.saveChat(chatPath, v.chat); } catch { if (previous !== undefined) v.chat.fm.attachment = previous; new Notice("Could not remove the saved attachment. Try again."); return; }
          this.lastAttachments.delete(chatPath);
        }
        if (material !== undefined) { this.attachment = material ?? undefined; this.attachmentChatPath = chatPath; }
        if (this.el) this.syncComposer();
      });
    };

    this.sendBtn = right.createEl("button", { cls: "st-btn is-primary mod-cta st-send" });
    this.sendBtn.onclick = () => {
      if (this.busy) this.stop();
      else if (this.input.value.trim()) void this.send(this.input.value);
    };
    this.diagEl = inner.createEl("details", { cls: "st-diag" });
    // A request for linked material that settles while this chat is open updates its chip.
    v.plugin.engine.onExpansion = (_dir, rec) => {
      if (!this.el || this.last?.expansion?.request.id !== rec.request.id) return;
      this.last = { ...this.last, expansion: rec };
      this.sync();
    };

    this.shownPath = null;
    this.sync();
    this.input.value = (v.chatPath && v.plugin.data.drafts[v.chatPath]) || "";
    if (!this.busy) this.input.focus();
  }

  unmount(): void {
    this.flushDrafts();
    this.el = null;
  }

  refresh(): void {
    if (!this.el) return;
    this.error = "";
    this.changes = [];
    this.marked = null;
    this.last = null;
    this.sync();
    this.input.value = (this.view.chatPath && this.view.plugin.data.drafts[this.view.chatPath]) || "";
  }

  /** Stops the reply being generated. The learner's message is already saved. */
  stop(): void {
    this.kill?.();
  }

  // ---------- drafts ----------

  private keepDraft(): void {
    const v = this.view;
    if (!v.chatPath) return;
    const text = this.input.value;
    if (text) v.plugin.data.drafts[v.chatPath] = text;
    else delete v.plugin.data.drafts[v.chatPath];
    window.clearTimeout(this.saveDrafts);
    this.saveDrafts = window.setTimeout(() => void v.plugin.save(), 900);
  }

  private flushDrafts(): void {
    if (!this.saveDrafts) return;
    window.clearTimeout(this.saveDrafts);
    this.saveDrafts = 0;
    void this.view.plugin.save();
  }

  // ---------- state the screen reads ----------

  private record(): SessionRecord | null {
    const v = this.view;
    return v.chat && v.state && !v.free ? sessionFor(v.chat, v.state, v.mode) : null;
  }

  /** The question waiting for an answer, from the session record, a bank card, or the last tutor message. */
  private openQuestionText(): string {
    const v = this.view;
    const chat = v.chat;
    if (!chat) return "";
    const record = this.record();
    if (record?.pendingQuestion) return record.pendingQuestion;
    const lastMsg = chat.messages[chat.messages.length - 1];
    return lastMsg?.role === "tutor" ? openQuestion(lastMsg.text) : "";
  }

  // ---------- rendering ----------

  /** Brings every part of the screen in line with the current chat. Safe to call at any time. */
  sync(): void {
    if (!this.el) return;
    this.syncHead();
    this.syncWhy();
    this.syncMessages();
    this.syncTail();
    this.syncComposer();
    this.syncDiagnostics();
  }

  private syncHead(): void {
    const v = this.view;
    const h = this.headEl;
    h.empty();
    button(h, { label: "Home", icon: "arrow-left", tone: "ghost", title: "Back to home. Your session stays as it is.", onClick: () => v.go("home") });
    if (v.free) {
      // A free question has no topic, mode or guide's step: its title, its transcript, and a way to delete it.
      h.createSpan({ cls: "st-study-topic st-ellipsis", text: fmStr(v.chat!.fm, "title") || "Free question" });
      const end = h.createDiv({ cls: "st-study-end" });
      if (v.chatPath) iconButton(end, "file-text", "Open this chat's transcript as a note", () => void v.app.workspace.openLinkText(v.chatPath!, "", true));
      if (v.chatPath) iconButton(end, "trash-2", "Delete this question", () => void this.deleteSession()).disabled = this.busy;
      return;
    }
    const title = h.createEl("button", { cls: "st-study-topic", attr: { "aria-label": `Topic: ${v.topic?.title ?? ""}. Open the topic overview.` } });
    title.createSpan({ cls: "st-ellipsis", text: v.topic?.title ?? "" });
    title.onclick = () => v.go("topic");

    // Explicit modes are overrides, always in the same place. Changing mode keeps the chat and its open question.
    const seg = h.createDiv({ cls: "st-seg st-modes", attr: { role: "group", "aria-label": "Study mode" } });
    for (const m of MODE_INFO) {
      const b = seg.createEl("button", { cls: "st-seg-btn" + (m.mode === v.mode ? " is-active" : ""), attr: { "aria-pressed": String(m.mode === v.mode), "aria-label": `${m.label}. ${m.hint}` } });
      setIcon(b.createSpan({ cls: "st-seg-icon" }), m.icon);
      b.createSpan({ text: m.label });
      b.disabled = this.busy;
      b.onclick = () => void this.setMode(m.mode);
    }
    const sel = h.createEl("select", { cls: "dropdown st-mode-select", attr: { "aria-label": "Study mode" } });
    for (const m of MODE_INFO) sel.createEl("option", { value: m.mode, text: m.label });
    sel.value = v.mode;
    sel.disabled = this.busy;
    sel.onchange = () => void this.setMode(sel.value as Mode);

    const end = h.createDiv({ cls: "st-study-end" });
    // In Adaptive and Learn, the step the guide chose is one small button; its reasons open on demand.
    const record = this.record();
    const label = record ? ACTION_LABEL[record.action as Action] : undefined;
    if ((v.mode === "auto" || v.mode === "teach") && record?.reason && label) {
      const why = end.createEl("button", { cls: "st-btn is-ghost st-why-btn" + (this.whyOpen ? " is-on" : ""), attr: { "aria-expanded": String(this.whyOpen), "aria-label": `${label}. Why this step?` } });
      setIcon(why.createSpan({ cls: "st-btn-icon" }), "lightbulb");
      why.createSpan({ cls: "st-btn-label", text: label });
      why.onclick = () => {
        this.whyOpen = !this.whyOpen;
        this.syncHead();
        this.syncWhy();
      };
    }
    const fresh = iconButton(end, "message-square-plus", "New chat in this mode", async () => {
      await v.newChat(v.mode);
      this.refresh();
      this.input.focus();
    });
    fresh.disabled = this.busy;
    if (v.chatPath) iconButton(end, "file-text", "Open this chat's transcript as a note", () => void v.app.workspace.openLinkText(v.chatPath!, "", true));
    if (v.chatPath) iconButton(end, "trash-2", "Delete this session and start a new one", () => void this.deleteSession()).disabled = this.busy;
  }

  /**
   * Deletes the open session, every earlier part of it and its session notes (to the trash), then
   * starts a fresh chat in the same mode. Answers, levels and saved activities are kept.
   */
  private async deleteSession(): Promise<void> {
    const v = this.view;
    const path = v.chatPath;
    if (!path || this.busy) return;
    if (v.free) {
      const ok = await confirmAction(v.app, { title: "Delete this question?", text: "The conversation is moved to the trash. Nothing else changes.", confirm: "Delete" });
      if (!ok) return;
      try {
        await v.deleteChat(path);
        v.go("home");
      } catch (e) {
        new Notice(`Study Tutor: the question could not be deleted. ${(e as Error).message}`);
      }
      return;
    }
    const ok = await confirmAction(v.app, {
      title: "Delete this session?",
      text: "The conversation, its earlier parts and its session notes are moved to the trash, and a new session starts in the same mode. Your answers, levels and saved activities are kept.",
      confirm: "Delete and start new",
    });
    if (!ok) return;
    try {
      await v.deleteChat(path);
      this.activity = null;
      this.whyOpen = false;
      await v.newChat(v.mode);
      this.refresh();
      this.input.focus();
      new Notice("Session deleted. A new one has started.");
    } catch (e) {
      new Notice(`Study Tutor: the session could not be deleted. ${(e as Error).message}`);
    }
  }

  /** The reasons behind the guide's chosen step, shown only when asked for from the header. */
  private syncWhy(): void {
    const el = this.whyEl;
    el.empty();
    const v = this.view;
    const record = this.record();
    const decision = this.last?.decision;
    const reason = record?.reason || "";
    const show = this.whyOpen && !!reason && (v.mode === "auto" || v.mode === "teach");
    el.toggleClass("is-empty", !show);
    if (!show) return;
    const box = el.createDiv({ cls: "st-why-detail" });
    const label = ACTION_LABEL[record!.action as Action];
    box.createDiv({ cls: "st-why-reason", text: label ? `${label}: ${reason}` : reason });
    // How many of this concept's ideas have been asked and secured (coverage.ts), once the bank is read.
    const { dir, topic, state } = v;
    const focus = record!.skill;
    if (dir && topic && state && focus !== null) {
      void v.plugin.store.loadQuestions(dir).then((qs) => {
        const sum = coverageSummary(coverageOf(topic, qs, state, focus));
        if (sum.total > 1 && box.isConnected) box.createDiv({ cls: "st-meta", text: `Ideas in this concept: ${sum.asked} of ${sum.total} asked, ${sum.secured} secured.` });
      }).catch(() => undefined);
    }
    if (!decision) {
      box.createDiv({ cls: "st-meta", text: `Policy version ${POLICY_VERSION}. The scores behind this step are shown after the next turn.` });
      return;
    }
    if (decision.constraint) box.createDiv({ text: `Rule applied: ${decision.constraint}.` });
    if (decision.local) box.createDiv({ text: decision.local === "bank" ? "Handled by the plugin: a bank question, marked without a model call." : "Handled by the plugin: placement questions, marked without a model call." });
    if (decision.scores.length) {
      const table = box.createEl("table", { cls: "st-table st-score-table" });
      const hr = table.createEl("thead").createEl("tr");
      for (const t of ["Concept", "Score", "Gap", "Priority", "Rests on it", "Errors", "Uncertainty", "Recency"]) hr.createEl("th", { text: t });
      const tb = table.createEl("tbody");
      for (const s of decision.scores.slice(0, 5)) {
        const tr = tb.createEl("tr", { cls: s.n === decision.focus ? "is-focus" : "" });
        tr.createEl("td", { text: s.name });
        for (const x of [s.score, s.parts.gap, s.parts.exam, s.parts.prerequisite, s.parts.errors, s.parts.uncertainty, s.parts.recency]) tr.createEl("td", { cls: "st-num", text: x.toFixed(2) });
      }
    }
    const exam = decision.scores.find((s) => s.n === decision.focus)?.exam;
    if (exam) box.createDiv({ cls: "st-meta", text: `Exam: ${exam.about || "metadata given"}. ${exam.note || "It does not change the ranking here."}` });
    box.createDiv({ cls: "st-meta", text: `Policy version ${POLICY_VERSION}. Scores only rank what to study next. Levels change through marked answers and nothing else. Weights are in settings.` });
  }

  private syncMessages(): void {
    const v = this.view;
    const chat = v.chat;
    const list = this.listEl;
    const scroll = this.scrollEl;
    const atEnd = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 96;
    const messages = chat?.messages ?? [];
    const rebuild = this.shownPath !== v.chatPath || messages.length < this.shownCount;
    if (rebuild) {
      list.empty();
      this.shownCount = 0;
      this.shownPath = v.chatPath;
      if (chat?.summary) {
        const sum = list.createEl("details", { cls: "st-summary" });
        sum.createEl("summary", { text: `Summary of earlier parts (this is part ${fmStr(chat.fm, "part", "1")})` });
        v.md(sum.createDiv({ cls: "st-text" }), chat.summary);
        const prev = /^\[\[([^\]|]+)/.exec(fmStr(chat.fm, "previous"));
        if (prev) button(sum, { label: "Open the earlier transcript", icon: "file-text", tone: "ghost", onClick: () => void v.app.workspace.openLinkText(`${prev[1]}.md`, "", true) });
      }
    }
    const who = v.free ? "Tutor" : modeInfo(v.mode).who;
    for (let i = this.shownCount; i < messages.length; i++) {
      const m = messages[i];
      const box = list.createDiv({ cls: `st-msg is-${m.role}` });
      box.createDiv({ cls: "st-who", text: m.role === "you" ? "You" : who });
      const note = m.role === "tutor" ? SYMPY_LINE.exec(m.text) : null;
      v.md(box.createDiv({ cls: "st-text" }), note ? m.text.slice(0, note.index) : m.text);
      // Verification is reported under the message it belongs to, small enough not to compete with it.
      if (note) {
        const bad = /disagrees/.test(note[1]);
        const c = box.createDiv({ cls: `st-verify${bad ? " is-bad" : ""}` });
        setIcon(c.createSpan({ cls: "st-chip-icon" }), bad ? "alert-triangle" : "check-circle");
        v.md(c.createSpan({ cls: "st-verify-text" }), note[1].replace(/^\*(?!\*)|(?<!\*)\*$/g, ""));
      }
    }
    const grew = messages.length > this.shownCount;
    this.shownCount = messages.length;
    list.toggleClass("is-empty", !messages.length && !chat?.summary);
    if (rebuild || (grew && atEnd) || this.busy) window.setTimeout(() => (scroll.scrollTop = scroll.scrollHeight), 30);
  }

  /** Everything after the last message: the empty state, what was just recorded, progress and errors. */
  private syncTail(): void {
    const v = this.view;
    const tail = this.tailEl;
    tail.empty();
    const chat = v.chat;
    const probe = chat ? fmStr(chat.fm, "probe") === "yes" : false;
    const assess = chat ? fmStr(chat.fm, "assess") === "outcome" : false;
    const info = modeInfo(v.mode);
    const lastMsg = chat?.messages[chat.messages.length - 1];

    if (v.free) {
      // A free question: no level, step, activity or Continue. Only the reply, or a way to get it.
      tail.createDiv({ cls: "st-notice st-ask-banner", text: "Free question. Nothing here counts toward a level." });
      if (this.busy) this.thinking(tail);
      else if (this.error) this.problem(tail);
      else if (lastMsg?.role === "you") {
        const box = tail.createDiv({ cls: "st-notice" });
        box.createSpan({ text: "This message has not been answered yet." });
        button(box, { label: "Get the reply", icon: "refresh-cw", onClick: () => void this.send("") });
      } else if (lastMsg?.role === "tutor" && chat) this.courseOffer(tail, chat);
      return;
    }

    if (!chat || (!chat.messages.length && !chat.summary)) {
      if (this.busy) return void this.thinking(tail);
      const box = tail.createDiv({ cls: "st-empty" });
      setIcon(box.createDiv({ cls: "st-empty-icon" }), info.icon);
      box.createDiv({ cls: "st-empty-title", text: `${info.label} · ${v.topic?.title ?? ""}` });
      box.createDiv({ cls: "st-empty-text", text: info.hint });
      if (info.start) button(box, { label: info.start, icon: "play", tone: "primary", onClick: () => void this.send("") });
      else box.createDiv({ cls: "st-meta", text: "Type your question below." });
      if (this.error) this.problem(tail);
      return;
    }

    if (probe) tail.createDiv({ cls: "st-notice st-probe-banner", text: "Cold probe: sealed questions, no help, levels unchanged." });
    if (assess) tail.createDiv({ cls: "st-notice st-probe-banner st-assess-banner", text: "Outcome check: on your own, marked by a separate assessor, levels unchanged." });
    if (this.changes.length) chip(tail, `Progress updated: ${this.changes.join("; ")}`, "good", "trending-up");
    if (this.marked) this.feedback(tail, this.marked);
    this.expansionChip(tail);
    const activity = this.activity;
    if (activity && !probe && !assess && activity.dir === v.dir && activity.chatPath === v.chatPath) {
      const out = activity.outcome;
      const card = tail.createDiv({ cls: "st-notice st-activity-offer" });
      card.createDiv({ cls: "st-meta", text: out.decision.reason });
      if (out.lesson) {
        const row = card.createDiv({ cls: "st-actions" });
        button(row, { label: "Reopen activity", icon: "play", onClick: () => this.openActivity(out, activity.dir, activity.chatPath) });
        // Fresh numbers come from module code with a new seed; the saved configuration is reused, no model is called.
        const saved = out.activity;
        if (saved && saved.status === "ready" && !saved.bankQuestion) button(row, { label: "New numbers", icon: "shuffle", tone: "ghost", title: "New numbers: the same activity with different values, made by the module itself. Uses no model.", onClick: async () => {
          try {
            const next = await v.plugin.engine.openActivity(activity.dir, saved.id, { chatPath: activity.chatPath, variantSeed: Math.floor(Math.random() * 1_000_000) });
            if (JSON.stringify(next.lesson?.settings) === JSON.stringify(saved.lesson?.settings)) new Notice("This activity has no numeric variants; it opens as saved.");
            this.openActivity({ ...next, request: out.request }, activity.dir, activity.chatPath);
          } catch (error) { new Notice((error as Error).message); }
        } });
      } else if (out.decision.status === "offer") {
        const open = button(card, { label: `Open ${out.decision.kind}`, icon: "play" });
        open.disabled = this.busy;
        open.onclick = async () => {
          open.disabled = true; open.setText("Preparing activity…");
          try {
            const next = await v.plugin.engine.requestActivity(activity.dir, { kind: out.decision.kind, concept: out.concept ?? v.state?.focus ?? undefined, chatPath: activity.chatPath, preferredModuleId: out.decision.moduleId ?? undefined });
            activity.outcome = next;
            if (v.dir === activity.dir && v.chatPath === activity.chatPath) this.openActivity(next, activity.dir, activity.chatPath);
          } catch (error) { new Notice((error as Error).message); }
          finally { this.sync(); }
        };
      } else if (out.activity?.status === "invalid" && out.activity.reason && out.activity.reason !== out.decision.reason) {
        // A configuration that failed its checks says why; an unsupported request is already
        // explained by the decision's reason, and a text or diagram reply needs no extra line.
        card.createDiv({ cls: "st-meta", text: out.activity.reason });
      }
    }

    if (this.busy) this.thinking(tail);
    else if (this.error) this.problem(tail);
    else if (lastMsg?.role === "you") {
      // The learner's message was saved but never answered: the app was closed, or a call failed earlier.
      const box = tail.createDiv({ cls: "st-notice" });
      box.createSpan({ text: "This message has not been answered yet." });
      button(box, { label: "Get the reply", icon: "refresh-cw", onClick: () => void this.send("") });
    } else if (v.mode !== "expert" && !assess && lastMsg?.role === "tutor" && !this.openQuestionText() && !fmStr(chat.fm, "card")) {
      button(tail, { label: "Continue", icon: "arrow-right", tone: fmStr(chat.fm, "await_continue") === "yes" || /^\*\*Placement done|\n\*\*Placement done/.test(lastMsg.text) ? "primary" : "secondary", cls: "st-continue", onClick: () => void this.send("") });
    }
  }

  private thinking(parent: HTMLElement): void {
    const t = parent.createDiv({ cls: "st-thinking", attr: { role: "status" } });
    t.createSpan({ cls: "st-dots" });
    t.createSpan({ text: "Working on a reply…" });
  }

  private openActivity(outcome: PresentationOutcome, dir: string, chatPath: string): void {
    const v = this.view;
    if (!outcome.lesson) return;
    const request = outcome.request ?? { version: 1 as const, kind: outcome.decision.kind, reason: outcome.decision.reason, objective: outcome.lesson.objective, sourceRefs: outcome.lesson.sourceRefs };
    let hintUsed = false;
    // Serialize writes so rapid checks cannot overwrite each other's evidence records.
    let recording = Promise.resolve();
    this.visualContext = { chatPath, value: { ...activityContext(outcome.lesson, { version: 1, type: "opened", moduleId: outcome.lesson.moduleId, reason: request.reason }), skill: outcome.concept ?? undefined } };
    v.presentActivity(outcome.lesson, request, event => {
      this.visualContext = { chatPath, value: activityContext(outcome.lesson!, event, this.visualContext?.chatPath === chatPath && this.visualContext.value.moduleId === outcome.lesson!.moduleId ? this.visualContext.value : undefined) };
      if (event.type === "hint") hintUsed = true;
      if (event.type !== "assessment" || !outcome.activity) return;
      const activityId = outcome.activity.id;
      recording = recording.then(async () => {
        // The lesson actually played is passed, so an answer in a numeric variant is checked against that variant.
        const marked = await v.plugin.engine.recordActivityResult(dir, activityId, event.response, { chatPath, hintUsed, lesson: outcome.lesson });
        if (v.dir === dir) {
          this.marked = marked.attempt;
          this.changes = marked.changes;
          // A part of a task answered in its activity moves the chat on to the next part.
          if (marked.advanced) {
            this.activity = marked.presentation ? { outcome: marked.presentation, dir, chatPath } : null;
            if (v.chatPath === chatPath) await v.openChat(chatPath);
            if (marked.presentation && this.el && v.screen === "study") this.openActivity(marked.presentation, dir, chatPath);
          } else if (marked.notPart) new Notice(marked.notPart, 8000);
          await v.loadState();
          await v.stateChanged();
          this.sync();
        }
      }).catch(error => { new Notice(`The practice result could not be saved: ${(error as Error).message}`); });
    });
  }

  private problem(parent: HTMLElement): void {
    const box = parent.createDiv({ cls: `st-notice ${this.stopped ? "is-stopped" : "is-error"}`, attr: { role: this.stopped ? "status" : "alert" } });
    setIcon(box.createSpan({ cls: "st-chip-icon" }), this.stopped ? "pause" : "alert-circle");
    const text = box.createDiv({ cls: "st-grow" });
    text.createDiv({ cls: "st-notice-title", text: this.stopped ? "Stopped" : "That did not go through" });
    text.createDiv({ cls: "st-meta", text: this.stopped ? "Your message was saved. Nothing was marked." : `${this.error} Your message was saved and nothing was marked.` });
    button(box, { label: "Retry", icon: "refresh-cw", onClick: () => void this.send("") });
  }

  /** What was recorded for the answer just marked, how it was checked, and a way to contest it. */
  /** A request for linked material: preparing (with Cancel), ready, or not available. Study goes on either way. */
  private expansionChip(parent: HTMLElement): void {
    const v = this.view;
    const rec = this.last?.expansion;
    if (!rec || !v.dir) return;
    const tone = rec.status === "complete" ? "good" : rec.status === "partial" ? "warn" : rec.status === "pending" ? "accent" : "";
    const icon = rec.status === "pending" ? "loader" : rec.status === "complete" || rec.status === "partial" ? "link" : "circle-slash";
    const row = parent.createDiv({ cls: "st-actions st-expansion" });
    chip(row, expansionLine(rec), tone, icon);
    if (rec.status !== "pending") return;
    const dir = v.dir;
    button(row, {
      label: "Cancel",
      icon: "x",
      tone: "ghost",
      onClick: async () => {
        const done = await v.plugin.engine.cancelExpansion(dir, rec.request.id);
        if (done && this.last) this.last = { ...this.last, expansion: done };
        this.sync();
      },
    });
  }

  private feedback(parent: HTMLElement, a: Attempt): void {
    const v = this.view;
    const tone = a.verification === "disputed" || a.result === "ungraded" ? "" : a.result === "correct" ? "good" : a.result === "partial" ? "warn" : "bad";
    const box = parent.createDiv({ cls: `st-feedback${tone ? ` is-${tone}` : ""}` });
    const label = a.verification === "disputed" ? "Mark set aside" : { correct: "Marked correct", partial: "Marked partly right", incorrect: "Marked incorrect", skipped: "Skipped", ungraded: "Not marked" }[a.result];
    const line = box.createDiv({ cls: "st-feedback-line" });
    setIcon(line.createSpan({ cls: "st-chip-icon" }), a.verification === "disputed" ? "flag" : a.result === "correct" ? "check" : a.result === "ungraded" ? "help-circle" : a.result === "skipped" ? "skip-forward" : "x");
    line.createSpan({ cls: "st-feedback-label", text: label });
    const bits = [gradingLabel(a)];
    if (a.assisted) bits.push("with help");
    if (a.answerExposed) bits.push("answer already shown");
    if (a.confidence !== null) bits.push(`your confidence: ${confidenceLabel(a.confidence).toLowerCase()}`);
    if (a.seconds !== null) bits.push(a.seconds < 90 ? `${a.seconds}s` : `${Math.round(a.seconds / 60)} min`);
    line.createSpan({ cls: "st-meta", text: bits.join(" · ") });
    // A code answer: how many tests passed and what ran them, or why it was not run.
    if (a.code) box.createDiv({ cls: "st-meta", text: codeRunSummary(a.code) });
    const more = box.createEl("details", { cls: "st-feedback-more" });
    more.createEl("summary", { text: "How this was checked" });
    if (a.assumptions) more.createDiv({ cls: "st-meta", text: `Basis: ${a.assumptions}.` });
    more.createDiv({ cls: "st-meta", text: a.probe ? "This counts toward the unseen-task score only." : a.assisted || a.answerExposed ? "Because help was given or the answer had been seen, this does not count as unaided evidence." : a.grading === "self" ? "A self-rating does not count as evidence for a level." : a.result === "ungraded" ? "An unmarked answer changes nothing." : !conclusive(a) ? "The breakdown could not back this mark, so it does not count as evidence either way." : "This counts as unaided evidence." });
    const ml = markLine(a);
    if (ml) more.createDiv({ cls: "st-meta st-reasoning", text: ml });
    if (a.note) more.createDiv({ cls: "st-meta", text: a.note });
    const calibration = calibrationCue([a]);
    if (calibration) box.createDiv({ cls: "st-meta", text: calibration });
    // The result, the method and the assumptions, each with who decided it.
    if (a.reasoning) for (const l of reasoningLines(a.reasoning)) more.createDiv({ cls: "st-meta st-reasoning", text: l });
    // Each test, hidden ones named now that the answer is marked, with the first failures' details as plain text.
    if (a.code) {
      if (a.code.status === "compile-error" && a.code.message) more.createEl("pre", { cls: "st-meta", text: a.code.message });
      for (const row of codeTestRows(a.code)) {
        more.createDiv({ cls: "st-meta st-reasoning", text: row.line });
        if (row.detail) more.createEl("pre", { cls: "st-meta", text: row.detail });
      }
    }
    if (this.markedNote) box.createDiv({ cls: "st-meta", text: this.markedNote });
    if (a.result === "ungraded" || a.result === "skipped" || a.grading === "self" || this.busy || !v.dir) return;
    const row = box.createDiv({ cls: "st-actions" });
    const dir = v.dir;
    if (a.verification !== "disputed") {
      button(row, {
        label: "Dispute this mark",
        icon: "flag",
        tone: "ghost",
        onClick: async () => {
          try {
            const r = await v.plugin.engine.dispute(dir, a.id, v.chatPath ?? undefined);
            this.marked = r.attempt;
            this.changes = r.changes;
            // A probe chat never calls the tutor, and a sealed question has no regrade: the next message answers the next question.
            this.markedNote = a.probe ? "This answer no longer counts in the unseen-task score." : "The mark no longer counts either way. " + (isBankId(a.questionId) ? "You can ask for a second opinion, or carry on." : "The tutor will look at your answer again on your next message.");
            if (v.chatPath) v.chat = await v.plugin.store.loadChat(v.chatPath);
            await v.stateChanged(r.state);
          } catch (e) {
            new Notice(`Could not dispute the mark: ${(e as Error).message}`);
          }
          this.sync();
        },
      });
    } else if (isBankId(a.questionId)) {
      const b = button(row, { label: "Regrade with more thinking (uses tokens)", icon: "refresh-cw", tone: "ghost" });
      b.onclick = async () => {
        b.disabled = true;
        try {
          const r = await v.plugin.engine.regrade(dir, a.id);
          v.sessionUsage = addUsage(v.sessionUsage, r.usage);
          this.marked = r.attempt;
          this.changes = r.changes;
          this.markedNote = "Regraded by the chat model with more thinking.";
          await v.stateChanged(r.state);
        } catch (e) {
          new Notice(`Regrading failed, so the mark stays set aside: ${(e as Error).message}`);
        }
        this.sync();
      };
    }
  }

  private syncComposer(): void {
    const v = this.view;
    const question = v.free ? "" : this.openQuestionText();
    // An outcome check is one task marked by the assessor: no hints, explanations, skip button, visuals or confidence.
    const assess = v.chat ? fmStr(v.chat.fm, "assess") === "outcome" : false;
    // A free question gets no topic help (hints, explanations, skip, visuals) and no confidence: nothing is marked.
    const asking = v.mode === "expert" || v.free || assess;
    // A cold probe gives no help, so nothing that asks for a hint, an explanation or an activity is offered.
    const probe = v.chat ? fmStr(v.chat.fm, "probe") === "yes" : false;
    const NO_HELP = "No help during a cold probe";

    // Help with the open question, beside the box you type in.
    const q = this.quickEl;
    q.empty();
    if (!probe && !assess && !v.free) {
      const coach = v.chat && fmStr(v.chat.fm, "coding_coach") === "yes";
      const coachButton = button(q, { label: coach ? "Stop coding coach" : "Coding coach", title:coach?"Stop coding coach":"Start coding coach", icon: "code", tone: "ghost", onClick: () => void this.send(coach ? "Stop coding coach" : "Start coding coach") });
      coachButton.disabled = this.busy;
      if (v.chat && fmStr(v.chat.fm, "placement") === "on") {
        const skip = button(q, { label: "Skip pretest", icon: "skip-forward", tone: "ghost", onClick: () => void this.send("Skip pretest") });
        skip.disabled = this.busy;
      }
    }
    if (!probe && !assess) {
      const code = button(q, {label:"Code walkthrough",icon:"terminal",tone:"ghost",title:"Open code: step through a program, trace variables, view flow diagrams and run console input/output",onClick:()=>this.openCodeWorkspace()});
      code.disabled = this.busy;
    }
    q.toggleClass("is-empty", assess || probe);
    if (!asking) {
      const quick = (label: string, icon: string, message: string, title: string) => {
        const b = button(q, { label, icon, tone: "ghost", title: `${label}: ${title}`, onClick: () => void this.send(message) });
        const help = probe && label !== "Skip";
        b.disabled = this.busy || !question || help;
        if (help) { b.title = NO_HELP; b.setAttribute("aria-label", NO_HELP); }
      };
      quick("Hint", "life-buoy", "Hint please.", "ask for a hint. The answer then counts as helped.");
      quick("Explain", "book-open", "Explain this to me.", "ask for an explanation. The answer then counts as helped.");
      quick("Skip", "skip-forward", "skip", "skip this question and see the answer. It is recorded as skipped.");
      const activity = button(q, { label: "Visual", icon: "play", tone: "ghost", title: "Visual activity: ask for a simulation of this concept. Uses a saved activity or Ollama.", onClick: () => void this.send("Show me a simulation for this concept.") });
      activity.disabled = this.busy || probe;
      if (probe) { activity.title = NO_HELP; activity.setAttribute("aria-label", NO_HELP); }
    }

    this.input.placeholder = assess ? "Your answer to the task…  (Enter to send, Shift+Enter for a new line)" : v.free ? "Ask a follow-up…  (Enter to send, Shift+Enter for a new line)" : asking ? "Ask a question…  (Enter to send, Shift+Enter for a new line)" : question ? "Your answer…  (Enter to send, Shift+Enter for a new line)" : "Message…  (Enter to send, Shift+Enter for a new line)";
    this.attachBtn.disabled = this.busy;
    const attachment = (this.attachmentChatPath === v.chatPath ? this.attachment : undefined) ?? (v.chat ? chatAttachment(v.chat) : undefined);
    this.attachBtn.toggleClass("is-on", !!attachment);
    this.attachBtn.setAttribute("aria-pressed", String(!!attachment));
    this.attachBtn.querySelector(".st-btn-label")?.setText(attachment ? `Attached: ${attachment.name}` : "Attach note or file");
    this.attachBtn.setAttribute("aria-label", attachment ? `Attached: ${attachment.name}. Select to change or remove.` : "Attach a vault note or a text/code file");

    // Confidence goes with an answer. It can be chosen at any time (it is sent with your next
    // message and counts only if that message is marked), and is not offered in Ask mode.
    this.confEl.toggleClass("is-hidden", asking);
    this.confPicker.set(this.confidence, this.busy);

    this.sendBtn.empty();
    setIcon(this.sendBtn.createSpan({ cls: "st-btn-icon" }), this.busy ? "square" : "send");
    this.sendBtn.createSpan({ cls: "st-btn-label", text: this.busy ? "Stop" : "Send" });
    this.sendBtn.toggleClass("is-stop", this.busy);
    this.sendBtn.toggleClass("mod-cta", !this.busy);
  }

  /** Token use and technical detail, out of the way until wanted. */
  private syncDiagnostics(): void {
    const v = this.view;
    const d = this.diagEl;
    const wasOpen = d.hasAttribute("open");
    d.empty();
    if (wasOpen) d.setAttribute("open", "");
    d.createEl("summary", { text: "Details" });
    const body = d.createDiv({ cls: "st-diag-body" });
    const r = this.last;
    if (!r) body.createDiv({ text: "Token use and checks for the last turn appear here." });
    else if (r.usage.calls === 0) body.createDiv({ text: "Last turn: handled by the plugin, no tokens used." });
    else {
      const u = r.rotationUsage ? addUsage(r.usage, r.rotationUsage) : r.usage;
      const total = u.input + u.cacheRead + u.cacheWrite;
      body.createDiv({ text: `Last turn: ${k(total)} tokens in (${k(u.cacheRead)} read from cache, ${k(u.cacheWrite)} written to cache, ${k(u.input)} uncached) · ${k(u.output)} out · ${u.calls} call${u.calls === 1 ? "" : "s"}.` });
      body.createDiv({ text: `Measured cache share of input this turn: ${total ? Math.round((100 * u.cacheRead) / total) : 0}%.` });
      if (r.route && v.plugin.opts.smartRouting) body.createDiv({ text: `Model: ${ROUTE_NOTE[r.route.route]} (${r.route.model}), because: ${r.route.reason}.` });
      if (r.maths && (r.maths.computed || r.maths.checked)) body.createDiv({ text: `SymPy: computed ${r.maths.computed}, checked ${r.maths.checked}${r.maths.corrected ? ", one draft rewritten" : ""}${r.maths.disputed ? ", still disagrees" : ""}.` });
    }
    // Why the tutor did what it did: the move and its reason code, how deep the turn went, and any request for linked material.
    if (r?.move) body.createDiv({ cls: "st-diag-move", text: `${moveLine(r.move)}${r.move.chosen && r.move.chosen !== r.move.move ? ` · the tutor said it made: ${r.move.chosen}` : ""}.` });
    if (r?.depth?.level === "lesson") body.createDiv({ text: `Depth: lesson material, because ${r.depth.reason}.${r.depth.missing.length ? ` Missing from the course: ${r.depth.missing.join("; ")}.` : ""}` });
    if (r?.expansion) body.createDiv({ text: `${expansionLine(r.expansion)}.` });
    for (const n of r?.notes ?? []) body.createDiv({ text: `Note: ${n}.` });
    for (const t of r?.tools ?? []) body.createDiv({ text: `Tool: ${toolLine(t)}.` });
    this.shadowLines(body);
    const su = v.sessionUsage;
    const st = su.input + su.cacheRead + su.cacheWrite;
    body.createDiv({ text: `This sitting: ${k(st)} tokens in (${st ? Math.round((100 * su.cacheRead) / st) : 0}% from cache) · ${k(su.output)} out over ${su.calls} call${su.calls === 1 ? "" : "s"}.` });
  }

  /** Multiple-choice option counts of the open topic's bank, for BKT's guess floor. Loaded once per topic. */
  private bankOptions: { dir: string; options: Record<string, number> | null } | null = null;

  /** Knowledge tracing on the focus concept, in shadow (bkt.ts): shown and scored, never used to decide. */
  private shadowLines(body: HTMLElement): void {
    const v = this.view;
    const st = v.state;
    const n = st?.focus;
    if (!st || v.free || n === null || n === undefined || !(n in st.names) || !v.dir) return;
    if (this.bankOptions?.dir !== v.dir) {
      const dir = v.dir;
      this.bankOptions = { dir, options: null };
      void v.plugin.store.loadQuestions(dir).then(mcqOptions, () => ({})).then((options) => {
        if (this.bankOptions?.dir !== dir) return;
        this.bankOptions.options = options;
        this.syncDiagnostics();
      });
      return;
    }
    if (!this.bankOptions.options) return;
    const t = bktTrace(st.attempts, n, { options: this.bankOptions.options });
    body.createDiv({ text: `${shadowLine(t)}, on ${st.names[n]}.` });
    body.createDiv({ cls: "st-meta", text: `${comparisonLine(brierComparison([t]))}.` });
  }

  // ---------- actions ----------

  private async setMode(mode: Mode): Promise<void> {
    const v = this.view;
    if (this.busy || mode === v.mode) return;
    v.mode = mode;
    if (v.chat && v.chatPath) {
      v.chat.fm.mode = mode;
      await v.plugin.store.saveChat(v.chatPath, v.chat);
    }
    this.sync();
  }

  private async attachedNote(): Promise<Material | undefined> {
    return (this.attachmentChatPath === this.view.chatPath ? this.attachment : undefined) ?? (this.view.chat ? chatAttachment(this.view.chat) : undefined);
  }

  private codeContext(): string {
    const v = this.view;
    const pending = (this.attachmentChatPath === v.chatPath ? this.attachment : undefined) ?? (v.chat ? chatAttachment(v.chat) : undefined);
    return [v.topic?.subskills?.find(s => s.n === v.state?.focus)?.section, ...(v.chat?.messages.slice(-8).map(m => m.text) ?? []), (pending ?? this.lastAttachments.get(v.chatPath ?? ""))?.text].filter(Boolean).join("\n\n");
  }

  private openCodeWorkspace(message = ""): void {
    const v = this.view;
    if (this.busy || (v.chat && (fmStr(v.chat.fm,"probe") === "yes" || fmStr(v.chat.fm,"assess") === "outcome"))) return;
    // The most recent message wins; an explicitly attached source file takes precedence.
    const attached = (this.attachmentChatPath === v.chatPath ? this.attachment : undefined) ?? (v.chat ? chatAttachment(v.chat) : undefined) ?? this.lastAttachments.get(v.chatPath ?? "");
    const found = attached ? fencedCode(attached.text) ?? (/\.(py|cpp|cc|cxx|c|h|hpp)$/i.test(attached.name) ? {source:attached.text,language:/\.(cpp|cc|cxx|hpp)$/i.test(attached.name)?"cpp" as const:/\.c$/i.test(attached.name)?"c" as const:"python" as const}:null) : null;
    const latest = fencedCode(message) ?? found ?? fencedCode(this.codeContext());
    new CodeWorkspaceModal(v, latest?.source ?? "", latest?.language ?? "python").open();
  }

  /**
   * Under a free chat's reply: open the course it grew into, or make one from it. A broad goal is
   * offered as the main next step, with the first step it would start from; a narrow question
   * gets a quiet button only.
   */
  private courseOffer(tail: HTMLElement, chat: NonNullable<TutorView["chat"]>): void {
    const v = this.view;
    const course = askCourse(chat);
    if (course && v.overview.some((t) => t.dir === course)) {
      const box = tail.createDiv({ cls: "st-notice st-ask-course" });
      box.createSpan({ text: "This question has a course." });
      button(box, { label: "Open the course", icon: "book-open", tone: "primary", onClick: () => void v.selectTopic(course).then(() => v.go("topic")) });
      return;
    }
    const broad = fmStr(chat.fm, "ask_kind") === "broad";
    const step = fmStr(chat.fm, "first_step");
    const box = tail.createDiv({ cls: "st-notice st-ask-course" });
    if (broad) box.createSpan({ text: step ? `This is worth learning properly. A course would plan it step by step, starting with: ${step.replace(/[.\s]+$/, "")}.` : "This is worth learning properly. A course would plan it step by step." });
    const seed = askCourseSeed(chat);
    button(box, { label: "Make this a course", icon: "graduation-cap", tone: broad ? "primary" : undefined, onClick: () => v.chatPath && v.plugin.openNewTopic({ ...seed, fromAsk: v.chatPath }) });
  }

  /** A turn of a free question (engine-ask.ts): one model call, nothing marked, no learner state. */
  private async sendAsk(message: string): Promise<void> {
    const v = this.view;
    const chatPath = v.chatPath;
    if (!chatPath || !v.chat) return;
    const text = message.trim();
    this.busy = true;
    this.error = "";
    this.stopped = false;
    this.last = null;
    try {
      const attached = await this.attachedNote();
      const turn = v.plugin.engine.askTurn(chatPath, text, { attached, onSpawn: (kill) => (this.kill = kill) });
      if (text) {
        v.chat.messages.push({ role: "you", text });
        if (this.el) this.input.value = "";
        delete v.plugin.data.drafts[chatPath];
      }
      this.sync();
      const r = await turn;
      if (attached) this.lastAttachments.set(chatPath, attached);
      this.attachment = undefined;
      v.sessionUsage = addUsage(v.sessionUsage, r.usage);
      if (v.chatPath === chatPath) await v.openChat(chatPath);
    } catch (e) {
      this.error = (e as Error).message || String(e);
      this.stopped = this.error === "Stopped.";
      if (v.chatPath === chatPath) {
        try {
          v.chat = await v.plugin.store.loadChat(chatPath);
          const saved = v.chat.messages[v.chat.messages.length - 1];
          if (text && !(saved?.role === "you" && saved.text === text) && this.el && !this.input.value) {
            this.input.value = text;
            this.keepDraft();
          }
        } catch {
          /* keep what is on screen */
        }
      }
    } finally {
      this.busy = false;
      this.kill = null;
      this.sync();
      if (this.el && !this.error) this.input.focus();
    }
  }

  /** Sends a message. An empty message starts a chat, continues, or retries the last turn. */
  async send(message: string): Promise<void> {
    const v = this.view;
    if (!this.busy && wantsCodeWalkthrough(message, this.codeContext()) && !(v.chat && (fmStr(v.chat.fm,"probe") === "yes" || fmStr(v.chat.fm,"assess") === "outcome"))) {
      this.openCodeWorkspace(message);
      return;
    }
    if (!this.busy && v.free) return this.sendAsk(message);
    if (this.busy || !v.dir || !v.topic) return;
    const dir = v.dir;
    const text = message.trim();
    this.busy = true;
    this.error = "";
    this.stopped = false;
    this.changes = [];
    this.marked = null;
    this.markedNote = "";
    let chatPath = v.chatPath;
    try {
      const attached = await this.attachedNote();
      if (!chatPath || !v.chat) {
        await v.newChat(v.mode);
        chatPath = v.chatPath;
      }
      if (!chatPath || !v.chat) throw new Error("The chat could not be created.");
      // Start the turn first: it decides its path from the chat as it stood before this message.
      const turn = v.plugin.engine.study(dir, chatPath, text, { attached, confidence: this.confidence, activityContext: this.visualContext?.chatPath === chatPath ? this.visualContext.value : undefined, onSpawn: (kill) => (this.kill = kill) });
      if (text) {
        v.chat.messages.push({ role: "you", text });
        if (this.el) this.input.value = "";
        delete v.plugin.data.drafts[chatPath];
      }
      this.sync();
      const r = await turn;
      if (attached) this.lastAttachments.set(chatPath, attached);
      this.attachment = undefined;
      const used = r.rotationUsage ? addUsage(r.usage, r.rotationUsage) : r.usage;
      v.sessionUsage = addUsage(v.sessionUsage, used);
      this.last = r;
      this.changes = r.changes;
      this.marked = r.attempt ?? null;
      // The answer was marked, so the next one starts at the default 50%.
      this.confidence = DEFAULT_CONFIDENCE;
      if (v.dir === dir) {
        await v.openChat(r.rotatedTo ?? chatPath);
        if (r.rotatedTo) new Notice("This chat was getting long, so the finished part was summarised and the chat continues in a new file. The full transcript is linked from the summary.", 8000);
        await v.stateChanged(r.state);
        if (r.presentation) {
          this.activity = { outcome: r.presentation, dir, chatPath: r.rotatedTo ?? chatPath };
          if (this.el && v.screen === "study") this.openActivity(r.presentation, dir, r.rotatedTo ?? chatPath);
        }
      }
    } catch (e) {
      this.error = (e as Error).message || String(e);
      this.stopped = this.error === "Stopped.";
      // The confidence you set is kept, so a retry sends the same answer with the same confidence.
      if (chatPath && v.dir === dir) {
        try {
          v.chat = await v.plugin.store.loadChat(chatPath);
          const saved = v.chat.messages[v.chat.messages.length - 1];
          // If the message never reached the file, give it back to the learner instead of losing it.
          if (text && !(saved?.role === "you" && saved.text === text) && this.el && !this.input.value) {
            this.input.value = text;
            this.keepDraft();
          }
        } catch {
          /* keep what is on screen */
        }
      }
    } finally {
      this.busy = false;
      this.kill = null;
      this.sync();
      if (this.el && !this.error) this.input.focus();
    }
  }
}
