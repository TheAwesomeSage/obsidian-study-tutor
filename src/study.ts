// The study screen: the conversation, the open question, and the answer area.
//
// The screen is built once and then updated in place. New messages are appended, the composer
// is never rebuilt while you type, and the list only follows the newest message when you were
// already reading the end. The screen object outlives its DOM, so a reply that arrives while
// you are on another screen is waiting when you come back.

import { Notice, TFile, setIcon } from "obsidian";
import { addUsage } from "./claude";
import { Material, TurnResult } from "./engine";
import { Attempt, gradingLabel } from "./evidence";
import { Mode, fmStr, splitFrontmatter } from "./formats";
import { ACTION_LABEL, Action, POLICY_VERSION } from "./policy";
import { SessionRecord, openQuestion, sessionFor } from "./session";
import { toolLine } from "./tools";
import type { Screen, TutorView } from "./view";
import { MODE_INFO, button, chip, iconButton, modeInfo } from "./ui";

const ROUTE_NOTE: Record<string, string> = { simple: "cheaper model", standard: "chat model", complex: "chat model, extra thinking" };
const k = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
/** A trailing status line the engine appends to a reply when SymPy computed or checked something. */
const SYMPY_LINE = /\n\n(\*SymPy [^\n]*\*|\*\*SymPy disagrees\*\*[^\n]*)\s*$/;
let uid = 0;

export class StudyScreen implements Screen {
  busy = false;
  private kill: (() => void) | null = null;
  private error = "";
  private stopped = false;
  private last: TurnResult | null = null;
  private changes: string[] = [];
  /** The attempt marked on the last turn, shown with how it was checked and a way to dispute it. */
  private marked: Attempt | null = null;
  private markedNote = "";
  /** Self-reported confidence for the answer being written. Null until the slider is deliberately moved. */
  private confidence: number | null = null;
  private attach = false;
  private whyOpen = false;
  private saveDrafts = 0;

  private el: HTMLElement | null = null;
  private headEl!: HTMLElement;
  private whyEl!: HTMLElement;
  private scrollEl!: HTMLElement;
  private listEl!: HTMLElement;
  private tailEl!: HTMLElement;
  private pendingEl!: HTMLElement;
  private quickEl!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private confEl!: HTMLElement;
  private slider!: HTMLInputElement;
  private confOut!: HTMLElement;
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

