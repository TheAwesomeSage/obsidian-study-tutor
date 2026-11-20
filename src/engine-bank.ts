// Turns answered from the question bank and marked by code: placement, and practice in Practise and Adaptive.
// Part of the engine (see engine.ts): each function takes the engine it works for, and the
// engine has a method of the same name that calls it. No Obsidian imports.

import { zeroUsage } from "./claude";
import { Attempt, Grading, Outcome, TASK_TYPES, TaskType, recordAttempt } from "./evidence";
import { Chat, Grade, LearnerState, Mode, Question, objectiveStamp, answerText, chatWords, codeMark, differentNumbers, fmList, fmNum, fmStr, formatQuizQuestion, givesUp, looksLikeQuestion, mcqLetter, parseMcqReply, placementQuestions, sameShortAnswer, schedule, setLevel } from "./formats";
import { Decision } from "./policy";
import { readPresentationRequest } from "./presentation";
import { sessionFor } from "./session";
import { ToolResult } from "./tools";
import { ReasoningAssessment, finalExpression, withCheck } from "./reasoning";
import { gradeOfOutcome, normaliseMark, outcomeOfGrade, withNote } from "./grading";
import { secondsPerItem, tutorSchedules } from "./scheduler";
import { IdeaStatus, coverageOf, ideaLabel, ideaOfQuestion, nextMove } from "./coverage";
import { BankPurpose, TurnResult, TurnOpts, MAX_ANSWER_SECONDS, applyAttempt, pickQuizQuestion } from "./engine-common";
import { dueMistake, fadedFor, followUp, freshVariant, markTask, metBefore, mistakeUpdates, pairedFor, taskHelp, taskOf } from "./bankvariants";
import { baseQuestionId } from "./families";
import { CodeRunRecord, codeGradingQuestion, codeRunMarkdown, codeRunRecord, codeSource, looksLikeCode, markCodeRun, notRun, sentAsCode, solutionMarkdown } from "./codequestions";
import type { CodeRunReport, CodeTask } from "./codetask";
import type { Engine } from "./engine";

/**
 * Places a new learner with plain code: one multiple-choice or short question per subskill
 * from the bank, marked without a model, then starting levels are set from the results.
 * Returns null when placement does not apply, and the caller then runs a normal turn.
 */
