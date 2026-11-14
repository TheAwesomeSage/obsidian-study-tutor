// The on-demand presentation gate: whether this turn should use something other than the
// tutor's text, and which existing module could show it. Plain code, no model call. It runs
// inside study turns only, so opening a topic, a note or a graph node never starts an activity.
//
// An interactive needs a reason: the learner asked for one, or the current task and a diagnosed
// difficulty call for one. An error alone is not a reason; the failed reasoning step is found
// first (diagnose-error), and only a repeated difficulty on an idea that the course marked as
// suited to manipulation is offered an interactive. The simplest sufficient format wins:
// text < worked example < diagram < simulation < game. An explicit request overrides the default.
// Pure functions, no Obsidian imports.

import type { Mode } from "./formats";
import { INTERACTIVE_KINDS, ModuleDescriptor, PRESENTATION_KINDS, PresentationKind } from "./visualcontract";

export interface ExplicitRequest {
  kind: PresentationKind;
  /** The learner's words, trimmed, for the record. */
  said: string;
}

const ASKING = /\b(show|give|draw|make|open|start|run|use|try|let me|let's|can (i|you|we)|could (i|you|we)|would you|i('d| would) like|i want|is there|do you have|please)\b/i;
const KIND_WORDS: [PresentationKind, RegExp][] = [
  ["external", /\b(phet|external (simulation|sim|activity)|existing simulation)\b/i],
  ["game", /\b(game|mini-?game|challenge me|target practice)\b/i],
  ["simulation", /\b(simulat\w*|animat\w*|interactive|play with|experiment with|manipulat\w*|sliders?)\b/i],
  ["diagram", /\b(diagrams?|draw (it|this|that|me)|sketch|picture|visuali[sz]\w*|plot (it|this|that)|graph (it|this|that))\b/i],
  ["worked-example", /\b(worked example|work(ed)? (me )?through an example|show me an example|an example step by step)\b/i],
  ["text", /\b(just explain|in words|text only|no (diagrams?|simulations?|visuals?|pictures?))\b/i],
];

/** An explicit request for a presentation format in the learner's message, or null. */
export function readPresentationRequest(message: string): ExplicitRequest | null {
  const m = message.trim();
  if (!m || m.length > 400) return null;
  for (const [kind, re] of KIND_WORDS) {
    if (!re.test(m)) continue;
    // "The diagram shows that…" inside an answer is not a request; "show me a diagram" is.
    const short = m.split(/\s+/).length <= 6;
    if (ASKING.test(m) || short || kind === "text") return { kind, said: m.slice(0, 200) };
  }
  return null;
}

const STOP = new Set("a an the and or of to in on for with by from as at is are be it its this that these those how what why when which who into onto over under than then so not no do does each every one two use using used show shows can will".split(" "));

const stem = (w: string): string => {
  if (w === "indices" || w === "indexes") return "index";
  if (/(ss|sh|ch|x)es$/.test(w)) return w.slice(0, -2);
  if (/ies$/.test(w) && w.length > 4) return w.slice(0, -3) + "y";
  if (/ing$/.test(w) && w.length > 5) return w.slice(0, -3);
  if (/ed$/.test(w) && w.length > 4) return w.slice(0, -2);
  if (/[^s]s$/.test(w) && w.length > 3) return w.slice(0, -1);
  return w;
};

/** Content words, lightly stemmed so "indices", "indexing" and "index" meet. */
export function terms(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z][a-z0-9]+/g) ?? []) {
    if (STOP.has(w) || w.length < 3) continue;
    out.add(stem(w));
  }
  return out;
}

export interface ModuleMatch {
  descriptor: ModuleDescriptor;
  /** The supported objective that matched. */
  phrase: string;
  score: number;
}

/**
 * Kinds a module renders: what it declares, otherwise inferred. The contract has no kinds field
 * yet, so an external-activity module (an id or objective naming PhET or "external") renders
 * "external", and any other module diagrams, simulations and games.
 */
