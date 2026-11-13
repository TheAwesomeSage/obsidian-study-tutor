// Small building blocks shared by every screen, so buttons, chips and empty states look and
// behave the same everywhere.

import { setIcon } from "obsidian";
import type { Mode } from "./formats";

export interface ModeInfo {
  mode: Mode;
  label: string;
  who: string;
  icon: string;
  start: string;
  hint: string;
}

/** Icon names are ones Obsidian has shipped for years; a newer name would draw nothing on older versions. */
export const MODE_INFO: ModeInfo[] = [
  { mode: "auto", label: "Adaptive", who: "Study guide", icon: "compass", start: "Start session", hint: "The guide chooses what helps most right now: a quick check, an explanation, a hint, practice or a transfer question. It finishes one step before starting another." },
  { mode: "teach", label: "Learn", who: "Teacher", icon: "book-open", start: "Start lesson", hint: "Lessons for material you have not met: why it matters, the idea, a worked example, then a problem to try with help on hand." },
  { mode: "quiz", label: "Practise", who: "Quizzer", icon: "zap", start: "Start quiz", hint: "Strict questions on your weakest concepts, from the question bank first. The plugin marks most answers itself, so most turns use no tokens." },
  { mode: "tutor", label: "Master", who: "Tutor", icon: "target", start: "Start", hint: "Socratic tutoring: one question at a time, and a level only goes up when your answers show it. The most thorough mode, and the one that uses the most tokens." },
  { mode: "expert", label: "Ask", who: "Expert", icon: "message-circle", start: "", hint: "Ask anything about this topic and get a direct explanation grounded in your notes." },
];
export const modeInfo = (m: Mode): ModeInfo => MODE_INFO.find((p) => p.mode === m) ?? MODE_INFO[0];

export type Tone = "primary" | "secondary" | "ghost" | "danger";

/** A button with one of three weights. Primary is the one action a screen most wants taken. */
export function button(parent: HTMLElement, o: { label: string; icon?: string; tone?: Tone; title?: string; onClick?: (e: MouseEvent) => void; cls?: string }): HTMLButtonElement {
  const tone = o.tone ?? "secondary";
  const b = parent.createEl("button", { cls: `st-btn is-${tone}${tone === "primary" ? " mod-cta" : ""}${o.cls ? ` ${o.cls}` : ""}`, attr: o.title ? { "aria-label": o.title } : {} });
  if (o.icon) setIcon(b.createSpan({ cls: "st-btn-icon" }), o.icon);
  b.createSpan({ cls: "st-btn-label", text: o.label });
  if (o.onClick) b.onclick = o.onClick;
  return b;
}

/** An icon with no visible label. The label is still there for screen readers and as a tooltip. */
export function iconButton(parent: HTMLElement, icon: string, label: string, onClick?: (e: MouseEvent) => void): HTMLButtonElement {
  const b = parent.createEl("button", { cls: "st-icon-btn clickable-icon", attr: { "aria-label": label } });
  setIcon(b, icon);
  if (onClick) b.onclick = onClick;
  return b;
}

export function chip(parent: HTMLElement, text: string, tone: "" | "good" | "bad" | "warn" | "accent" = "", icon?: string): HTMLElement {
  const c = parent.createSpan({ cls: `st-chip${tone ? ` is-${tone}` : ""}` });
  if (icon) setIcon(c.createSpan({ cls: "st-chip-icon" }), icon);
  c.createSpan({ text });
  return c;
}

export function emptyState(parent: HTMLElement, o: { icon: string; title: string; text?: string }): HTMLElement {
  const box = parent.createDiv({ cls: "st-empty" });
  setIcon(box.createDiv({ cls: "st-empty-icon" }), o.icon);
  box.createDiv({ cls: "st-empty-title", text: o.title });
  if (o.text) box.createDiv({ cls: "st-empty-text", text: o.text });
  return box;
}

/** Five pips for a level, with the target marked. Null draws as not yet placed. */
export function levelPips(parent: HTMLElement, level: number | null, target: number, backed = true): HTMLElement {
  const wrap = parent.createSpan({ cls: `st-pips${backed ? "" : " is-unbacked"}`, attr: { role: "img", "aria-label": level === null ? "Not placed yet" : `Level ${level} of 5${backed ? "" : ", not yet backed by your answers"}` } });
  for (let i = 1; i <= 5; i++) wrap.createSpan({ cls: "st-pip" + (level !== null && i <= level ? " is-on" : "") + (i === target ? " is-target" : "") });
  return wrap;
}

export function progressBar(parent: HTMLElement, pct: number, label: string): HTMLElement {
  const bar = parent.createDiv({ cls: "st-bar", attr: { role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(pct), "aria-label": label } });
  bar.createDiv({ cls: "st-bar-fill", attr: { style: `width:${Math.max(0, Math.min(100, pct))}%` } });
  return bar;
}

/** A labelled section with an optional row of controls beside its heading. */
export function panel(parent: HTMLElement, title: string, cls = ""): { el: HTMLElement; head: HTMLElement; tools: HTMLElement; body: HTMLElement } {
  const el = parent.createEl("section", { cls: `st-panel${cls ? ` ${cls}` : ""}` });
  const head = el.createDiv({ cls: "st-panel-head" });
  head.createEl("h3", { cls: "st-panel-title", text: title });
  const tools = head.createDiv({ cls: "st-panel-tools" });
  return { el, head, tools, body: el.createDiv({ cls: "st-panel-body" }) };
}

export const pct = (x: number): string => `${Math.round(x * 100)}%`;

/** "2026-11-12 1701" as "12 Nov, 17:01". */
export function stampLabel(stamp: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2})(\d{2}))?/.exec(stamp);
  if (!m) return stamp;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(m[3])} ${months[Number(m[2]) - 1] ?? ""}${m[4] ? `, ${m[4]}:${m[5]}` : ""}`;
}
