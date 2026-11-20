// What the engine and the files split out of it share: the settings and result types, the
// small helpers that read a chat, and the rules that move a level or pick a question. No
// Obsidian imports.

import { Usage } from "./claude";
import { daysBetween as dayGap } from "./dates";
import type { ModelProviderSettings } from "./model-provider";
import { Attempt, Grading, TASK_TYPES, TaskType } from "./evidence";
import { Chat, Frontmatter, LearnerState, Mode, Question, SourceMode, Topic, fmStr, mastery, setLevel, words } from "./formats";
import { ACTION_LABEL, Action, Decision, PolicyWeights, PrereqCheck } from "./policy";
import { ActivityRecord } from "./configure";
import { type CompileMetrics, type ExpansionRequest as CompileExpansionRequest } from "./compiler";
import type { ResearchLimits } from "./compile-research";
import type { SourceRevision } from "./compile-sources";
import { PresentationDecision } from "./presentation";
import { GenerationResult, ModuleRegistry, PresentationRequest, VisualLesson } from "./visualcontract";
import { GRADE_SCHEMA } from "./prompts";
import { Route } from "./router";
import { ToolResult } from "./tools";
import { REASONING_SCHEMA } from "./reasoning";
import { MoveDecision } from "./tutormove";
import { Depth } from "./lessondepth";
import { ExpansionRecord } from "./expansion";
import { questionFamilies } from "./coursepkg";
import { baseQuestionId } from "./families";

/** The grading schema with the reasoning breakdown added. Only the overall mark is required, so a grader that gives no breakdown is read as before. */
export const GRADE_REASONING_SCHEMA = { ...GRADE_SCHEMA, properties: { ...GRADE_SCHEMA.properties, reasoning: REASONING_SCHEMA } };

/** A registry with no modules, for code decisions when the host has none. */
export const NO_MODULES: ModuleRegistry = { listModuleDescriptors: () => [], validateLesson: () => ({ ok: false, errors: ["no modules are installed"] }), assessLesson: () => ({ correct: null, score: null, feedback: "", status: "invalid", detail: {} }), listAssets: () => [], catalogVersion: () => "none", createVariant: () => null };

export const PREREQ_RESULTS: PrereqCheck[] = ["asked", "correct", "partial", "incorrect", "skipped", "ungraded", "taught"];

/** Outside prerequisite checks this chat has made, by prerequisite id. */
export function prereqChecks(chat: Chat): Record<string, PrereqCheck> {
  try {
    const v = JSON.parse(fmStr(chat.fm, "prereq_checks", "{}"));
    const out: Record<string, PrereqCheck> = {};
    if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, r] of Object.entries(v)) if (PREREQ_RESULTS.includes(r as PrereqCheck)) out[k] = r as PrereqCheck;
    return out;
  } catch {
    return {};
  }
}

export function setPrereqCheck(chat: Chat, id: string, result: PrereqCheck): void {
  chat.fm.prereq_checks = JSON.stringify({ ...prereqChecks(chat), [id]: result });
}

/**
 * The kind of task an answered question was. The app knows when it set the question under an
 * action; in the modes where the tutor chooses its own questions, the tutor's label is the only
 * record, as with transfer. A transfer still needs the tutor to confirm the problem was fresh.
 */
export function taskTypeFor(askedUnder: string, mode: Mode, tag: Record<string, unknown> | null): TaskType | "" {
  if (askedUnder === "transfer") return tag?.transfer === true ? "transfer" : "application";
  const set: Record<string, TaskType> = { "teach-back": "teach-back", "edge-case": "edge-case", retrieval: "recall", "independent-practice": "application", "guided-practice": "application" };
  if (set[askedUnder]) return set[askedUnder];
  const claimed = tag && typeof tag.task_type === "string" ? tag.task_type : "";
  if ((mode === "tutor" || mode === "quiz") && TASK_TYPES.includes(claimed as TaskType) && claimed !== "interactive" && claimed !== "transfer") return claimed as TaskType;
  if (askedUnder.startsWith("diagnose")) return "application";
  return "";
}

export interface EngineSettings extends ModelProviderSettings {
  effort: string;
  targetLevel: number;
  maxChatWords: number;
  maxTopicWords: number;
  singlePassWords: number;
  researchLimits?: Partial<ResearchLimits>;
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
  /** Plan diagrams and simulations at compile time with the main provider ("main" compile strategy only). Default on. */
  compileBlueprints?: boolean;
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
  /** The subskill the activity is about, so an offer is opened for that concept. Null when unknown. */
  concept: number | null;
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
  /** Master mode: the move code chose, its reason code and evidence, and the move the tutor said it made. */
  move?: MoveDecision & { chosen: string };
  /** How deep this turn went (the card, or the lesson with its sources), why, and what the course is missing. */
  depth?: Depth & { missing: string[] };
  /** A request for linked material made this turn, or one whose result this turn used. */
  expansion?: ExpansionRecord;
  /** Requests about misconceptions or material that could not be honoured, for Details. */
  notes?: string[];
}

