// Orchestrates everything that happens in a study turn: choosing what to do, marking what code
// can mark, calling the model for the rest, recording the evidence, and keeping the session
// record. No Obsidian imports, so it can be exercised from Node.

import { CallResult, ClaudeError, Usage, addUsage, callClaude, findClaude, zeroUsage } from "./claude";
import { dependentCounts } from "./course";
import { Attempt, EVIDENCE_RULES, Grading, Outcome, TASK_TYPES, TaskType, checkDue, recordAttempt, skillEvidence } from "./evidence";
import { Chat, Frontmatter, Grade, LearnerState, Mode, NextStep, Prereqs, Question, SourceMode, Topic, addDays, answerText, applyStateUpdate, chatWords, codeMark, contentHash, differentNumbers, extractStateTrailer, fmList, fmNum, fmStr, formatQuizQuestion, givesUp, looksLikeQuestion, mastery, mcqLetter, parseCompileOutput, parseMcqReply, parseQuestions, parseTopic, placementQuestions, prereqGaps, sameShortAnswer, schedule, setLevel, splitFrontmatter, stateForPrompt, words, ymd } from "./formats";
import { ACTION_GUIDE, ACTION_LABEL, Action, DEFAULT_WEIGHTS, Decision, POLICY_VERSION, PolicyInput, PolicyWeights, PrereqCheck, decide, homeStep } from "./policy";
import { ActivityRecord, CONFIG_PROMPT_VERSION, LESSON_SCHEMA_VERSION, configureActivity, toResult } from "./configure";
import { CoursePackage, buildPackage, coverageLine, mergeRefresh, sourceChanges, subskillSections } from "./coursepkg";
import { DEFAULT_LOCAL_MODEL, LocalModel } from "./ollama";
import { ExplicitRequest, PRESENT_RULE, PresentationDecision, choosePresentation, extractPresent, matchModules, presentationNote, readPresentationRequest } from "./presentation";
import { AssessmentResult, GenerationResult, ModuleDescriptor, ModuleRegistry, PresentationKind, PresentationRequest, SourceRef, VisualLesson } from "./visualcontract";

/** A registry with no modules, for code decisions when the host has none. */
const NO_MODULES: ModuleRegistry = { listModuleDescriptors: () => [], validateLesson: () => ({ ok: false, errors: ["no modules are installed"] }), assessLesson: () => ({ correct: null, score: null, feedback: "", status: "invalid", detail: {} }), listAssets: () => [], catalogVersion: () => "none", createVariant: () => null };

const PREREQ_RESULTS: PrereqCheck[] = ["asked", "correct", "partial", "incorrect", "skipped", "ungraded", "taught"];

/** Outside prerequisite checks this chat has made, by prerequisite id. */
function prereqChecks(chat: Chat): Record<string, PrereqCheck> {
  try {
    const v = JSON.parse(fmStr(chat.fm, "prereq_checks", "{}"));
    const out: Record<string, PrereqCheck> = {};
    if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, r] of Object.entries(v)) if (PREREQ_RESULTS.includes(r as PrereqCheck)) out[k] = r as PrereqCheck;
    return out;
  } catch {
    return {};
  }
}

function setPrereqCheck(chat: Chat, id: string, result: PrereqCheck): void {
  chat.fm.prereq_checks = JSON.stringify({ ...prereqChecks(chat), [id]: result });
}

/**
 * The kind of task an answered question was. The app knows when it set the question under an
 * action; in the modes where the tutor chooses its own questions, the tutor's label is the only
 * record, as with transfer. A transfer still needs the tutor to confirm the problem was fresh.
 */
function taskTypeFor(askedUnder: string, mode: Mode, tag: Record<string, unknown> | null): TaskType | "" {
  if (askedUnder === "transfer") return tag?.transfer === true ? "transfer" : "application";
  const set: Record<string, TaskType> = { "teach-back": "teach-back", "edge-case": "edge-case", retrieval: "recall", "independent-practice": "application", "guided-practice": "application" };
  if (set[askedUnder]) return set[askedUnder];
  const claimed = tag && typeof tag.task_type === "string" ? tag.task_type : "";
  if ((mode === "tutor" || mode === "quiz") && TASK_TYPES.includes(claimed as TaskType) && claimed !== "interactive" && claimed !== "transfer") return claimed as TaskType;
  if (askedUnder.startsWith("diagnose")) return "application";
  return "";
}
import { GRADE_SCHEMA, buildCompileInput, buildRefreshInput, buildSystem, buildTurnInput, modeFile, topicForPrompt, utilityPrompt } from "./prompts";
import { Route, routeTurn } from "./router";
import { Intent, SESSION_RULES, SessionRecord, applyIntent, readIntent, readSessionReply, sessionFor } from "./session";
import { ExternalPrereq, Store } from "./store";
import { CheckReport, Claim, ClaimResult, MathBackend, checkReport, computeBlock, extractCompute, extractVerify, plainMaths } from "./sympy";
import { ToolRegistry, ToolResult, need } from "./tools";

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
  /** True when another plugin keeps the flashcard schedule; this one then records no schedule of its own. */
  externalFlashcards?: boolean;
  /** Let SymPy compute and check the maths: typed answers, and the tutor's own results. */
  mathCheck?: boolean;
  /** Pick the model and thinking effort per turn from the message (see router.ts). */
  smartRouting: boolean;
  /** Thinking effort for turns the router calls complex. */
  hardEffort: string;
  /** Quiz mode, and unaided practice in Adaptive mode, ask from the question bank and mark with plain code first. */
  bankQuiz?: boolean;
  /** A new learner is placed with bank questions marked by code, not model turns. */
  codePlacement?: boolean;
  /** How the study policy weighs its components. Affects what is suggested, never what a level is. */
  weights?: PolicyWeights;
  /** Minutes the learner has for this sitting. */
  minutes?: number;
  /** Configure existing visual modules with the local model when no saved configuration fits. Default on. */
  localActivities?: boolean;
  /** The local model's name (Ollama tag). Part of every activity cache key. */
  localModel?: string;
}

/** What happened about presentation in one turn or one activity request. */
export interface PresentationOutcome {
  decision: PresentationDecision;
  request: PresentationRequest | null;
  /** The saved configuration (ready) or failure record, when there is one. */
  activity: ActivityRecord | null;
  /** The lesson to render, when one is ready. */
  lesson: VisualLesson | null;
  /** The contract's view of the outcome, for the player. */
  result: GenerationResult | null;
  /** A simpler supported explanation shown when the interactive is unavailable: the compiled worked lesson. */
  fallback: string;
  cacheHit: boolean;
  /** Model calls spent on presentation: local model calls, and Claude calls (always 0). */
  calls: { local: number; claude: 0 };
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
  /**
   * What SymPy did for this reply: results it computed, results it checked, whether it still
   * disagrees, and whether a draft was rewritten. `unresolved` counts checks SymPy could not
   * decide (or could not run); `numeric` counts agreements reached only at sample points.
   */
  maths?: { computed: number; checked: number; disputed: boolean; corrected: boolean; unresolved?: number; numeric?: number };
  /** The attempt recorded this turn, when the learner's answer was marked. */
  attempt?: Attempt;
  /** What the study policy chose for this turn, and why. */
  decision?: Decision;
  /** Tools run during this turn, with what each assumed. */
  tools?: ToolResult[];
  /** An activity opened, offered or declined this turn, with its reason. Absent when the text alone is the format. */
  presentation?: PresentationOutcome;
}

export interface TurnOpts {
  attached?: Material;
  onSpawn?: (kill: () => void) => void;
  /** The learner's stated confidence in this answer, 0 to 1, given before feedback. Null when not given. */
  confidence?: number | null;
}

/** How many times one turn may ask SymPy to compute before it must answer. */
const COMPUTE_ROUNDS = 2;
/** How long a typed answer waits for SymPy's first download before it goes to the model instead. */
const FIRST_CHECK_WAIT_MS = 20000;
/** A gap longer than this between question and answer is the learner being away, not thinking time. */
const MAX_ANSWER_SECONDS = 3600;

/** True when a topic card contains enough notation for maths checking to be worth its prompt. */
export const looksMathematical = (card: string): boolean => (card.match(/\$[^$\n]+\$/g) ?? []).length >= 3 || /\\(frac|int|sum|sqrt|partial|mathbf|begin\{)/.test(card);

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
  /** One line on how well the package covers its objectives. */
  coverage?: string;
  /** Every objective maps to a lesson and questions, and every lesson has a worked example. */
  complete?: boolean;
  /** Set by refresh(): whether nothing, a few subskills or the whole topic was recompiled, and why. */
  refresh?: "unchanged" | "partial" | "full";
  subskillsRefreshed?: number[];
  why?: string;
}

const BATCH_WORDS = 3000;
const PARALLEL = 3;

const MODE_NAME: Record<Mode, string> = { auto: "Adaptive", teach: "Learn", quiz: "Practise", tutor: "Master", expert: "Ask" };
const TEACHING: string[] = ["explain", "worked-example", "re-explain"];
const ERROR_TYPES = ["conceptual", "procedural", "arithmetic", "notation", "prerequisite", "careless"];
/** The learner is pointing back at something said before this part of the chat. */
const LOOKS_BACK = /\b(earlier|before|previous(ly)?|last time|you said|you told|we (did|covered|talked|discussed|went over)|remind me|go back|at the start)\b/i;

const daysBetween = (from: string, to: string): number => Math.max(0, Math.round((Date.parse(to + "T00:00:00") - Date.parse(from.slice(0, 10) + "T00:00:00")) / 86400000));

/** What kind of evidence a SymPy comparison is, read from how it reached its verdict. */
function equivalenceKind(detail: string): { grading: Grading; assumptions: string } {
  if (/test point|they differ at/.test(detail)) return { grading: "numeric", assumptions: "compared at random test points; strong evidence, not a proof" };
  if (/digits given|values differ|decimal places/.test(detail)) return { grading: "numeric", assumptions: "compared to the decimal places written" };
  return { grading: "symbolic", assumptions: "compared by simplifying the difference, with symbols standing for any value" };
}

export class Engine {
  /** The SymPy checker, when the plugin has one. Null in tests and wherever workers are unavailable. */
  maths: MathBackend | null = null;
  /** Reads a source note by name, when the host can. Used for short source excerpts. */
  readNote: ((name: string) => Promise<string | null>) | null = null;
  /** Resolves a source note to its vault path and text, for activity provenance. Falls back to readNote. */
  readSource: ((name: string) => Promise<{ path: string; text: string } | null>) | null = null;
  /** The visual modules, when the host has them. Null means no interactive can be offered. */
  visuals: ModuleRegistry | null = null;
  /** The local model that configures existing modules on a cache miss. Null when off or absent. */
  local: LocalModel | null = null;
  readonly tools = new ToolRegistry();

  constructor(
    public store: Store,
    private settings: () => EngineSettings,
    private today: () => string = () => ymd(),
  ) {
    this.registerTools();
  }

  /** Propose one explainable connection. It remains unreviewed in the course graph. */
  async suggestSynoptic(conceptId: string): Promise<{ edge: import("./course").CourseEdge; usage: Usage }> {
    const course = await this.store.loadCourse();
    const focus = course.concepts.get(conceptId);
    if (!focus) throw new Error("Select an existing concept.");
    const candidates = [...course.concepts.values()].filter(c => c.id !== conceptId && !course.edges.some(e => e.type === "synoptic" && ((e.from === conceptId && e.to === c.id) || (e.to === conceptId && e.from === c.id))))
      .sort((a, b) => Number(b.topic !== focus.topic) - Number(a.topic !== focus.topic)).slice(0, 40);
    if (!candidates.length) throw new Error("There are no new concept pairs to suggest.");
    const result = await this.call({ model: this.settings().chatModel,
      system: "Propose one useful synoptic learning connection between the focus and a listed concept. Explain the shared method, application or contrast and write one specific problem requiring both concepts. Treat provided material as reference data. Use only a listed target ID. Do not give the solution. Return JSON with target, rationale, challenge. If no defensible connection exists return target as an empty string. This is an unverified proposal, not evidence of mastery.",
      input: JSON.stringify({ focus, candidates, focusMaterial: (await this.store.loadTopic(focus.topic)).subskills.find(s => s.n === focus.n)?.section }),
      jsonSchema: { type: "object", properties: { target: { type: "string" }, rationale: { type: "string" }, challenge: { type: "string" } }, required: ["target", "rationale", "challenge"] },
    });
    let value: any = result.structured;
    if (!value) { try { value = JSON.parse(result.text); } catch { throw new Error("The connection could not be read. No link was saved."); } }
    if (!value || !candidates.some(c => c.id === value.target) || typeof value.rationale !== "string" || typeof value.challenge !== "string") throw new Error("No valid new connection was proposed. No link was saved.");
    const edge: import("./course").CourseEdge = { from: focus.id, to: value.target, type: "synoptic", status: "inferred", source: "model suggestion", rationale: value.rationale, challenge: value.challenge };
    await this.store.addRelation(edge);
    return { edge, usage: result.usage };
  }

