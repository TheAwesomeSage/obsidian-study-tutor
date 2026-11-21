// The outcome check: the course's outcome task (the topic card's `## Outcome`), attempted unaided and
// marked by a separate assessor. The assessor is one call with skills/assess.md on the compile model,
// not the tutor's chat model, and it sees only the task, its criteria and the answer: no chat, lesson
// or learner state. The verdict is logged in the topic's assessments.md and moves no level, card or
// estimate. Part of the engine (see engine.ts): each function takes the engine it works for, and the
// engine has a method of the same name. No Obsidian imports.

import { zeroUsage } from "./claude";
import { modelFor } from "./model-provider";
import { type Chat, type Frontmatter, fmStr, givesUp, textHash } from "./formats";
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

export const ASSESS_NO_HELP = "That looks like a request for help, and an outcome check gives none until it is marked. Add to your answer, send **mark** when it is complete, or say **skip**.";
/** The reply to each part of an answer: nothing is marked until the learner says so. */
export const ASSESS_ADDED = "Added to your answer. Send more, or send **mark** when it is complete.";
/** Used when the outcome lists no criteria of its own. */
export const WHOLE_TASK = "The task is done correctly and completely.";
const MAX_CRITERIA = 12;
/** Only a short message can be a request for help: a long one is an answer that may well ask "is that right?". */
const HELP_REQUEST = /^\s*(?:(?:can|could|would|will) (?:you|i)\b.*|(?:give|show|tell) me\b.*|(?:a |another )?(?:hint|clue)s?\b.*|help\b.*|explain\b.*|what(?:'s| is) the answer\b.*|i(?:'m| am) stuck\b.*)$/i;
const MARK = /^\s*(?:mark(?: it| this| my answer)?|done|submit|finished)\s*[.!]?\s*$/i;
const VERDICTS: Verdict[] = ["met", "partly", "no"];
const SCHEMA = {
  type: "object", additionalProperties: false, required: ["criteria", "summary"],
  properties: {
    criteria: { type: "array", maxItems: MAX_CRITERIA, items: { type: "object", additionalProperties: false, required: ["criterion", "verdict", "evidence"], properties: { criterion: { type: "string" }, verdict: { type: "string", enum: VERDICTS }, evidence: { type: "string" } } } },
    summary: { type: "string" },
  },
};

/** The outcome section split into the task and its criteria (the `- ` lines after "Done well when:"). */
export function outcomeTask(outcome: string): { task: string; criteria: string[] } | null {
  const text = outcome.replace(/\r\n?/g, "\n").trim();
  if (!text) return null;
  const [head, tail = ""] = text.split(/^\s*\**Done well when:\**\s*$/m);
  const criteria = tail.split("\n").map((l) => /^\s*[-*]\s+(.+)$/.exec(l)?.[1].trim() ?? "").filter(Boolean).slice(0, MAX_CRITERIA);
  const task = head.trim();
  return task ? { task, criteria: criteria.length ? criteria : [WHOLE_TASK] } : null;
}

/** Model text made inert for any Markdown view, fences included: it is saved in the chat note. */
const inert = (s: string): string => neutraliseRemote(s, { trustFences: false });
const one = (s: unknown, max: number): string => (typeof s === "string" ? inert(s.replace(/\s+/g, " ").trim().slice(0, max)) : "");

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
/** Which outcome a check was opened for, so a recompile that changes it cannot mark an answer against another task. */
const outcomeKey = (o: { task: string; criteria: string[] }): string => textHash(JSON.stringify(o));

/** The learner's answer so far: every message the check accepted as part of it. */
function answerSoFar(chat: Chat): string {
  const parts: string[] = [];
  chat.messages.forEach((m, i) => {
    if (m.role === "you" && chat.messages[i + 1]?.text === ASSESS_ADDED) parts.push(m.text);
  });
  return parts.join("\n\n");
}

/**
 * Opens an outcome check on a topic: a chat that states the task and how it will be judged. An open
 * check for the same outcome that is not marked yet is returned instead of a second one. Null when the
 * topic has no outcome.
 */
