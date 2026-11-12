// Orchestrates the three things that cost tokens: a chat turn, compiling a topic, and grading
// one flashcard answer. No Obsidian imports, so it can be exercised from Node.

import { CallResult, ClaudeError, Usage, addUsage, callClaude, findClaude, zeroUsage } from "./claude";
import { answerText, fmList, fmNum, formatQuizQuestion, givesUp, looksLikeQuestion, mcqLetter, parseMcqReply, pickQuizQuestion, sameShortAnswer, schedule, stateForPrompt } from "./formats";
import { Frontmatter, Grade, LearnerState, Mode, Question, SourceMode, applyStateUpdate, chatWords, extractStateTrailer, fmStr, parseCompileOutput, parseQuestions, parseTopic, words, ymd } from "./formats";
import { GRADE_SCHEMA, buildCompileInput, buildSystem, buildTurnInput, modeFile, topicForPrompt, utilityPrompt } from "./prompts";
import { Route, routeTurn } from "./router";
import { Store } from "./store";
import { codeMark, placementQuestions } from "./formats";

export interface EngineSettings {
  claudePath: string;
  chatModel: string;
  compileModel: string;
  utilityModel: string;
  effort: string;
  targetLevel: number;
  maxChatWords: number;
  maxTopicWords: number;
  singlePassWords: number;
  /** Pick the model and thinking effort per turn from the message (see router.ts). */
  smartRouting: boolean;
  /** Thinking effort for turns the router calls complex. */
  hardEffort: string;
}

export interface TurnResult {
  reply: string;
  changes: string[];
  state: LearnerState;
  usage: Usage;
  /** Set when the chat grew past the limit and a new part was started. */
  rotatedTo?: string;
  rotationUsage?: Usage;
  /** True when plain code produced the reply and no model was called. */
  local?: boolean;
  /** Which model answered and why, when routing is on. */
  route?: { route: Route; reason: string; model: string };
}

export interface Material {
  name: string;
  text: string;
}

export interface CompileRequest {
  title: string;
  mode: SourceMode;
  goal: string;
  material: Material[];
  /** Extra frontmatter to store on the topic card (sources, folder, goal). */
  fm: Frontmatter;
  existingDir?: string;
  /** Let the compile call search the web. Costs more; off unless asked for. */
  research?: boolean;
}

export interface CompileResult {
  dir: string;
  subskills: number;
  questions: number;
  usage: Usage;
  agents: number;
}

const BATCH_WORDS = 3000;
const PARALLEL = 3;

export class Engine {
  constructor(
    public store: Store,
    private settings: () => EngineSettings,
    private today: () => string = () => ymd(),
  ) {}

  private claudePath(): string {
    const p = findClaude(this.settings().claudePath);
    if (!p) throw new ClaudeError("Claude CLI not found. Install Claude Code, or set its path in Study Tutor settings.");
    return p;
  }

  private call(o: { model: string; system: string; input: string; effort?: string; jsonSchema?: object; tools?: string[]; timeoutMs?: number; onSpawn?: (kill: () => void) => void }): Promise<CallResult> {
    return callClaude({ claudePath: this.claudePath(), ...o });
  }