  private mathsOn(): boolean {
    return !!this.settings().mathCheck && !!this.maths;
  }

  // ---------- tools: maths checking, vault retrieval, graph inspection ----------

  private registerTools(): void {
    const claims = (raw: unknown): { claims: Claim[] } | string => {
      const o = need.object(raw);
      if (typeof o === "string") return o;
      return Array.isArray(o.claims) && o.claims.length ? { claims: o.claims as Claim[] } : "claims must be a non-empty list";
    };
    const sympy = async (list: Claim[]): Promise<ClaimResult[]> => {
      if (!this.maths) throw new Error("SymPy is not available.");
      const results = await this.maths.check(list);
      if (results.length !== list.length) throw new Error(`SymPy is unavailable (${this.maths.status()}).`);
      return results;
    };
    this.tools.register<{ expected: string; given: string }, { equal: boolean | null; detail: string }>({
      name: "maths.equivalent",
      description: "Whether a typed answer equals the expected expression, by SymPy.",
      kind: "symbolic-equivalence",
      timeoutMs: 30000,
      validate: (raw) => {
        const o = need.object(raw);
        if (typeof o === "string") return o;
        const expected = need.text(o, "expected", 400);
        const given = need.text(o, "given", 400);
        return expected && given ? { expected, given } : "expected and given must be short expressions";
      },
      run: async (input) => {
        const [r] = await sympy([{ type: "equal", a: input.given, b: input.expected, lenient: true }]);
        const kind = equivalenceKind(r.detail);
        return { output: { equal: r.ok, detail: r.detail }, assumptions: [kind.assumptions], kind: kind.grading === "numeric" ? "numeric-check" : "symbolic-equivalence" };
      },
    });
    this.tools.register<{ claims: Claim[] }, ClaimResult[]>({
      name: "maths.check",
      description: "Recomputes the results a reply states (derivatives, integrals, solutions, values).",
      kind: "step-validation",
      timeoutMs: 40000,
      validate: claims,
      run: async (input) => ({ output: await sympy(input.claims), assumptions: ["each stated result was recomputed independently; the reasoning between results is not checked"] }),
    });
    this.tools.register<{ claims: Claim[] }, ClaimResult[]>({
      name: "maths.compute",
      description: "Computes expressions with SymPy before a reply is written.",
      kind: "computed",
      timeoutMs: 40000,
      validate: claims,
      run: async (input) => ({ output: await sympy(input.claims), assumptions: ["computed by SymPy from the expression as the model wrote it"] }),
    });
    this.tools.register<{ chatPath: string; query: string; maxWords: number }, { excerpts: string[] }>({
      name: "vault.transcript",
      description: "Finds exchanges from earlier parts of a chat that match what the learner is asking about.",
      kind: "retrieval",
      timeoutMs: 8000,
      validate: (raw) => {
        const o = need.object(raw);
        if (typeof o === "string") return o;
        const chatPath = need.text(o, "chatPath", 600);
        const query = need.text(o, "query", 4000);
        return chatPath && query ? { chatPath, query, maxWords: need.int(o, "maxWords") ?? 220 } : "chatPath and query are required";
      },
      run: async (input) => {
        const parts = await this.store.earlierParts(input.chatPath);
        const messages = parts.flatMap((c) => c.messages);
        return { output: { excerpts: bestExcerpts(messages.map((m) => `${m.role === "you" ? "LEARNER" : "TUTOR"}: ${m.text}`), input.query, input.maxWords) }, assumptions: ["matched by shared words; quoted exactly, possibly out of order"] };
      },
    });
    this.tools.register<{ notes: string[]; query: string; maxWords: number }, { excerpts: string[] }>({
      name: "vault.source",
      description: "Pulls the paragraphs of the learner's source notes most relevant to the current subskill.",
      kind: "retrieval",
      timeoutMs: 8000,
      validate: (raw) => {
        const o = need.object(raw);
        if (typeof o === "string") return o;
        const notes = Array.isArray(o.notes) ? o.notes.filter((n): n is string => typeof n === "string").slice(0, 4) : [];
        const query = need.text(o, "query", 4000);
        return notes.length && query ? { notes, query, maxWords: need.int(o, "maxWords") ?? 160 } : "notes and query are required";
      },
      run: async (input) => {
        if (!this.readNote) throw new Error("Source notes cannot be read here.");
        const paragraphs: string[] = [];
        for (const name of input.notes) {
          const text = await this.readNote(name.replace(/^\[\[|\]\]$/g, ""));
          if (text) for (const para of text.split(/\n\s*\n/)) if (words(para) >= 6) paragraphs.push(`[[${name.replace(/^\[\[|\]\]$/g, "")}]]: ${para.trim()}`);
        }
        return { output: { excerpts: bestExcerpts(paragraphs, input.query, input.maxWords) }, assumptions: ["matched by shared words; quoted exactly from the note"] };
      },
    });
    this.tools.register<{ dir: string; skill: number }, { name: string; prerequisites: string[]; dependents: string[]; weak: string[]; outside: string[] }>({
      name: "graph.inspect",
      description: "Reads a concept's place in the course graph: what it requires, what requires it, and which prerequisites are weak.",
      kind: "inspection",
      timeoutMs: 8000,
      validate: (raw) => {
        const o = need.object(raw);
        if (typeof o === "string") return o;
        const dir = need.text(o, "dir", 600);
        const skill = need.int(o, "skill");
        return dir && skill !== null ? { dir, skill } : "dir and skill are required";
      },
      run: async (input) => {
        const s = this.settings();
        const state = await this.store.loadState(input.dir, s.targetLevel);
        const pre = await this.store.prereqs(input.dir);
        if (!(input.skill in state.names)) throw new Error("No such subskill.");
        const label = (n: number) => `${state.names[n]} (level ${state.levels[n] ?? "unset"})`;
        const outside = (await this.store.externalPrereqs(input.dir, state.target)).filter((e) => e.skill === input.skill);
        return {
          output: {
            name: state.names[input.skill],
            prerequisites: (pre[input.skill] ?? []).map(label),
            dependents: Object.keys(pre).map(Number).filter((n) => (pre[n] ?? []).includes(input.skill)).map(label),
            weak: (pre[input.skill] ?? []).filter((n) => (state.levels[n] ?? -1) < 2).map(label),
            outside: outside.map((e) => `${e.name} in ${e.topic} (level ${e.level ?? "unknown"})`),
          },
          assumptions: ["relations marked rejected are left out"],
        };
      },
    });
  }

  /**
   * Asks SymPy whether a typed answer equals the expected one, and says what kind of evidence
   * the verdict is. `equal` is null when checking is off, either side is not an expression,
   * SymPy could not decide, or the tool failed. A null is never treated as a wrong answer.
   */
  async checkEquivalent(expected: string, given: string): Promise<{ equal: boolean | null; grading: Grading; assumptions: string; tool: ToolResult | null }> {
    const none = { equal: null, grading: "symbolic" as Grading, assumptions: "", tool: null };
    if (!this.mathsOn()) return none;
    const a = plainMaths(given, { allowLhs: true });
    const b = plainMaths(expected, { allowLhs: true });
    if (!a || !b) return none;
    // While SymPy is still downloading, an answer waits only so long before the model marks it.
    const r = await this.tools.run<{ equal: boolean | null; detail: string }>("maths.equivalent", { expected: b, given: a }, { timeoutMs: this.maths!.status() === "ready" ? 30000 : FIRST_CHECK_WAIT_MS });
    if (!r.ok || !r.output) return { ...none, tool: r };
    const kind = equivalenceKind(r.output.detail);
    return { equal: r.output.equal, grading: kind.grading, assumptions: kind.assumptions, tool: r };
  }

  async mathEquivalent(expected: string, given: string): Promise<boolean | null> {
    return (await this.checkEquivalent(expected, given)).equal;
  }

  /** Starts loading SymPy in the background when it is going to be wanted. */
  private warmMaths(): void {
    if (this.mathsOn()) this.maths!.warm();
  }

  /** Runs checks or computations through the tool registry; an empty list means SymPy was unavailable, never an error. */
  private async runMaths(tool: "maths.check" | "maths.compute", claims: Claim[], log: ToolResult[]): Promise<ClaimResult[]> {
    if (!claims.length || !this.maths) return [];
    const r = await this.tools.run<ClaimResult[]>(tool, { claims });
    log.push(r);
    return r.ok && r.output ? r.output : [];
  }

  private claudePath(): string {
    const p = findClaude(this.settings().claudePath);
    if (!p) throw new ClaudeError("Claude CLI not found. Install Claude Code, or set its path in Study Tutor settings.");
    return p;
  }

  private call(o: { model: string; system: string; input: string; effort?: string; jsonSchema?: object; tools?: string[]; timeoutMs?: number; onSpawn?: (kill: () => void) => void }): Promise<CallResult> {
    return callClaude({ claudePath: this.claudePath(), ...o });
  }

  // ---------- the study policy ----------

  /** Everything the policy looks at, gathered into one plain object that can be logged and replayed. */
  private policyInput(p: { mode: Mode; state: LearnerState; pre: Prereqs; chat: Chat; session: SessionRecord; intent: Intent; questions: Question[]; external: ExternalPrereq[] }): PolicyInput {
    const s = this.settings();
    const { state } = p;
    const today = this.today();
    const asked = fmList(p.chat.fm, "asked");
    const seenToday = new Set(state.attempts.filter((a) => a.timestamp.slice(0, 10) === today).map((a) => a.questionId));
    const dependents = dependentCounts(p.pre);
    const skills = Object.keys(state.names).map(Number).sort((a, b) => a - b).map((n) => {
      const m = mastery(state, n);
      const e = m.evidence;
      return {
        n,
        name: state.names[n],
        level: m.level,
        prerequisites: p.pre[n] ?? [],
        dependents: dependents[n] ?? 0,
        priority: state.priorities[n] ?? 1,
        taught: n in state.taught,
        supported: m.supported,
        independent: e.independent,
        independentCorrect: e.independentCorrect,
        recentFailures: e.recentFailures,
        lapse: e.lapse,
        // Retention is measured from unaided work; helped answers do not renew it.
        daysSince: e.lastIndependent ? daysBetween(e.lastIndependent, today) : null,
        bankLeft: s.bankQuiz === false ? 0 : p.questions.filter((q) => q.subskill === n && q.type !== "open" && !asked.includes(q.id) && !seenToday.has(q.id)).length,
        checkDue: (m.level ?? 0) >= 3 && checkDue(e, today),
        nextCheck: e.nextCheck,
        transferReady: !e.firstIndependentDay || e.firstIndependentDay < today,
        needsTeachBack: !e.teachBack,
        needsEdgeCase: !e.edgeCase,
      };
    });
    return {
      mode: p.mode,
      target: state.target,
      focus: state.focus,
      skills,
      pending: !!p.session.pendingQuestion,
      completedStep: p.session.completedStep,
      intent: p.intent,
      misconceptions: state.misconceptions.length,
      minutes: s.minutes ?? 25,
      weights: s.weights ?? DEFAULT_WEIGHTS,
      placementReady: s.codePlacement !== false && !p.chat.messages.length && skills.every((k) => k.level === null) && placementQuestions(p.questions, state).length > 0,
      external: p.external.map((e) => ({ skill: e.skill, name: e.name, topic: e.topic, level: e.level, id: e.id })),
      checked: fmList(p.chat.fm, "checked").map(Number),
      prereqChecks: prereqChecks(p.chat),
    };
  }

  /** The Home suggestion for a topic: the decision Adaptive study would make on a fresh chat, as a step. */
  async recommendTopic(dir: string, due?: number): Promise<{ step: NextStep; decision: Decision }> {
    const s = this.settings();
    const topic = await this.store.loadTopic(dir);
    const state = await this.store.loadState(dir, s.targetLevel);
    const chat: Chat = { fm: {}, summary: "", messages: [] };
    const questions = await this.store.loadQuestions(dir);
    const input = this.policyInput({ mode: "auto", state, pre: await this.store.prereqs(dir, topic), chat, session: sessionFor(chat, state, "auto"), intent: "none", questions, external: await this.store.externalPrereqs(dir, state.target) });
    const decision = decide(input);
    const ns = Object.keys(state.names).map(Number);
    const atTarget = ns.length > 0 && input.skills.every((k) => (k.level ?? 0) >= state.target && (k.level ?? 0) <= k.supported && !k.checkDue);
    return { step: homeStep(decision, { due: due ?? Object.values(state.cards).filter((c) => c.due <= this.today()).length, atTarget }), decision };
  }