    const dock = page.createDiv({ cls: "st-dock" });
    const inner = dock.createDiv({ cls: "st-column" });
    this.pendingEl = inner.createDiv({ cls: "st-pending" });
    const composer = inner.createDiv({ cls: "st-composer" });
    this.quickEl = composer.createDiv({ cls: "st-quick", attr: { role: "group", "aria-label": "Help with the open question" } });
    this.input = composer.createEl("textarea", { cls: "st-input", attr: { rows: "3", "aria-label": "Your answer or message" } });
    this.input.oninput = () => this.keepDraft();
    this.input.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!this.busy && this.input.value.trim()) void this.send(this.input.value);
      }
    };
    const foot = composer.createDiv({ cls: "st-composer-foot" });
    this.attachBtn = foot.createEl("button", { cls: "st-btn is-ghost st-attach", attr: { "aria-pressed": "false" } });
    setIcon(this.attachBtn.createSpan({ cls: "st-btn-icon" }), "paperclip");
    this.attachBtn.createSpan({ cls: "st-btn-label", text: "Attach open note" });
    this.attachBtn.onclick = () => {
      this.attach = !this.attach;
      this.syncComposer();
    };

    // The confidence slider. It starts unset and records a value only once it is deliberately moved.
    const id = `st-conf-${++uid}`;
    this.confEl = foot.createDiv({ cls: "st-conf" });
    this.confEl.createEl("label", { cls: "st-conf-label", text: "Confidence", attr: { for: id } });
    this.slider = this.confEl.createEl("input", { type: "range", cls: "st-conf-range", attr: { id, min: "0", max: "100", step: "5", "aria-label": "How confident are you in this answer? Set it before you see feedback." } });
    this.slider.value = "50";
    this.confOut = this.confEl.createEl("output", { cls: "st-conf-value", attr: { for: id } });
    const clear = this.confEl.createEl("button", { cls: "st-conf-clear clickable-icon", attr: { "aria-label": "Clear confidence" } });
    setIcon(clear, "x");
    const set = () => {
      this.confidence = Number(this.slider.value) / 100;
      this.syncConfidence();
    };
    this.slider.oninput = set;
    // A click that lands exactly on the thumb moves nothing, so it fires no input event. It is still a choice.
    this.slider.onclick = set;
    this.slider.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        set();
      } else if ((e.key === "Backspace" || e.key === "Delete") && this.confidence !== null) {
        e.preventDefault();
        this.confidence = null;
        this.syncConfidence();
      }
    };
    clear.onclick = () => {
      this.confidence = null;
      this.syncConfidence();
      this.slider.focus();
    };

    this.sendBtn = foot.createEl("button", { cls: "st-btn is-primary mod-cta st-send" });
    this.sendBtn.onclick = () => {
      if (this.busy) this.stop();
      else if (this.input.value.trim()) void this.send(this.input.value);
    };
    this.diagEl = inner.createEl("details", { cls: "st-diag" });

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
    return v.chat && v.state ? sessionFor(v.chat, v.state, v.mode) : null;
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
    const fresh = iconButton(end, "message-square-plus", "New chat in this mode", async () => {
      await v.newChat(v.mode);
      this.refresh();
      this.input.focus();
    });
    fresh.disabled = this.busy;
    if (v.chatPath) iconButton(end, "file-text", "Open this chat's transcript as a note", () => void v.app.workspace.openLinkText(v.chatPath!, "", true));
  }

  /** The reason for the current action, in one line, with the working behind it on demand. */
  private syncWhy(): void {
    const el = this.whyEl;
    el.empty();
    const v = this.view;
    const record = this.record();
    const decision = this.last?.decision;
    const reason = record?.reason || "";
    el.toggleClass("is-empty", !reason);
    if (!reason) return;
    const line = el.createDiv({ cls: "st-why-line" });
    setIcon(line.createSpan({ cls: "st-why-icon" }), "lightbulb");
    const label = ACTION_LABEL[record!.action as Action];
    if (label && (v.mode === "auto" || v.mode === "teach")) line.createSpan({ cls: "st-why-action", text: label });
    line.createSpan({ cls: "st-why-text", text: reason });
    if (!decision) return;
    const toggle = line.createEl("button", { cls: "st-link", text: this.whyOpen ? "Hide details" : "Why this?", attr: { "aria-expanded": String(this.whyOpen) } });
    toggle.onclick = () => {
      this.whyOpen = !this.whyOpen;
      this.syncWhy();
    };
    if (!this.whyOpen) return;
    const box = el.createDiv({ cls: "st-why-detail" });
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
    const who = modeInfo(v.mode).who;
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
    const info = modeInfo(v.mode);
    const lastMsg = chat?.messages[chat.messages.length - 1];

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

    if (this.changes.length) chip(tail, `Progress updated: ${this.changes.join("; ")}`, "good", "trending-up");
    if (this.marked) this.feedback(tail, this.marked);

    if (this.busy) this.thinking(tail);
    else if (this.error) this.problem(tail);
    else if (lastMsg?.role === "you") {
      // The learner's message was saved but never answered: the app was closed, or a call failed earlier.
      const box = tail.createDiv({ cls: "st-notice" });
      box.createSpan({ text: "This message has not been answered yet." });
      button(box, { label: "Get the reply", icon: "refresh-cw", onClick: () => void this.send("") });
    } else if (v.mode !== "expert" && lastMsg?.role === "tutor" && !this.openQuestionText() && !fmStr(chat.fm, "card")) {
      button(tail, { label: "Continue", icon: "arrow-right", tone: fmStr(chat.fm, "await_continue") === "yes" || /^\*\*Placement done|\n\*\*Placement done/.test(lastMsg.text) ? "primary" : "secondary", cls: "st-continue", onClick: () => void this.send("") });
    }
  }

  private thinking(parent: HTMLElement): void {
    const t = parent.createDiv({ cls: "st-thinking", attr: { role: "status" } });
    t.createSpan({ cls: "st-dots" });
    t.createSpan({ text: "Working on a reply…" });
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
    if (a.confidence !== null) bits.push(`your confidence ${Math.round(a.confidence * 100)}%`);
    if (a.seconds !== null) bits.push(a.seconds < 90 ? `${a.seconds}s` : `${Math.round(a.seconds / 60)} min`);
    line.createSpan({ cls: "st-meta", text: bits.join(" · ") });
    const more = box.createEl("details", { cls: "st-feedback-more" });
    more.createEl("summary", { text: "How this was checked" });
    if (a.assumptions) more.createDiv({ cls: "st-meta", text: `Basis: ${a.assumptions}.` });
    more.createDiv({ cls: "st-meta", text: a.assisted || a.answerExposed ? "Because help was given or the answer had been seen, this does not count as unaided evidence." : a.grading === "self" ? "A self-rating does not count as evidence for a level." : a.result === "ungraded" ? "An unmarked answer changes nothing." : "This counts as unaided evidence." });
    if (a.note) more.createDiv({ cls: "st-meta", text: a.note });
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
            this.marked = r.state.attempts.find((x) => x.id === a.id) ?? null;
            this.changes = r.changes;
            this.markedNote = "The mark no longer counts either way. " + (/^Q\d+$/.test(a.questionId) ? "You can ask for a second opinion, or carry on." : "The tutor will look at your answer again on your next message.");
            if (v.chatPath) v.chat = await v.plugin.store.loadChat(v.chatPath);
            await v.stateChanged(r.state);
          } catch (e) {
            new Notice(`Could not dispute the mark: ${(e as Error).message}`);
          }
          this.sync();
        },
      });
    } else if (/^Q\d+$/.test(a.questionId)) {
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

  private syncConfidence(): void {
    const set = this.confidence !== null;
    this.confEl.toggleClass("is-set", set);
    if (set) this.slider.value = String(Math.round(this.confidence! * 100));
    this.confOut.setText(set ? `${Math.round(this.confidence! * 100)}%` : "Not set");
    this.slider.setAttribute("aria-valuetext", set ? `${Math.round(this.confidence! * 100)} percent confident` : "not set");
  }

  private syncComposer(): void {
    const v = this.view;
    const question = this.openQuestionText();
    const asking = v.mode === "expert";

    // The open question, pinned above the answer area so the two are never confused.
    const p = this.pendingEl;
    p.empty();
    p.toggleClass("is-empty", !question || asking);
    if (question && !asking) {
      setIcon(p.createSpan({ cls: "st-pending-icon" }), "help-circle");
      const t = p.createDiv({ cls: "st-grow" });
      t.createDiv({ cls: "st-kicker", text: "Open question" });
      t.createDiv({ cls: "st-pending-text", text: question.replace(/\s+/g, " ").slice(0, 220) });
      button(p, { label: "Show", tone: "ghost", title: "Scroll to the question", onClick: () => (this.scrollEl.scrollTop = this.scrollEl.scrollHeight) });
    }

    // Help with the open question, always in the same place: just above where you type.
    const q = this.quickEl;
    q.empty();
    q.toggleClass("is-empty", asking);
    if (!asking) {
      const quick = (label: string, icon: string, message: string, title: string) => {
        const b = button(q, { label, icon, tone: "ghost", title, onClick: () => void this.send(message) });
        b.disabled = this.busy || !question;
      };
      quick("Hint", "life-buoy", "Hint please.", "Ask for a hint. The answer will then count as helped.");
      quick("Explain", "book-open", "Explain this to me.", "Ask for an explanation. The answer will then count as helped.");
      quick("Skip", "skip-forward", "skip", "Skip this question and see the answer. It is recorded as skipped.");
    }

    this.input.placeholder = asking ? "Ask a question…  (Enter to send, Shift+Enter for a new line)" : question ? "Your answer…  (Enter to send, Shift+Enter for a new line)" : "Message…  (Enter to send, Shift+Enter for a new line)";
    const active = v.app.workspace.getActiveFile();
    const canAttach = active instanceof TFile && active.extension === "md" && !active.path.startsWith(v.plugin.store.root + "/");
    if (!canAttach) this.attach = false;
    this.attachBtn.disabled = !canAttach || this.busy;
    this.attachBtn.toggleClass("is-on", this.attach);
    this.attachBtn.setAttribute("aria-pressed", String(this.attach));
    this.attachBtn.querySelector(".st-btn-label")?.setText(this.attach && active ? `Attached: ${active.basename}` : "Attach open note");

    // Confidence belongs to an answer, so it is offered only while a question is open.
    this.confEl.toggleClass("is-hidden", asking);
    this.slider.disabled = !question || this.busy;
    this.confEl.toggleClass("is-off", !question);
    if (!question) this.confidence = null;
    this.syncConfidence();

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
    for (const t of r?.tools ?? []) body.createDiv({ text: `Tool: ${toolLine(t)}.` });
    const su = v.sessionUsage;
    const st = su.input + su.cacheRead + su.cacheWrite;
    body.createDiv({ text: `This sitting: ${k(st)} tokens in (${st ? Math.round((100 * su.cacheRead) / st) : 0}% from cache) · ${k(su.output)} out over ${su.calls} call${su.calls === 1 ? "" : "s"}.` });
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
    if (!this.attach) return undefined;
    const v = this.view;
    const f = v.app.workspace.getActiveFile();
    if (!(f instanceof TFile) || f.extension !== "md" || f.path.startsWith(v.plugin.store.root + "/")) return undefined;
    const text = splitFrontmatter(await v.app.vault.cachedRead(f)).body.trim();
    return text ? { name: f.basename, text: text.split(/\s+/).slice(0, 3000).join(" ") } : undefined;
  }

  /** Sends a message. An empty message starts a chat, continues, or retries the last turn. */
  async send(message: string): Promise<void> {
    const v = this.view;
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
      if (!chatPath || !v.chat) {
        await v.newChat(v.mode);
        chatPath = v.chatPath;
      }
      if (!chatPath || !v.chat) throw new Error("The chat could not be created.");
      const attached = await this.attachedNote();
      this.attach = false;
      // Start the turn first: it decides its path from the chat as it stood before this message.
      const turn = v.plugin.engine.study(dir, chatPath, text, { attached, confidence: this.confidence, onSpawn: (kill) => (this.kill = kill) });
      if (text) {
        v.chat.messages.push({ role: "you", text });
        if (this.el) this.input.value = "";
        delete v.plugin.data.drafts[chatPath];
      }
      this.sync();
      const r = await turn;
      const used = r.rotationUsage ? addUsage(r.usage, r.rotationUsage) : r.usage;
      v.sessionUsage = addUsage(v.sessionUsage, used);
      this.last = r;
      this.changes = r.changes;
      this.marked = r.attempt ?? null;
      // The answer was marked, so the next one starts with no confidence set.
      this.confidence = null;
      if (v.dir === dir) {
        await v.openChat(r.rotatedTo ?? chatPath);
        if (r.rotatedTo) new Notice("This chat was getting long, so the finished part was summarised and the chat continues in a new file. The full transcript is linked from the summary.", 8000);
        await v.stateChanged(r.state);
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