export const moduleKinds = (d: ModuleDescriptor): PresentationKind[] => {
  if (d.kinds?.length) return d.kinds.filter((k) => PRESENTATION_KINDS.includes(k));
  if (/phet|external/i.test(`${d.id} ${d.supportedObjectives.join(" ")}`)) return ["external"];
  return ["diagram", "simulation", "game"];
};

/** Words too general to tie a note to a module on their own. */
const GENERIC = new Set(["value", "function", "number", "numeric", "result", "data", "time", "point", "step", "based", "zero", "first", "match", "matching", "source", "support", "constant", "equal", "selected"].map((w) => stem(w)));

/**
 * Modules that could show `text`, best first. A supported objective matches when at least two of
 * its specific words (or its only one) appear in the text, so "Binary search on sorted numbers"
 * matches a note on binary search over a sorted array. This is a shortlist, not a verdict: the
 * configuration step still has to fit the excerpt, and the module still validates the result.
 * Words of the concept's own name (`title`) count most, so a note on linear search over an
 * indexed array is matched to "Linear search", not to "array indexing".
 */
export function matchModules(text: string, kind: PresentationKind, descriptors: ModuleDescriptor[], preferred?: string, title = ""): ModuleMatch[] {
  const have = terms(text);
  const named = terms(title);
  const out: ModuleMatch[] = [];
  for (const d of descriptors) {
    if (!moduleKinds(d).includes(kind) && !(kind === "game" && moduleKinds(d).includes("simulation"))) continue;
    let best: { phrase: string; score: number } | null = null;
    for (const phrase of d.supportedObjectives) {
      const specific = [...terms(phrase)].filter((w) => !GENERIC.has(w));
      const found = specific.filter((w) => have.has(w)).length;
      if (!specific.length || found < Math.min(2, specific.length)) continue;
      const score = found + 2 * specific.filter((w) => named.has(w)).length + found / specific.length;
      if (!best || score > best.score) best = { phrase, score };
    }
    if (best) out.push({ descriptor: d, phrase: best.phrase, score: best.score + (d.id === preferred ? 10 : 0) + (moduleKinds(d)[0] === kind ? 0.5 : 0) });
  }
  return out.sort((a, b) => b.score - a.score || a.descriptor.id.localeCompare(b.descriptor.id));
}

export interface GateInput {
  mode: Mode;
  /** The policy's action this turn, when a policy ran (Adaptive, Learn). */
  action: string | null;
  /** The learner's message this turn. Empty when a chat is opened or the learner pressed Continue. */
  message: string;
  /** The concept's name and what it is about, for matching and for the request's objective. */
  objective: string;
  /** Source text the match may also use: the subskill section and note excerpts. */
  context: string;
  /** Unaided failures among the last three answers on the concept. */
  recentFailures: number;
  /** The latest error type on the concept ("conceptual", "procedural", …), or empty. */
  errorType: string;
  /** An unresolved misconception is recorded for the topic. */
  misconception: boolean;
  /** Visual eligibility the course recorded for this concept. Never a trigger on its own. */
  eligibility: { kind: string; reason: string } | null;
  descriptors: ModuleDescriptor[];
  /** Saved activities for this concept: ids, kinds, modules and status. */
  saved: { id: string; kind: PresentationKind; moduleId: string; status: "ready" | "unsupported" | "invalid" }[];
  preferredModuleId?: string;
}

export type GateStatus =
  /** Nothing changes: the turn's own action is the right format. */
  | "none"
  /** The tutor writes it in the reply (a worked example, or one small diagram). */
  | "text"
  /** A saved activity can be opened as it is, with no model call. */
  | "cached"
  /** A module fits but has no saved configuration: the local model configures it. */
  | "configure"
  /** Offered beside the reply; configured only if the learner opens it. */
  | "offer"
  /** No module can show this; a missing capability is recorded. */
  | "unsupported";

