// Flashcard review from the question bank, with no model call unless the learner asks for one.
// Each card is recorded with how it was marked: by code, by SymPy, by the model, or self-rated
// after seeing the answer. Only the first three can count as evidence for a level.

import { outcomeOfGrade } from "./grading";
import { Notice } from "obsidian";
import { addUsage, usageLine } from "./claude";
import { applyAttempt } from "./engine";
import { Attempt, Grading, recordAttempt } from "./evidence";
import { Grade, Question, objectiveStamp, answerText, differentNumbers, mcqLetter, reviewQueue, sameShortAnswer, schedule } from "./formats";
import type { Screen, TutorView } from "./view";
import { button, chip, emptyState, progressBar } from "./ui";

interface Marking {
  grading: Grading;
  assumptions: string;
  /** What the learner typed or chose, when there was something. */
  answer: string;
  /** The answer was on screen before the mark was decided. */
  exposed: boolean;
}

export class ReviewScreen implements Screen {
  private el: HTMLElement | null = null;
  private queue: Question[] = [];
  private requeued = new Set<string>();
  private reviewed = 0;
  private forDir: string | null = null;
  private shownAt = 0;

  constructor(private view: TutorView) {}

  async mount(el: HTMLElement): Promise<void> {
    this.el = el;
    await this.start();
    this.render();
  }
  unmount(): void {
    this.el = null;
  }
  async refresh(): Promise<void> {
    await this.start();
    this.render();
  }

  private async start(): Promise<void> {
    const v = this.view;
    this.queue = [];
    this.requeued.clear();
    this.reviewed = 0;
    this.forDir = v.dir;
    if (!v.dir) return;
    await v.loadState();
    const qs = await v.plugin.store.loadQuestions(v.dir);
    if (v.state) this.queue = reviewQueue(qs, v.state, v.today, v.plugin.opts.newCardsPerDay);
  }