export async function startAssessment(eng: Engine, dir: string): Promise<string | null> {
  const topic = await eng.store.loadTopic(dir);
  const o = outcomeTask(topic.outcome);
  if (!o) return null;
  const key = outcomeKey(o);
  // Checks are recent chats: the newest few are enough to find one still open.
  for (const path of (await eng.store.listChats(dir)).slice(-8).reverse()) {
    const chat = await eng.store.loadChat(path).catch(() => null);
    if (chat && isAssessChat(chat.fm) && !fmStr(chat.fm, "assess_done") && fmStr(chat.fm, "assess_key") === key) return path;
  }
  const chatPath = await eng.store.newChat(dir, topic.title, "quiz");
  const chat = await eng.store.loadChat(chatPath);
  chat.fm.assess = "outcome";
  chat.fm.assess_key = key;
  chat.fm.asked_at = new Date().toISOString();
  chat.messages.push({
    role: "tutor",
    text: `**Outcome check** · on your own, no hints · marked by a separate assessor that sees only the task and your answer · levels are unchanged.\n\n${o.task}\n\nIt is judged on:\n${o.criteria.map((c) => `- ${c}`).join("\n")}\n\nWrite your answer in one message or several. Nothing is marked until you send **mark**.`,
  });
  await eng.store.saveChat(chatPath, chat);
  return chatPath;
}

/**
 * One turn of an outcome check. Parts of the answer and requests for help are answered without a
 * model call; **mark** sends the whole answer to the assessor once, and the verdict is logged.
 */
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
  const heard = () => { if (text) chat.messages.push({ role: "you", text }); };

  if (fmStr(chat.fm, "assess_done")) {
    heard();
    return say("This outcome check is finished. Start another from the topic page when you want to try again.");
  }
  const o = outcomeTask((await eng.store.loadTopic(dir)).outcome);
  if (!o || fmStr(chat.fm, "assess_key") !== outcomeKey(o)) {
    heard();
    chat.fm.assess_done = eng.today();
    return say("The topic was recompiled and its outcome changed, so this check was closed without marking. Start a new one from the topic page.");
  }
  // An empty message (Get the reply, Retry) repeats the last request: a mark that did not finish, or the prompt.
  const request = text || (last?.role === "you" ? last.text : "");
  if (givesUp(request)) {
    heard();
    chat.fm.assess_done = eng.today();
    return say("Outcome check skipped. Nothing was marked or recorded.");
  }
  if (!MARK.test(request)) {
    if (!text) return say("Write your answer to the task above, then send **mark**.");
    heard();
    if (text.length < 80 && HELP_REQUEST.test(text)) return say(ASSESS_NO_HELP);
    return say(ASSESS_ADDED);
  }

  heard();
  const answer = answerSoFar(chat);
  if (!answer) return say("There is no answer to mark yet. Write it first, then send **mark**.");
  await eng.store.saveChat(chatPath, chat);
  const model = modelFor(s, "compileModel");
  const res = await eng.call({ model, effort: s.hardEffort || s.effort || undefined, system: await eng.store.skill("assess.md"), input: JSON.stringify({ task: o.task, criteria: o.criteria, answer }), jsonSchema: SCHEMA, onSpawn: opts.onSpawn }, s);
  const v = readVerdicts(res.structured, o.criteria);
  // A reply that does not judge every criterion is not a mark: nothing is logged, and Retry marks the same answer again.
  if (!v) throw new Error("The assessor's reply could not be read, so nothing was recorded. Try again.");
  const record: Assessment = { t: new Date().toISOString(), chat: chatPath, task: o.task, ...v, model: res.model || model || "CLI default" };
  await eng.store.appendAssessment(dir, record);
  chat.fm.assess_done = eng.today();
  const rows = v.criteria.map((c) => `- **${c.verdict === "met" ? "Met" : c.verdict === "partly" ? "Partly" : "Not yet"}**: ${c.criterion}${c.evidence ? ` (${c.evidence})` : ""}`).join("\n");
  return say(inert(`**Outcome check marked:** ${assessmentLine(v)}.\n\n${rows}${v.summary ? `\n\n${v.summary}` : ""}\n\nMarked by a separate assessor that saw only the task and your answer. This is recorded apart from practice, and levels are unchanged.`), res.usage, false);
}
