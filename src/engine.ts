// Orchestrates the three things that cost tokens: a chat turn, compiling a topic, and grading
// one flashcard answer. No Obsidian imports, so it can be exercised from Node.

import { CallResult, ClaudeError, Usage, addUsage, callClaude, findClaude, zeroUsage } from "./claude";
import { Frontmatter, Grade, LearnerState, Mode, Question, SourceMode, applyStateUpdate, chatWords, extractStateTrailer, fmStr, parseCompileOutput, parseQuestions, parseTopic, words, ymd } from "./formats";
import { GRADE_SCHEMA, buildCompileInput, buildSystem, buildTurnInput, modeFile, topicForPrompt, utilityPrompt } from "./prompts";
import { Store } from "./store";

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
}

export interface TurnResult {
  reply: string;
  changes: string[];
  state: LearnerState;
  usage: Usage;
  /** Set when the chat grew past the limit and a new part was started. */
  rotatedTo?: string;
  rotationUsage?: Usage;
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

  private call(o: { model: string; system: string; input: string; effort?: string; jsonSchema?: object; timeoutMs?: number; onSpawn?: (kill: () => void) => void }): Promise<CallResult> {
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
    const res = await this.call({ model: s.chatModel, effort: s.effort || undefined, system, input, onSpawn: opts.onSpawn });

    const { text, update } = extractStateTrailer(res.text);
    const changes = update ? applyStateUpdate(state, update, mode !== "expert") : [];
    if (changes.length) await this.store.saveState(dir, state);
    const reply = text || "(empty reply)";
    chat.messages.push({ role: "tutor", text: reply });
    await this.store.saveChat(chatPath, chat);

    const out: TurnResult = { reply, changes, state, usage: res.usage };
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
      input: buildCompileInput({ title: req.title, mode: req.mode, goal: req.goal, subjects, material: req.mode === "subject" ? "" : material }),
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
      fm: { source: req.mode, subject, goal: req.goal.trim(), ...req.fm },
      topicBody: parsed.topicBody,
      questionsBody: parsed.questionsBody,
      target: s.targetLevel,
      existingDir: req.existingDir,
    });
    return { dir, subskills: topic.subskills.length, questions: questions.length, usage, agents: agents + 1 };
  }

  /** Grades one free-text flashcard answer on the cheap model. Only runs when the learner asks for it. */
  async grade(q: Question, answer: string): Promise<{ grade: Grade; feedback: string; usage: Usage }> {
    const s = this.settings();
    const res = await this.call({
      model: s.utilityModel,
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