  /**
   * The one entry point for a study turn in any mode. It sends the turn down the cheapest path
   * that can handle it: plain code for placement and bank questions, the model for the rest.
   * Adaptive mode uses the same local paths as the explicit modes when the policy calls for them.
   */
  async study(dir: string, chatPath: string, message: string, opts: TurnOpts = {}): Promise<TurnResult> {
    const s = this.settings();
    const chat = await this.store.loadChat(chatPath);
    const mode = (fmStr(chat.fm, "mode", "tutor") as Mode) || "tutor";
    const placing = fmStr(chat.fm, "placement") === "on";
    if (mode === "tutor" && s.codePlacement !== false && (!chat.messages.length || placing)) {
      const placed = await this.placementTurn(dir, chatPath, message, opts);
      if (placed) return placed;
    }
    if (mode === "quiz" && s.bankQuiz !== false) return this.quizTurn(dir, chatPath, message, opts);
    if (mode === "auto") {
      if (placing) {
        const placed = await this.placementTurn(dir, chatPath, message, opts);
        if (placed) return placed;
      }
      // A bank question the guide asked is still open: its answer is marked by code.
      if (fmStr(chat.fm, "card") && s.bankQuiz !== false) return this.quizTurn(dir, chatPath, message, { ...opts, adaptive: true });
      if (!message.trim() && chat.messages[chat.messages.length - 1]?.role !== "you") {
        const plan = await this.plan(dir, chat, mode, "");
        if (plan.local === "placement") {
          const placed = await this.placementTurn(dir, chatPath, message, opts);
          if (placed) return { ...placed, decision: plan };
        }
        if (plan.local === "bank" && plan.focus !== null) return this.quizTurn(dir, chatPath, "", { ...opts, adaptive: true, decision: plan });
      }
    }
    return this.turn(dir, chatPath, message, opts);
  }

  /** What the policy would choose now, without doing anything. */
  async plan(dir: string, chat: Chat, mode: Mode, message: string): Promise<Decision> {
    const s = this.settings();
    const topic = await this.store.loadTopic(dir);
    const state = await this.store.loadState(dir, s.targetLevel);
    const session = sessionFor(chat, state, mode);
    return decide(
      this.policyInput({ mode, state, pre: await this.store.prereqs(dir, topic), chat, session, intent: readIntent(message, !!session.pendingQuestion), questions: await this.store.loadQuestions(dir), external: await this.store.externalPrereqs(dir, state.target) }),
    );
  }

  /** What the policy would do with one concept if it were the focus of a fresh Adaptive chat. Changes nothing. */
  async advise(dir: string, n: number): Promise<Decision> {
    const s = this.settings();
    const topic = await this.store.loadTopic(dir);
    const state = await this.store.loadState(dir, s.targetLevel);
    if (n in state.names) state.focus = n;
    const chat: Chat = { fm: {}, summary: "", messages: [] };
    const input = this.policyInput({ mode: "auto", state, pre: await this.store.prereqs(dir, topic), chat, session: sessionFor(chat, state, "auto"), intent: "none", questions: await this.store.loadQuestions(dir), external: await this.store.externalPrereqs(dir, state.target) });
    input.placementReady = false;
    return decide(input);
  }

  // ---------- presentation: on-demand activities ----------

  /** Short exact passages from the concept's source notes, with provenance; the card section when there are none. */
  private async sourceRefsFor(dir: string, topic: Topic, n: number, query: string): Promise<SourceRef[]> {
    const sk = topic.subskills.find((k) => k.n === n);
    if (!sk) return [];
    const refs: SourceRef[] = [];
    for (const link of sk.sources.slice(0, 2)) {
      const name = link.replace(/^\[\[|\]\]$/g, "");
      const got = this.readSource ? await this.readSource(name).catch(() => null) : this.readNote ? await this.readNote(name).then((text) => (text === null ? null : { path: `${name}.md`, text })).catch(() => null) : null;
      if (!got) continue;
      const paragraphs = got.text.split(/\n\s*\n/).filter((p) => words(p) >= 6);
      const excerpt = bestExcerpts(paragraphs, query, 120).join("\n\n");
      // The hash is of the excerpt itself: an edit elsewhere in the note leaves the activity valid,
      // and any change to the passage it rests on makes a new one.
      if (excerpt) refs.push({ path: got.path, contentHash: contentHash(excerpt), excerpt });
    }
    if (!refs.length) {
      const excerpt = sk.section.split(/\s+/).slice(0, 120).join(" ");
      refs.push({ path: `${dir}/topic.md`, contentHash: contentHash(excerpt), excerpt });
    }
    return refs;
  }

  /** The compiled worked lesson for a concept: the simpler explanation offered when an interactive is not available. */
  private async workedLesson(dir: string, topic: Topic, n: number): Promise<string> {
    const sk = topic.subskills.find((k) => k.n === n);
    if (sk?.worked) return sk.worked;
    const pkg = await this.store.loadPackage(dir).catch(() => null);
    return pkg?.lessons.find((l) => l.n === n)?.worked ?? "";
  }

  /**
   * Runs the presentation gate for the concept in focus and prepares what it chose. An explicit
   * request is carried out now (a saved activity, or a local configuration on a cache miss); an
   * offer is only recorded, and configured if the learner opens it. Returns null when the text
   * alone is the format. Never calls Claude.
   */
  private async presentationFor(p: { dir: string; topic: Topic; state: LearnerState; mode: Mode; action: string | null; said: string; visualAsk: ExplicitRequest | null; tutorKind?: PresentationKind | null; chatPath?: string; concept?: number; preferredModuleId?: string; variantSeed?: number }): Promise<PresentationOutcome | null> {
    const n = p.concept ?? p.state.focus;
    const sk = p.topic.subskills.find((k) => k.n === n);
    if (!sk || n === null || n === undefined) return null;
    // Most turns have nothing to decide: no request, no proposal, and nothing the course marked.
    if (!p.visualAsk && !p.tutorKind && !sk.visual) return null;
    const conceptId = p.state.concepts[n] ?? "";
    const descriptors = this.visuals ? this.visuals.listModuleDescriptors() : [];
    const catalog = this.visuals?.catalogVersion() ?? "none";
    const modelName = this.local?.model ?? this.settings().localModel ?? DEFAULT_LOCAL_MODEL;
    const objective = `${sk.name}: ${(sk.section.split("\n").find((l) => /^\s*-\s+/.test(l)) ?? "").replace(/^\s*-\s+/, "").replace(/\s*\(\[\[[^\]]+\]\]\)\s*$/, "").trim()}`.replace(/:\s*$/, "");
    // Excerpts are chosen by the concept, not by how the learner worded the request, so the same
    // activity is found again however it is asked for.
    const refs = await this.sourceRefsFor(p.dir, p.topic, n, objective);
    // A saved record is reused only while its sources, module, catalogue, schema, prompt and
    // model are all unchanged. Anything else is a miss, and the old record stays on disk.
    const same = (a: SourceRef[]) => a.length === refs.length && a.every((x) => refs.some((y) => y.path === x.path && y.contentHash === x.contentHash));
    const saved = (await this.store.loadActivities(p.dir)).filter((a) => a.conceptId === conceptId && a.schemaVersion === LESSON_SCHEMA_VERSION && a.promptVersion === CONFIG_PROMPT_VERSION && a.model === modelName && a.catalogVersion === catalog && same(a.sourceRefs) && (!a.moduleId || descriptors.some((d) => d.id === a.moduleId && d.version === a.moduleVersion)));
    const e = skillEvidence(p.state.attempts, n);
    const lastWrong = [...p.state.attempts].reverse().find((a) => a.skill === n && a.result !== "correct" && a.result !== "ungraded");
    const decision = choosePresentation(
      { mode: p.mode, action: p.action, message: p.said, objective, context: sk.section, recentFailures: e.recentFailures, errorType: lastWrong?.errorType ?? "", misconception: p.state.misconceptions.length > 0, eligibility: sk.visual ?? null, descriptors, saved: saved.map((a) => ({ id: a.id, kind: a.kind, moduleId: a.moduleId, status: a.status })), preferredModuleId: p.preferredModuleId },
      p.visualAsk,
      p.tutorKind ?? null,
    );
    if (decision.status === "none") return null;
    const outcome: PresentationOutcome = { decision, request: null, activity: null, lesson: null, result: null, fallback: "", cacheHit: false, calls: { local: 0, claude: 0 } };
    if (decision.status === "text") return outcome;
    const t = new Date().toISOString();
    const log = (event: string, a: ActivityRecord | null) => this.store.logActivity(p.dir, { t, activityId: a?.id ?? decision.activityId ?? "", conceptId, event, trigger: decision.trigger, reason: decision.reason, ...(p.chatPath ? { chatPath: p.chatPath } : {}) });
    const request: PresentationRequest = { version: 1, kind: decision.kind, reason: decision.reason, objective, sourceRefs: refs, ...(decision.moduleId ? { preferredModuleId: decision.moduleId } : {}) };
    outcome.request = request;
    const configure = (candidates: ModuleDescriptor[], model: LocalModel | null) => configureActivity({ request, conceptId, candidates, assets: this.visuals?.listAssets() ?? [], registry: this.visuals ?? NO_MODULES, model, catalogVersion: catalog, trigger: decision.trigger, modelName });

    if (decision.status === "cached") {
      const rec = saved.find((a) => a.id === decision.activityId) ?? null;
      outcome.activity = rec;
      outcome.cacheHit = !!rec;
      if (rec?.lesson) {
        outcome.lesson = this.variant(rec.lesson, p.variantSeed) ?? rec.lesson;
        outcome.result = { status: "ready", lesson: outcome.lesson };
      }
      await log(decision.trigger === "explicit" ? "reused" : "offered", rec);
      return outcome;
    }
    if (decision.status === "offer") {
      await log("offered", null);
      return outcome;
    }
    if (decision.status === "unsupported") {
      // A failure saved for this concept and kind is reused; otherwise code records the gap.
      const known = saved.find((a) => a.status !== "ready" && a.kind === decision.kind && !a.moduleId) ?? null;
      const rec = known ?? (await configure([], null));
      if (!known) await this.store.saveActivity(p.dir, rec);
      return this.declined(p.dir, p.topic, n, outcome, rec, conceptId, !!known, log);
    }
    // configure: a saved configuration (or saved failure) for exactly these sources and versions
    // is reused first, so a repeated failure never runs the local model again.
    if (!this.visuals) return this.declined(p.dir, p.topic, n, outcome, null, conceptId, false, log);
    const candidates = matchModules(`${objective}\n${sk.section}\n${p.said}`, decision.kind, descriptors, decision.moduleId ?? undefined).map((m) => m.descriptor);
    const hit = saved.find((a) => a.kind === decision.kind && a.moduleId === candidates[0]?.id && a.objective === objective) ?? null;
    let rec: ActivityRecord;
    if (hit) {
      rec = hit;
      outcome.cacheHit = true;
    } else {
      rec = await configure(candidates, this.settings().localActivities === false ? null : this.local);
      outcome.calls.local = rec.localCalls;
      await this.store.saveActivity(p.dir, rec);
    }
    outcome.activity = rec;
    if (rec.status === "ready" && rec.lesson) {
      outcome.lesson = this.variant(rec.lesson, p.variantSeed) ?? rec.lesson;
      outcome.result = { status: "ready", lesson: outcome.lesson };
      await log(hit ? "reused" : "generated", rec);
      return outcome;
    }
    return this.declined(p.dir, p.topic, n, outcome, rec, conceptId, !!hit, log);
  }

  /** An interactive that cannot be given: the gap is recorded, and the compiled worked lesson is offered instead. */
  private async declined(dir: string, topic: Topic, n: number, outcome: PresentationOutcome, rec: ActivityRecord | null, conceptId: string, known: boolean, log: (event: string, a: ActivityRecord | null) => Promise<void>): Promise<PresentationOutcome> {
    outcome.activity = rec;
    outcome.result = rec ? toResult(rec) : { status: "invalid", reason: "No visual modules are installed.", validationErrors: [{ path: "$", message: "no module registry" }] };
    outcome.fallback = await this.workedLesson(dir, topic, n);
    if (rec?.status === "unsupported" && rec.missingCapability && !known) {
      await this.store.logCapability({ t: rec.createdAt, topic: topic.title, conceptId, kind: rec.kind, operation: rec.missingCapability.operation, objective: rec.objective, motivatingTask: rec.missingCapability.motivatingTask, sources: rec.sourceRefs.map((s) => ({ path: s.path, contentHash: s.contentHash })) });
    }
    await log(rec?.status === "unsupported" ? "unsupported" : "failed", rec);
    return outcome;
  }

