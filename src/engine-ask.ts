// Ask anything: a free question or learning goal with no topic behind it. One call to the primary
// chat model with skills/ask.md, nothing else: no compile, no placement, no Ollama, no learner
// state. The reply's hidden header (narrow or broad, the goal, a first step) is kept in the chat's
// frontmatter for turning the chat into a course later. Part of the engine (see engine.ts): each
// function takes the engine it works for, and the engine has a method of the same name. No Obsidian imports.

import type { Usage } from "./claude";
import { modelFor } from "./model-provider";
import { Chat, fmStr, words } from "./formats";
import { neutraliseRemote } from "./safemd";
import type { TurnOpts } from "./engine-common";
import type { Engine } from "./engine";

export type AskKind = "narrow" | "broad";

export interface AskResult {
  reply: string;
  usage: Usage;
  /** From the reply's header; empty when the header was missing or could not be read. */
  kind: AskKind | "";
  goal: string;
  firstStep: string;
  model: string;
}

/** True for a free question's chat, which belongs to no topic. */
export const isAskChat = (chat: Chat | null | undefined): boolean => !!chat && fmStr(chat.fm, "mode") === "ask";

/** A chat's title from the learner's first message: its first line, cut at a word near 80 characters. */
export function askTitle(message: string): string {
  const line = message.trim().split(/\r?\n/)[0].replace(/\s+/g, " ").trim();
  if (line.length <= 80) return line || "Question";
  const cut = line.slice(0, 80);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 40 ? cut.lastIndexOf(" ") : 80).trim()}…`;
}

/** The fewest words of conversation a free chat sends, whatever `maxChatWords` says: a question and its answers need room. */
export const ASK_MIN_CONTEXT_WORDS = 1500;

const oneLine = (x: unknown, max: number): string => (typeof x === "string" ? neutraliseRemote(x.replace(/\s+/g, " ").trim()).slice(0, max) : "");

/**
 * Takes the `<ask>{json}</ask>` header out of a reply. Only a header at the very start is read;
 * every closed one is removed from the text wherever it is. An unclosed one at the start loses only
 * the tag and the JSON-looking part after it on that line, never the reply. `header` is null unless
 * it held valid JSON with a known kind.
 */
export function readAskHeader(raw: string): { text: string; header: { kind: AskKind; goal: string; firstStep: string } | null } {
  const body = /^\s*`{0,3}\s*<ask>([\s\S]*?)<\/ask>/.exec(raw)?.[1] ?? null;
  let text = raw.replace(/`{0,3}[ \t]*<ask>[\s\S]*?<\/ask>[ \t]*`{0,3}/g, "\n");
  text = text.replace(/^\s*<ask>[ \t]*(\{(?:[ \t]*"[^"\n]*"[ \t]*[:,]?)*[ \t]*\}?)?/, "");
  let header: { kind: AskKind; goal: string; firstStep: string } | null = null;
  try {
    const v = body === null ? null : JSON.parse(body);
    if (v && (v.kind === "narrow" || v.kind === "broad")) header = { kind: v.kind, goal: oneLine(v.goal, 200), firstStep: v.kind === "broad" ? oneLine(v.first_step, 200) : "" };
  } catch {
    header = null;
  }
  return { text: text.trim(), header };
}

/**
 * The conversation as the model sees it: the opening message (it holds the goal) and then as many
 * of the latest messages as fit in `maxWords`, counted from the end, with a marker where earlier
 * ones were left out. The latest message is always sent. The file keeps the whole transcript.
 */
export function askContext(chat: Chat, maxWords: number): string {
  const msgs = chat.messages;
  const line = (m: Chat["messages"][number]) => `${m.role === "you" ? "LEARNER" : "TUTOR"}: ${m.text.trim()}`;
  if (!msgs.length) return "";
  const kept: number[] = [];
  let used = words(msgs[0].text);
  for (let i = msgs.length - 1; i > 0; i--) {
    const w = words(msgs[i].text);
    if (kept.length && used + w > maxWords) break;
    kept.unshift(i);
    used += w;
  }
  const omitted = msgs.length - 1 - kept.length;
  const out = ["## Messages", line(msgs[0]), ""];
  if (omitted > 0) out.push(`[${omitted} earlier message${omitted === 1 ? "" : "s"} omitted]`, "");
  for (const i of kept) out.push(line(msgs[i]), "");
  return out.join("\n").trim();
}

/** Starts a free chat titled from the learner's message. The message itself is sent by `askTurn`. */
export async function startAsk(eng: Engine, message: string): Promise<string> {
  return eng.store.newAskChat(askTitle(message));
}

/**
 * One turn of a free chat. A message is saved first, so a failed call keeps it; an empty message
 * answers the learner's last one again. The earlier turns are the context.
 */
export async function askTurn(eng: Engine, chatPath: string, message: string, opts: TurnOpts = {}): Promise<AskResult> {
  const s = eng.settings();
  const chat = await eng.store.loadChat(chatPath);
  if (!isAskChat(chat)) throw new Error("This is not a free question chat.");
  const text = message.trim();
  if (text) {
    chat.messages.push({ role: "you", text });
    await eng.store.saveChat(chatPath, chat);
  }
  if (chat.messages[chat.messages.length - 1]?.role !== "you") throw new Error("There is no question to answer.");

  const attached = opts.attached ? `# Note the learner attached: ${opts.attached.name}\n${opts.attached.text}\n\n` : "";
  const input = `${attached}${askContext(chat, Math.max(s.maxChatWords, ASK_MIN_CONTEXT_WORDS))}\n\nReply to the learner's last message.\n`;
  const model = modelFor(s, "chatModel");
  const res = await eng.call({ model, effort: s.effort || undefined, system: await eng.store.skill("ask.md"), input, onSpawn: opts.onSpawn }, s);

  const { text: shown, header } = readAskHeader(res.text);
  const reply = neutraliseRemote(shown) || "(empty reply)";
  // The chat is read again: the call can take a while, and the file is the record.
  const saved = await eng.store.loadChat(chatPath);
  saved.messages.push({ role: "tutor", text: reply });
  // Only the first header that can be read sets the goal: a follow-up's header never replaces the opening one.
  if (header && !fmStr(saved.fm, "ask_kind")) Object.assign(saved.fm, { ask_kind: header.kind, goal: header.goal, first_step: header.firstStep });
  await eng.store.saveChat(chatPath, saved);
  return {
    reply,
    usage: res.usage,
    kind: (fmStr(saved.fm, "ask_kind") as AskKind | "") || "",
    goal: fmStr(saved.fm, "goal"),
    firstStep: fmStr(saved.fm, "first_step"),
    model: model || "CLI default",
  };
}