  private async record(q: Question, grade: Grade, how: Marking): Promise<void> {
    const v = this.view;
    if (!v.dir || !v.state) return;
    const s = v.state;
    const now = new Date();
    const isNew = !s.cards[q.id];
    const seconds = this.shownAt ? Math.round((now.getTime() - this.shownAt) / 1000) : null;
    const attempt: Attempt = {
      id: `review:${q.id}:${now.getTime()}`,
      v: 2,
      skill: q.subskill in s.names ? q.subskill : 0,
      concept: s.concepts[q.subskill] ?? "",
      questionId: q.id,
      question: q.question,
      answer: how.answer || (how.grading === "self" ? "Self-rated review" : ""),
      activity: "review",
      mode: "review",
      difficulty: null,
      result: outcomeOfGrade(grade),
      errorType: "",
      note: "",
      confidence: null,
      assisted: false,
      assistance: [],
      answerExposed: how.exposed,
      transfer: false,
      seconds: seconds !== null && seconds <= 3600 ? seconds : null,
      timestamp: now.toISOString(),
      grading: how.grading,
      verification: how.grading === "model" || how.grading === "self" ? "unverified" : "verified",
      assumptions: how.assumptions,
      ...objectiveStamp(s, q.subskill),
    };
    s.attempts = recordAttempt(s.attempts, attempt);
    s.cards[q.id] = schedule(s.cards[q.id], grade, v.today);
    if (isNew) {
      if (s.newDate !== v.today) {
        s.newDate = v.today;
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
    // A self-rating schedules the card and nothing more. A marked answer is evidence.
    const changes = applyAttempt(s, attempt);
    await v.plugin.store.saveState(v.dir, s);
    if (changes.length) new Notice(`Progress updated: ${changes.join("; ")}`, 5000);
    this.queue.shift();
    this.reviewed += 1;
    if (grade === "again" && !this.requeued.has(q.id)) {
      this.requeued.add(q.id);
      this.queue.push(q);
    }
    await v.stateChanged(s);
    this.render();
  }

  /** Review handed to the Spaced Repetition plugin: show its counts and start its review on this topic's note. */
  private renderSr(page: HTMLElement): void {
    const v = this.view;
    const dir = v.dir;
    if (!dir) return;
    const sr = v.sr ?? { total: 0, due: 0, fresh: 0 };
    const card = page.createDiv({ cls: "st-card" });
    card.createDiv({ cls: "st-kicker", text: "Flashcards · Spaced Repetition" });
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
    card.createDiv({ cls: "st-card-text", text: "This topic's question bank is kept as a flashcard note. Spaced Repetition schedules it alongside your other decks, and reviewing there uses no tokens. Reviews done there are self-rated, so they schedule cards without changing levels here." });
    const row = card.createDiv({ cls: "st-actions" });
    const go = button(row, { label: "Review this topic", icon: "play", tone: "primary", onClick: () => void v.plugin.reviewInSr(dir) });
    go.disabled = !sr.total;
    button(row, { label: "Open flashcard note", icon: "file-text", onClick: async () => void v.app.workspace.openLinkText(await v.plugin.store.exportFlashcards(dir), "", true) });
    button(row, { label: "Refresh counts", icon: "refresh-cw", tone: "ghost", onClick: () => void v.stateChanged().then(() => this.render()) });
    if (!sr.total) card.createDiv({ cls: "st-meta", text: "The question bank is empty. Recompile the topic from its topic page." });
  }

  private render(): void {
    const el = this.el;
    const v = this.view;
    if (!el) return;
    el.empty();
    const page = el.createDiv({ cls: "st-page st-review" });
    const head = page.createDiv({ cls: "st-page-head" });
    button(head, { label: "Home", icon: "arrow-left", tone: "ghost", onClick: () => v.go("home") });
    head.createEl("h2", { cls: "st-page-title", text: `Review · ${v.topic?.title ?? ""}` });
    if (v.plugin.usesSr()) return this.renderSr(page);

    const q = this.queue[0];
    if (!q || !v.state) {
      const done = emptyState(page, { icon: "check", title: this.reviewed ? `Done. ${this.reviewed} card${this.reviewed === 1 ? "" : "s"} reviewed.` : "Nothing is due today", text: "Cards come from this topic's question bank. Due cards and a few new ones appear here each day, and reviewing them uses no tokens." });
      button(done, { label: "Back to home", icon: "arrow-left", onClick: () => v.go("home") });
      return;
    }
    const total = this.reviewed + this.queue.length;
    const meta = page.createDiv({ cls: "st-row-top" });
    meta.createSpan({ cls: "st-meta", text: `${this.queue.length} left` });
    chip(meta, v.state.names[q.subskill] ?? "General");
    progressBar(page, total ? Math.round((100 * this.reviewed) / total) : 0, "Review progress");

    const card = page.createDiv({ cls: "st-card st-question" });
    card.createDiv({ cls: "st-kicker", text: "Question" });
    v.md(card.createDiv({ cls: "st-text" }), q.question);
    const area = page.createDiv({ cls: "st-answer" });
    this.shownAt = Date.now();

    const reveal = (verdict: string, how: Marking, auto?: Grade) => {
      area.empty();
      if (verdict) chip(area, verdict, /^Correct/.test(verdict) ? "good" : /^Incorrect/.test(verdict) ? "bad" : "");
      const a = area.createDiv({ cls: "st-card st-reveal" });
      a.createDiv({ cls: "st-kicker", text: "Answer" });
      v.md(a.createDiv({ cls: "st-text" }), answerText(q) + (q.explanation ? `\n\n${q.explanation}` : ""));
      const row = area.createDiv({ cls: "st-actions st-grades" });
      if (auto) {
        button(row, { label: "Next", icon: "arrow-right", tone: "primary", onClick: () => void this.record(q, auto, how) }).focus();
        return;
      }
      area.createDiv({ cls: "st-meta", text: "Rate yourself against the answer. A self-rating schedules the card; it does not count as evidence for a level." });
      for (const g of ["again", "hard", "good", "easy"] as Grade[]) {
        button(row, { label: g[0].toUpperCase() + g.slice(1), tone: g === "good" ? "primary" : "secondary", cls: `st-grade is-${g}`, onClick: () => void this.record(q, g, { ...how, grading: "self", exposed: true, assumptions: "rated by the learner after seeing the answer" }) });
      }
      if (how.answer.trim()) {
        const ask = button(area, { label: "Ask the model to grade what I typed (uses tokens)", icon: "sparkles", tone: "ghost" });
        ask.onclick = async () => {
          ask.disabled = true;
          try {
            const r = await v.plugin.engine.grade(q, how.answer);
            v.sessionUsage = addUsage(v.sessionUsage, r.usage);
            reveal(`${r.grade === "again" ? "Incorrect" : r.grade === "hard" ? "Partly right" : "Correct"}. ${r.feedback} (${usageLine(r.usage)})`, { ...how, grading: "model", exposed: false, assumptions: "one model judgement of the answer typed before the reveal" }, r.grade);
          } catch (e) {
            ask.disabled = false;
            // A grading that fails leaves the card ungraded, for the learner to rate or retry.
            new Notice(`Grading failed, so the card is still ungraded: ${(e as Error).message}`);
          }
        };
      }
    };

    if (q.type === "mcq") {
      const correct = mcqLetter(q.answer);
      const opts = area.createDiv({ cls: "st-options", attr: { role: "group", "aria-label": "Choices" } });
      for (const opt of q.options) {
        const b = opts.createEl("button", { cls: "st-option" });
        v.md(b, opt);
        b.onclick = () => {
          const right = mcqLetter(opt) === correct;
          reveal(right ? "Correct." : `Incorrect. You chose ${mcqLetter(opt)}.`, { grading: "deterministic", assumptions: "the chosen letter was compared with the answer key", answer: mcqLetter(opt), exposed: false }, right ? "good" : "again");
        };
      }
      return;
    }
    const input = area.createEl("textarea", { cls: "st-input st-review-input", attr: { rows: q.type === "short" ? "1" : "3", placeholder: q.type === "short" ? "Type your answer" : "Answer in your head, or type it here", "aria-label": "Your answer" } });
    const row = area.createDiv({ cls: "st-actions" });
    const check = button(row, { label: q.type === "short" ? "Check" : "Show answer", icon: q.type === "short" ? "check" : "eye", tone: "primary" });
    const run = async () => {
      const typed = input.value;
      const byCode = (assumptions: string): Marking => ({ grading: "deterministic", assumptions, answer: typed, exposed: false });
      if (q.type === "short" && sameShortAnswer(typed, q.answer)) return reveal("Correct.", byCode("matched the expected answer after ignoring case and spacing"), "good");
      if (q.type === "short" && differentNumbers(typed, q.answer)) return reveal("Incorrect.", byCode("both answers are plain numbers, and they differ"), "again");
      if (q.type === "short" && typed.trim()) {
        // Another form of the same expression (1/2 for 0.5): SymPy can tell, with no model call.
        check.disabled = true;
        const sym = await v.plugin.engine.checkEquivalent(q.answer, typed).catch(() => null);
        if (this.queue[0] !== q || !this.el) return;
        if (sym && sym.equal !== null) return reveal(sym.equal ? "Correct. SymPy confirms your answer equals the expected one." : "Incorrect. SymPy finds your answer is not equal to the expected one.", { grading: sym.grading, assumptions: sym.assumptions, answer: typed, exposed: false }, sym.equal ? "good" : "again");
      }
      reveal(q.type === "short" && typed.trim() ? "That could not be checked automatically. Compare it with the answer and rate yourself." : "", { grading: "self", assumptions: "", answer: typed, exposed: true });
    };
    check.onclick = () => void run();
    input.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && q.type === "short") {
        e.preventDefault();
        void run();
      }
    };
    input.focus();
  }
}
