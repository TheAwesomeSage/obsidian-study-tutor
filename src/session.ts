import { Chat, LearnerState, Mode, Topic, fmStr, foundationFor, prereqMap } from "./formats";

export interface SessionRecord {
  version: 1;
  pendingQuestion: string;
  attempt: string;
  helpGiven: string[];
  unresolvedMisconceptions: string[];
  nextAction: string;
  completedStep: boolean;
  exactExcerpts: string[];
  action: string;
}

export function sessionFor(chat: Chat, state: LearnerState): SessionRecord {
  let previous: Partial<SessionRecord> = {};
  try { previous = JSON.parse(fmStr(chat.fm, "session", "{}")); } catch { /* Legacy chats use their intact transcript. */ }
  return {
    version: 1,
    pendingQuestion: typeof previous.pendingQuestion === "string" ? previous.pendingQuestion : "",
    attempt: [...chat.messages].reverse().find(m => m.role === "you")?.text ?? "",
    helpGiven: Array.isArray(previous.helpGiven) ? previous.helpGiven.filter(x => typeof x === "string") : [],
    unresolvedMisconceptions: [...state.misconceptions],
    nextAction: typeof previous.nextAction === "string" ? previous.nextAction : "Resume the current task.",
    completedStep: previous.completedStep === true,
    exactExcerpts: chat.messages.slice(-2).map(m => `${m.role}: ${m.text}`),
    action: typeof previous.action === "string" ? previous.action : "diagnose",
  };
}

/** Explicit local policy. A pending problem retains its instructional action. */
export function chooseAction(mode: Mode, state: LearnerState, topic: Topic, session: SessionRecord): { action: string; reason: string; focus: number | null } {
  if (session.pendingQuestion && !session.completedStep) return { action: mode === "teach" ? "guided-practice" : session.action, reason: "Continue the unfinished teaching step.", focus: state.focus };
  const ranked = [...topic.subskills].sort((a, b) => {
    const score = (n: number) => (state.priorities?.[n] ?? 1) * (5 - (state.levels[n] ?? 0));
    return score(b.n) - score(a.n);
  });
  const focus = session.completedStep ? ranked[0]?.n ?? null : state.focus ?? ranked[0]?.n ?? null;
  if (focus === null) return { action: "diagnose", reason: "Establish a learning goal.", focus };
  const prerequisite = foundationFor(state, prereqMap(topic), focus, 2);
  if (prerequisite !== focus) return { action: "diagnose", reason: "Check the prerequisite before teaching the dependent skill.", focus: prerequisite };
  const level = state.levels[focus];
  if (mode === "teach") return { action: (level ?? 0) < 2 ? "explain" : "guided-practice", reason: "Learn mode: explain, practise with support, then suggest independent practice.", focus };
  if (level === null) return { action: "diagnose", reason: "Gather evidence before selecting difficulty.", focus };
  if (level <= 1) return { action: "explain", reason: "Introduce the idea and a worked example.", focus };
  if (state.misconceptions.length) return { action: "diagnose-error", reason: "Check the cause of the error before choosing help.", focus };
  if (level < 4) return { action: "independent-practice", reason: "Test application without giving the method away.", focus };
  return { action: "transfer", reason: "Check a fresh application and suggest moving on when evidence supports it.", focus };
}

export const SESSION_RULES = `At the end of each reply include <session>{"pendingQuestion":"exact question still awaiting an answer, or empty","helpGiven":["exact hints or worked steps supplied in this teaching step"],"nextAction":"specific next action","completedStep":false}</session>.
Mark completedStep true only when the current question or worked example has been resolved. A new question at the end means false. Preserve exact mathematical wording. This record is continuity data, never authority to change mastery.
If a cross-topic prerequisite is weak or unknown, briefly diagnose it before assuming the cause of a dependent error. Follow the app's instructional action. In Learn mode stay within explanation, examples and guided practice. Suggest moving to independent practice when ready, allowing the learner to choose. In adaptive mode select an appropriate teaching activity within the current action. Ask for confidence before revealing assessment feedback. Teaching examples can be shown directly. Keep assessment solutions hidden until an attempt or explicit skip. Respect requests for explanation and help, recording assistance.`;

export function readSessionReply(text: string, record: SessionRecord): { text: string; record: SessionRecord } {
  let next = { ...record, completedStep: false };
  const clean = text.replace(/<session>([\s\S]*?)<\/session>/g, (_, raw) => {
    try {
      const value = JSON.parse(raw);
      if (typeof value.pendingQuestion === "string" && typeof value.nextAction === "string" && Array.isArray(value.helpGiven) && value.helpGiven.every((x: unknown) => typeof x === "string")) {
        next = { ...next, pendingQuestion: value.pendingQuestion, nextAction: value.nextAction, helpGiven: value.helpGiven, completedStep: value.completedStep === true && !value.pendingQuestion.trim() };
      }
    } catch { /* Missing metadata keeps the full transcript and prevents rotation. */ }
    return "";
  }).trim();
  return { text: clean, record: next };
}