export async function placementTurn(eng: Engine, dir: string, chatPath: string, message: string, opts: TurnOpts = {}): Promise<TurnResult | null> {
  const s = eng.settings();
  const now = new Date().toISOString();
  const chat = await eng.store.loadChat(chatPath);
  const mode = (fmStr(chat.fm, "mode", "tutor") as Mode) || "tutor";
  const phase = fmStr(chat.fm, "placement");
  const text = message.trim();
  const state = await eng.store.loadState(dir, s.targetLevel);
  const questions = await eng.store.loadQuestions(dir);
  const usage = zeroUsage();
  const tools: ToolResult[] = [];
  const say = async (reply: string, open: Question | null): Promise<TurnResult> => {
    chat.messages.push({ role: "tutor", text: reply });
    eng.bankSession(chat, state, mode, open, { action: "diagnose", reason: "Quick questions to find your starting level. The plugin marks them, so they use no tokens." }, now);
    await eng.store.saveChat(chatPath, chat);
    return { reply, changes: [], state, usage, local: true, tools };
  };

  if (phase !== "on") {
    const fresh = !chat.messages.length && !text && Object.values(state.levels).every((l) => l === null);
    const queue = fresh ? placementQuestions(questions, state) : [];
    if (!queue.length) return null;
    chat.fm.placement = "on";
    chat.fm.queue = queue.map((q) => q.id);
    chat.fm.placed = [];
    chat.fm.card = queue[0].id;
    return say(`**Placement** · ${queue.length} quick question${queue.length === 1 ? "" : "s"} to find your starting level, one per subskill. They are marked by the plugin, so this uses no tokens. Say **skip** for anything you have not met.\n\n---\n\n${formatQuizQuestion(queue[0], state)}`, queue[0]);
  }

  const queue = fmList(chat.fm, "queue");
  const pending = questions.find((q) => q.id === fmStr(chat.fm, "card"));
  const last = chat.messages[chat.messages.length - 1];
  const answer = text || (last?.role === "you" ? last.text : "");
  if (!pending) {
    // The pending question is gone (the chat was used in another mode, or the bank was
    // recompiled). Give up on placement instead of asking for an answer to nothing.
    chat.fm.placement = "done";
    chat.fm.card = "";
    await eng.store.saveChat(chatPath, chat);
    return null;
  }
  if (!answer) return say(formatQuizQuestion(pending, state), pending);
  if (text) {
    chat.messages.push({ role: "you", text });
    chat.fm.pending_confidence = typeof opts.confidence === "number" ? opts.confidence : "";
    chat.fm.answered_at = now;
    await eng.store.saveChat(chatPath, chat);
  }

  const mark = codeMark(pending, answer);
  if (mark === "letter") return say("Reply with one letter, for example **B**, or say **skip**.", pending);
  // Placement never calls a model. What code cannot decide is left unplaced: a check that
  // failed or could not tell is not a wrong answer.
  const sym = mark === "model" && pending.type === "short" ? await eng.checkEquivalent(pending.answer, answer) : null;
  if (sym?.tool) tools.push(sym.tool);
  const skipped = givesUp(answer);
  const result: Outcome = skipped ? "skipped" : mark === "good" || sym?.equal === true ? "correct" : mark === "model" && (!sym || sym.equal === null) ? "ungraded" : "incorrect";
  const level = result === "skipped" ? 0 : result === "correct" ? 2 : result === "incorrect" ? 1 : -1;
  const attemptId = `${chatPath}:${chat.messages.length}:${pending.id}`;
  const repeat = state.attempts.some((a) => a.id === attemptId);
  const attempt = eng.bankAttempt({ id: attemptId, chat, state, q: pending, answer, result, activity: "placement", mode, grading: sym?.equal !== null && sym ? sym.grading : "deterministic", assumptions: result === "ungraded" ? "could not be checked by code, so it was left ungraded" : sym && sym.equal !== null ? sym.assumptions : pending.type === "mcq" ? "the chosen letter was compared with the answer key" : result === "incorrect" ? "both answers are plain numbers, and they differ" : "matched the expected answer after ignoring case and spacing", note: result === "ungraded" ? "Could not be checked automatically during placement." : "", now });
  state.attempts = recordAttempt(state.attempts, attempt);
  const placed = [...fmList(chat.fm, "placed").filter((p) => !p.startsWith(`${pending.subskill}:`)), `${pending.subskill}:${level}`];
  chat.fm.placed = placed;
  if (!repeat && result !== "ungraded") {
    if (pending.subskill in state.names) {
      const b = state.bank[pending.subskill] ?? (state.bank[pending.subskill] = { right: 0, total: 0 });
      b.total += 1;
      if (result === "correct") b.right += 1;
    }
    if (tutorSchedules(s)) state.cards[pending.id] = schedule(state.cards[pending.id], result === "correct" ? "good" : "again", eng.today(), state.scheduler);
  }
  chat.fm.pending_confidence = "";
  const verdict = result === "correct" ? "**Correct.**" : result === "incorrect" ? "**Not quite.**" : result === "skipped" ? "**Skipped.**" : "**Could not be checked automatically**, so this subskill is left unplaced for now.";

  const next = questions.find((q) => q.id === queue[queue.indexOf(pending.id) + 1]);
  if (next) {
    chat.fm.card = next.id;
    await eng.store.saveState(dir, state);
    const r = await say(`${verdict}\n\n---\n\n${formatQuizQuestion(next, state)}`, next);
    r.attempt = attempt;
    return r;
  }

  // Finished: set a starting level wherever an answer could be marked, and choose where to begin.
  const got = new Map(placed.map((p) => p.split(":").map(Number) as [number, number]));
  const ns = Object.keys(state.names).map(Number).sort((a, b) => a - b);
  const changes: string[] = [];
  for (const n of ns) {
    const lvl = got.get(n);
    if (lvl === undefined || lvl < 0) continue;
    const line = setLevel(state, n, lvl, "placement", "starting level from one placement question", now);
    if (line) changes.push(line);
  }
  const focus = [...ns].sort((a, b) => (state.levels[a] ?? 0) - (state.levels[b] ?? 0) || a - b)[0];
  state.focus = focus;
  await eng.store.saveState(dir, state);
  chat.fm.placement = "done";
  chat.fm.card = "";
  chat.fm.await_continue = "yes";
  const rows = ns.map((n) => `| ${state.names[n].replace(/\|/g, "/")} | ${state.levels[n] ?? "not placed"} |`).join("\n");
  const res = await say(`${verdict}\n\n**Placement done.** No tokens were used.\n\n| Subskill | Starting level |\n| --- | --- |\n${rows}\n\nThese are rough starting points from one question each, and they move as you answer more. Press **Continue** to begin with **${state.names[focus]}**.`, null);
  res.changes = [`starting levels set for ${changes.length} subskill${changes.length === 1 ? "" : "s"}`, `focus → ${state.names[focus]}`];
  res.attempt = attempt;
  return res;
}