export interface TurnOpts {
  attached?: Material;
  onSpawn?: (kill: () => void) => void;
  /** The learner's stated confidence in this answer, 0 to 1, given before feedback. Null when not given. */
  confidence?: number | null;
}

/** How many times one turn may ask SymPy to compute before it must answer. */
export const COMPUTE_ROUNDS = 2;
/** How long a typed answer waits for SymPy's first download before it goes to the model instead. */
export const FIRST_CHECK_WAIT_MS = 20000;
/** A gap longer than this between question and answer is the learner being away, not thinking time. */
export const MAX_ANSWER_SECONDS = 3600;

/** True when a topic card contains enough notation for maths checking to be worth its prompt. */
export const looksMathematical = (card: string): boolean => (card.match(/\$[^$\n]+\$/g) ?? []).length >= 3 || /\\(frac|int|sum|sqrt|partial|mathbf|begin\{)/.test(card);

export interface Material {
  name: string;
  text: string;
  path?: string;
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
  signal?: AbortSignal;
  truncated?: boolean;
  expansion?: CompileExpansionRequest;
  savedSources?: SourceRevision[];
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
  status?: "complete" | "partial";
  metrics?: CompileMetrics;
  preservedCourse?: string;
}

export const MODE_NAME: Record<Mode, string> = { auto: "Adaptive", teach: "Learn", quiz: "Practise", tutor: "Master", expert: "Ask" };
export const TEACHING: string[] = ["explain", "worked-example", "re-explain"];
export const ERROR_TYPES = ["conceptual", "procedural", "arithmetic", "notation", "prerequisite", "careless"];
/** The learner is pointing back at something said before this part of the chat. */
export const LOOKS_BACK = /\b(earlier|before|previous(ly)?|last time|you said|you told|we (did|covered|talked|discussed|went over)|remind me|go back|at the start)\b/i;

export const daysBetween = (from: string, to: string): number => Math.max(0, dayGap(from, to));

/** What kind of evidence a SymPy comparison is, read from how it reached its verdict. */
export function equivalenceKind(detail: string): { grading: Grading; assumptions: string } {
  if (/test point|they differ at/.test(detail)) return { grading: "numeric", assumptions: "compared at random test points; strong evidence, not a proof" };
  if (/digits given|values differ|decimal places/.test(detail)) return { grading: "numeric", assumptions: "compared to the decimal places written" };
  return { grading: "symbolic", assumptions: "compared by simplifying the difference, with symbols standing for any value" };
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

/** What a bank question is for: practice, a delayed check of what was learnt, or a fresh application. */
export type BankPurpose = "practice" | "retrieval" | "transfer";

/**
 * The next bank question: weakest subskill first, due cards before unseen ones, never one asked
 * in this chat or already answered today. Practice never takes a question from a family kept
 * for assessment (questionFamilies). A retrieval check may, but only when nothing else is left.
 * A transfer check takes a kept family the learner has not met first, then any family they have
 * not met, since only an unmet family can show transfer. A question with a generator may come
 * back up to three times in a chat, each time with new numbers (bankvariants.ts).
 */
export function pickQuizQuestion(questions: Question[], s: LearnerState, asked: string[], today: string, opts: { purpose?: BankPurpose; only?: (q: Question) => boolean } = {}): Question | null {
  const purpose = opts.purpose ?? "practice";
  const met = new Set(s.attempts.map((a) => baseQuestionId(a.questionId)));
  const kept = new Set<string>();
  const unmet = new Set<string>();
  for (const f of questionFamilies(questions)) {
    if (f.reserved) f.questions.forEach((id) => kept.add(id));
    if (!f.questions.some((id) => met.has(id))) f.questions.forEach((id) => unmet.add(id));
  }
  const seenToday = new Set(s.attempts.filter((a) => a.timestamp.slice(0, 10) === today).map((a) => baseQuestionId(a.questionId)));
  const times = (q: Question) => asked.filter((id) => baseQuestionId(id) === q.id).length;
  const left = questions.filter((q) => times(q) < (q.generator ? 3 : 1) && (!opts.only || opts.only(q)) && (purpose !== "practice" || !kept.has(q.id)));
  if (!left.length) return null;
  const level = (q: Question) => s.levels[q.subskill] ?? 0;
  const fresh = (q: Question) => (purpose === "transfer" ? (unmet.has(q.id) ? (kept.has(q.id) ? 0 : 1) : 2) : kept.has(q.id) ? 1 : 0);
  const order = (q: Question) => (seenToday.has(q.id) ? 3 : s.cards[q.id] ? (s.cards[q.id].due <= today ? 0 : 2) : 1);
  return [...left].sort((a, b) => level(a) - level(b) || fresh(a) - fresh(b) || order(a) - order(b))[0];
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
