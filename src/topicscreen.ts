// The topic page: one topic's concepts with the level each holds and the evidence behind it,
// the suggested next step, and the topic's tools. Reached from the home screen's topic list.

import { Notice } from "obsidian";
import { addUsage, usageLine } from "./claude";
import { MIN_ESTIMATE_N, missingFor } from "./evidence";
import { fmStr, mastery } from "./formats";
import { isActive, misconceptionLine } from "./misconceptions";
import { ago } from "./overview";
import type { Screen, TutorView } from "./view";
import { MODE_INFO, button, chip, emptyState, iconButton, levelPips, panel, pct, progressBar } from "./ui";

export class TopicScreen implements Screen {
  private el: HTMLElement | null = null;

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

  private render(): void {
    const el = this.el;
    const v = this.view;
    if (!el) return;
    el.empty();
    const page = el.createDiv({ cls: "st-page st-topic" });
    const s = v.state;
    const topic = v.topic;
    const dir = v.dir;
    if (!s || !topic || !dir) {
      emptyState(page, { icon: "folder-open", title: "No topic is open", text: "Choose a topic on the home screen." });
      return;
    }
    const info = v.info;

    const head = page.createDiv({ cls: "st-page-head" });
    button(head, { label: "Home", icon: "arrow-left", tone: "ghost", onClick: () => v.go("home") });
    head.createEl("h2", { cls: "st-page-title", text: topic.title });

    const summary = page.createEl("section", { cls: "st-card st-topic-summary" });
    const top = summary.createDiv({ cls: "st-row-top" });
    top.createSpan({ cls: "st-card-title", text: `${info?.progress ?? 0}% of the way to level ${s.target}` });
    top.createSpan({ cls: "st-meta", text: `${info?.secured ?? 0} of ${info?.concepts ?? 0} concepts secured` });
    progressBar(summary, info?.progress ?? 0, "Progress to target");
    if (info) {
      const next = summary.createDiv({ cls: "st-next-inline" });
      const text = next.createDiv({ cls: "st-grow" });
      text.createDiv({ cls: "st-kicker", text: `Next · ${info.step.title}` });
      text.createDiv({ cls: "st-card-text", text: info.step.detail });
      if (info.step.action !== "done") button(next, { label: "Do this", icon: "arrow-right", tone: "primary", onClick: () => void v.follow(info.step, dir) });
    }
    const modes = summary.createDiv({ cls: "st-actions" });
    for (const m of MODE_INFO) button(modes, { label: m.label, icon: m.icon, tone: "ghost", title: m.hint, onClick: () => void v.startStudy({ mode: m.mode }) });
    button(modes, { label: "Review", icon: "layers", tone: "ghost", onClick: () => v.go("review") });
    button(modes, { label: "Graph", icon: "git-fork", tone: "ghost", onClick: () => v.go("graph") });

    // ----- concepts -----
    const concepts = panel(page, "Concepts");
    concepts.tools.createSpan({ cls: "st-meta", text: "Levels move only through marked answers." });
    const table = concepts.body.createEl("table", { cls: "st-table" });
    const hr = table.createEl("thead").createEl("tr");
    for (const t of ["Concept", "Level", "Evidence", "Last practised", ""]) hr.createEl("th", { text: t });
    const tb = table.createEl("tbody");
    for (const n of Object.keys(s.names).map(Number).sort((a, b) => a - b)) {
      const m = mastery(s, n);
      const e = m.evidence;
      const tr = tb.createEl("tr", { cls: s.focus === n ? "is-focus" : "" });
      const name = tr.createEl("td", { cls: "st-td-name" });
      name.createSpan({ cls: "st-num", text: `${n}. ` });
      name.createSpan({ text: s.names[n] });
      if (s.focus === n) chip(name, "Focus", "accent");
      if (e.lapse) chip(name, "Slipped", "warn", "alert-triangle");
      const lv = tr.createEl("td", { cls: "st-td-level" });
      levelPips(lv, m.level, s.target, m.backed || m.level === null);
      lv.createSpan({ cls: "st-num", text: m.level === null ? " not placed" : ` ${m.level}` });
      const ev = tr.createEl("td", { cls: "st-td-evidence" });
      if (!e.graded) ev.createSpan({ cls: "st-meta", text: "No marked answers yet" });
      else {
        ev.createDiv({ text: `${e.independentCorrect} of ${e.independent} unaided correct` });
        const more: string[] = [];
        if (e.independent >= MIN_ESTIMATE_N && e.estimate !== null) more.push(`est. ${pct(e.estimate)} (provisional)`);
        else more.push("too few unaided answers for an estimate");
        if (e.assistedCount) more.push(`${e.assistedCount} with help`);
        ev.createDiv({ cls: "st-meta", text: more.join(" · ") });
      }
      if (m.level !== null && !m.backed) ev.createDiv({ cls: "st-meta st-warn-text", text: `Level ${m.level} is recorded; your answers support level ${m.supported} so far.` });
      else if (m.level !== null && m.level < 5) {
        const need = missingFor(e, m.level + 1, n in s.taught);
        if (need) ev.createDiv({ cls: "st-meta", text: `For level ${m.level + 1}: ${need}.` });
      }
      tr.createEl("td", { cls: "st-meta", text: ago(e.last, v.today) });
      const act = tr.createEl("td", { cls: "st-td-actions" });
      iconButton(act, "play", `Study ${s.names[n]}`, () => void v.startStudy({ mode: "auto", focus: n }));
      iconButton(act, "git-fork", `Show ${s.names[n]} in the graph`, () => {
        v.graphFocus = s.concepts[n] ?? null;
        v.go("graph");
      });
    }

    // ----- misconceptions -----
    // Each with its status and what stands behind it; ones resolved or set aside are listed after, muted.
    const mis = panel(page, "Misconceptions being tracked");
    const records = s.misconceptionRecords ?? [];
    const active = records.filter((m) => isActive(m, s.attempts));
    const past = records.filter((m) => !isActive(m, s.attempts)).slice(-6);
    if (records.length) {
      const ul = mis.body.createEl("ul", { cls: "st-plain-list" });
      for (const m of active) ul.createEl("li", { text: misconceptionLine(m, s.attempts) });
      for (const m of past) ul.createEl("li", { cls: "st-meta", text: misconceptionLine(m, s.attempts) });
      if (!active.length) mis.body.createDiv({ cls: "st-meta", text: "None active." });
    } else if (s.misconceptions.length) {
      const ul = mis.body.createEl("ul", { cls: "st-plain-list" });
      for (const m of s.misconceptions) ul.createEl("li", { text: m });
    } else mis.body.createDiv({ cls: "st-meta", text: "None recorded." });

    // ----- tools -----
    const tools = panel(page, "Topic tools");
    const row = tools.body.createDiv({ cls: "st-actions" });
    const targetSel = row.createEl("select", { cls: "dropdown", attr: { "aria-label": "Target level" } });
    for (const t of [3, 4, 5]) targetSel.createEl("option", { text: `Target level ${t}`, value: String(t) });
    targetSel.value = String(s.target);
    targetSel.onchange = async () => {
      s.target = Number(targetSel.value);
      await v.plugin.store.saveState(dir, s);
      await v.stateChanged(s);
      this.render();
    };
    const open = (path: string) => void v.app.workspace.openLinkText(path, "", true);
    button(row, { label: "Topic card", icon: "file-text", onClick: () => open(`${dir}/topic.md`) });
    button(row, { label: "Question bank", icon: "help-circle", onClick: () => open(`${dir}/questions.md`) });
    button(row, { label: "Evidence log", icon: "clipboard-list", onClick: () => open(`${dir}/evidence.md`) });
    const sumBtn = button(row, { label: "Write summary note", icon: "file-plus", title: "One model call: writes a revision summary with a concept map into the topic folder" });
    sumBtn.onclick = async () => {
      sumBtn.disabled = true;
      sumBtn.querySelector(".st-btn-label")?.setText("Writing…");
      try {
        const r = await v.plugin.engine.summarySheet(dir);
        v.sessionUsage = addUsage(v.sessionUsage, r.usage);
        new Notice(`Summary written to ${r.path}.\n${usageLine(r.usage)}`, 8000);
        open(r.path);
      } catch (e) {
        new Notice(`Summary failed: ${(e as Error).message}`, 10000);
      }
      sumBtn.disabled = false;
      sumBtn.querySelector(".st-btn-label")?.setText("Write summary note");
    };
    button(row, {
      label: "Export flashcards",
      icon: "share",
      onClick: async () => {
        const p = await v.plugin.store.exportFlashcards(dir);
        new Notice(`Flashcards are up to date in ${p}, in the Spaced Repetition plugin's format. Existing review history was kept.`);
      },
    });
    button(row, {
      label: "Recompile from notes",
      icon: "refresh-cw",
      tone: "danger",
      onClick: () => {
        if (window.confirm("Recompile this topic from its sources?\n\nLevels, marked answers, priorities and relations follow each concept, including ones that are renumbered or renamed. The question bank is rewritten, so the built-in flashcard schedule starts again.")) void v.plugin.recompile(dir);
      },
    });
    tools.body.createDiv({ cls: "st-meta", text: `Source: ${fmStr(topic.fm, "source", "subject")}. Compiled ${fmStr(topic.fm, "compiled", "?")}. Subject card: ${fmStr(topic.fm, "subject", "none")}. Web research: ${fmStr(topic.fm, "research", "no")}.` });
  }
}
