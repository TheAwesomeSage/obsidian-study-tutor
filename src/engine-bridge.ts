// A bridge across topics: before a concept is taught, the learner carries over a concept from another
// topic with the same deep structure (structures.ts). The question is written by code and marked by the
// separate assessor against a rubric built from both cards and the structure. Part of the engine (see
// engine.ts): each function takes the engine it works for. No Obsidian imports.

import { zeroUsage, type Usage } from "./claude";
import { recordAttempt, type Outcome } from "./evidence";
import { Question, fmStr, givesUp } from "./formats";
import { normaliseMark, outcomeOfGrade, withNote } from "./grading";
import { BRIDGE_FROM_LEVEL, bridgeMarking, bridgeQuestion, structureOf, type StructureTwin } from "./structures";
import { applyAttempt, type TurnOpts, type TurnResult } from "./engine-common";
import { grade } from "./engine-marks";
import type { Decision } from "./policy";
import type { Engine } from "./engine";

export const BRIDGE_NO_HELP = "This bridge question is answered before any teaching, so there is no help with it. Answer as best you can, or say **skip** to go straight to the lesson.";
const HELP_WORDS = /\b(hints?|clue|help|explain)\b/i;

interface OpenBridge {
  skill: number;
  from: string;
}

function openBridge(raw: string): OpenBridge | null {
  try {
    const v = JSON.parse(raw) as Partial<OpenBridge>;
    return typeof v.skill === "number" && typeof v.from === "string" && v.from ? { skill: v.skill, from: v.from } : null;
  } catch {
    return null;
  }
}

/** The bank-shaped question a bridge is recorded and marked as. Its id names the concept it bridges from. */
function bridgeAsQuestion(skill: number, newName: string, newSection: string, twin: StructureTwin): Question {
  const { answer, rubric } = bridgeMarking(newName, newSection, twin);
  return { id: `bridge:${twin.id}`, subskill: skill, type: "open", question: bridgeQuestion(newName, twin), answer, rubric, task: "transfer", family: `bridge-${twin.structure}` } as Question;
}

/** Puts the bridge question the policy chose. No model call. */
export async function askBridge(eng: Engine, dir: string, chatPath: string, decision: Decision): Promise<TurnResult> {
  const state = await eng.store.loadState(dir, eng.settings().targetLevel);
  const chat = await eng.store.loadChat(chatPath);
  const twin = (await eng.store.structureTwins(dir, state.target)).find((t) => t.id === decision.bridgeFrom && t.skill === decision.focus && t.demonstrated && (t.level ?? 0) >= BRIDGE_FROM_LEVEL);
  const n = decision.focus ?? 0;
  const reply = twin ? bridgeQuestion(state.names[n] ?? "", twin) : "";
  if (twin) {
    chat.fm.bridge = JSON.stringify({ skill: n, from: twin.id });
    chat.fm.asked_at = new Date().toISOString();
    chat.messages.push({ role: "tutor", text: `*${decision.reason}*\n\n${reply}` });
    await eng.store.saveChat(chatPath, chat);
  }
  return { reply, changes: [], state, usage: zeroUsage(), local: true, decision };
}

/** The answer to an open bridge question, marked by the assessor and recorded with the concept it came from. */
export async function bridgeTurn(eng: Engine, dir: string, chatPath: string, message: string, opts: TurnOpts): Promise<TurnResult | null> {
  const now = new Date().toISOString();
  const chat = await eng.store.loadChat(chatPath);
  const open = openBridge(fmStr(chat.fm, "bridge"));
  const state = await eng.store.loadState(dir, eng.settings().targetLevel);
  const topic = await eng.store.loadTopic(dir);
  const twin = open ? (await eng.store.structureTwins(dir, state.target)).find((t) => t.id === open.from && t.skill === open.skill) : undefined;
  const sk = open ? topic.subskills.find((k) => k.n === open.skill) : undefined;
  // A card edited since the question was put (the structure line gone, the concept renumbered) closes it.
  if (!open || !twin || !sk || !structureOf(twin.structure)) {
    chat.fm.bridge = "";
    await eng.store.saveChat(chatPath, chat);
    return null;
  }
  const say = async (reply: string, extra: Partial<TurnResult> = {}): Promise<TurnResult> => {
    chat.messages.push({ role: "tutor", text: reply });
    await eng.store.saveChat(chatPath, chat);
    return { reply, changes: [], state, usage: zeroUsage(), local: true, ...extra };
  };
  const text = message.trim();
  const last = chat.messages[chat.messages.length - 1];
  const answer = text || (last?.role === "you" ? last.text : "");
  const q = bridgeAsQuestion(sk.n, sk.name, sk.section, twin);
  if (!answer) return say(q.question);
  if (text) {
    chat.messages.push({ role: "you", text });
    chat.fm.pending_confidence = typeof opts.confidence === "number" ? opts.confidence : "";
  }
  if (!givesUp(answer) && (/\?$/.test(answer) || (answer.length < 60 && HELP_WORDS.test(answer)))) return say(BRIDGE_NO_HELP);
  // A failed assessor call must leave the same answer and stated confidence for Retry.
  await eng.store.saveChat(chatPath, chat);

  let usage: Usage = zeroUsage();
  let result: Outcome = "skipped";
  let note = "";
  let feedback = "";
  let reasoning = null as Awaited<ReturnType<typeof grade>>["reasoning"];
  let basis: ReturnType<typeof normaliseMark>["basis"] | null = null;
  if (!givesUp(answer)) {
    const g = await grade(eng, q, answer, true, true);
    usage = g.usage;
    feedback = g.feedback;
    reasoning = g.reasoning;
    const mark = normaliseMark({ proposed: outcomeOfGrade(g.grade), reasoning: g.reasoning, rubric: q.rubric ?? "" });
    result = mark.result;
    note = withNote(g.feedback, mark);
    basis = mark.basis;
  }
  const attempt = eng.bankAttempt({ id: `${chatPath}:${chat.messages.length}:${q.id}`, chat, state, q, answer, result, activity: "bridge", mode: "auto", grading: "model", assumptions: "marked by the separate assessor against the two concepts' cards and the structure they share; a model's judgement, not a check by code", note: result === "correct" ? "" : note, now });
  attempt.taskType = "transfer";
  attempt.transferFrom = twin.id;
  if (reasoning) attempt.reasoning = reasoning;
  if (basis) attempt.mark = basis;
  state.attempts = recordAttempt(state.attempts, attempt);
  const changes = result === "skipped" ? [] : applyAttempt(state, attempt);
  await eng.store.saveState(dir, state);
  chat.fm.bridge = "";
  chat.fm.pending_confidence = "";
  chat.fm.await_continue = "yes";
  const s = structureOf(twin.structure)!;
  const head = result === "skipped" ? "**Skipped.**" : result === "correct" ? "**Correct.**" : result === "partial" ? "**Partly right.**" : result === "ungraded" ? "**Left ungraded.**" : "**Not yet.**";
  const parts = [
    `${head}${feedback && result !== "skipped" ? ` ${feedback}` : ""} *Marked by the separate assessor, a model: not a check by code.*`,
    `**Where the comparison breaks:** ${s.breaks}`,
    `Press **Continue** for the lesson on ${sk.name}.`,
  ];
  return say(parts.join("\n\n"), { usage, changes, attempt });
}
