// Bundled skill files and the functions that assemble prompts from them. No Obsidian imports.

import coreMd from "../skills/core.md";
import tutorMd from "../skills/mode-tutor.md";
import teachMd from "../skills/mode-teach.md";
import summaryMd from "../skills/summary.md";
import quizMd from "../skills/mode-quiz.md";
import expertMd from "../skills/mode-expert.md";
import compileMd from "../skills/compile.md";
import utilityMd from "../skills/utility.md";
import subjectsMd from "../skills/subjects.md";
import { Chat, LearnerState, Mode, SourceMode, Topic, chatForPrompt, stateForPrompt, words } from "./formats";

export function splitSubjects(md: string): Record<string, string> {
  const out: Record<string, string> = {};
  const parts = md.split(/^# Subject card:\s*(.+)$/m);
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const name = parts[i].trim();
    out[name] = `# Subject card: ${name}\n\n${parts[i + 1].trim()}\n`;
  }
  return out;
}

/** Every skill file the plugin ships, keyed by its path under the vault's _skills folder. */
export const BUNDLED: Record<string, string> = {
  "core.md": coreMd,
  "mode-tutor.md": tutorMd,
  "mode-teach.md": teachMd,
  "summary.md": summaryMd,
  "mode-quiz.md": quizMd,
  "mode-expert.md": expertMd,
  "compile.md": compileMd,
  "utility.md": utilityMd,
  ...Object.fromEntries(Object.entries(splitSubjects(subjectsMd)).map(([name, text]) => [`subjects/${name}.md`, text])),
};

export function utilityPrompt(md: string, name: "extract" | "summarise" | "grade"): string {
  const parts = md.split(/^## (extract|summarise|grade)[ \t]*$/m);
  const i = parts.indexOf(name);
  return i >= 0 && parts[i + 1] ? parts[i + 1].trim() : "";
}

/** The topic card as the model sees it: whole if small, otherwise an outline plus the focus subskill in full. */
export function topicForPrompt(topic: Topic, focus: number | null, maxWords: number): string {
  if (words(topic.body) <= maxWords) return topic.body;
  const outline = topic.subskills.map((s) => `${s.n}. ${s.name}${s.prerequisites.length ? ` (needs ${s.prerequisites.join(", ")})` : ""}`).join("\n");
  const current = topic.subskills.find((s) => s.n === focus) ?? topic.subskills[0];
  return [`# ${topic.title}`, "", topic.overview, "", "## Subskills (outline; only the focus subskill is shown in full)", outline, "", "## Focus subskill", current ? current.section : ""].join("\n");
}

/**
 * The stable part of every turn. It is byte-identical from one turn to the next within a chat,
 * so after the first turn it is read from the prompt cache. The cache matches the whole block:
 * changing mode, focus (on a trimmed card) or the topic card costs one uncached turn.
 */
export function buildSystem(p: { core: string; subject: string; topicText: string; mode: string }): string {
  return [p.core.trim(), p.subject.trim(), "# Topic card\n\n" + p.topicText.trim(), p.mode.trim()].filter(Boolean).join("\n\n---\n\n") + "\n";
}

/** The part that changes every turn. */
export function buildTurnInput(p: { state: LearnerState; today: string; chat: Chat; attached?: { name: string; text: string } }): string {
  const out = ["# Learner state", stateForPrompt(p.state, p.today), ""];
  const chat = chatForPrompt(p.chat);
  if (chat) out.push("# Chat", chat, "");
  if (p.attached) out.push(`# Attached note: [[${p.attached.name}]]`, p.attached.text.trim(), "");
  const last = p.chat.messages[p.chat.messages.length - 1];
  out.push(last && last.role === "you" ? "Reply to the learner's last message." : "The learner has just opened this chat. Begin.");
  return out.join("\n");
}

export function buildCompileInput(p: { title: string; mode: SourceMode; goal: string; subjects: string[]; material: string; research?: boolean }): string {
  return [`TITLE: ${p.title}`, `SOURCE MODE: ${p.mode}`, `GOAL: ${p.goal.trim() || "(none given)"}`, `SUBJECT CARDS: ${p.subjects.join(", ") || "none"}`, `RESEARCH: ${p.research ? "on" : "off"}`, "", "MATERIAL:", p.material.trim() || "(none)"].join("\n");
}

export const modeFile = (m: Mode): string => `mode-${m}.md`;

export const GRADE_SCHEMA = {
  type: "object",
  properties: { grade: { type: "string", enum: ["again", "hard", "good", "easy"] }, feedback: { type: "string" } },
  required: ["grade", "feedback"],
};
