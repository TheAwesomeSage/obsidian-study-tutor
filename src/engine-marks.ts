// Marks after the fact: disputing one, regrading it, grading a single answer, and the revision summary.
// Part of the engine (see engine.ts): each function takes the engine it works for, and the
// engine has a method of the same name that calls it. No Obsidian imports.

import { ClaudeError, Usage } from "./claude";
import { modelFor } from "./model-provider";
import { Attempt } from "./evidence";
import { Grade, LearnerState, Mode, Question, fmStr, setLevel, stateForPrompt } from "./formats";
import { GRADE_SCHEMA, utilityPrompt } from "./prompts";
import { sessionFor } from "./session";
import { activeDescriptions, recompute } from "./misconceptions";
import { REASONING_RULE, ReasoningAssessment, parseReasoning, rubricBrief } from "./reasoning";
import { GRADE_REASONING_SCHEMA, applyAttempt } from "./engine-common";
import { normaliseMark, outcomeOfGrade, withNote } from "./grading";
import { taskOf } from "./bankvariants";
import type { Engine } from "./engine";

/**
 * Sets a mark aside because the learner disputes it. The attempt stops counting as evidence
 * in either direction, and a level change it caused is undone if the level is still where
 * that change left it. With `chatPath`, the tutor is told to look at the answer again.
 */
/**
 * Where an attempt is kept: this topic, or, for a prerequisite check across topics, the topic
 * that holds the prerequisite.
 */
export async function findAttempt(eng: Engine, dir: string, attemptId: string): Promise<{ dir: string; state: LearnerState; attempt: Attempt } | null> {
  const s = eng.settings();
  const here = await eng.store.loadState(dir, s.targetLevel);
  const a = here.attempts.find((x) => x.id === attemptId);
  if (a) return { dir, state: here, attempt: a };
  for (const ref of await eng.store.listTopics()) {
    if (ref.dir === dir) continue;
    const st = await eng.store.loadState(ref.dir, s.targetLevel);
    const b = st.attempts.find((x) => x.id === attemptId);
    if (b) return { dir: ref.dir, state: st, attempt: b };
  }
  return null;
}

/** Sets a mark aside. The returned state is always this topic's, for the screen showing it. */
export async function dispute(eng: Engine, dir: string, attemptId: string, chatPath?: string): Promise<{ state: LearnerState; changes: string[]; attempt: Attempt }> {
  const s = eng.settings();
  const found = await eng.findAttempt(dir, attemptId);
  if (!found) throw new Error("That attempt is no longer on record.");
  const { state, attempt: a } = found;
  const changes: string[] = [];
  if (a.verification !== "disputed") {
    a.verification = "disputed";
    const change = [...state.changes].reverse().find((c) => c.cause === a.id);
    if (change && change.skill in state.names && state.levels[change.skill] === change.to) {
      const line = setLevel(state, change.skill, change.from, "dispute", "the mark behind this change is disputed");
      if (line) changes.push(found.dir === dir ? line : `${state.topic}: ${line}`);
    }
    // A misconception this answer supported or resolved is worked out again without it.
    for (const line of eng.recomputeMisconceptions(state)) changes.push(found.dir === dir ? line : `${state.topic}: ${line}`);
    await eng.store.saveState(found.dir, state);
  }
  const mine = found.dir === dir ? state : await eng.store.loadState(dir, s.targetLevel);
  if (chatPath) {
    const chat = await eng.store.loadChat(chatPath);
    const record = sessionFor(chat, mine, (fmStr(chat.fm, "mode", "tutor") as Mode) || "tutor");
    record.disputed = attemptId;
    chat.fm.session = JSON.stringify(record);
    await eng.store.saveChat(chatPath, chat);
  }
  return { state: mine, changes, attempt: a };
}

/**
 * A second opinion on a disputed bank answer, from the chat model with more thinking. Whatever
 * it says replaces the disputed mark; if the call fails the attempt stays set aside.
 */
