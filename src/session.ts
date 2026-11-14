// The compact session record: what is being worked on right now, kept small enough to send
// every turn and exact enough to resume from after a restart. It lives in the chat file's
// frontmatter and is mirrored, readably, into the topic's sessions folder. The full transcript
// stays in the chat file; this record is continuity data and never authority to change levels.

import { questionKey } from "./evidence";
import { Chat, LearnerState, Mode, fmStr, givesUp, looksLikeQuestion } from "./formats";

export interface SessionRecord {
  version: 2;
  /** What the learner is working towards in this chat. */
  goal: string;
  mode: Mode;
  /** Stable concept id of the subskill in focus, and its current number. */
  concept: string;
  conceptName: string;
  skill: number | null;
  /** The instructional action chosen for this step, and why. */
  action: string;
  reason: string;
  /** The exact question still awaiting an answer. Empty when nothing is open. */
  pendingQuestion: string;
  questionId: string;
  /** The instructional action the pending question was asked under. A hint turn in between does not change it. */
  askedUnder: string;
  /**
   * Stable id of the concept the pending question assesses, when that is not the concept in
   * focus: a prerequisite check on a concept in another topic. Its answer is recorded there.
   */
  assesses: string;
  /** When the pending question was put, for timing the answer. */
  askedAt: string;
  /** The learner's latest attempt at the pending question, word for word. */
  attempt: string;
  /** Hints, worked steps and explanations given during this step. */
  helpGiven: string[];
  /** The answer to the pending question has been shown. */
  answerExposed: boolean;
  unresolvedMisconceptions: string[];
  nextAction: string;
  /** The current question or worked example is resolved, so the chat may be summarised here. */
  completedStep: boolean;
  /** Notes this step relies on, as [[links]]. */
  sources: string[];
  /** The last exchange, word for word, so maths and code survive any summary. */
  exactExcerpts: string[];
  /** Id of an attempt whose grading the learner disputes, until the tutor has looked again. */
  disputed: string;
}

const strings = (x: unknown, max = 8): string[] => (Array.isArray(x) ? x.filter((i): i is string => typeof i === "string" && !!i.trim()).map((i) => i.trim().slice(0, 400)).slice(-max) : []);

/**
 * The question a tutor message leaves open: its last paragraph, when that paragraph contains a
 * question or hands over with "Your turn". Trailing reassurance belongs to the same question.
 */