  /**
   * One chat turn. `message` may be empty to start a chat or to retry after a failure.
   * The user's message is saved before the call, so nothing is lost if the call fails.
   */
  async turn(dir: string, chatPath: string, message: string, opts: { attached?: Material; onSpawn?: (kill: () => void) => void } = {}): Promise<TurnResult> {
    const s = this.settings();
    const topic = await this.store.loadTopic(dir);
    const state = await this.store.loadState(dir, s.targetLevel);
    const chat = await this.store.loadChat(chatPath);
    if (message.trim()) {
      chat.messages.push({ role: "you", text: message.trim() });
      await this.store.saveChat(chatPath, chat);
    }
    const mode = (fmStr(chat.fm, "mode", "tutor") as Mode) || "tutor";
    const subjectName = fmStr(topic.fm, "subject", "none");
    const system = buildSystem({
      core: await this.store.skill("core.md"),
      subject: subjectName && subjectName !== "none" ? await this.store.skill(`subjects/${subjectName}.md`) : "",
      topicText: topicForPrompt(topic, state.focus, s.maxTopicWords),
      mode: await this.store.skill(modeFile(mode)),
    });
    const input = buildTurnInput({ state, today: this.today(), chat, attached: opts.attached });
    // Route on the learner's latest message (also on a retry, when `message` itself is empty).
    const lastMsg = chat.messages[chat.messages.length - 1];
    const decision = s.smartRouting ? routeTurn({ mode, message: lastMsg?.role === "you" ? lastMsg.text : "", attached: !!opts.attached }) : { route: "standard" as Route, reason: "routing off" };
    const model = decision.route === "simple" ? s.utilityModel : s.chatModel;
    const effort = decision.route === "simple" ? undefined : decision.route === "complex" ? s.hardEffort || s.effort || undefined : s.effort || undefined;
    const res = await this.call({ model, effort, system, input, onSpawn: opts.onSpawn });

    const { text, update } = extractStateTrailer(res.text);
    // Levels are never changed on the word of the cheap model.
    const changes = update ? applyStateUpdate(state, update, mode !== "expert" && decision.route !== "simple") : [];
    if (changes.length) await this.store.saveState(dir, state);
    const reply = text || "(empty reply)";
    chat.messages.push({ role: "tutor", text: reply });
    await this.store.saveChat(chatPath, chat);

    const out: TurnResult = { reply, changes, state, usage: res.usage, route: { ...decision, model } };
    if (chatWords(chat) > s.maxChatWords && chat.messages.length > 4) {
      try {
        const sum = await this.call({
          model: s.utilityModel,
          system: utilityPrompt(await this.store.skill("utility.md"), "summarise"),
          input: [chat.summary ? `Summary of earlier parts:\n${chat.summary}\n` : "", "Chat:", ...chat.messages.map((m) => `${m.role === "you" ? "LEARNER" : "TUTOR"}: ${m.text}`)].join("\n"),
        });
        if (sum.text.trim()) {
          out.rotatedTo = await this.store.rotateChat(chatPath, chat, sum.text.trim());
          out.rotationUsage = sum.usage;
        }
      } catch {
        /* Rotation is an optimisation. If it fails the chat simply stays in this file. */
      }
    }
    return out;
  }

  /**
   * Places a new learner with plain code: one multiple-choice or short question per subskill
   * from the bank, marked without a model, then starting levels are set from the results.
   * Returns null when placement does not apply, and the caller then runs a normal turn.
   */
  async placementTurn(dir: string, chatPath: string, message: string): Promise<TurnResult | null> {
    const s = this.settings();
    const chat = await this.store.loadChat(chatPath);
    const phase = fmStr(chat.fm, "placement");
    const text = message.trim();
    const state = await this.store.loadState(dir, s.targetLevel);
    const questions = await this.store.loadQuestions(dir);
    const usage = zeroUsage();
    const say = async (reply: string): Promise<TurnResult> => {
      chat.messages.push({ role: "tutor", text: reply });
      await this.store.saveChat(chatPath, chat);
      return { reply, changes: [], state, usage, local: true };
    };

    if (phase !== "on") {
      const fresh = !chat.messages.length && !text && Object.values(state.levels).every((l) => l === null);
      const queue = fresh ? placementQuestions(questions, state) : [];
      if (!queue.length) return null;
      chat.fm.placement = "on";
      chat.fm.queue = queue.map((q) => q.id);
      chat.fm.placed = [];
      chat.fm.card = queue[0].id;
      return say(`**Placement** · ${queue.length} quick question${queue.length === 1 ? "" : "s"} to find your starting level, one per subskill. They are marked by the plugin, so this uses no tokens. Say **skip** for anything you have not met.\n\n---\n\n${formatQuizQuestion(queue[0], state)}`);
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
      await this.store.saveChat(chatPath, chat);
      return null;
    }
    if (!answer) return say(formatQuizQuestion(pending, state));
    if (text) chat.messages.push({ role: "you", text });

    const mark = codeMark(pending, answer);
    if (mark === "letter") return say("Reply with one letter, for example **B**, or say **skip**.");
    // Placement never calls a model: anything code cannot confirm counts as not yet known.
    const level = givesUp(answer) ? 0 : mark === "good" ? 2 : 1;
    const placed = [...fmList(chat.fm, "placed"), `${pending.subskill}:${level}`];
    chat.fm.placed = placed;
    if (pending.subskill in state.names) {
      const b = state.bank[pending.subskill] ?? (state.bank[pending.subskill] = { right: 0, total: 0 });
      b.total += 1;
      if (level === 2) b.right += 1;
    }
    state.cards[pending.id] = schedule(state.cards[pending.id], level === 2 ? "good" : "again", this.today());

    const next = questions.find((q) => q.id === queue[queue.indexOf(pending.id) + 1]);
    if (next) {
      chat.fm.card = next.id;
      await this.store.saveState(dir, state);
      return say(`${level === 2 ? "**Correct.**" : level === 1 ? "**Not quite.**" : "**Skipped.**"}\n\n---\n\n${formatQuizQuestion(next, state)}`);
    }

    // Finished: set every starting level and choose where to begin.
    const got = new Map(placed.map((p) => p.split(":").map(Number) as [number, number]));
    const ns = Object.keys(state.names).map(Number).sort((a, b) => a - b);
    for (const n of ns) state.levels[n] = got.get(n) ?? 1;
    const focus = [...ns].sort((a, b) => (state.levels[a] ?? 0) - (state.levels[b] ?? 0) || a - b)[0];
    state.focus = focus;
    await this.store.saveState(dir, state);
    chat.fm.placement = "done";
    chat.fm.card = "";
    const rows = ns.map((n) => `| ${state.names[n].replace(/\|/g, "/")} | ${state.levels[n]} |`).join("\n");
    const res = await say(`**Placement done.** No tokens were used.\n\n| Subskill | Starting level |\n| --- | --- |\n${rows}\n\nThese are rough starting points, and the tutor will adjust them. Press **Continue** to begin with **${state.names[focus]}**.`);
    res.changes = [`starting levels set for ${ns.length} subskills`, `focus → ${state.names[focus]}`];
    return res;
  }