  /** A fresh numeric variant made and validated by module code, when the module offers one. */
  private variant(lesson: VisualLesson, seed?: number): VisualLesson | null {
    if (seed === undefined || !this.visuals) return null;
    const v = this.visuals.createVariant(lesson, seed);
    if (!v) return null;
    const ok = this.visuals.validateLesson(v);
    return ok.ok ? ok.lesson : null;
  }

  /** Answers an explicit request for an activity in the chat, with no model call. */
  private async presentLocally(p: { chatPath: string; chat: Chat; state: LearnerState; session: SessionRecord; outcome: PresentationOutcome; decision: Decision | null }): Promise<TurnResult> {
    const { outcome, session } = p;
    const kind = outcome.decision.kind;
    const label = kind === "game" ? "Challenge" : kind === "external" ? "External activity" : kind.charAt(0).toUpperCase() + kind.slice(1);
    let reply: string;
    if (outcome.lesson) {
      reply = `**${label}** · ${outcome.decision.reason}\n\n${outcome.lesson.predictionQuestion}\n\n*Make your prediction in the activity before you run it. Moving its controls, playing and resetting use no tokens.*`;
      session.nextAction = session.pendingQuestion ? "Answer the open question." : "Make a prediction in the activity.";
    } else {
      const why = outcome.activity?.reason || outcome.decision.reason;
      reply = `**No ${kind} for this yet** · ${why}${outcome.fallback ? `\n\nHere is the worked example from your course instead:\n\n${outcome.fallback}` : ""}\n\n*Ask for an explanation in words or a diagram if you want one.*`;
    }
    p.chat.messages.push({ role: "tutor", text: reply });
    session.exactExcerpts = p.chat.messages.slice(-2).map((m) => `${m.role}: ${m.text}`);
    session.unresolvedMisconceptions = [...p.state.misconceptions];
    p.chat.fm.session = JSON.stringify(session);
    p.chat.fm.pending_confidence = "";
    p.chat.fm.answered_at = "";
    await this.store.saveChat(p.chatPath, p.chat);
    const out: TurnResult = { reply, changes: [], state: p.state, usage: zeroUsage(), local: true, presentation: outcome };
    if (p.decision) out.decision = p.decision;
    return out;
  }

  /** Records, on an open question in a chat, that an activity was used for it, so the answer counts as helped. */
  private async noteActivityHelp(chatPath: string | undefined, state: LearnerState, kind: string): Promise<void> {
    if (!chatPath) return;
    const chat = await this.store.loadChat(chatPath);
    const record = sessionFor(chat, state, (fmStr(chat.fm, "mode", "tutor") as Mode) || "tutor");
    if (!record.pendingQuestion) return;
    const line = `learner opened an interactive ${kind} for this question`;
    if (!record.helpGiven.includes(line)) record.helpGiven = [...record.helpGiven, line].slice(-8);
    chat.fm.session = JSON.stringify(record);
    if (fmStr(chat.fm, "card")) chat.fm.card_help = "yes";
    await this.store.saveChat(chatPath, chat);
  }

  /**
   * An explicit request from the interface, such as a "Show a simulation" button: reopens a saved
   * activity or configures one on a cache miss. Supported activities open with no approval step
   * and no Claude call. With `chatPath`, an open question in that chat is marked as helped.
   */
  async requestActivity(dir: string, o: { kind: PresentationKind; concept?: number; chatPath?: string; preferredModuleId?: string; variantSeed?: number }): Promise<PresentationOutcome> {
    const s = this.settings();
    const topic = await this.store.loadTopic(dir);
    const state = await this.store.loadState(dir, s.targetLevel);
    const said = `show me a ${o.kind}`;
    const outcome = await this.presentationFor({ dir, topic, state, mode: "auto", action: null, said, visualAsk: { kind: o.kind, said }, chatPath: o.chatPath, concept: o.concept, preferredModuleId: o.preferredModuleId, variantSeed: o.variantSeed });
    if (!outcome) throw new Error("Choose a concept first.");
    if (outcome.lesson) await this.noteActivityHelp(o.chatPath, state, o.kind);
    return outcome;
  }

  /** Reopens a saved activity by id with no model call; with a seed, a fresh variant checked by the module. */
  async openActivity(dir: string, activityId: string, o: { chatPath?: string; variantSeed?: number } = {}): Promise<PresentationOutcome> {
    const rec = (await this.store.loadActivities(dir)).find((a) => a.id === activityId);
    if (!rec) throw new Error("That activity is no longer saved.");
    const state = await this.store.loadState(dir, this.settings().targetLevel);
    const lesson = rec.lesson ? this.variant(rec.lesson, o.variantSeed) ?? rec.lesson : null;
    await this.store.logActivity(dir, { t: new Date().toISOString(), activityId, conceptId: rec.conceptId, event: "opened", trigger: rec.trigger, reason: rec.selectionReason, ...(o.chatPath ? { chatPath: o.chatPath } : {}) });
    if (lesson) await this.noteActivityHelp(o.chatPath, state, rec.kind);
    const decision: PresentationDecision = { kind: rec.kind, trigger: "explicit", status: rec.status === "ready" ? "cached" : "unsupported", reason: rec.selectionReason, moduleId: rec.moduleId || null, activityId, candidates: rec.moduleId ? [rec.moduleId] : [] };
    return { decision, request: null, activity: rec, lesson, result: lesson ? { status: "ready", lesson } : toResult(rec), fallback: "", cacheHit: true, calls: { local: 0, claude: 0 } };
  }

  /**
   * The learner's answer inside an activity, assessed by the module's own code. It is logged with
   * the activity and recorded as evidence, always as helped work: an interactive shows its result
   * as the learner works, so it can support "can do with help" and never counts as unaided
   * retention or transfer. No model is called.
   */
  async recordActivityResult(dir: string, activityId: string, response: unknown, o: { hintUsed?: boolean; chatPath?: string; confidence?: number | null } = {}): Promise<{ assessment: AssessmentResult; attempt: Attempt | null; changes: string[] }> {
    const s = this.settings();
    if (!this.visuals) throw new Error("No visual modules are installed.");
    const rec = (await this.store.loadActivities(dir)).find((a) => a.id === activityId);
    if (!rec?.lesson) throw new Error("That activity is no longer saved.");
    const assessment = this.visuals.assessLesson(rec.lesson, response);
    // The contract's response carries its own hintsUsed flag; either source marks the hint.
    o = { ...o, hintUsed: !!o.hintUsed || (!!response && typeof response === "object" && (response as Record<string, unknown>).hintsUsed === true) };
    const now = new Date().toISOString();
    const state = await this.store.loadState(dir, s.targetLevel);
    const n = Number(Object.entries(state.concepts).find(([, id]) => id === rec.conceptId)?.[0] ?? 0);
    let attempt: Attempt | null = null;
    let changes: string[] = [];
    if (assessment.correct !== null && n in state.names) {
      const result: Outcome = assessment.correct ? "correct" : assessment.score !== null && assessment.score > 0 ? "partial" : "incorrect";
      attempt = {
        id: `${activityId}:${now}`,
        v: 2,
        skill: n,
        concept: rec.conceptId,
        questionId: `${activityId}:${rec.lesson.assessmentId}`,
        question: rec.lesson.predictionQuestion,
        answer: JSON.stringify(response ?? null).slice(0, 400),
        activity: "interactive",
        mode: "activity",
        difficulty: null,
        result,
        errorType: "",
        note: assessment.feedback.slice(0, 300),
        confidence: typeof o.confidence === "number" && o.confidence >= 0 && o.confidence <= 1 ? o.confidence : null,
        assisted: true,
        assistance: ["interactive activity: the representation responds as the learner works", ...(o.hintUsed ? ["the activity's hint was opened"] : [])],
        answerExposed: false,
        transfer: false,
        seconds: null,
        timestamp: now,
        grading: "deterministic",
        verification: "verified",
        assumptions: `assessed by ${rec.moduleId}'s own code; interactive work counts as helped, never as unaided evidence`,
        taskType: "interactive",
        family: `activity-${rec.moduleId}`,
      };
      state.attempts = recordAttempt(state.attempts, attempt);
      changes = applyAttempt(state, attempt);
      await this.store.saveState(dir, state);
    }
    await this.store.logActivity(dir, { t: now, activityId, conceptId: rec.conceptId, event: "assessed", trigger: rec.trigger, reason: rec.selectionReason, correct: assessment.correct, hintUsed: !!o.hintUsed, ...(attempt ? { attemptId: attempt.id } : {}), ...(o.chatPath ? { chatPath: o.chatPath } : {}) });
    return { assessment, attempt, changes };
  }