/** The evidence record for a bank question marked by code or by the grading call. */
export function bankAttempt(eng: Engine, p: { id: string; chat: Chat; state: LearnerState; q: Question; answer: string; result: Outcome; activity: string; mode: Mode; grading: Grading; assumptions: string; note: string; now: string; errorType?: string; help?: string }): Attempt {
  const conf = p.chat.fm.pending_confidence;
  const asked = fmStr(p.chat.fm, "asked_at");
  const seconds = asked ? Math.round((Date.parse(p.now) - Date.parse(asked)) / 1000) : NaN;
  const assistance = [...(fmStr(p.chat.fm, "card_help") === "yes" ? ["the learner asked the tutor about this question before answering"] : []), ...(p.help ? [p.help] : [])];
  const helped = assistance.length > 0;
  return {
    id: p.id,
    v: 2,
    skill: p.q.subskill in p.state.names ? p.q.subskill : 0,
    concept: p.state.concepts[p.q.subskill] ?? "",
    questionId: p.q.id,
    question: p.q.question,
    answer: p.answer,
    activity: p.activity,
    mode: p.mode,
    difficulty: null,
    result: p.result,
    errorType: p.result === "skipped" ? "skipped" : p.errorType ?? "",
    note: p.note,
    confidence: typeof conf === "number" && conf >= 0 && conf <= 1 ? conf : null,
    assisted: helped,
    assistance,
    answerExposed: false,
    transfer: false,
    seconds: Number.isFinite(seconds) && seconds >= 0 && seconds <= MAX_ANSWER_SECONDS ? seconds : null,
    timestamp: p.now,
    grading: p.grading,
    verification: p.result === "ungraded" || p.grading === "model" ? "unverified" : "verified",
    assumptions: p.assumptions,
    taskType: (TASK_TYPES.includes(p.q.task as TaskType) ? p.q.task : p.activity === "retrieval" ? "recall" : "application") as TaskType,
    family: p.q.family ?? "",
    ...objectiveStamp(p.state, p.q.subskill),
  };
}

/** Keeps the session record in step on the paths that never call the model, so resuming works the same everywhere. */
export function bankSession(eng: Engine, chat: Chat, state: LearnerState, mode: Mode, open: Question | null, why: { action: string; reason: string }, now: string): void {
  const record = sessionFor(chat, state, mode);
  const skill = open && open.subskill in state.names ? open.subskill : state.focus;
  const changed = (open?.id ?? "") !== record.questionId;
  record.mode = mode;
  record.action = why.action;
  record.reason = why.reason;
  record.skill = skill;
  record.concept = skill !== null ? state.concepts[skill] ?? "" : "";
  record.conceptName = skill !== null ? state.names[skill] ?? "" : "";
  record.pendingQuestion = open ? formatQuizQuestion(open, state) : "";
  record.questionId = open?.id ?? "";
  if (changed) {
    record.askedAt = open ? now : "";
    record.attempt = "";
    record.helpGiven = [];
    record.answerExposed = false;
    chat.fm.asked_at = open ? now : "";
    chat.fm.card_help = "";
  }
  record.completedStep = !open;
  record.nextAction = open ? "Answer the open question." : "Continue to the next step.";
  record.unresolvedMisconceptions = [...state.misconceptions];
  record.exactExcerpts = chat.messages.slice(-2).map((m) => `${m.role}: ${m.text}`);
  chat.fm.session = JSON.stringify(record);
}

