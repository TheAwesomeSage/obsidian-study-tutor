// The outcome check: the course's outcome task (the topic card's `## Outcome`), attempted unaided and
// marked by a separate assessor. The assessor is one call with skills/assess.md on the compile model,
// not the tutor's chat model, and it sees only the task, its criteria and the answer: no chat, lesson
// or learner state. The verdict is logged in the topic's assessments.md and moves no level, card or
// estimate. Part of the engine (see engine.ts): each function takes the engine it works for, and the
// engine has a method of the same name. No Obsidian imports.

import { zeroUsage } from "./claude";
import { modelFor } from "./model-provider";
import { type Frontmatter, fmStr, givesUp } from "./formats";
import { neutraliseRemote } from "./safemd";
import type { TurnOpts, TurnResult } from "./engine-common";
import type { Engine } from "./engine";

export type Verdict = "met" | "partly" | "no";

/** One outcome check, as logged. */
export interface Assessment {
  t: string;
  chat: string;
  task: string;
  criteria: { criterion: string; verdict: Verdict; evidence: string }[];
  summary: string;
  model: string;
}

export const ASSESS_NO_HELP = "This is an outcome check, so there is no help until it is marked. Write your answer to the task as best you can, or say **skip**.";
/** Used when the outcome lists no criteria of its own. */
export const WHOLE_TASK = "The task is done correctly and completely.";
const HELP_WORDS = /\b(hints?|clue|help|explain)\b/i;
const VERDICTS: Verdict[] = ["met", "partly", "no"];
const SCHEMA = {
  type: "object", additionalProperties: false, required: ["criteria", "summary"],
  properties: {
    criteria: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false, required: ["criterion", "verdict", "evidence"], properties: { criterion: { type: "string" }, verdict: { type: "string", enum: VERDICTS }, evidence: { type: "string" } } } },
    summary: { type: "string" },
  },
};

/** The outcome section split into the task and its criteria (the `- ` lines after "Done well when:"). */
export function outcomeTask(outcome: string): { task: string; criteria: string[] } | null {
  const text = outcome.trim();
  if (!text) return null;
  const [head, tail = ""] = text.split(/^Done well when:\s*$/m);
  const criteria = tail.split("\n").map((l) => /^\s*[-*]\s+(.+)$/.exec(l)?.[1].trim() ?? "").filter(Boolean);
  const task = head.trim();
  return task ? { task, criteria: criteria.length ? criteria : [WHOLE_TASK] } : null;
}

const one = (s: unknown, max: number): string => (typeof s === "string" ? neutraliseRemote(s.replace(/\s+/g, " ").trim()).slice(0, max) : "");

/** The assessor's reply as one verdict per criterion, in order, or null when it does not give exactly that. */
export function readVerdicts(raw: unknown, criteria: string[]): { criteria: Assessment["criteria"]; summary: string } | null {
  const r = raw as { criteria?: { verdict?: unknown; evidence?: unknown }[]; summary?: unknown } | null;
  if (!r || !Array.isArray(r.criteria) || r.criteria.length !== criteria.length) return null;
  const out: Assessment["criteria"] = [];
  for (const [i, c] of r.criteria.entries()) {
    if (!VERDICTS.includes(c?.verdict as Verdict)) return null;
    out.push({ criterion: criteria[i], verdict: c.verdict as Verdict, evidence: one(c.evidence, 240) });
  }
  return { criteria: out, summary: one(r.summary, 400) };
}

/** "3 of 5 met, 1 partly". */
export function assessmentLine(a: Pick<Assessment, "criteria">): string {
  const met = a.criteria.filter((c) => c.verdict === "met").length;
  const partly = a.criteria.filter((c) => c.verdict === "partly").length;
  return `${met} of ${a.criteria.length} met${partly ? `, ${partly} partly` : ""}`;
}

const isAssessChat = (fm: Frontmatter): boolean => fmStr(fm, "assess") === "outcome";

/**
 * Opens an outcome check on a topic: a chat that states the task and how it will be judged. An open
 * check that is not marked yet is returned instead of a second one. Null when the topic has no outcome.
 */