  /**
   * Turns notes, a spec or a bare subject into a topic card and question bank.
   * Small inputs take one call. Large inputs fan out to parallel extraction calls on the
   * cheap model, and one synthesis call then works from the extracts.
   */
  async compile(req: CompileRequest, onProgress: (msg: string) => void = () => {}): Promise<CompileResult> {
    const s = this.settings();
    let usage = zeroUsage();
    let agents = 0;
    let material = req.material.map((m) => `## [[${m.name}]]\n${m.text.trim()}`).join("\n\n");

    if (req.mode !== "subject" && words(material) > s.singlePassWords) {
      const batches = batchMaterial(req.material, BATCH_WORDS);
      const extractPrompt = utilityPrompt(await this.store.skill("utility.md"), "extract");
      const results: string[] = new Array(batches.length).fill("");
      let next = 0;
      let done = 0;
      onProgress(`Reading ${req.material.length} notes in ${batches.length} ${batches.length === 1 ? "batch" : "parallel batches"}…`);
      const worker = async () => {
        while (next < batches.length) {
          const i = next++;
          const r = await this.call({ model: s.utilityModel, system: extractPrompt, input: batches[i], timeoutMs: 300000 });
          results[i] = r.text.trim();
          usage = addUsage(usage, r.usage);
          onProgress(`Read ${++done} of ${batches.length} batches…`);
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL, batches.length) }, worker));
      agents = batches.length;
      material = results.join("\n\n");
    }

    onProgress("Building the topic card and question bank…");
    const subjects = await this.store.subjectNames();
    const res = await this.call({
      model: s.compileModel,
      system: await this.store.skill("compile.md"),
      input: buildCompileInput({ title: req.title, mode: req.mode, goal: req.goal, subjects, material: req.mode === "subject" ? "" : material, research: req.research }),
      // The web tools are the only tools ever enabled, and only for this one call.
      tools: req.research ? ["WebSearch", "WebFetch"] : undefined,
      timeoutMs: 900000,
    });
    usage = addUsage(usage, res.usage);

    const parsed = parseCompileOutput(res.text);
    const topic = parseTopic(parsed.topicBody);
    const questions = parseQuestions(parsed.questionsBody);
    if (topic.subskills.length < 2 || !questions.length) {
      throw new ClaudeError(`The compiled output was not in the expected format (${topic.subskills.length} subskills, ${questions.length} questions). It began: ${res.text.slice(0, 200)}`);
    }
    const subject = subjects.includes(parsed.subject) ? parsed.subject : "none";
    const dir = await this.store.saveCompiled({
      title: req.title,
      fm: { source: req.mode, subject, goal: req.goal.trim(), research: req.research ? "yes" : "no", ...req.fm },
      topicBody: parsed.topicBody,
      questionsBody: parsed.questionsBody,
      target: s.targetLevel,
      existingDir: req.existingDir,
    });
    return { dir, subskills: topic.subskills.length, questions: questions.length, usage, agents: agents + 1 };
  }

  /**
   * A quiz turn that uses plain code wherever it can. Questions come from the question bank;
   * multiple-choice and exact short answers are marked without a model. The model is called only
   * when an answer needs judgement (a cheap grading call), when the learner asks something, or
   * when the bank has run out (the model-run quizzer then takes over).
   */
  async quizTurn(dir: string, chatPath: string, message: string, opts: { attached?: Material; onSpawn?: (kill: () => void) => void } = {}): Promise<TurnResult> {
    const s = this.settings();
    const chat = await this.store.loadChat(chatPath);
    const questions = await this.store.loadQuestions(dir);
    const pending = questions.find((q) => q.id === fmStr(chat.fm, "card"));
    const text = message.trim();
    const last = chat.messages[chat.messages.length - 1];
    const asksTutor = (t: string) => looksLikeQuestion(t) && !givesUp(t);

    if (!pending && (text || last?.role === "you")) return this.turn(dir, chatPath, message, opts);
    if (pending && text && asksTutor(text)) return this.turn(dir, chatPath, message, opts);

    const state = await this.store.loadState(dir, s.targetLevel);
    const today = this.today();
    let usage = zeroUsage();
    let verdict = "";

    if (pending) {
      let answer = "";
      if (text) {
        chat.messages.push({ role: "you", text });
        await this.store.saveChat(chatPath, chat);
        answer = text;
      } else if (last?.role === "you") {
        if (asksTutor(last.text)) return this.turn(dir, chatPath, "", opts);
        answer = last.text;
      }
      if (answer) {
        let grade: Grade;
        let note = "";
        if (givesUp(answer)) grade = "again";
        else if (pending.type === "mcq") {
          const letter = parseMcqReply(answer, pending.options.length);
          if (!letter) {
            const reply = "Reply with one letter, for example **B**.";
            chat.messages.push({ role: "tutor", text: reply });
            await this.store.saveChat(chatPath, chat);
            return { reply, changes: [], state, usage, local: true };
          }
          grade = letter === mcqLetter(pending.answer) ? "good" : "again";
        } else if (pending.type === "short" && sameShortAnswer(answer, pending.answer)) grade = "good";
        else {
          // Not something code can mark: one small grading call on the cheap model.
          const g = await this.grade(pending, answer);
          grade = g.grade;
          note = g.feedback;
          usage = g.usage;
        }
        state.cards[pending.id] = schedule(state.cards[pending.id], grade, today);
        if (pending.subskill in state.names) {
          const b = state.bank[pending.subskill] ?? (state.bank[pending.subskill] = { right: 0, total: 0 });
          b.total += 1;
          if (grade !== "again") b.right += 1;
        }
        await this.store.saveState(dir, state);
        const right = fmNum(chat.fm, "right", 0) + (grade === "again" ? 0 : 1);
        const total = fmNum(chat.fm, "total", 0) + 1;
        chat.fm.right = right;
        chat.fm.total = total;
        chat.fm.card = "";
        const head = grade === "again" ? "**Incorrect.**" : grade === "hard" ? "**Partly right.**" : "**Correct.**";
        const parts = [note ? `${head} ${note}` : head];
        if (grade === "again" || grade === "hard") parts.push(`Answer: ${answerText(pending)}${pending.explanation ? `\n\n${pending.explanation}` : ""}`);
        if (total % 5 === 0) parts.push(`*Score so far: ${right}/${total}.*`);
        verdict = parts.join("\n\n");
      }
    }

    const asked = fmList(chat.fm, "asked");
    const next = pickQuizQuestion(questions, state, asked);
    if (!next && !verdict) return this.turn(dir, chatPath, message, opts);
    const reply = next
      ? [verdict, formatQuizQuestion(next, state)].filter(Boolean).join("\n\n---\n\n")
      : `${verdict}\n\n---\n\nThat was the last question in the bank (${fmNum(chat.fm, "right", 0)}/${fmNum(chat.fm, "total", 0)}). Send any message and the quizzer will write fresh questions with the model.`;
    if (next) {
      chat.fm.card = next.id;
      chat.fm.asked = [...asked, next.id];
    }
    chat.messages.push({ role: "tutor", text: reply });
    await this.store.saveChat(chatPath, chat);

    const out: TurnResult = { reply, changes: [], state, usage, local: usage.calls === 0 };
    if (chatWords(chat) > s.maxChatWords && chat.messages.length > 4) {
      // The quiz score is the whole story so far, so the handover needs no model.
      const summary = [chat.summary, `Question-bank quiz: ${fmNum(chat.fm, "total", 0)} asked, ${fmNum(chat.fm, "right", 0)} right so far.`].filter(Boolean).join(" ");
      out.rotatedTo = await this.store.rotateChat(chatPath, chat, summary);
    }
    return out;
  }

  /** Writes a revision summary note for the topic, with a concept map, into the topic folder. */
  async summarySheet(dir: string): Promise<{ path: string; usage: Usage }> {
    const s = this.settings();
    const topic = await this.store.loadTopic(dir);
    const state = await this.store.loadState(dir, s.targetLevel);
    const res = await this.call({
      model: s.chatModel,
      effort: s.effort || undefined,
      system: await this.store.skill("summary.md"),
      input: `# Topic card\n\n${topic.body}\n\n# Learner state\n\n${stateForPrompt(state, this.today())}`,
      timeoutMs: 300000,
    });
    const body = res.text.trim().replace(/^```(?:markdown|md)?\r?\n([\s\S]*?)\r?\n```$/, "$1");
    if (!body) throw new ClaudeError("The summary came back empty.");
    return { path: await this.store.saveSummary(dir, topic.title, body), usage: res.usage };
  }

  /** Grades one free-text flashcard answer on the cheap model. Only runs when the learner asks for it. */
  async grade(q: Question, answer: string): Promise<{ grade: Grade; feedback: string; usage: Usage }> {
    const s = this.settings();
    // Marking maths wrongly is worse than spending a little more, so answers with symbols or
    // numbers in them go to the chat model. Plain-prose answers stay on the cheap one.
    const mathsy = /\$|\\[a-zA-Z]+|[=<>^]|\d/.test(`${q.answer} ${answer}`);
    const res = await this.call({
      model: s.smartRouting && mathsy ? s.chatModel : s.utilityModel,
      effort: s.smartRouting && mathsy ? s.effort || undefined : undefined,
      system: utilityPrompt(await this.store.skill("utility.md"), "grade"),
      input: `Question: ${q.question}\n\nModel answer: ${q.answer}\n${q.explanation ? `Explanation: ${q.explanation}\n` : ""}\nLearner's answer: ${answer.trim() || "(blank)"}`,
      jsonSchema: GRADE_SCHEMA,
    });
    let o = res.structured as { grade?: string; feedback?: string } | undefined;
    if (!o) {
      try {
        o = JSON.parse(res.text);
      } catch {
        o = {};
      }
    }
    const grade = (["again", "hard", "good", "easy"].includes(String(o?.grade)) ? o!.grade : "again") as Grade;
    return { grade, feedback: String(o?.feedback ?? ""), usage: res.usage };
  }
}

/** Packs notes into batches of roughly `size` words; a note longer than one batch is split across several. */
export function batchMaterial(material: Material[], size: number): string[] {
  const pieces: Material[] = [];
  for (const m of material) {
    const w = m.text.trim().split(/\s+/);
    if (w.length <= size) pieces.push(m);
    else for (let i = 0, part = 1; i < w.length; i += size, part++) pieces.push({ name: m.name, text: `(part ${part})\n` + w.slice(i, i + size).join(" ") });
  }
  const batches: string[] = [];
  let cur: string[] = [];
  let count = 0;
  for (const p of pieces) {
    const w = words(p.text);
    if (cur.length && count + w > size) {
      batches.push(cur.join("\n\n"));
      cur = [];
      count = 0;
    }
    cur.push(`## [[${p.name}]]\n${p.text.trim()}`);
    count += w;
  }
  if (cur.length) batches.push(cur.join("\n\n"));
  return batches;
}