  /**
   * How activities have fared on a topic: offers never opened (unnecessary activations), local
   * configurations, cache hits, rejected configurations, missing capabilities, and whether the
   * next unaided answer on the concept after an activity was right (resolved) or wrong.
   */
  async activityReport(dir: string): Promise<{ offered: number; unopened: number; generated: number; reused: number; failed: number; unsupported: number; assessed: number; resolved: number; unresolved: number; pending: number; localCalls: number; claudeCalls: 0 }> {
    const log = await this.store.loadActivityLog(dir);
    const records = await this.store.loadActivities(dir);
    const state = await this.store.loadState(dir, this.settings().targetLevel);
    const count = (ev: string) => log.filter((e) => e.event === ev).length;
    const offeredIds = log.filter((e) => e.event === "offered");
    const opened = new Set(log.filter((e) => e.event === "opened" || e.event === "reused" || e.event === "generated").map((e) => e.conceptId));
    let resolved = 0;
    let unresolved = 0;
    let pending = 0;
    for (const use of log.filter((e) => e.event === "generated" || e.event === "reused" || e.event === "opened")) {
      const n = Number(Object.entries(state.concepts).find(([, id]) => id === use.conceptId)?.[0] ?? 0);
      const next = state.attempts.filter((a) => a.skill === n && a.timestamp > use.t && !a.assisted && !a.answerExposed && a.result !== "ungraded" && a.verification !== "disputed").sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1))[0];
      if (!next) pending++;
      else if (next.result === "correct") resolved++;
      else unresolved++;
    }
    return { offered: offeredIds.length, unopened: offeredIds.filter((e) => !opened.has(e.conceptId)).length, generated: count("generated"), reused: count("reused") + count("opened"), failed: count("failed"), unsupported: count("unsupported"), assessed: count("assessed"), resolved, unresolved, pending, localCalls: records.reduce((a, r) => a + r.localCalls, 0), claudeCalls: 0 };
  }

  /**
   * One model turn. `message` may be empty to start a chat, to continue, or to retry after a
   * failure. The learner's message is saved before the call, so nothing is lost if the call fails.
   */
  async turn(dir: string, chatPath: string, message: string, opts: TurnOpts = {}): Promise<TurnResult> {
    const s = this.settings();
    const now = new Date().toISOString();
    const topic = await this.store.loadTopic(dir);
    let state = await this.store.loadState(dir, s.targetLevel);
    const chat = await this.store.loadChat(chatPath);
    if (message.trim()) {
      chat.messages.push({ role: "you", text: message.trim() });
      // Kept with the message, so a failed turn that is retried still has the confidence given.
      chat.fm.pending_confidence = typeof opts.confidence === "number" ? opts.confidence : "";
      chat.fm.answered_at = now;
      chat.fm.await_continue = "";
      await this.store.saveChat(chatPath, chat);
    }
    const mode = (fmStr(chat.fm, "mode", "tutor") as Mode) || "tutor";
    const subjectName = fmStr(topic.fm, "subject", "none");
    const lastMsg = chat.messages[chat.messages.length - 1];
    const said = lastMsg?.role === "you" ? lastMsg.text : "";
    const toolLog: ToolResult[] = [];

    // What the learner's message means for the open step, read before any model is asked.
    const before = sessionFor(chat, state, mode);
    // Asking for a diagram, a simulation or a game is asking for help with the open step. It is
    // never an answer to it, and an answer given after it counts as helped.
    const visualAsk = readPresentationRequest(said);
    const heard = readIntent(said, !!before.pendingQuestion);
    const intent = visualAsk && (heard === "attempt" || heard === "none") ? (before.pendingQuestion ? "hint" : "question") : heard;
    let session = applyIntent(before, intent, said);
    // The action the open question was put under. A hint turn since then does not change it.
    const askedUnder = before.askedUnder || before.action;

    const pre = await this.store.prereqs(dir, topic);
    const external = await this.store.externalPrereqs(dir, state.target);
    let decision: Decision | null = null;
    if (mode === "auto" || mode === "teach") {
      const input = this.policyInput({ mode, state, pre, chat, session, intent, questions: await this.store.loadQuestions(dir), external });
      decision = decide(input);
      if (decision.focus !== null && decision.focus in state.names && decision.focus !== state.focus) {
        state.focus = decision.focus;
        await this.store.saveState(dir, state);
      }
      session.action = decision.action;
      session.reason = decision.reason;
      // Outside prerequisite checks are kept by prerequisite id, so each weak one is reached in turn.
      if (decision.action === "diagnose-prerequisite" && decision.assesses) setPrereqCheck(chat, decision.assesses, "asked");
      else if (decision.action === "diagnose-prerequisite" && decision.focus !== null && external.some((e) => e.skill === decision!.focus && !e.id)) chat.fm.checked = [...new Set([...fmList(chat.fm, "checked"), String(decision.focus)])];
      void this.store.logDecision({ t: now, topic: topic.title, input, decision: { version: POLICY_VERSION, action: decision.action, focus: decision.focus, local: decision.local } });
    } else {
      session.action = intent === "attempt" ? "check" : intent === "hint" ? "hint" : "continue";
      session.reason = `${MODE_NAME[mode]} mode, chosen by you.`;
    }
    // The concept this turn's question assesses, when it lives in another topic. A hint or a nudge
    // to go on leaves the same question open, so it keeps the link. A worked example after a
    // reveal or skip may go on to ask about either concept, so the link stops there and the
    // tutor's mark says which one its next question tested.
    const stepPrereq = before.pendingQuestion ? before.assesses : "";
    const assesses = decision?.assesses ?? (decision && ["hint", "continue"].includes(decision.action) ? stepPrereq : "");
    session.mode = mode;
    session.skill = state.focus;
    session.concept = state.focus !== null ? state.concepts[state.focus] ?? "" : "";
    session.conceptName = state.focus !== null ? state.names[state.focus] ?? "" : "";
    session.goal = session.goal || fmStr(topic.fm, "goal") || `Reach level ${state.target} in ${topic.title}`;

    // Presentation, decided in code before any model is asked. An explicit request for an
    // activity a module supports is answered here: a saved one reopens, a new one is configured
    // by the local model, and either way Claude is not called. So is a request that cannot be
    // met when the course has a worked lesson to offer instead.
    const presented = await this.presentationFor({ dir, topic, state, mode, action: decision?.action ?? null, said, visualAsk, chatPath });
    if (presented && presented.decision.trigger === "explicit" && (presented.lesson || (presented.decision.status !== "text" && presented.fallback))) {
      return this.presentLocally({ chatPath, chat, state, session, outcome: presented, decision });
    }

    // Route on the learner's latest message (also on a retry, when `message` itself is empty).
    let route = s.smartRouting ? routeTurn({ mode, message: said, attached: !!opts.attached }) : { route: "standard" as Route, reason: "routing off" };
    const model = route.route === "simple" ? s.utilityModel : s.chatModel;
    // The chat model is told how to hand work to SymPy, on topics that have maths in them.
    const verifying = this.mathsOn() && route.route !== "simple" && looksMathematical(topic.body);
    if (verifying) this.warmMaths();
    let effort = route.route === "simple" ? undefined : route.route === "complex" ? s.hardEffort || s.effort || undefined : s.effort || undefined;
    if (verifying && route.reason === "answer contains maths to check" && said && plainMaths(said, { allowLhs: true })) {
      // The answer is a bare expression. SymPy does the comparing, so the model need not think
      // hard about the algebra; if SymPy then disputes the reply, the redo below thinks harder.
      route = { route: "standard", reason: "expression answer, checked by SymPy" };
      effort = s.effort || undefined;
    }

    const modeRules = await this.store.skill(modeFile(mode));
    const system = buildSystem({
      core: `${await this.store.skill("core.md")}\n\n${SESSION_RULES}\n\n${EVIDENCE_RULES}`,
      subject: subjectName && subjectName !== "none" ? await this.store.skill(`subjects/${subjectName}.md`) : "",
      topicText: topicForPrompt(topic, state.focus, s.maxTopicWords),
      mode: verifying ? `${modeRules.trim()}\n\n---\n\n${(await this.store.skill("maths-check.md")).trim()}` : modeRules,
    });

    // The part that changes each turn: state, chat, and only the extra context this turn needs.
    const extras: string[] = [];
    const linked = await this.store.linkedContext(dir, state, external);
    if (linked) extras.push(`# Cross-topic prerequisites\n${linked}`);
    if (said && fmStr(chat.fm, "previous") && LOOKS_BACK.test(said)) {
      const r = await this.tools.run<{ excerpts: string[] }>("vault.transcript", { chatPath, query: said, maxWords: 220 });
      toolLog.push(r);
      if (r.ok && r.output?.excerpts.length) extras.push(`# Retrieved from earlier in this chat (exact quotes)\n${r.output.excerpts.join("\n\n")}`);
    }
    const focusSkill = topic.subskills.find((k) => k.n === state.focus);
    if (this.readNote && focusSkill?.sources.length && ((decision && [...TEACHING, "diagnose-error"].includes(decision.action)) || (mode === "expert" && said))) {
      const r = await this.tools.run<{ excerpts: string[] }>("vault.source", { notes: focusSkill.sources, query: `${focusSkill.name} ${said}`, maxWords: 160 });
      toolLog.push(r);
      if (r.ok && r.output?.excerpts.length) {
        extras.push(`# From the learner's source notes (exact quotes)\n${r.output.excerpts.join("\n\n")}`);
        session.sources = focusSkill.sources.slice(0, 6);
      }
    }
    extras.push(`# Session record\n${JSON.stringify(session)}`);
    if (decision) extras.push(`Instructional action: ${decision.action}. ${ACTION_GUIDE[decision.action]}\nWhy: ${decision.reason}${decision.suggestIndependent ? "\nThe learner looks ready to practise this unaided. Say so in one line and let them choose; stay in guided practice unless they switch." : ""}`);
    if (session.disputed) extras.push("# Disputed grading\nThe learner disputes how their last answer was marked, and the app has set that mark aside. Check that answer again step by step. If the mark was wrong, say so plainly. Do not add an <attempt> line for this re-check.");
    const note = presented ? presentationNote(presented.decision) : "";
    if (note) extras.push(note);
    // The tutor may propose an interactive in the reply it is writing anyway, but only where one could exist.
    else if (this.visuals && focusSkill?.visual && ["simulation", "game"].includes(focusSkill.visual.kind) && ["auto", "quiz", "tutor"].includes(mode)) extras.push(PRESENT_RULE);
    const input = `${buildTurnInput({ state, today: this.today(), chat, attached: opts.attached, gaps: prereqGaps(state, pre) })}\n\n${extras.join("\n\n")}\n`;

    let res = await this.call({ model, effort, system, input, onSpawn: opts.onSpawn });
    let usage = res.usage;

    // 1. The model may ask SymPy to do the computing before it answers. It reasons about what
    //    needs working out and how the pieces connect; SymPy works each piece out.
    const asks: Claim[] = [];
    let computed = 0;
    let extra = "";
    for (let round = 1; verifying && round <= COMPUTE_ROUNDS; round++) {
      const more = extractCompute(res.text, asks.length).asks;
      if (!more.length) break;
      // Earlier requests are run again with the new ones, so the names r1, r2, … still resolve.
      asks.push(...more);
      const results = await this.runMaths("maths.compute", asks, toolLog);
      computed = results.filter((r) => r.ok).length;
      const last = round === COMPUTE_ROUNDS;
      extra = `\n\n# SymPy results\nYou asked the app to compute these before replying:\n${computeBlock(asks, results)}\n\nNow write your reply to the learner, relying on these results and not on your own arithmetic. ${last ? "Do not ask for more computation." : "Ask for more computation only if these results make a new one necessary."}`;
      res = await this.call({ model, effort, system, input: input + extra, onSpawn: opts.onSpawn });
      usage = addUsage(usage, res.usage);
    }

    // 2. Hidden lines may follow the reply: results for SymPy to check, and a state update.
    const read = (raw: string) => {
      const verify = extractVerify(extractCompute(raw).text);
      return { ...extractStateTrailer(verify.text), claims: verifying ? verify.claims : [] };
    };
    let decided = 0;
    const check = async (claims: Claim[], redone = false): Promise<CheckReport> => {
      const results = await this.runMaths("maths.check", claims, toolLog);
      decided = results.filter((r) => r.ok !== null).length;
      return checkReport(claims, results, { computed, corrected: redone });
    };
    let parsed = read(res.text);
    let report = await check(parsed.claims);
    let corrected = false;

    // 3. SymPy disputes the draft: the learner never sees it. The model gets the findings and
    //    one chance to rewrite, with more thinking. A reply still disputed is shown with a warning.
    if (report.disagreed) {
      const redo = `${input}${extra}\n\n# SymPy check of your draft\nThe app checked the reply you drafted. The learner has not seen it.\n\n<draft>\n${parsed.text}\n</draft>\n\n${report.findings.join("\n")}\n\nWrite the reply again with the error put right, ending with the hidden lines as usual. If the disagreement only shows that you transcribed something into SymPy syntax wrongly, keep the maths and correct the check.`;
      try {
        const again = await this.call({ model, effort: s.hardEffort || effort, system, input: redo, onSpawn: opts.onSpawn });
        usage = addUsage(usage, again.usage);
        const p2 = read(again.text);
        if (p2.text) {
          parsed = p2;
          report = await check(p2.claims, true);
          corrected = true;
        }
      } catch (e) {
        if (e instanceof ClaudeError && e.message === "Stopped.") throw e;
        /* the redo is a refinement: without it the draft is shown with SymPy's warning */
      }
    }

    // 4. The state is read again here. The call above can take a minute, and a review or a
    //    setting changed in that time must not be overwritten by a copy from before it.
    state = await this.store.loadState(dir, s.targetLevel);
    const changes: string[] = [];
    const push = (line: string | null) => {
      if (line) changes.push(line);
    };

    // 5. The learner's attempt. The model proposes a mark; code decides what it may count as.
    let marked: Attempt | null = null;
    /** The attempt was recorded in another topic, against a prerequisite this turn checked. */
    let elsewhere = false;
    let tagRaw: string | null = null;
    parsed.text = parsed.text.replace(/`{0,3}\s*<attempt>([\s\S]*?)<\/attempt>\s*`{0,3}/g, (_all, raw: string) => ((tagRaw = raw), "")).trim();
    // The tutor's optional proposal of an interactive, a field in a reply it was writing anyway.
    const proposal = extractPresent(parsed.text);
    parsed.text = proposal.text;
    const canMark = !!said && !!before.pendingQuestion && (intent === "attempt" || intent === "skip");
    if (canMark) {
      let tag: Record<string, unknown> | null = null;
      try {
        const v = tagRaw === null ? null : JSON.parse(tagRaw);
        tag = v && typeof v === "object" ? v : null;
      } catch {
        tag = null;
      }
      const tagSkill = tag && Number(tag.skill) in state.names ? Number(tag.skill) : null;
      // An open question tied to a stable concept cannot be reassigned by a model's mark.
      const recordedSkill = before.concept ? Object.entries(state.concepts).find(([, id]) => id === before.concept)?.[0] : undefined;
      const skill = recordedSkill !== undefined ? Number(recordedSkill) : tagSkill ?? (state.focus !== null && state.focus in state.names ? state.focus : null);
      const results: Outcome[] = ["correct", "partial", "incorrect", "ungraded"];
      let result: Outcome | null = null;
      let note = tag && typeof tag.error === "string" ? tag.error.slice(0, 300) : "";
      if (intent === "skip") result = "skipped";
      else if (tag && results.includes(tag.result as Outcome)) result = tag.result as Outcome;
      // A mark that came back unreadable is an ungraded attempt, never a wrong one.
      else if (tagRaw !== null) [result, note] = ["ungraded", "The mark for this answer could not be read, so it was left ungraded."];
      if (result && result !== "ungraded" && result !== "skipped" && report.disagreed) [result, note] = ["ungraded", "SymPy disagreed with the maths in the reply that marked this answer, so it was left ungraded."];
      if (result && skill !== null) {
        const fmConfidence = chat.fm.pending_confidence;
        const typed = /\bconfidence\s*:?\s*(100|\d{1,2})\s*%/i.exec(said);
        const helped = before.helpGiven.length > 0 || session.helpGiven.length > 0;
        const afterTeaching = TEACHING.includes(askedUnder);
        const answeredAt = fmStr(chat.fm, "answered_at") || now;
        const seconds = before.askedAt ? Math.round((Date.parse(answeredAt) - Date.parse(before.askedAt)) / 1000) : NaN;
        const checkedBySympy = parsed.claims.length > 0 && decided > 0 && !report.disagreed;
        const activity = ["independent-practice", "transfer", "guided-practice", "retrieval"].includes(askedUnder) ? askedUnder : askedUnder.startsWith("diagnose") ? "diagnosis" : afterTeaching ? "guided-practice" : mode === "auto" || mode === "teach" ? "guided-practice" : mode;
        const assistance = [...new Set([...before.helpGiven, ...session.helpGiven, ...(afterTeaching ? ["asked straight after an explanation or worked example"] : [])])];
        marked = {
          id: `${chatPath}:${chat.messages.length}`,
          v: 2,
          skill,
          concept: state.concepts[skill] ?? "",
          questionId: before.questionId,
          question: before.pendingQuestion,
          answer: said,
          activity,
          mode,
          difficulty: tag && typeof tag.difficulty === "number" && tag.difficulty >= 1 && tag.difficulty <= 5 ? Math.round(tag.difficulty) : null,
          result,
          errorType: result === "skipped" ? "skipped" : tag && ERROR_TYPES.includes(String(tag.error_type)) ? String(tag.error_type) : "",
          note,
          confidence: typeof fmConfidence === "number" && fmConfidence >= 0 && fmConfidence <= 1 ? fmConfidence : typed ? Number(typed[1]) / 100 : null,
          assisted: helped || afterTeaching || (tag ? tag.assisted !== false : false),
          assistance,
          answerExposed: before.answerExposed,
          // A transfer question is one the policy set as such, or one a model-run mode says was fresh.
          transfer: !!tag && tag.transfer === true && (askedUnder === "transfer" || mode === "tutor" || mode === "quiz"),
          seconds: Number.isFinite(seconds) && seconds >= 0 && seconds <= MAX_ANSWER_SECONDS ? seconds : null,
          timestamp: answeredAt,
          grading: result === "skipped" ? "deterministic" : "model",
          verification: result === "skipped" || checkedBySympy ? "verified" : "unverified",
          assumptions: result === "skipped" ? "the learner skipped the question" : checkedBySympy ? `SymPy recomputed the results the reply states${report.numeric ? " (some only numerically, at sample points)" : ""}${report.unresolved ? `; ${report.unresolved} could not be checked` : ""}; the judgement of the reasoning is the model's` : "one model judgement, not independently checked",
          taskType: taskTypeFor(askedUnder, mode, tag),
          family: "",
        };
        // A check on a prerequisite in another topic is evidence about that concept. It is kept
        // with that topic's evidence, and counts neither for nor against the concept in focus.
        // The app knows when it set the question as such a check; otherwise the tutor's mark may
        // name a prerequisite, which must be one this concept actually has.
        const named = tag && typeof tag.external === "string" ? tag.external.trim().toLowerCase() : "";
        const outside = before.assesses ? external.find((e) => e.id === before.assesses) : named ? external.find((e) => e.skill === skill && e.name.toLowerCase() === named) : undefined;
        const there = outside ? await this.store.loadState(outside.dir, s.targetLevel) : null;
        if (outside && there && outside.n in there.names) {
          marked = { ...marked, skill: outside.n, concept: outside.id };
          there.attempts = recordAttempt(there.attempts, marked);
          for (const line of applyAttempt(there, marked)) changes.push(`${outside.topic}: ${line}`);
          await this.store.saveState(outside.dir, there);
          elsewhere = true;
          // The outcome is kept with the chat by prerequisite, so the next one is checked next.
          setPrereqCheck(chat, outside.id, marked.result);
        } else {
          state.attempts = recordAttempt(state.attempts, marked);
          for (const line of applyAttempt(state, marked)) changes.push(line);
        }
      }
    }

    // 6. A lesson that was delivered is exposure: it can put a subskill on the map at level 1,
    //    and no higher. What the learner can do is shown only by their answers.
    //    A worked example that answers a prerequisite check from another topic teaches that, not the focus.
    if (decision && TEACHING.includes(decision.action) && !assesses && !stepPrereq && !decision.teaches && decision.focus !== null && decision.focus in state.names && parsed.text) {
      const f = decision.focus;
      if (!(f in state.taught)) state.taught[f] = this.today();
      if ((state.levels[f] ?? 0) < 1) push(setLevel(state, f, 1, "lesson", "a lesson on this was delivered", now));
    }
    //    An explanation of a prerequisite from another topic, after its check failed, is exposure to that concept.
    if (decision?.teaches && parsed.text) {
      const pre = external.find((e) => e.id === decision!.teaches);
      if (pre) {
        const there = await this.store.loadState(pre.dir, s.targetLevel);
        if (pre.n in there.names) {
          if (!(pre.n in there.taught)) there.taught[pre.n] = this.today();
          const line = (there.levels[pre.n] ?? 0) < 1 ? setLevel(there, pre.n, 1, "lesson", "a lesson on this was delivered while studying a concept that builds on it", now) : null;
          if (line) changes.push(`${pre.topic}: ${line}`);
          await this.store.saveState(pre.dir, there);
        }
      }
      setPrereqCheck(chat, decision.teaches, "taught");
    }

    // 7. The model's own proposals, within what the evidence allows. Levels are never changed on
    //    the word of the cheap model, in Ask mode, or on a turn SymPy disputes.
    if (parsed.update) for (const line of applyStateUpdate(state, parsed.update, { levels: mode !== "expert" && route.route !== "simple" && !report.disagreed, attempt: elsewhere ? null : marked })) changes.push(line);
    await this.store.saveState(dir, state);

    // 8. The session record, saved with the reply so the next turn and a restart both resume from it.
    const resolved = (!!marked && marked.result !== "ungraded") || intent === "skip" || intent === "reveal";
    const continuation = readSessionReply(parsed.text, session, { now: new Date().toISOString(), resolved, assesses });
    session = continuation.record;
    session.unresolvedMisconceptions = [...state.misconceptions];
    session.disputed = "";
    const reply = (continuation.text || "(empty reply)") + (report.line ? `\n\n${report.line}` : "");
    chat.messages.push({ role: "tutor", text: reply });
    session.exactExcerpts = chat.messages.slice(-2).map((m) => `${m.role}: ${m.text}`);
    chat.fm.session = JSON.stringify(session);
    chat.fm.pending_confidence = "";
    chat.fm.answered_at = "";
    await this.store.saveChat(chatPath, chat);

    const out: TurnResult = { reply, changes, state, usage, route: { ...route, model }, tools: toolLog };
    if (marked) out.attempt = marked;
    if (decision) out.decision = decision;
    if (verifying) out.maths = { computed, checked: parsed.claims.length, disputed: report.disagreed, corrected, ...(report.unresolved ? { unresolved: report.unresolved } : {}), ...(report.numeric ? { numeric: report.numeric } : {}) };
    if (presented) out.presentation = presented;
    else if (proposal.kind) {
      // The tutor's proposal can only become an offer, and only for a module that exists.
      const offered = await this.presentationFor({ dir, topic, state, mode, action: decision?.action ?? null, said, visualAsk: null, tutorKind: proposal.kind, chatPath });
      if (offered) out.presentation = offered;
    }

    // 9. A long chat is summarised and continued in a new part, but only at a finished step:
    //    an open question or a half-done proof keeps its whole transcript.
    if (session.completedStep && chatWords(chat) > s.maxChatWords && chat.messages.length > 4) {
      const summary = await this.summarise(chat, session);
      if (summary) {
        out.rotatedTo = await this.store.rotateChat(chatPath, chat, summary.text);
        out.rotationUsage = summary.usage;
      }
    }
    return out;
  }

  /**
   * A handover note for the next part of a chat: a short summary by the cheap model, followed
   * by the things that must survive word for word. Returns null when the summary could not be
   * written, and the chat then simply stays in one part.
   */
  private async summarise(chat: Chat, session: SessionRecord): Promise<{ text: string; usage: Usage } | null> {
    const s = this.settings();
    try {
      const transcript = chat.messages.map((m) => `${m.role === "you" ? "LEARNER" : "TUTOR"}: ${m.text.trim()}`).join("\n\n");
      const res = await this.call({ model: s.utilityModel, system: utilityPrompt(await this.store.skill("utility.md"), "summarise"), input: `${chat.summary.trim() ? `Summary of earlier parts:\n${chat.summary.trim()}\n\n` : ""}Chat:\n${transcript}`, timeoutMs: 120000 });
      const text = res.text.trim();
      if (!text) return null;
      const exact = [`Next action: ${session.nextAction}`, ...(session.unresolvedMisconceptions.length ? [`Unresolved misconceptions: ${session.unresolvedMisconceptions.join("; ")}`] : []), ...(session.sources.length ? [`Sources: ${session.sources.join(", ")}`] : [])];
      return { text: `${text}\n\n**Carried over exactly**\n${exact.map((l) => `- ${l}`).join("\n")}`, usage: res.usage };
    } catch {
      return null;
    }
  }

  /**
   * Places a new learner with plain code: one multiple-choice or short question per subskill
   * from the bank, marked without a model, then starting levels are set from the results.
   * Returns null when placement does not apply, and the caller then runs a normal turn.
   */
  async placementTurn(dir: string, chatPath: string, message: string, opts: TurnOpts = {}): Promise<TurnResult | null> {
    const s = this.settings();
    const now = new Date().toISOString();
    const chat = await this.store.loadChat(chatPath);
    const mode = (fmStr(chat.fm, "mode", "tutor") as Mode) || "tutor";
    const phase = fmStr(chat.fm, "placement");
    const text = message.trim();
    const state = await this.store.loadState(dir, s.targetLevel);
    const questions = await this.store.loadQuestions(dir);
    const usage = zeroUsage();
    const tools: ToolResult[] = [];
    const say = async (reply: string, open: Question | null): Promise<TurnResult> => {
      chat.messages.push({ role: "tutor", text: reply });
      this.bankSession(chat, state, mode, open, { action: "diagnose", reason: "Quick questions to find your starting level. The plugin marks them, so they use no tokens." }, now);
      await this.store.saveChat(chatPath, chat);
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
      await this.store.saveChat(chatPath, chat);
      return null;
    }
    if (!answer) return say(formatQuizQuestion(pending, state), pending);
    if (text) {
      chat.messages.push({ role: "you", text });
      chat.fm.pending_confidence = typeof opts.confidence === "number" ? opts.confidence : "";
      chat.fm.answered_at = now;
      await this.store.saveChat(chatPath, chat);
    }

    const mark = codeMark(pending, answer);
    if (mark === "letter") return say("Reply with one letter, for example **B**, or say **skip**.", pending);
    // Placement never calls a model. What code cannot decide is left unplaced: a check that
    // failed or could not tell is not a wrong answer.
    const sym = mark === "model" && pending.type === "short" ? await this.checkEquivalent(pending.answer, answer) : null;
    if (sym?.tool) tools.push(sym.tool);
    const skipped = givesUp(answer);
    const result: Outcome = skipped ? "skipped" : mark === "good" || sym?.equal === true ? "correct" : mark === "model" && (!sym || sym.equal === null) ? "ungraded" : "incorrect";
    const level = result === "skipped" ? 0 : result === "correct" ? 2 : result === "incorrect" ? 1 : -1;
    const attemptId = `${chatPath}:${chat.messages.length}:${pending.id}`;
    const repeat = state.attempts.some((a) => a.id === attemptId);
    const attempt = this.bankAttempt({ id: attemptId, chat, state, q: pending, answer, result, activity: "placement", mode, grading: sym?.equal !== null && sym ? sym.grading : "deterministic", assumptions: result === "ungraded" ? "could not be checked by code, so it was left ungraded" : sym && sym.equal !== null ? sym.assumptions : pending.type === "mcq" ? "the chosen letter was compared with the answer key" : result === "incorrect" ? "both answers are plain numbers, and they differ" : "matched the expected answer after ignoring case and spacing", note: result === "ungraded" ? "Could not be checked automatically during placement." : "", now });
    state.attempts = recordAttempt(state.attempts, attempt);
    const placed = [...fmList(chat.fm, "placed").filter((p) => !p.startsWith(`${pending.subskill}:`)), `${pending.subskill}:${level}`];
    chat.fm.placed = placed;
    if (!repeat && result !== "ungraded") {
      if (pending.subskill in state.names) {
        const b = state.bank[pending.subskill] ?? (state.bank[pending.subskill] = { right: 0, total: 0 });
        b.total += 1;
        if (result === "correct") b.right += 1;
      }
      if (!s.externalFlashcards) state.cards[pending.id] = schedule(state.cards[pending.id], result === "correct" ? "good" : "again", this.today());
    }
    chat.fm.pending_confidence = "";
    const verdict = result === "correct" ? "**Correct.**" : result === "incorrect" ? "**Not quite.**" : result === "skipped" ? "**Skipped.**" : "**Could not be checked automatically**, so this subskill is left unplaced for now.";

    const next = questions.find((q) => q.id === queue[queue.indexOf(pending.id) + 1]);
    if (next) {
      chat.fm.card = next.id;
      await this.store.saveState(dir, state);
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
    await this.store.saveState(dir, state);
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
  private bankAttempt(p: { id: string; chat: Chat; state: LearnerState; q: Question; answer: string; result: Outcome; activity: string; mode: Mode; grading: Grading; assumptions: string; note: string; now: string }): Attempt {
    const conf = p.chat.fm.pending_confidence;
    const asked = fmStr(p.chat.fm, "asked_at");
    const seconds = asked ? Math.round((Date.parse(p.now) - Date.parse(asked)) / 1000) : NaN;
    const helped = fmStr(p.chat.fm, "card_help") === "yes";
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
      errorType: p.result === "skipped" ? "skipped" : "",
      note: p.note,
      confidence: typeof conf === "number" && conf >= 0 && conf <= 1 ? conf : null,
      assisted: helped,
      assistance: helped ? ["the learner asked the tutor about this question before answering"] : [],
      answerExposed: false,
      transfer: false,
      seconds: Number.isFinite(seconds) && seconds >= 0 && seconds <= MAX_ANSWER_SECONDS ? seconds : null,
      timestamp: p.now,
      grading: p.grading,
      verification: p.result === "ungraded" || p.grading === "model" ? "unverified" : "verified",
      assumptions: p.assumptions,
      taskType: (TASK_TYPES.includes(p.q.task as TaskType) ? p.q.task : p.activity === "retrieval" ? "recall" : "application") as TaskType,
      family: p.q.family ?? "",
    };
  }

  /** Keeps the session record in step on the paths that never call the model, so resuming works the same everywhere. */
  private bankSession(chat: Chat, state: LearnerState, mode: Mode, open: Question | null, why: { action: string; reason: string }, now: string): void {
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
    const previous = req.existingDir ? await this.store.loadPackage(req.existingDir).catch(() => null) : null;
    const dir = await this.store.saveCompiled({
      title: req.title,
      fm: { source: req.mode, subject, goal: req.goal.trim(), research: req.research ? "yes" : "no", ...req.fm },
      topicBody: parsed.topicBody,
      questionsBody: parsed.questionsBody,
      target: s.targetLevel,
      existingDir: req.existingDir,
    });
    const pkg = await this.writePackage(dir, req, previous);
    return { dir, subskills: topic.subskills.length, questions: questions.length, usage, agents: agents + 1, coverage: coverageLine(pkg), complete: pkg.coverage.complete };
  }

  /** Builds and saves the course package for a compiled topic, fingerprinting its source notes. */
  private async writePackage(dir: string, req: Pick<CompileRequest, "mode" | "material" | "research">, previous: CoursePackage | null, refreshed?: { subskills: number[]; notes: string[] }): Promise<CoursePackage> {
    const s = this.settings();
    const topic = await this.store.loadTopic(dir);
    const state = await this.store.loadState(dir, s.targetLevel);
    const sources = req.mode === "subject" ? {} : Object.fromEntries(req.material.map((m) => [m.name, contentHash(m.text)]));
    const pkg = buildPackage({ topic, questions: await this.store.loadQuestions(dir), concepts: state.concepts, sources: refreshed && previous ? { ...previous.sources, ...sources } : sources, previous, at: new Date().toISOString(), mode: req.mode, research: !!req.research, refreshed });
    await this.store.savePackage(dir, pkg);
    return pkg;
  }

  /**
   * Recompiles only what changed. Source notes are compared with the fingerprints in the course
   * package: unchanged notes cost nothing, and a change that reaches a few subskills rewrites
   * just those sections and their questions in one call, keeping every other section, question
   * id and review schedule. New notes, a change reaching most of the topic, or a topic with no
   * package yet get a full compile. Learner evidence is kept either way, through stable ids.
   */
  async refresh(req: CompileRequest & { existingDir: string }, onProgress: (msg: string) => void = () => {}): Promise<CompileResult & { refresh: "unchanged" | "partial" | "full"; subskillsRefreshed: number[]; why: string }> {
    const s = this.settings();
    const dir = req.existingDir;
    const pkg = await this.store.loadPackage(dir).catch(() => null);
    const full = async (why: string) => ({ ...(await this.compile(req, onProgress)), refresh: "full" as const, subskillsRefreshed: [] as number[], why });
    if (!pkg || req.mode === "subject" || !req.material.length) return full(!pkg ? "there is no course package yet" : "a topic without notes is always compiled whole");
    const now = Object.fromEntries(req.material.map((m) => [m.name, contentHash(m.text)]));
    const ch = sourceChanges(pkg, now);
    const topic = await this.store.loadTopic(dir);
    const questions = await this.store.loadQuestions(dir);
    if (!ch.changed.length && !ch.removed.length && !ch.added.length) return { dir, subskills: topic.subskills.length, questions: questions.length, usage: zeroUsage(), agents: 0, coverage: coverageLine(pkg), complete: pkg.coverage.complete, refresh: "unchanged", subskillsRefreshed: [], why: "no source note has changed since the last compile" };
    if (ch.added.length) return full(`new notes (${ch.added.slice(0, 3).join(", ")}) need a full compile to place them`);
    if (!ch.subskills.length) return full("the changed notes are not cited by any subskill");
    if (ch.subskills.length > Math.max(1, Math.floor(pkg.lessons.length / 2))) return full(`the changes reach ${ch.subskills.length} of ${pkg.lessons.length} subskills`);

    onProgress(`Refreshing ${ch.subskills.length} subskill${ch.subskills.length === 1 ? "" : "s"} from ${ch.changed.length + ch.removed.length} changed note${ch.changed.length + ch.removed.length === 1 ? "" : "s"}…`);
    const material = req.material.filter((m) => ch.changed.includes(m.name)).map((m) => `## [[${m.name}]]\n${m.text.trim()}`).join("\n\n");
    const res = await this.call({ model: s.compileModel, system: await this.store.skill("compile.md"), input: buildRefreshInput({ title: topic.title, goal: req.goal, subjects: await this.store.subjectNames(), card: topic.body, subskills: ch.subskills, removed: ch.removed, material }), timeoutMs: 600000 });
    const parsed = parseCompileOutput(res.text);
    const sections = subskillSections(parsed.topicBody);
    const missing = ch.subskills.filter((n) => !sections.has(n));
    if (missing.length) throw new ClaudeError(`The refresh did not return subskill ${missing.join(", ")}. Nothing was changed; recompile the whole topic instead.`);
    const qRaw = splitFrontmatter(await this.store.readQuestionsRaw(dir)).body;
    const merged = mergeRefresh({ topicBody: topic.body, questionsBody: qRaw, sections, questions: parsed.questionsBody, subskills: ch.subskills });
    const check = parseTopic(merged.topicBody);
    if (check.subskills.length !== topic.subskills.length) throw new ClaudeError("The refreshed card did not keep the same subskills. Nothing was changed; recompile the whole topic instead.");
    const kept = parseQuestions(merged.questionsBody).filter((q) => !merged.replaced.includes(q.subskill)).map((q) => q.id);
    const fm: Frontmatter = { ...topic.fm };
    delete fm.compiled;
    await this.store.saveCompiled({ title: topic.title, fm, topicBody: merged.topicBody, questionsBody: merged.questionsBody, target: s.targetLevel, existingDir: dir, keepCards: kept });
    const next = await this.writePackage(dir, req, pkg, { subskills: merged.replaced, notes: [...ch.changed, ...ch.removed] });
    return { dir, subskills: check.subskills.length, questions: parseQuestions(merged.questionsBody).length, usage: res.usage, agents: 1, coverage: coverageLine(next), complete: next.coverage.complete, refresh: "partial", subskillsRefreshed: merged.replaced, why: `${[...ch.changed, ...ch.removed].join(", ")} changed` };
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
  async quizTurn(dir: string, chatPath: string, message: string, opts: TurnOpts & { adaptive?: boolean; decision?: Decision } = {}): Promise<TurnResult> {
    const s = this.settings();
    const now = new Date().toISOString();
    const chat = await this.store.loadChat(chatPath);
    const mode = (fmStr(chat.fm, "mode", "quiz") as Mode) || "quiz";
    const questions = await this.store.loadQuestions(dir);
    const pending = questions.find((q) => q.id === fmStr(chat.fm, "card"));
    const text = message.trim();
    const last = chat.messages[chat.messages.length - 1];
    // A question, or a request for a diagram or simulation, goes to the tutor as help with the open question.
    const asksTutor = (t: string) => (looksLikeQuestion(t) || !!readPresentationRequest(t)) && !givesUp(t);
    const tools: ToolResult[] = [];
    // A bank quiz may need SymPy for the next typed answer; load it while the learner reads.
    if (questions.some((q) => q.type === "short")) this.warmMaths();

    const toTutor = async () => {
      if (pending) {
        // Help asked for while a bank question is open is help with that question.
        chat.fm.card_help = "yes";
        await this.store.saveChat(chatPath, chat);
      }
      return this.turn(dir, chatPath, message, opts);
    };
    if (!pending && (text || last?.role === "you")) return this.turn(dir, chatPath, message, opts);
    if (pending && text && asksTutor(text)) return toTutor();

    const state = await this.store.loadState(dir, s.targetLevel);
    const today = this.today();
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
        await this.store.saveChat(chatPath, chat);
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
        const skipped = givesUp(answer);
        if (skipped) [grade, assumptions] = ["again", "the learner skipped the question"];
        else if (pending.type === "mcq") {
          const letter = parseMcqReply(answer, pending.options.length);
          if (!letter) {
            const reply = "Reply with one letter, for example **B**.";
            chat.messages.push({ role: "tutor", text: reply });
            await this.store.saveChat(chatPath, chat);
            return { reply, changes: [], state, usage, local: true };
          }
          grade = letter === mcqLetter(pending.answer) ? "good" : "again";
          assumptions = "the chosen letter was compared with the answer key";
        } else if (pending.type === "short" && sameShortAnswer(answer, pending.answer)) [grade, assumptions] = ["good", "matched the expected answer after ignoring case and spacing"];
        else if (pending.type === "short" && differentNumbers(answer, pending.answer)) [grade, assumptions] = ["again", "both answers are plain numbers, and they differ"];
        else {
          // An answer in another form (1/2 for 0.5, or an unsimplified expression): SymPy can say
          // whether it equals the expected one, with no model call. If SymPy fails or cannot
          // tell, that decides nothing and the answer goes to the grading call.
          const sym = pending.type === "short" ? await this.checkEquivalent(pending.answer, answer) : null;
          if (sym?.tool) tools.push(sym.tool);
          if (sym && sym.equal !== null) {
            grade = sym.equal ? "good" : "again";
            note = sym.equal ? "SymPy confirms your answer equals the expected one." : "SymPy finds your answer is not equal to the expected one.";
            grading = sym.grading;
            assumptions = sym.assumptions;
          } else {
            // Not something code can mark: one small grading call. If it fails, the error is
            // shown with a retry and nothing is recorded: the answer stays ungraded.
            const g = await this.grade(pending, answer);
            grade = g.grade;
            note = g.feedback;
            usage = g.usage;
            grading = "model";
            assumptions = "one model judgement against the model answer, not independently checked";
          }
        }
        const result: Outcome = skipped ? "skipped" : grade === "again" ? "incorrect" : grade === "hard" ? "partial" : "correct";
        const id = `${chatPath}:${chat.messages.length}:${pending.id}`;
        // If the state was saved and the chat was not (an interrupted turn), this is the same
        // attempt arriving again: the record is replaced, and the counters are left alone.
        const repeat = state.attempts.some((a) => a.id === id);
        attempt = this.bankAttempt({ id, chat, state, q: pending, answer, result, activity: opts.adaptive ? (sessionFor(chat, state, mode).action === "retrieval" ? "retrieval" : "independent-practice") : "quiz", mode, grading, assumptions, note: result === "correct" ? "" : note, now });
        state.attempts = recordAttempt(state.attempts, attempt);
        if (!repeat) {
          if (!s.externalFlashcards) state.cards[pending.id] = schedule(state.cards[pending.id], grade, today);
          if (pending.subskill in state.names) {
            const b = state.bank[pending.subskill] ?? (state.bank[pending.subskill] = { right: 0, total: 0 });
            b.total += 1;
            if (grade === "good" || grade === "easy") b.right += 1;
          }
          for (const line of applyAttempt(state, attempt)) changes.push(line);
        }
        // The chat's own score is saved with the verdict message, so it moves with that write.
        chat.fm.right = fmNum(chat.fm, "right", 0) + (grade === "good" || grade === "easy" ? 1 : 0);
        chat.fm.total = fmNum(chat.fm, "total", 0) + 1;
        await this.store.saveState(dir, state);
        chat.fm.card = "";
        chat.fm.pending_confidence = "";
        const head = skipped ? "**Skipped.**" : grade === "again" ? "**Incorrect.**" : grade === "hard" ? "**Partly right.**" : "**Correct.**";
        const parts = [note ? `${head} ${note}` : head];
        // The solution is shown only now, after an attempt or an explicit skip.
        if (grade === "again" || grade === "hard") parts.push(`Answer: ${answerText(pending)}${pending.explanation ? `\n\n${pending.explanation}` : ""}`);
        if (!opts.adaptive && fmNum(chat.fm, "total", 0) % 5 === 0) parts.push(`*Score so far: ${fmNum(chat.fm, "right", 0)}/${fmNum(chat.fm, "total", 0)}.*`);
        verdict = parts.join("\n\n");
      }
    }

    // What to ask next. In Adaptive mode the policy decides whether the bank still has the right question.
    const asked = fmList(chat.fm, "asked");
    let decision = opts.decision;
    let next: Question | null = null;
    if (opts.adaptive) {
      if (!decision || verdict) decision = await this.planFrom(dir, chat, state, mode, attempt && attempt.result === "correct" && attempt.skill ? attempt.skill : null);
      // Transfer questions are kept fresh for assessment: practice does not use them up.
      const assessing = decision.action === "transfer" || decision.action === "retrieval";
      if (decision.local === "bank" && decision.focus !== null) next = pickQuizQuestion(questions.filter((q) => q.subskill === decision!.focus && q.type !== "open" && (assessing || q.task !== "transfer")), state, asked, today);
    } else next = pickQuizQuestion(questions, state, asked, today);
    if (!next && !verdict) return this.turn(dir, chatPath, message, opts);

    let reply: string;
    if (next) reply = [verdict, formatQuizQuestion(next, state)].filter(Boolean).join("\n\n---\n\n");
    else if (opts.adaptive) reply = `${verdict}\n\n---\n\n*Next: ${decision ? decision.reason : "the guide chooses the next step."}* Press **Continue** when you are ready.`;
    else reply = `${verdict}\n\n---\n\nThat was the last question in the bank (${fmNum(chat.fm, "right", 0)}/${fmNum(chat.fm, "total", 0)}). Send any message and the quizzer will write fresh questions with the model.`;
    if (next) {
      chat.fm.card = next.id;
      chat.fm.asked = [...asked, next.id];
      if (opts.adaptive && next.subskill in state.names && state.focus !== next.subskill) {
        state.focus = next.subskill;
        await this.store.saveState(dir, state);
      }
    }
    chat.fm.await_continue = !next && opts.adaptive ? "yes" : "";
    chat.messages.push({ role: "tutor", text: reply });
    const why = opts.adaptive && decision ? { action: decision.action, reason: decision.reason } : { action: "quiz", reason: "Practise mode: questions from the bank, marked by the plugin where it can." };
    this.bankSession(chat, state, mode, next, why, now);
    await this.store.saveChat(chatPath, chat);

    const out: TurnResult = { reply, changes, state, usage, local: usage.calls === 0, tools };
    if (attempt) out.attempt = attempt;
    if (decision) out.decision = decision;
    if (!opts.adaptive && chatWords(chat) > s.maxChatWords && chat.messages.length > 4) {
      // The quiz score is the whole story so far, so the handover needs no model. The open
      // question travels with the new part.
      const summary = [chat.summary, `Question-bank quiz: ${fmNum(chat.fm, "total", 0)} asked, ${fmNum(chat.fm, "right", 0)} right so far.`].filter(Boolean).join(" ");
      out.rotatedTo = await this.store.rotateChat(chatPath, chat, summary);
    }
    return out;
  }

  private async planFrom(dir: string, chat: Chat, state: LearnerState, mode: Mode, continuing: number | null): Promise<Decision> {
    const topic = await this.store.loadTopic(dir);
    const session = { ...sessionFor(chat, state, mode), pendingQuestion: "", completedStep: true };
    const input = this.policyInput({ mode, state, pre: await this.store.prereqs(dir, topic), chat, session, intent: "none", questions: await this.store.loadQuestions(dir), external: await this.store.externalPrereqs(dir, state.target) });
    input.continuing = continuing;
    const decision = decide(input);
    void this.store.logDecision({ t: new Date().toISOString(), topic: topic.title, input, decision: { version: POLICY_VERSION, action: decision.action, focus: decision.focus, local: decision.local } });
    return decision;
  }

  // ---------- disputed marks ----------

  /**
   * Sets a mark aside because the learner disputes it. The attempt stops counting as evidence
   * in either direction, and a level change it caused is undone if the level is still where
   * that change left it. With `chatPath`, the tutor is told to look at the answer again.
   */
  /**
   * Where an attempt is kept: this topic, or, for a prerequisite check across topics, the topic
   * that holds the prerequisite.
   */
  private async findAttempt(dir: string, attemptId: string): Promise<{ dir: string; state: LearnerState; attempt: Attempt } | null> {
    const s = this.settings();
    const here = await this.store.loadState(dir, s.targetLevel);
    const a = here.attempts.find((x) => x.id === attemptId);
    if (a) return { dir, state: here, attempt: a };
    for (const ref of await this.store.listTopics()) {
      if (ref.dir === dir) continue;
      const st = await this.store.loadState(ref.dir, s.targetLevel);
      const b = st.attempts.find((x) => x.id === attemptId);
      if (b) return { dir: ref.dir, state: st, attempt: b };
    }
    return null;
  }

  /** Sets a mark aside. The returned state is always this topic's, for the screen showing it. */
  async dispute(dir: string, attemptId: string, chatPath?: string): Promise<{ state: LearnerState; changes: string[]; attempt: Attempt }> {
    const s = this.settings();
    const found = await this.findAttempt(dir, attemptId);
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
      await this.store.saveState(found.dir, state);
    }
    const mine = found.dir === dir ? state : await this.store.loadState(dir, s.targetLevel);
    if (chatPath) {
      const chat = await this.store.loadChat(chatPath);
      const record = sessionFor(chat, mine, (fmStr(chat.fm, "mode", "tutor") as Mode) || "tutor");
      record.disputed = attemptId;
      chat.fm.session = JSON.stringify(record);
      await this.store.saveChat(chatPath, chat);
    }
    return { state: mine, changes, attempt: a };
  }

  /**
   * A second opinion on a disputed bank answer, from the chat model with more thinking. Whatever
   * it says replaces the disputed mark; if the call fails the attempt stays set aside.
   */
  async regrade(dir: string, attemptId: string): Promise<{ state: LearnerState; attempt: Attempt; changes: string[]; usage: Usage }> {
    const found = await this.findAttempt(dir, attemptId);
    if (!found) throw new Error("That attempt is no longer on record.");
    const { state, attempt: a } = found;
    if (found.dir !== dir) throw new Error("This answer was marked in conversation, so there is no model answer to regrade it against. Ask the tutor to look again.");
    const q = (await this.store.loadQuestions(dir)).find((x) => x.id === a.questionId);
    if (!q) throw new Error("This answer was marked in conversation, so there is no model answer to regrade it against. Ask the tutor to look again.");
    const g = await this.grade(q, a.answer, true);
    a.result = g.grade === "again" ? "incorrect" : g.grade === "hard" ? "partial" : "correct";
    a.grading = "model";
    a.verification = "unverified";
    a.note = `Regraded after a dispute. ${g.feedback}`.trim();
    a.assumptions = "a second model judgement with more thinking, after the first mark was disputed";
    const changes = applyAttempt(state, a);
    await this.store.saveState(dir, state);
    return { state, attempt: a, changes, usage: g.usage };
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

  /**
   * Grades one free-text answer. A reply that cannot be read as a grade throws, so a failed
   * grading leaves the answer ungraded; it never becomes a wrong answer by default.
   */
  async grade(q: Question, answer: string, careful = false): Promise<{ grade: Grade; feedback: string; usage: Usage }> {
    const s = this.settings();
    // Marking maths wrongly is worse than spending a little more, so answers with symbols or
    // numbers in them go to the chat model. Plain-prose answers stay on the cheap one.
    const mathsy = /\$|\\[a-zA-Z]+|[=<>^]|\d/.test(`${q.answer} ${answer}`);
    const strong = careful || (s.smartRouting && mathsy);
    const res = await this.call({
      model: strong ? s.chatModel : s.utilityModel,
      effort: careful ? s.hardEffort || s.effort || undefined : strong ? s.effort || undefined : undefined,
      system: utilityPrompt(await this.store.skill("utility.md"), "grade"),
      input: `Question: ${q.question}\n\nModel answer: ${q.answer}\n${q.explanation ? `Explanation: ${q.explanation}\n` : ""}${q.rubric ? `Rubric: ${q.rubric}\n` : ""}\nLearner's answer: ${answer.trim() || "(blank)"}`,
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
    if (!["again", "hard", "good", "easy"].includes(String(o?.grade))) throw new ClaudeError("The answer could not be graded. It remains ungraded. Retry to check it.");
    const grade = o!.grade as Grade;
    return { grade, feedback: String(o?.feedback ?? ""), usage: res.usage };
  }
}

/**
 * Moves a level after a marked attempt, by the evidence rules alone. A right answer can lift
 * the level one step, up to what the recorded attempts support. A wrong unaided answer after
 * earlier success is a lapse, and lowers a level of 3 or more by one when it is repeated or
 * comes on a later day. Returns readable lines for what changed.
 */
export function applyAttempt(s: LearnerState, a: Attempt): string[] {
  const out: string[] = [];
  if (!(a.skill in s.names) || a.result === "ungraded" || a.verification === "disputed" || a.grading === "self") return out;
  const m = mastery(s, a.skill);
  const current = s.levels[a.skill] ?? null;
  const push = (line: string | null) => {
    if (line) out.push(line);
  };
  if (a.result === "correct" || a.result === "partial") {
    const next = current === null ? m.supported : Math.min(m.supported, current + 1);
    if (current === null || next > current) push(setLevel(s, a.skill, next, a.id, `the recorded attempts now support level ${next}`, a.timestamp));
    return out;
  }
  if (current === null) {
    push(setLevel(s, a.skill, a.result === "skipped" ? 0 : Math.min(1, m.supported), a.id, "first marked answer on this subskill", a.timestamp));
    return out;
  }
  const unaided = !a.assisted && !a.answerExposed;
  if (unaided && current >= 3 && m.evidence.lapse && (m.evidence.recentFailures >= 2 || m.evidence.delayedLapse)) {
    push(setLevel(s, a.skill, current - 1, a.id, m.evidence.delayedLapse ? "an unaided answer was wrong on a later day than the last success" : "two recent unaided answers were wrong", a.timestamp));
  }
  return out;
}

/** The next bank question: weakest subskill first, due cards before unseen ones, never one asked in this chat or already answered today. */
export function pickQuizQuestion(questions: Question[], s: LearnerState, asked: string[], today: string): Question | null {
  const seenToday = new Set(s.attempts.filter((a) => a.timestamp.slice(0, 10) === today).map((a) => a.questionId));
  const left = questions.filter((q) => !asked.includes(q.id));
  if (!left.length) return null;
  const level = (q: Question) => s.levels[q.subskill] ?? 0;
  const order = (q: Question) => (seenToday.has(q.id) ? 3 : s.cards[q.id] ? (s.cards[q.id].due <= today ? 0 : 2) : 1);
  return [...left].sort((a, b) => level(a) - level(b) || order(a) - order(b))[0];
}

/** Picks the texts that share the most words with the query, in their original order, within a word budget. */
export function bestExcerpts(texts: string[], query: string, maxWords: number): string[] {
  const stop = new Set("the a an and or of to in is it that this what was were you your for on with as at be do did how why when can could me my we i are not have has had about from".split(" "));
  const terms = new Set((query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !stop.has(w)));
  if (!terms.size) return [];
  const scored = texts
    .map((text, i) => {
      const found = new Set((text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => terms.has(w)));
      return { text, i, score: found.size };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i);
  const picked: { text: string; i: number }[] = [];
  let budget = maxWords;
  for (const x of scored) {
    const w = words(x.text);
    const text = w > budget ? x.text.split(/\s+/).slice(0, budget).join(" ") + " …" : x.text;
    if (budget < 12) break;
    picked.push({ text, i: x.i });
    budget -= Math.min(w, budget);
  }
  return picked.sort((a, b) => a.i - b.i).map((x) => x.text);
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

export { ACTION_LABEL };
export type { Action, Topic };