export async function startAssessment(eng: Engine, dir: string): Promise<string | null> {
  const topic = await eng.store.loadTopic(dir);
  const o = outcomeTask(topic.outcome);
  if (!o) return null;
  for (const path of [...(await eng.store.listChats(dir))].reverse()) {
    const chat = await eng.store.loadChat(path).catch(() => null);
    if (chat && isAssessChat(chat.fm) && !fmStr(chat.fm, "assess_done")) return path;
  }
  const chatPath = await eng.store.newChat(dir, topic.title, "quiz");
  const chat = await eng.store.loadChat(chatPath);
  chat.fm.assess = "outcome";
  chat.fm.asked_at = new Date().toISOString();
  chat.messages.push({
    role: "tutor",
    text: `**Outcome check** · on your own, no hints · marked by a separate assessor that sees only the task and your answer · levels are unchanged.\n\n${o.task}\n\nIt is judged on:\n${o.criteria.map((c) => `- ${c}`).join("\n")}`,
  });
  await eng.store.saveChat(chatPath, chat);
  return chatPath;
}

/** One turn of an outcome check. Help is refused without a model call; an answer is marked once and logged. */
export async function assessTurn(eng: Engine, dir: string, chatPath: string, message: string, opts: TurnOpts): Promise<TurnResult> {
  const s = eng.settings();
  const chat = await eng.store.loadChat(chatPath);
  const state = await eng.store.loadState(dir, s.targetLevel);
  const text = message.trim();
  const last = chat.messages[chat.messages.length - 1];
  const say = async (reply: string, usage = zeroUsage(), local = true): Promise<TurnResult> => {
    chat.messages.push({ role: "tutor", text: reply });
    await eng.store.saveChat(chatPath, chat);
    return { reply, changes: [], state, usage, local };
  };

  if (fmStr(chat.fm, "assess_done")) return say("This outcome check is marked. Start another from the topic page when you want to try again.");
  const o = outcomeTask((await eng.store.loadTopic(dir)).outcome);
  if (!o) return say("This topic has no outcome any more, so there is nothing to check. Recompile it to plan one.");
  const answer = text || (last?.role === "you" ? last.text : "");
  if (!answer) return say("Write your answer to the task above, or say **skip**.");
  if (text) {
    chat.messages.push({ role: "you", text });
    await eng.store.saveChat(chatPath, chat);
  }
  if (givesUp(answer)) {
    chat.fm.assess_done = eng.today();
    return say("Outcome check skipped. Nothing was marked or recorded.");
  }
  if (/\?$/.test(answer) || (answer.length < 60 && HELP_WORDS.test(answer))) return say(ASSESS_NO_HELP);

  const model = modelFor(s, "compileModel");
  const res = await eng.call({ model, effort: s.effort || undefined, system: await eng.store.skill("assess.md"), input: JSON.stringify({ task: o.task, criteria: o.criteria, answer }), jsonSchema: SCHEMA, onSpawn: opts.onSpawn }, s);
  const v = readVerdicts(res.structured, o.criteria);
  // A reply that does not judge every criterion is not a mark: nothing is logged, and the answer stays to be marked again.
  if (!v) throw new Error("The assessor's reply could not be read, so nothing was recorded. Try again.");
  const record: Assessment = { t: new Date().toISOString(), chat: chatPath, task: o.task, ...v, model: res.model || model || "CLI default" };
  await eng.store.appendAssessment(dir, record);
  chat.fm.assess_done = eng.today();
  const rows = v.criteria.map((c) => `- **${c.verdict === "met" ? "Met" : c.verdict === "partly" ? "Partly" : "Not yet"}**: ${c.criterion}${c.evidence ? ` (${c.evidence})` : ""}`).join("\n");
  return say(`**Outcome check marked:** ${assessmentLine(v)}.\n\n${rows}${v.summary ? `\n\n${v.summary}` : ""}\n\nMarked by a separate assessor that saw only the task and your answer. This is recorded apart from practice, and levels are unchanged.`, res.usage, false);
}