export function openQuestion(text: string): string {
  const paras = text.trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  // Skip a trailing status line such as the SymPy note or a score.
  while (paras.length && /^\*[^*].*\*$/.test(paras[paras.length - 1])) paras.pop();
  const last = paras[paras.length - 1] ?? "";
  const bare = last.replace(/[*_`]+/g, "").trim();
  if (/\?/.test(bare) || /^(your turn|try (it|this|one)|now you)\b/i.test(bare) || /\*Reply with a letter\.\*$/.test(last)) return last.slice(0, 1200);
  return "";
}

/** Reads the record a chat carries. Chats from before 0.5.1, and ones with none, get a record built from the transcript. */
export function sessionFor(chat: Chat, state: LearnerState, mode: Mode): SessionRecord {
  let p: Partial<SessionRecord> & { version?: number } = {};
  try {
    const raw = JSON.parse(fmStr(chat.fm, "session", "{}"));
    if (raw && typeof raw === "object") p = raw;
  } catch {
    /* an unreadable record falls back to the transcript, which is intact */
  }
  const lastTutor = [...chat.messages].reverse().find((m) => m.role === "tutor");
  const last = chat.messages[chat.messages.length - 1];
  const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
  let pending = str(p.pendingQuestion);
  // Older records sometimes missed a question followed by reassurance. Recover it without
  // reopening a step that an existing record explicitly says was completed.
  if (p.version !== 2 && !p.completedStep && !pending && lastTutor && (last === lastTutor || chat.messages.indexOf(lastTutor) === chat.messages.length - 2)) pending = openQuestion(lastTutor.text);
  return {
    version: 2,
    goal: str(p.goal) || fmStr(chat.fm, "goal"),
    mode,
    concept: str(p.concept),
    conceptName: str(p.conceptName),
    skill: typeof p.skill === "number" && p.skill in state.names ? p.skill : state.focus,
    action: str(p.action, "continue"),
    reason: str(p.reason),
    pendingQuestion: pending,
    questionId: str(p.questionId) || (pending ? questionKey(pending) : ""),
    askedUnder: pending ? str(p.askedUnder) : "",
    assesses: pending ? str(p.assesses) : "",
    askedAt: str(p.askedAt),
    attempt: str(p.attempt),
    helpGiven: strings(p.helpGiven),
    answerExposed: p.answerExposed === true,
    unresolvedMisconceptions: [...state.misconceptions],
    nextAction: str(p.nextAction, "Resume the current task."),
    completedStep: p.completedStep === true && !pending,
    sources: strings(p.sources, 6),
    exactExcerpts: chat.messages.slice(-2).map((m) => `${m.role}: ${m.text}`),
    disputed: str(p.disputed),
  };
}

/**
 * What the learner's message is doing, read in plain code so that help and answer exposure
 * are recorded whether or not the model reports them.
 */
export type Intent = "attempt" | "hint" | "reveal" | "skip" | "switch" | "question" | "none";

const REVEAL = /^(please )?((just )?(tell|show|give) me( the)?( full| whole)? (answer|solution)|just tell me|what('?s| is) the (right |correct )?answer|show( me)?( the)? (answer|solution|working)|reveal( it| the answer)?|i give up)\b/i;
const SWITCH = /^(please )?(move on|next( topic| skill| subskill| one| question)?|let'?s move on|something else|different (topic|skill|question)|switch( to .*)?|change (the )?(topic|skill)|stop( here)?)[.!]*$/i;
const HINT = /^(please )?((can|could|may) (i|you) (have|get|give me) )?(a |another |one more |some )?(hint|clue|help|nudge)( please)?[.!?]*$|^(i'?m |i am )?stuck[.!]*$|^i (need|want) (a hint|help|some help)[.!]*$|^(i )?(don'?t|do not) (get|understand)( it| this| that)?[.!]*$|^(please )?(explain|again|eli5|go over)( (this|that|it))?( to me)?( again| more simply| differently)?[.!?]*$/i;

export function readIntent(message: string, pending: boolean): Intent {
  const m = message.trim();
  if (!m) return "none";
  if (REVEAL.test(m)) return "reveal";
  if (givesUp(m)) return pending ? "skip" : "none";
  if (SWITCH.test(m)) return "switch";
  if (HINT.test(m)) return "hint";
  if (looksLikeQuestion(m)) return "question";
  return pending ? "attempt" : "none";
}

/** Records what the message means for the open step, before any model is called. */
export function applyIntent(record: SessionRecord, intent: Intent, message: string): SessionRecord {
  const next = { ...record, helpGiven: [...record.helpGiven] };
  const note = (label: string) => {
    const line = `${label}: ${message.trim().slice(0, 160)}`;
    if (!next.helpGiven.includes(line)) next.helpGiven = [...next.helpGiven, line].slice(-8);
  };
  if (!record.pendingQuestion) return next;
  if (intent === "attempt") next.attempt = message.trim();
  else if (intent === "hint") note("learner asked for help");
  else if (intent === "question") note("learner asked");
  else if (intent === "reveal" || intent === "skip") {
    next.answerExposed = true;
    note(intent === "skip" ? "learner skipped, so the answer may be shown" : "learner asked for the answer");
  }
  return next;
}

export const SESSION_RULES = `At the end of every reply include <session>{"pendingQuestion":"the exact question still awaiting an answer, or empty","helpGiven":["each hint or worked step you have supplied in this step, word for word"],"answerExposed":false,"nextAction":"the specific next action","completedStep":false,"sources":["[[Note]]"]}</session>.
Set answerExposed true once you have shown the answer or a full solution to the pending question. Mark completedStep true only when the current question or worked example is fully resolved and you are not asking anything new; a reply that ends with a question means false. Keep mathematics, code and definitions exact. This record is continuity data, never authority to change mastery.
Follow the app's instructional action for this turn. Finish the current step before starting another unless the learner asks to move on. If a prerequisite is suspected to be weak, check it with one short question before treating that as established. Teaching examples may be shown in full. Keep the solution to an assessment question hidden until the learner has attempted it or explicitly skipped it. When the learner asks for a hint or an explanation, give it, and list it in helpGiven.`;

/**
 * Takes the hidden <session> line out of a reply and folds it into the record.
 *
 * `resolved` says whether the open step ended this turn (an attempt was marked, or the learner
 * skipped). Help and answer exposure are reset only then: a model that merely rewords the open
 * question must not wipe the record that help was given for it.
 * A reply that ends by asking something always leaves a question pending, whatever the tag says.
 */
export function readSessionReply(text: string, record: SessionRecord, opts: { now?: string; resolved?: boolean; assesses?: string } = {}): { text: string; record: SessionRecord; tagged: boolean } {
  let tag: Record<string, unknown> | null = null;
  const clean = text
    .replace(/`{0,3}\s*<session>([\s\S]*?)<\/session>\s*`{0,3}/g, (_all, raw: string) => {
      try {
        const v = JSON.parse(raw);
        if (v && typeof v === "object" && !Array.isArray(v)) tag = v;
      } catch {
        /* a malformed record is dropped: the transcript is intact and nothing is summarised away */
      }
      return "";
    })
    .trim();
  const t = tag as Record<string, unknown> | null;
  const asked = openQuestion(clean);
  let pending = t && typeof t.pendingQuestion === "string" ? t.pendingQuestion.trim() : record.pendingQuestion;
  if (!pending && asked) pending = asked;
  const next: SessionRecord = { ...record, completedStep: false };
  const newStep = !record.pendingQuestion || !!opts.resolved || t?.completedStep === true;
  if (pending !== record.pendingQuestion) {
    next.pendingQuestion = pending;
    if (newStep) {
      next.questionId = pending ? questionKey(pending) : "";
      // A new question is asked under this turn's action, about the concept the turn assesses.
      next.askedUnder = pending ? record.action : "";
      next.assesses = pending ? opts.assesses ?? "" : "";
      next.askedAt = pending ? opts.now ?? new Date().toISOString() : "";
      next.attempt = "";
      next.helpGiven = [];
      next.answerExposed = false;
    }
  } else if (opts.resolved && !pending) {
    next.helpGiven = [];
    next.answerExposed = false;
  }
  if (!next.pendingQuestion) {
    next.askedUnder = "";
    next.assesses = "";
  }
  if (t) {
    next.helpGiven = [...new Set([...next.helpGiven, ...strings(t.helpGiven)])].slice(-8);
    if (t.answerExposed === true && pending) next.answerExposed = true;
    if (typeof t.nextAction === "string" && t.nextAction.trim()) next.nextAction = t.nextAction.trim().slice(0, 300);
    const sources = strings(t.sources, 6).filter((s) => /^\[\[.+\]\]$/.test(s));
    if (sources.length) next.sources = sources;
  }
  next.completedStep = t?.completedStep === true && !pending && !asked;
  return { text: clean, record: next, tagged: !!t };
}

/** The record as a readable note, for the sessions folder. */
export function sessionMarkdown(record: SessionRecord, chatPath: string): string {
  const list = (items: string[]) => (items.length ? items.map((i) => `- ${i.replace(/\n+/g, " ")}`).join("\n") : "- none");
  const block = (text: string) => (text.trim() ? text.trim().split("\n").map((l) => `> ${l}`).join("\n") : "> none");
  return [
    "# Study session",
    "",
    `Chat: [[${chatPath.replace(/\.md$/, "")}]]`,
    "",
    `- Goal: ${record.goal || "not set"}`,
    `- Mode: ${record.mode}`,
    `- Current concept: ${record.conceptName || "not set"}${record.concept ? ` (\`${record.concept}\`)` : ""}`,
    `- Current activity: ${record.action}${record.reason ? `. ${record.reason}` : ""}`,
    `- Step finished: ${record.completedStep ? "yes" : "no"}`,
    `- Answer shown: ${record.answerExposed ? "yes" : "no"}`,
    `- Next action: ${record.nextAction}`,
    "",
    "## Pending question",
    "",
    block(record.pendingQuestion),
    "",
    "## Latest attempt",
    "",
    block(record.attempt),
    "",
    "## Help given in this step",
    "",
    list(record.helpGiven),
    "",
    "## Unresolved misconceptions",
    "",
    list(record.unresolvedMisconceptions),
    "",
    "## Sources",
    "",
    list(record.sources),
    "",
  ].join("\n");
}