export async function regrade(eng: Engine, dir: string, attemptId: string): Promise<{ state: LearnerState; attempt: Attempt; changes: string[]; usage: Usage }> {
  const found = await eng.findAttempt(dir, attemptId);
  if (!found) throw new Error("That attempt is no longer on record.");
  const { state, attempt: a } = found;
  if (found.dir !== dir) throw new Error("This answer was marked in conversation, so there is no model answer to regrade it against. Ask the tutor to look again.");
  const q = taskOf(await eng.store.loadQuestions(dir), a.questionId)?.question;
  if (!q) throw new Error("This answer was marked in conversation, so there is no model answer to regrade it against. Ask the tutor to look again.");
  const g = await eng.grade(q, a.answer, true);
  // The second opinion is held to its own breakdown like any other mark (grading.ts).
  const mark = normaliseMark({ proposed: outcomeOfGrade(g.grade), reasoning: g.reasoning, rubric: q.rubric });
  a.result = mark.result;
  a.grading = "model";
  a.verification = "unverified";
  a.note = `Regraded after a dispute. ${withNote(g.feedback, mark)}`.trim();
  a.assumptions = "a second model judgement with more thinking, after the first mark was disputed";
  if (g.reasoning) {
    a.reasoning = g.reasoning;
    a.mark = mark.basis;
  } else {
    delete a.reasoning;
    delete a.mark;
  }
  const changes = [...applyAttempt(state, a), ...eng.recomputeMisconceptions(state)];
  await eng.store.saveState(dir, state);
  return { state, attempt: a, changes, usage: g.usage };
}

/** Brings misconception records into line with the attempts as they now stand (a dispute or a regrade changed one). */
export function recomputeMisconceptions(eng: Engine, state: LearnerState): string[] {
  if (!state.misconceptionRecords?.length) return [];
  const r = recompute(state.misconceptionRecords, state.attempts, new Date().toISOString());
  state.misconceptionRecords = r.list;
  state.misconceptions = activeDescriptions(r.list, state.attempts);
  return r.changes;
}

/** Writes a revision summary note for the topic, with a concept map, into the topic folder. */
export async function summarySheet(eng: Engine, dir: string): Promise<{ path: string; usage: Usage }> {
  const s = eng.settings();
  const topic = await eng.store.loadTopic(dir);
  const state = await eng.store.loadState(dir, s.targetLevel);
  const res = await eng.call({
    model: modelFor(s, "chatModel"),
    effort: s.effort || undefined,
    system: await eng.store.skill("summary.md"),
    input: `# Topic card\n\n${topic.body}\n\n# Learner state\n\n${stateForPrompt(state, eng.today())}`,
    timeoutMs: 300000,
  }, s);
  const body = res.text.trim().replace(/^```(?:markdown|md)?\r?\n([\s\S]*?)\r?\n```$/, "$1");
  if (!body) throw new ClaudeError("The summary came back empty.");
  return { path: await eng.store.saveSummary(dir, topic.title, body), usage: res.usage };
}

/**
 * Grades one free-text answer. A reply that cannot be read as a grade throws, so a failed
 * grading leaves the answer ungraded; it never becomes a wrong answer by default.
 */
export async function grade(eng: Engine, q: Question, answer: string, careful = false): Promise<{ grade: Grade; feedback: string; usage: Usage; reasoning: ReasoningAssessment | null }> {
  const s = eng.settings();
  // Marking maths wrongly is worse than spending a little more, so answers with symbols or
  // numbers in them go to the chat model. Plain-prose answers stay on the cheap one.
  const mathsy = /\$|\\[a-zA-Z]+|[=<>^]|\d/.test(`${q.answer} ${answer}`);
  const strong = careful || (s.smartRouting && mathsy);
  // An open answer is judged on its result, method and assumptions apart as well as overall.
  // Exact answers and multiple choice keep the overall mark alone.
  const open = q.type === "open";
  const brief = open && q.rubric ? rubricBrief(q.rubric) : "";
  const res = await eng.call({
    model: modelFor(s, strong ? "chatModel" : "utilityModel"),
    effort: careful ? s.hardEffort || s.effort || undefined : strong ? s.effort || undefined : undefined,
    system: utilityPrompt(await eng.store.skill("utility.md"), "grade"),
    input: `Question: ${q.question}\n\nModel answer: ${q.answer}\n${q.explanation ? `Explanation: ${q.explanation}\n` : ""}${q.rubric ? `Rubric: ${q.rubric}\n` : ""}${brief ? `Rubric by what it checks:\n${brief}\n` : ""}${open ? `\n${REASONING_RULE} Give this as "reasoning", answering the rubric points in order in rubric_met.\n` : ""}\nLearner's answer: ${answer.trim() || "(blank)"}`,
    jsonSchema: open ? GRADE_REASONING_SCHEMA : GRADE_SCHEMA,
  }, s);
  let o = res.structured as { grade?: string; feedback?: string; reasoning?: unknown } | undefined;
  if (!o) {
    try {
      o = JSON.parse(res.text);
    } catch {
      o = {};
    }
  }
  if (!["again", "hard", "good", "easy"].includes(String(o?.grade))) throw new ClaudeError("The answer could not be graded. It remains ungraded. Retry to check it.");
  const grade = o!.grade as Grade;
  return { grade, feedback: String(o?.feedback ?? ""), usage: res.usage, reasoning: open ? parseReasoning(o?.reasoning, q.rubric ?? "") : null };
}
