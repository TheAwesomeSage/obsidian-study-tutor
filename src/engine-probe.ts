// Running a cold probe: sealed questions asked one after another with no help, marked by the bank's own
// code, and recorded as probe evidence that moves no level (evidence.ts). Part of the engine (see engine.ts):
// each function takes the engine it works for, and the engine has a method of the same name. No Obsidian imports.

import { zeroUsage } from "./claude";
import { recordAttempt, type Outcome } from "./evidence";
import { Question, fmList, fmStr, formatQuizQuestion, givesUp, looksLikeQuestion } from "./formats";
import { normaliseMark, outcomeOfGrade, withNote } from "./grading";
import { readPresentationRequest } from "./presentation";
import { currentSealed, probeQueue, spentSealed } from "./probe";
import { sentAsCode } from "./codequestions";
import { markBankAnswer, verdictText } from "./engine-bank";
import type { TurnOpts, TurnResult } from "./engine-common";
import type { Engine } from "./engine";

export const PROBE_NO_HELP = "This is a cold probe, so there is no help until it ends. Answer as best you can, or say **skip**.";

/** Starts a probe chat with the sealed questions that are ready, or returns null when there are none. */
export async function startProbe(eng: Engine, dir: string): Promise<{ chatPath: string; count: number } | null> {
  const state = await eng.store.loadState(dir, eng.settings().targetLevel);
  const queue = probeQueue(await eng.store.loadSealed(dir), state, eng.today());
  if (!queue.length) return null;
  const chatPath = await eng.store.newChat(dir, (await eng.store.loadTopic(dir)).title, "quiz");
  const chat = await eng.store.loadChat(chatPath);
  chat.fm.probe = "yes";
  chat.fm.probe_queue = queue.map((q) => q.id);
  chat.fm.card = queue[0].id;
  chat.fm.asked_at = new Date().toISOString();
  chat.messages.push({ role: "tutor", text: `**Cold probe** · ${queue.length} question${queue.length === 1 ? "" : "s"} · no hints or explanations until you finish.\n\n${formatQuizQuestion(queue[0], state)}` });
  await eng.store.saveChat(chatPath, chat);
  return { chatPath, count: queue.length };
}

/** One turn of a probe chat. Never calls the tutor, and never schedules a card, sets a level or records a misconception. */
export async function probeTurn(eng: Engine, dir: string, chatPath: string, message: string, opts: TurnOpts): Promise<TurnResult> {
  const now = new Date().toISOString();
  const chat = await eng.store.loadChat(chatPath);
  const state = await eng.store.loadState(dir, eng.settings().targetLevel);
  const sealed = currentSealed(await eng.store.loadSealed(dir), state);
  const queue = fmList(chat.fm, "probe_queue");
  const pending = sealed.find((q) => q.id === fmStr(chat.fm, "card"));
  const text = message.trim();
  const last = chat.messages[chat.messages.length - 1];
  const say = async (reply: string, extra: Partial<TurnResult> = {}): Promise<TurnResult> => {
    chat.messages.push({ role: "tutor", text: reply });
    await eng.store.saveChat(chatPath, chat);
    return { reply, changes: [], state, usage: zeroUsage(), local: true, ...extra };
  };

  if (fmStr(chat.fm, "probe_done")) return say("This cold probe is finished. Start another from the topic page when one is due.");
  // A recompile can retire the open question; the probe goes on with the next one that is left.
  if (!pending) return advance("");

  const answer = text || (last?.role === "you" ? last.text : "");
  if (!answer) return say(formatQuizQuestion(pending, state));
  // A question or a request for a visual is help, and a cold probe gives none. A block of code for a code question is an answer.
  if ((looksLikeQuestion(answer) || readPresentationRequest(answer)) && !givesUp(answer) && !(pending.code && sentAsCode(answer))) {
    if (text) chat.messages.push({ role: "you", text });
    return say(PROBE_NO_HELP);
  }
  if (text) {
    chat.messages.push({ role: "you", text });
    chat.fm.pending_confidence = typeof opts.confidence === "number" ? opts.confidence : "";
    chat.fm.answered_at = now;
    await eng.store.saveChat(chatPath, chat);
  }

  const m = await markBankAnswer(eng, pending, null, answer, opts);
  if (m.kind === "reply") return say(m.reply);
  const mark = normaliseMark({ proposed: m.skipped ? "skipped" : outcomeOfGrade(m.grade), reasoning: m.reasoning, rubric: m.rubric });
  const result: Outcome = mark.result;
  const note = withNote(m.note, mark);
  const attempt = eng.bankAttempt({ id: `${chatPath}:${chat.messages.length}:${pending.id}`, chat, state, q: pending, answer, result, activity: "probe", mode: "quiz", grading: m.grading, assumptions: m.assumptions, note: result === "correct" ? "" : note, now, errorType: result === "correct" ? "" : m.mistake });
  attempt.probe = true;
  attempt.taskType = "transfer";
  if (m.reasoning) {
    if (m.grading !== "executed") attempt.reasoning = m.reasoning;
    attempt.mark = mark.basis;
  }
  if (m.codeRun) attempt.code = m.codeRun;
  state.attempts = recordAttempt(state.attempts, attempt);
  await eng.store.saveState(dir, state);
  chat.fm.pending_confidence = "";
  return advance(verdictText(m, pending, result, note), m.usage, m.tools, attempt);

  /** Asks the first queued question with no answer yet, or closes the probe when none is left. */
  async function advance(verdict: string, usage = zeroUsage(), tools: TurnResult["tools"] = [], attempt?: TurnResult["attempt"]): Promise<TurnResult> {
    const spent = spentSealed(sealed, state.attempts);
    const next = queue.map((id) => sealed.find((q) => q.id === id)).find((q): q is Question => !!q && !spent.has(q.id));
    const head = verdict ? `${verdict}\n\n---\n\n` : "";
    if (next) {
      chat.fm.card = next.id;
      chat.fm.asked_at = now;
      return say(`${head}${formatQuizQuestion(next, state)}`, { usage, tools, attempt });
    }
    const mine = state.attempts.filter((a) => a.probe && queue.includes(a.questionId));
    chat.fm.card = "";
    chat.fm.probe_done = eng.today();
    return say(`${head}**Cold probe finished:** ${mine.filter((a) => a.result === "correct").length}/${mine.length} right. These questions were sealed when the topic was compiled, so this shows what transfers. Levels are unchanged.`, { usage, tools, attempt });
  }
}