export interface PresentationDecision {
  kind: PresentationKind;
  trigger: "explicit" | "difficulty" | "tutor" | "none";
  status: GateStatus;
  /** Compact instructional reason for the interface, under 140 characters. */
  reason: string;
  moduleId: string | null;
  activityId: string | null;
  /** Module ids that matched, best first. */
  candidates: string[];
}

const NONE: PresentationDecision = { kind: "text", trigger: "none", status: "none", reason: "", moduleId: null, activityId: null, candidates: [] };
const clip = (s: string, n = 140): string => (s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…");

/** The modes whose turns may select a presentation without being asked. */
const AUTO_MODES: Mode[] = ["auto", "quiz", "tutor"];

/**
 * Chooses the presentation for one turn. `explicit` is the learner's own request, read by
 * readPresentationRequest; `tutorKind` is a kind the tutor proposed in its structured reply
 * field, which can only lead to an offer.
 */
export function choosePresentation(g: GateInput, explicit: ExplicitRequest | null, tutorKind: PresentationKind | null = null): PresentationDecision {
  const name = g.objective.split(/[:.\n]/)[0].trim() || "this";
  const find = (kind: PresentationKind) => {
    const candidates = matchModules(`${g.objective}\n${g.context}\n${g.message}`, kind, g.descriptors, g.preferredModuleId, name);
    const ids = candidates.map((c) => c.descriptor.id);
    const ready = g.saved.find((a) => a.status === "ready" && (a.kind === kind || (kind === "game" && a.kind === "simulation")) && (ids.includes(a.moduleId) || !ids.length));
    const failed = g.saved.find((a) => a.status !== "ready" && a.kind === kind);
    return { candidates, ids, ready, failed };
  };

  if (explicit) {
    const k = explicit.kind;
    if (k === "text") return { ...NONE, kind: "text", trigger: "explicit", status: "text", reason: "You asked for an explanation in words." };
    if (k === "worked-example") return { ...NONE, kind: k, trigger: "explicit", status: "text", reason: `You asked for a worked example on ${name}.` };
    const f = find(k);
    if (f.ready) return { kind: k, trigger: "explicit", status: "cached", reason: clip(`You asked for a ${k}; the saved one for ${name} opens with no model call.`), moduleId: f.ready.moduleId, activityId: f.ready.id, candidates: f.ids };
    if (f.candidates.length) return { kind: k, trigger: "explicit", status: "configure", reason: clip(`You asked for a ${k}; ${f.candidates[0].descriptor.id} can show ${f.candidates[0].phrase}.`), moduleId: f.candidates[0].descriptor.id, activityId: null, candidates: f.ids };
    // A diagram with no module behind it is still possible: the tutor draws a small one.
    if (k === "diagram") return { ...NONE, kind: k, trigger: "explicit", status: "text", reason: `You asked for a diagram of ${name}; the tutor draws it in the reply.` };
    return { ...NONE, kind: k, trigger: "explicit", status: "unsupported", reason: clip(`No ${k} module can show ${name} yet, so it is explained another way and the request is noted.`), activityId: f.failed?.id ?? null };
  }

  // Never on opening a chat or pressing Continue: an activity needs a reason in this turn.
  if (!g.message.trim()) return NONE;
  if (tutorKind && INTERACTIVE_KINDS.includes(tutorKind) && AUTO_MODES.includes(g.mode)) {
    const f = find(tutorKind);
    if (f.ready) return { kind: tutorKind, trigger: "tutor", status: "cached", reason: clip(`The tutor suggests a ${tutorKind} for ${name}; a saved one is ready.`), moduleId: f.ready.moduleId, activityId: f.ready.id, candidates: f.ids };
    if (f.candidates.length) return { kind: tutorKind, trigger: "tutor", status: "offer", reason: clip(`The tutor suggests a ${tutorKind} for ${name}.`), moduleId: f.candidates[0].descriptor.id, activityId: null, candidates: f.ids };
    return NONE;
  }
  if (!AUTO_MODES.includes(g.mode)) return NONE;

  const eligible = g.eligibility && PRESENTATION_KINDS.includes(g.eligibility.kind as PresentationKind) ? (g.eligibility.kind as PresentationKind) : null;
  // The step this turn takes. Master and Practise run no policy; there a reply follows an answer.
  const step = g.action ?? "check";
  // A difficulty counts only once it is repeated and its kind is known: two or more recent
  // unaided failures, with the failed step diagnosed as conceptual or a misconception recorded.
  // A first error, or a slip in arithmetic, gets a narrower question instead.
  const diagnosed = g.errorType === "conceptual" || (g.misconception && g.errorType !== "careless" && g.errorType !== "arithmetic" && g.errorType !== "notation");
  const repeated = g.recentFailures >= 2 && diagnosed;
  const helping = ["check", "diagnose-error", "re-explain", "worked-example", "guided-practice", "hint"].includes(step);
  // A stable structure the course marked for a diagram: drawn when the idea is explained again.
  if (eligible === "diagram" && repeated && helping) return { ...NONE, kind: "diagram", trigger: "difficulty", status: "text", reason: clip(`Another explanation of ${name}, drawn as a diagram this time.`) };
  if (!eligible || (eligible !== "simulation" && eligible !== "game") || !repeated || !helping) return NONE;
  const f = find(eligible);
  const why = g.eligibility!.reason ? `: ${g.eligibility!.reason}` : "";
  if (f.ready) return { kind: eligible, trigger: "difficulty", status: "cached", reason: clip(`The same idea in ${name} went wrong again; manipulating it may show why${why}`), moduleId: f.ready.moduleId, activityId: f.ready.id, candidates: f.ids };
  if (f.candidates.length) return { kind: eligible, trigger: "difficulty", status: "offer", reason: clip(`The same idea in ${name} went wrong again; manipulating it may show why${why}`), moduleId: f.candidates[0].descriptor.id, activityId: null, candidates: f.ids };
  return NONE;
}

/** What the tutor is told about this turn's presentation, in the part of the prompt that changes. Empty when nothing changes. */
export function presentationNote(d: PresentationDecision): string {
  if (d.status === "none") return "";
  if (d.status === "text" && d.kind === "diagram") return `Presentation: include one small Mermaid diagram that shows the structure (${d.reason})`;
  if (d.status === "text" && d.kind === "worked-example") return "Presentation: the learner asked for a worked example. Work one fully, each step justified, then ask them to try a similar one.";
  if (d.status === "text") return "Presentation: the learner wants this in words. No diagram.";
  if (d.status === "unsupported") return `Presentation: the learner asked for a ${d.kind}, and no interactive module can show this. Use the simplest representation that works here (a worked example, or one small Mermaid diagram if structure matters), and say in one line that an interactive version is not available.`;
  return `Presentation: an interactive ${d.kind} on this is offered to the learner beside your reply (${d.reason}). Do not describe its controls or its answer. You may point to it in one sentence.`;
}

/** The structured field the tutor may add in a reply it is writing anyway. */
export const PRESENT_RULE = 'If an interactive would clearly help with the failed step (manipulating a changing quantity, tracing execution over time), you may add <present>{"kind":"simulation|game|diagram","reason":"under 15 words"}</present>. The app decides whether one exists; never describe one that has not been offered.';

/** Reads and removes the tutor's <present> field. An unknown kind is dropped. */
export function extractPresent(text: string): { text: string; kind: PresentationKind | null; reason: string } {
  let kind: PresentationKind | null = null;
  let reason = "";
  const clean = text
    .replace(/`{0,3}\s*<present>([\s\S]*?)<\/present>\s*`{0,3}/g, (_all, raw: string) => {
      try {
        const v = JSON.parse(raw);
        if (v && PRESENTATION_KINDS.includes(v.kind)) {
          kind = v.kind;
          reason = typeof v.reason === "string" ? v.reason.slice(0, 120) : "";
        }
      } catch {
        /* a malformed field is dropped */
      }
      return "";
    })
    .trim();
  return { text: clean, kind, reason };
}