/**
 * Runs a code answer with the engine's runner. No runner, or a runner that throws despite its
 * contract, gives an "unavailable" report: no execution evidence, so the caller asks the grader.
 * Stopping the turn aborts the run.
 */
async function runCode(eng: Engine, task: CodeTask, source: string, opts: TurnOpts): Promise<CodeRunReport> {
  const runner = eng.codeRunner;
  if (!runner) return notRun(task.language, "no code runner is set up here");
  const ctl = new AbortController();
  opts.onSpawn?.(() => ctl.abort());
  try {
    return await runner.run(task, source, ctl.signal);
  } catch (e) {
    return notRun(task.language, `the code runner failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  }
}

/**
 * A turn that uses plain code wherever it can. Questions come from the question bank;
 * multiple-choice and exact short answers are marked without a model, and other forms of a
 * typed expression by SymPy. The model is called only when an answer needs judgement (a
 * cheap grading call), when the learner asks something, or when the bank has run out.
 *
 * In Quiz mode this runs question after question. In Adaptive mode (`adaptive`) it asks the
 * questions the policy calls for and hands back to the guide when the policy wants something
 * the bank cannot do.
 */
export async function quizTurn(eng: Engine, dir: string, chatPath: string, message: string, opts: TurnOpts & { adaptive?: boolean; decision?: Decision } = {}): Promise<TurnResult> {
  const s = eng.settings();
  const now = new Date().toISOString();
  const chat = await eng.store.loadChat(chatPath);
  const mode = (fmStr(chat.fm, "mode", "quiz") as Mode) || "quiz";
  const questions = await eng.store.loadQuestions(dir);
  const task = taskOf(questions, fmStr(chat.fm, "card"));
  const pending = task?.question;
  const text = message.trim();
  const last = chat.messages[chat.messages.length - 1];
  // A question, or a request for a diagram or simulation, goes to the tutor as help with the open
  // question. A block of code sent for a code question is an answer, whatever its last line says.
  const asksTutor = (t: string) => (looksLikeQuestion(t) || !!readPresentationRequest(t)) && !givesUp(t) && !(pending?.code && sentAsCode(t));
  const tools: ToolResult[] = [];
  // A bank quiz may need SymPy for the next typed answer; load it while the learner reads.
  if (questions.some((q) => q.type === "short")) eng.warmMaths();

  const toTutor = async () => {
    if (pending) {
      // Help asked for while a bank question is open is help with that question.
      chat.fm.card_help = "yes";
      await eng.store.saveChat(chatPath, chat);
    }
    return eng.turn(dir, chatPath, message, opts);
  };
  if (!pending && (text || last?.role === "you")) return eng.turn(dir, chatPath, message, opts);
  if (pending && text && asksTutor(text)) return toTutor();

  const state = await eng.store.loadState(dir, s.targetLevel);
  const today = eng.today();
  let usage = zeroUsage();
  let verdict = "";
  let attempt: Attempt | null = null;
  const changes: string[] = [];

  if (pending) {
    let answer = "";
    if (text) {
      chat.messages.push({ role: "you", text });
      chat.fm.pending_confidence = typeof opts.confidence === "number" ? opts.confidence : "";
      chat.fm.answered_at = now;
      chat.fm.await_continue = "";
      await eng.store.saveChat(chatPath, chat);
      answer = text;
    } else if (last?.role === "you") {
      if (asksTutor(last.text)) return toTutor();
      answer = last.text;
    }
    if (answer) {
      let grade: Grade;
      let note = "";
      let grading: Grading = "deterministic";
      let assumptions = "";
      let reasoning: ReasoningAssessment | null = null;
      let mistake = "";
      let rubric = pending.rubric;
      let codeRun: CodeRunRecord | null = null;
      const skipped = givesUp(answer);
      if (skipped) [grade, assumptions] = ["again", "the learner skipped the question"];
      else if (pending.type === "mcq") {
        const letter = parseMcqReply(answer, pending.options.length);
        if (!letter) {
          const reply = "Reply with one letter, for example **B**.";
          chat.messages.push({ role: "tutor", text: reply });
          await eng.store.saveChat(chatPath, chat);
          return { reply, changes: [], state, usage, local: true };
        }
        grade = letter === mcqLetter(pending.answer) ? "good" : "again";
        assumptions = "the chosen letter was compared with the answer key";
      } else if (pending.code) {
        if (!looksLikeCode(answer)) {
          const reply = "Reply with your code, in a fenced code block or as plain text, or say **skip**.";
          chat.messages.push({ role: "tutor", text: reply });
          await eng.store.saveChat(chatPath, chat);
          return { reply, changes: [], state, usage, local: true };
        }
        // A code question: the learner's source is run against the task's tests (codequestions.ts).
        // The run decides the result and nothing else. When nothing could run it, one grading call
        // judges the code instead, and the attempt says it was not run.
        const report = await runCode(eng, pending.code, codeSource(answer), opts);
        const run = markCodeRun(pending.code, report, pending.rubric);
        codeRun = run ? run.record : codeRunRecord(pending.code, report);
        if (run) {
          grade = run.proposed === "correct" ? "good" : run.proposed === "partial" ? "hard" : "again";
          note = run.feedback;
          grading = "executed";
          assumptions = run.assumptions;
          reasoning = run.reasoning;
          rubric = run.rubric;
          mistake = run.errorType;
        } else {
          const why = codeRun.message.replace(/\s+/g, " ").replace(/[.\s]+$/, "") || "no runner for this language here";
          const g = await eng.grade(codeGradingQuestion(pending), answer);
          grade = g.grade;
          note = [`Not run (${why}), so the model judged your code without running it.`, g.feedback].filter(Boolean).join(" ");
          usage = g.usage;
          grading = "model";
          assumptions = `the code was not run (${why}); one model judgement of it against the tests and the reference solution, not independently checked`;
          reasoning = g.reasoning;
        }
      } else if (task?.inst) {
        // New numbers or a repair task: code computed the answer, so code marks it.
        const m = markTask(task, answer);
        if (!m) {
          const reply = task.kind !== "fix" ? "Reply with your answer as a number, for example **12.5**." : 'Reply as "step N, answer X", for example **step 2, answer 12.5**.';
          chat.messages.push({ role: "tutor", text: reply });
          await eng.store.saveChat(chatPath, chat);
          return { reply, changes: [], state, usage, local: true };
        }
        [grade, note, assumptions, mistake] = [m.grade, m.note, m.assumptions, m.mistake];
      } else if (pending.type === "short" && sameShortAnswer(answer, pending.answer)) [grade, assumptions] = ["good", "matched the expected answer after ignoring case and spacing"];
      else if (pending.type === "short" && differentNumbers(answer, pending.answer)) [grade, assumptions] = ["again", "both answers are plain numbers, and they differ"];
      else {
        // An answer in another form (1/2 for 0.5, or an unsimplified expression): SymPy can say
        // whether it equals the expected one, with no model call. If SymPy fails or cannot
        // tell, that decides nothing and the answer goes to the grading call.
        const sym = pending.type === "short" ? await eng.checkEquivalent(pending.answer, answer) : null;
        if (sym?.tool) tools.push(sym.tool);
        if (sym && sym.equal !== null) {
          grade = sym.equal ? "good" : "again";
          note = sym.equal ? "SymPy confirms your answer equals the expected one." : "SymPy finds your answer is not equal to the expected one.";
          grading = sym.grading;
          assumptions = sym.assumptions;
        } else {
          // Not something code can mark: one small grading call. If it fails, the error is
          // shown with a retry and nothing is recorded: the answer stays ungraded.
          const g = await eng.grade(pending, answer);
          grade = g.grade;
          note = g.feedback;
          usage = g.usage;
          grading = "model";
          assumptions = "one model judgement against the model answer, not independently checked";
          reasoning = g.reasoning;
          // Where both answers end in an expression, SymPy compares the final results. That settles
          // the result and nothing else: the method and the assumptions stay the grader's judgement.
          if (reasoning && pending.type === "open") {
            const given = finalExpression(answer);
            const expected = finalExpression(pending.answer);
            const sym = given && expected ? await eng.checkEquivalent(expected, given) : null;
            if (sym?.tool) tools.push(sym.tool);
            if (sym && sym.equal !== null) {
              reasoning = withCheck(reasoning, { evaluated: `the final result ${given} against the expected ${expected}`, kind: sym.grading === "numeric" ? "numeric" : "symbolic", outcome: sym.equal, assumptions: sym.assumptions || "compared as expressions" });
              assumptions += "; SymPy checked the final result only, not the method";
            }
          }
        }
      }
      // The proposed mark is held to its breakdown (grading.ts). An uncheckable answer, SymPy
      // disagreeing with the grader, or a mark its own breakdown contradicts is left ungraded,
      // never guessed; a right result whose required method could not be judged is partly right
      // and counts neither way.
      const mark = normaliseMark({ proposed: skipped ? "skipped" : outcomeOfGrade(grade), reasoning, rubric });
      const result: Outcome = mark.result;
      const conflict = result === "ungraded";
      note = withNote(note, mark);
      const scheduled = gradeOfOutcome(result, grade);
      const id = `${chatPath}:${chat.messages.length}:${pending.id}`;
      // If the state was saved and the chat was not (an interrupted turn), this is the same
      // attempt arriving again: the record is replaced, and the counters are left alone.
      const repeat = state.attempts.some((a) => a.id === id);
      attempt = eng.bankAttempt({ id, chat, state, q: pending, answer, result, activity: opts.adaptive ? (sessionFor(chat, state, mode).action === "retrieval" ? "retrieval" : "independent-practice") : "quiz", mode, grading, assumptions, note: result === "correct" ? "" : note, now, errorType: result === "correct" ? "" : mistake, help: taskHelp(task) });
      if (reasoning) {
        // A run's breakdown is its result alone, and reasoning.ts has no way to say a run decided
        // it, so it is not kept as a grader's judgement: the run record says what ran instead.
        if (grading !== "executed") attempt.reasoning = reasoning;
        attempt.mark = mark.basis;
      }
      if (codeRun) attempt.code = codeRun;
      state.attempts = recordAttempt(state.attempts, attempt);
      if (!repeat && scheduled) {
        // New numbers for a question are the same card: its schedule is the question's. Helped work
        // (a repair, a faded example, a pair) does not move it: the solution was in view, so only an
        // unaided answer on new numbers can push the card out. Known mistakes have cards of their own.
        const card = baseQuestionId(pending.id);
        if (tutorSchedules(s)) {
          if (!taskHelp(task)) state.cards[card] = schedule(state.cards[card], scheduled, today, state.scheduler);
          for (const u of mistakeUpdates(task, attempt, state)) state.cards[u.id] = schedule(state.cards[u.id], u.grade, today, state.scheduler);
        }
        if (pending.subskill in state.names) {
          const b = state.bank[pending.subskill] ?? (state.bank[pending.subskill] = { right: 0, total: 0 });
          b.total += 1;
          if (result === "correct") b.right += 1;
        }
        for (const line of applyAttempt(state, attempt)) changes.push(line);
      }
      // The chat's own score is saved with the verdict message, so it moves with that write.
      if (result !== "ungraded") {
        chat.fm.right = fmNum(chat.fm, "right", 0) + (result === "correct" ? 1 : 0);
        chat.fm.total = fmNum(chat.fm, "total", 0) + 1;
      }
      await eng.store.saveState(dir, state);
      chat.fm.card = "";
      chat.fm.pending_confidence = "";
      const head = skipped ? "**Skipped.**" : conflict ? "**Left ungraded.**" : result === "incorrect" ? "**Incorrect.**" : result === "partial" ? "**Partly right.**" : "**Correct.**";
      const parts = [note ? `${head} ${note}` : head];
      // Each test's result, hidden ones included now that the answer is marked.
      if (codeRun && grading === "executed") parts.push(codeRunMarkdown(codeRun));
      // The solution is shown only now, after an attempt or an explicit skip.
      if (result !== "correct") parts.push(`${pending.code ? solutionMarkdown(pending) : `Answer: ${answerText(pending)}`}${pending.explanation ? `\n\n${pending.explanation}` : ""}`);
      if (!opts.adaptive && fmNum(chat.fm, "total", 0) % 5 === 0) parts.push(`*Score so far: ${fmNum(chat.fm, "right", 0)}/${fmNum(chat.fm, "total", 0)}.*`);
      verdict = parts.join("\n\n");
    }
  }

  // What to ask next. In Adaptive mode the policy decides whether the bank still has the right question.
  const asked = fmList(chat.fm, "asked");
  let decision = opts.decision;
  let next: Question | null = null;
  // After a known mistake comes a repair task, and after a repair a fresh check (bankvariants.ts).
  // A mistake whose check is due comes next when there is no repair to set (bankvariants.ts).
  const follow = (task && attempt && verdict ? followUp(task, attempt, state, asked) : null) ?? (tutorSchedules(s) ? dueMistake(questions, state, today, asked) : null);
  // Which idea of the subskill the last answer was on, and whether the next question builds on it
  // (the same idea from another angle) or moves to an idea not yet asked (coverage.ts).
  const topic = await eng.store.loadTopic(dir);
  const cover = new Map<number, IdeaStatus[]>();
  const coverage = (n: number): IdeaStatus[] => cover.get(n) ?? cover.set(n, coverageOf(topic, questions, state, n)).get(n)!;
  const ideaOfBank = (q: Question | undefined): IdeaStatus | null => (q ? coverage(q.subskill).find((i) => i.id === ideaOfQuestion(coverage(q.subskill), q)) ?? null : null);
  const lastIdea = !follow && task && attempt && verdict ? ideaOfBank(task.base) : null;
  const typical = secondsPerItem(state.attempts);
  const [builtIdea, builtCount] = fmStr(chat.fm, "built").split(":");
  const builds = lastIdea && builtIdea === lastIdea.id ? Number(builtCount) || 0 : 0;
  const move = lastIdea && attempt ? nextMove({ attempt, idea: lastIdea, typicalSeconds: typical.fallback ? null : typical.seconds, buildsInARow: builds }) : null;
  const rank = (q: Question): number => {
    const i = ideaOfBank(q);
    return !i ? 1 : i.asked === 0 ? 0 : i.secured ? 2 : 1;
  };
  const pick = (purpose: BankPurpose | undefined, only?: (q: Question) => boolean): Question | null => {
    if (move?.kind === "build-on" && lastIdea && attempt) {
      const same = pickQuizQuestion(questions, state, asked, today, { purpose, only: (q) => q.subskill === attempt.skill && ideaOfBank(q)?.id === lastIdea.id && (!only || only(q)), rank });
      if (same) return same;
    }
    return pickQuizQuestion(questions, state, asked, today, { purpose, only, rank });
  };
  if (follow) next = follow.question;
  else if (opts.adaptive) {
    if (!decision || verdict) decision = await eng.planFrom(dir, chat, state, mode, attempt && attempt.result === "correct" && attempt.skill ? attempt.skill : null);
    // Families kept for assessment stay fresh: practice does not use them up.
    const purpose = decision.action === "transfer" || decision.action === "retrieval" ? decision.action : "practice";
    const focus = decision.focus;
    // Supported practice from the bank is a faded worked example on new numbers.
    if (decision.local === "bank" && focus !== null && (decision.action === "worked-example" || decision.action === "guided-practice")) {
      // Faded examples first; once they run out, a contrasting pair; then plain practice.
      for (const make of [fadedFor, pairedFor]) {
        for (const q of questions.filter((x) => x.subskill === focus)) {
          next = make(q, state, asked);
          if (next) break;
        }
        if (next) break;
      }
    } else if (decision.local === "bank" && focus !== null) next = pick(purpose, (q) => q.subskill === focus && q.type !== "open");
  } else next = pick(undefined);
  // A question met before comes back with new numbers when code can make them.
  if (next && !follow && next.generator && metBefore(next, state, asked)) next = freshVariant(next, state, asked) ?? (asked.includes(next.id) ? null : next);
  if (!next && !verdict) return eng.turn(dir, chatPath, message, opts);

  // One line in the learner's view saying how this question follows the last: code-written, no model call.
  let bridge = "";
  chat.fm.built = "";
  if (next && move && lastIdea && !follow) {
    const nextIdea = ideaOfBank(questions.find((q) => q.id === baseQuestionId(next!.id)));
    if (move.kind === "build-on" && nextIdea?.id === lastIdea.id) {
      bridge = `*Builds on the last question (${ideaLabel(lastIdea)}). ${move.reason}*`;
      chat.fm.built = `${lastIdea.id}:${builds + 1}`;
    } else if (move.kind === "build-on") bridge = nextIdea ? "*No other question on that idea is left, so on to a new one.*" : "";
    else if (nextIdea && nextIdea.id !== lastIdea.id && nextIdea.asked === 0) bridge = `*A new idea: ${ideaLabel(nextIdea)}.*${move.reason ? ` ${move.reason}` : ""}`;
    else if (move.reason) bridge = `*${move.reason}*`;
  }
  let reply: string;
  if (next) reply = [verdict, bridge ? `${bridge}\n\n${formatQuizQuestion(next, state)}` : formatQuizQuestion(next, state)].filter(Boolean).join("\n\n---\n\n");
  else if (opts.adaptive) reply = `${verdict}\n\n---\n\n*Next: ${decision ? decision.reason : "the guide chooses the next step."}* Press **Continue** when you are ready.`;
  else reply = `${verdict}\n\n---\n\nThat was the last question in the bank (${fmNum(chat.fm, "right", 0)}/${fmNum(chat.fm, "total", 0)}). Send any message and the quizzer will write fresh questions with the model.`;
  if (next) {
    chat.fm.card = next.id;
    chat.fm.asked = [...asked, next.id];
    if (opts.adaptive && next.subskill in state.names && state.focus !== next.subskill) {
      state.focus = next.subskill;
      await eng.store.saveState(dir, state);
    }
  }
  chat.fm.await_continue = !next && opts.adaptive ? "yes" : "";
  chat.messages.push({ role: "tutor", text: reply });
  const why = follow
    ? { action: follow.action, reason: follow.reason }
    : opts.adaptive && decision
      ? { action: decision.action, reason: decision.reason }
      : { action: "quiz", reason: "Practise mode: questions from the bank, marked by the plugin where it can." };
  eng.bankSession(chat, state, mode, next, why, now);
  await eng.store.saveChat(chatPath, chat);

  const out: TurnResult = { reply, changes, state, usage, local: usage.calls === 0, tools };
  if (attempt) out.attempt = attempt;
  if (decision) out.decision = decision;
  if (!opts.adaptive && chatWords(chat) > s.maxChatWords && chat.messages.length > 4) {
    // The quiz score is the whole story so far, so the handover needs no model. The open
    // question travels with the new part.
    const summary = [chat.summary, `Question-bank quiz: ${fmNum(chat.fm, "total", 0)} asked, ${fmNum(chat.fm, "right", 0)} right so far.`].filter(Boolean).join(" ");
    out.rotatedTo = await eng.store.rotateChat(chatPath, chat, summary);
  }
  return out;
}
