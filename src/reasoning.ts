// The outcome of an open answer kept apart from the reasoning behind it. A rubric is split into
// what it checks (the result, the method, the material assumptions), the grader judges each, and
// the earliest supported error is named when the work shows one. A SymPy check is recorded beside
// the judgement, labelled with exactly what it evaluated and under which assumptions: it can
// support the result it compared and nothing else, never the method.
//
// The overall mark (correct, partial, incorrect, ungraded) is decided as before. This adds a
// breakdown to it; exact answers, multiple choice and older attempts carry no breakdown.

export type ResultVerdict = "correct" | "partial" | "incorrect" | "unclear";
export type MethodVerdict = "sound" | "flawed" | "missing" | "unclear" | "not-assessed";
export type AssumptionVerdict = "sound" | "unstated" | "wrong" | "none-needed" | "unclear" | "not-assessed";
/**
 * complete       the work shown is enough to judge every dimension
 * incomplete     the learner stopped short or left steps out, so some of it cannot be judged
 * uncheckable    the answer cannot be judged from what is here (unreadable, off the question)
 */
export type Certainty = "complete" | "incomplete" | "uncheckable";
export type Dimension = "result" | "method" | "assumptions";

export interface SymbolicCheck {
  /** Exactly what SymPy compared, for example "final answer 1/4 against expected 1/4". */
  evaluated: string;
  kind: "symbolic" | "numeric";
  /** True: equal. False: not equal. Null: SymPy could not decide. */
  outcome: boolean | null;
  /** The domain and assumptions the comparison worked under. */
  assumptions: string;
}

export interface ReasoningAssessment {
  v: 1;
  result: { verdict: ResultVerdict; by: "model" | "symbolic" | "numeric"; note: string };
  method: { verdict: MethodVerdict; note: string };
  assumptions: { verdict: AssumptionVerdict; items: string[] };
  /** The first step that goes wrong, when the work supports naming one. */
  earliestError: { step: string; kind: string; why: string } | null;
  certainty: Certainty;
  /** Each rubric point, the dimension it checks, and whether the answer meets it. */
  rubric: { point: string; dimension: Dimension; met: "yes" | "no" | "unclear" }[];
  /** SymPy's comparisons, kept apart from the grader's judgement. */
  checks: SymbolicCheck[];
  /** The grader's verdict on the result, when SymPy decided it differently. */
  gradedResult?: ResultVerdict;
}

const RESULTS: ResultVerdict[] = ["correct", "partial", "incorrect", "unclear"];
const METHODS: MethodVerdict[] = ["sound", "flawed", "missing", "unclear", "not-assessed"];
const ASSUMPTIONS: AssumptionVerdict[] = ["sound", "unstated", "wrong", "none-needed", "unclear", "not-assessed"];
const CERTAINTIES: Certainty[] = ["complete", "incomplete", "uncheckable"];
const ERROR_KINDS = ["conceptual", "procedural", "arithmetic", "notation", "prerequisite", "careless", "assumption"];

const ASSUMPTION_WORDS = /\b(assum\w*|condition\w*|domain|provided|valid (only )?(if|when)|only (if|when)|non-?zero|positive|negative|continuous|differentiable|converg\w*|bounded|sorted|independent|finite|defined|restrict\w*|edge case|special case|case where)\b/i;
const METHOD_WORDS = /\b(method|because|explain\w*|justif\w*|reason\w*|shows?|show(ing)? (that|why)|derive\w*|uses?|using|applies|apply\w*|step\w*|by (the|a|using)|rule|why|how|approach|argument|proof|prove\w*|identif\w*|sets? up|expand\w*|substitut\w*|factori[sz]\w*)\b/i;
const RESULT_WORDS = /\b(answer|result|value|final|states?|gives?|equals?|obtains?|correct (value|number|answer)|answers?|output|returns?)\b|=|\d/i;

/**
 * Splits a rubric ("2 to 4 short points separated by semicolons") into points and the dimension
 * each one checks. An assumption point is one about conditions or domain; a method point is one
 * about how or why; the rest are about the result. Deterministic, so the same rubric always maps
 * the same way.
 */
export function rubricDimensions(rubric: string): { point: string; dimension: Dimension }[] {
  return rubric
    .split(/;|\n/)
    .map((p) => p.replace(/^\s*[-*\d.)]+\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((point) => ({ point: point.slice(0, 200), dimension: ASSUMPTION_WORDS.test(point) ? "assumptions" : METHOD_WORDS.test(point) && !/^(states?|gives?) (the )?(final )?(answer|result|value)\b/i.test(point) ? "method" : RESULT_WORDS.test(point) ? "result" : "method" }));
}

/** The rubric, grouped by dimension, as the grader is shown it. */
export function rubricBrief(rubric: string): string {
  const d = rubricDimensions(rubric);
  if (!d.length) return "";
  const group = (k: Dimension) => d.filter((x) => x.dimension === k).map((x) => x.point);
  return (["result", "method", "assumptions"] as Dimension[]).filter((k) => group(k).length).map((k) => `- ${k}: ${group(k).join("; ")}`).join("\n");
}

/** What the grader is asked to add to its overall mark. Short, because it goes with every graded open answer. */
export const REASONING_RULE = `Judge three things separately as well as the overall grade: the result (is the final answer right), the method (is the reasoning that reaches it valid), and the material assumptions (are conditions it depends on stated and right). A right result can come from a flawed method, and a sound method can end in a late slip. Name the earliest step that goes wrong when the work shows one, quoting it briefly. When the work shown is not enough to judge something, say "unclear" and set certainty to incomplete; do not guess.`;

export const REASONING_SCHEMA = {
  type: "object",
  properties: {
    result: { type: "string", enum: RESULTS },
    method: { type: "string", enum: METHODS },
    method_note: { type: "string" },
    assumptions: { type: "string", enum: ASSUMPTIONS },
    assumption_items: { type: "array", items: { type: "string" } },
    earliest_error: { type: "object", properties: { step: { type: "string" }, kind: { type: "string" }, why: { type: "string" } } },
    certainty: { type: "string", enum: CERTAINTIES },
    rubric_met: { type: "array", items: { type: "string", enum: ["yes", "no", "unclear"] } },
  },
};

const pick = <T extends string>(v: unknown, list: T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
const text = (v: unknown, n: number): string => (typeof v === "string" ? v.trim().slice(0, n) : "");

/**
 * Reads the grader's breakdown, from a grading call or a tutor's attempt line. Returns null when
 * there is none, so a grader that gives only the overall mark is treated exactly as before.
 * `rubric` maps the rubric points to the dimensions; `rubric_met` answers them in order.
 */
export function parseReasoning(raw: unknown, rubric = ""): ReasoningAssessment | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!RESULTS.includes(r.result as ResultVerdict) && !METHODS.includes(r.method as MethodVerdict)) return null;
  // The earliest error comes as {step, kind, why} from a grading call, or as a short quote from a tutor's attempt line.
  const e: Record<string, unknown> | null = typeof r.earliest_error === "string" ? { step: r.earliest_error, kind: r.error_type } : r.earliest_error && typeof r.earliest_error === "object" ? (r.earliest_error as Record<string, unknown>) : null;
  const step = e ? text(e.step, 200) : "";
  const points = rubricDimensions(rubric);
  const met = Array.isArray(r.rubric_met) ? r.rubric_met : [];
  const certainty = pick(r.certainty, CERTAINTIES, "complete");
  const result = pick(r.result, RESULTS, "unclear");
  return {
    v: 1,
    result: { verdict: result, by: "model", note: "" },
    method: { verdict: pick(r.method, METHODS, "not-assessed"), note: text(r.method_note, 240) },
    assumptions: { verdict: pick(r.assumptions, ASSUMPTIONS, "not-assessed"), items: Array.isArray(r.assumption_items) ? r.assumption_items.map((x) => text(x, 160)).filter(Boolean).slice(0, 4) : [] },
    // An earliest error is named only when the work supports it: an incomplete answer may have none.
    earliestError: step ? { step, kind: pick(text(e!.kind, 20), ERROR_KINDS, "procedural"), why: text(e!.why, 240) } : null,
    certainty: result === "unclear" && certainty === "complete" ? "incomplete" : certainty,
    rubric: points.map((p, i) => ({ ...p, met: pick(met[i], ["yes", "no", "unclear"] as const, "unclear") })),
    checks: [],
  };
}

/** Reads a breakdown stored with an attempt. Older attempts have none; a damaged one is dropped. */
export function normaliseReasoning(raw: unknown): ReasoningAssessment | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || !r.result || typeof r.result !== "object") return undefined;
  const res = r.result as Record<string, unknown>;
  const m = (r.method ?? {}) as Record<string, unknown>;
  const a = (r.assumptions ?? {}) as Record<string, unknown>;
  const e = r.earliestError && typeof r.earliestError === "object" ? (r.earliestError as Record<string, unknown>) : null;
  return {
    v: 1,
    result: { verdict: pick(res.verdict, RESULTS, "unclear"), by: pick(res.by, ["model", "symbolic", "numeric"] as const, "model"), note: text(res.note, 240) },
    method: { verdict: pick(m.verdict, METHODS, "not-assessed"), note: text(m.note, 240) },
    assumptions: { verdict: pick(a.verdict, ASSUMPTIONS, "not-assessed"), items: Array.isArray(a.items) ? a.items.map((x) => text(x, 160)).filter(Boolean).slice(0, 4) : [] },
    earliestError: e && text(e.step, 200) ? { step: text(e.step, 200), kind: pick(text(e.kind, 20), ERROR_KINDS, "procedural"), why: text(e.why, 240) } : null,
    certainty: pick(r.certainty, CERTAINTIES, "complete"),
    rubric: Array.isArray(r.rubric) ? r.rubric.flatMap((x) => (x && typeof x === "object" && typeof (x as { point?: unknown }).point === "string" ? [{ point: text((x as { point: string }).point, 200), dimension: pick((x as { dimension?: unknown }).dimension, ["result", "method", "assumptions"] as const, "method"), met: pick((x as { met?: unknown }).met, ["yes", "no", "unclear"] as const, "unclear") }] : [])).slice(0, 8) : [],
    checks: Array.isArray(r.checks) ? r.checks.flatMap((x) => (x && typeof x === "object" && typeof (x as { evaluated?: unknown }).evaluated === "string" ? [{ evaluated: text((x as SymbolicCheck).evaluated, 200), kind: pick((x as SymbolicCheck).kind, ["symbolic", "numeric"] as const, "symbolic"), outcome: (x as SymbolicCheck).outcome === true ? true : (x as SymbolicCheck).outcome === false ? false : null, assumptions: text((x as SymbolicCheck).assumptions, 200) }] : [])).slice(0, 6) : [],
    ...(RESULTS.includes(r.gradedResult as ResultVerdict) ? { gradedResult: r.gradedResult as ResultVerdict } : {}),
  };
}

/** A breakdown with only what code knows: no grader judgement at all. */
export function resultOnly(): ReasoningAssessment {
  return { v: 1, result: { verdict: "unclear", by: "model", note: "" }, method: { verdict: "not-assessed", note: "" }, assumptions: { verdict: "not-assessed", items: [] }, earliestError: null, certainty: "complete", rubric: [], checks: [] };
}

/**
 * Adds a SymPy comparison of the final result. A decided comparison settles the result dimension
 * and nothing else: the method and the assumptions stay the grader's to judge. Where the grader
 * judged the result differently, its verdict is kept beside SymPy's, so the disagreement shows.
 */
export function withCheck(r: ReasoningAssessment, c: SymbolicCheck): ReasoningAssessment {
  const out: ReasoningAssessment = { ...r, checks: [...r.checks, c].slice(-6) };
  if (c.outcome === null) return out;
  const verdict: ResultVerdict = c.outcome ? "correct" : "incorrect";
  if (r.result.by === "model" && r.result.verdict !== "unclear" && r.result.verdict !== verdict) out.gradedResult = r.result.verdict;
  out.result = { verdict, by: c.kind, note: `${c.evaluated}; ${c.assumptions}` };
  return out;
}

/** The SymPy comparison and the grader disagree about the result: the attempt is then left ungraded. */
export const resultConflict = (r: ReasoningAssessment | undefined): boolean => !!r?.gradedResult && r.gradedResult !== "partial" && r.result.by !== "model" && r.gradedResult !== r.result.verdict;

/** The final expression of a worked answer: what follows the last "=" of its last line with one, or the whole answer when it is one expression. */
export function finalExpression(answer: string): string {
  const lines = answer.trim().split(/\n/).map((l) => l.trim()).filter(Boolean);
  const withEq = [...lines].reverse().find((l) => /=/.test(l));
  const raw = withEq ? withEq.slice(withEq.lastIndexOf("=") + 1) : lines.length === 1 ? lines[0] : "";
  return raw.replace(/^[\s$]+|[\s$.;,]+$/g, "").replace(/\s*\(.*\)\s*$/, "").trim();
}

const VERDICT_TEXT: Record<ResultVerdict | MethodVerdict | AssumptionVerdict, string> = {
  correct: "right", partial: "partly right", incorrect: "wrong", unclear: "unclear", sound: "sound", flawed: "flawed", missing: "not shown", "not-assessed": "not assessed", unstated: "not stated", wrong: "wrong", "none-needed": "none needed",
};

/** One line per dimension for the feedback panel, each saying who decided it. */
export function reasoningLines(r: ReasoningAssessment): string[] {
  const by = r.result.by === "model" ? "the grader's judgement" : `checked ${r.result.by === "symbolic" ? "symbolically" : "numerically"} by SymPy: ${r.result.note}`;
  const lines = [`Result: ${VERDICT_TEXT[r.result.verdict]} (${by})${r.gradedResult ? `; the grader judged it ${VERDICT_TEXT[r.gradedResult]}` : ""}.`];
  if (r.method.verdict !== "not-assessed") lines.push(`Method: ${VERDICT_TEXT[r.method.verdict]}${r.method.note ? `, ${r.method.note}` : ""} (the grader's judgement; SymPy does not check methods).`);
  if (r.assumptions.verdict !== "not-assessed") lines.push(`Assumptions: ${VERDICT_TEXT[r.assumptions.verdict]}${r.assumptions.items.length ? `: ${r.assumptions.items.join("; ")}` : ""}.`);
  if (r.earliestError) lines.push(`Earliest error: "${r.earliestError.step}" (${r.earliestError.kind})${r.earliestError.why ? `: ${r.earliestError.why}` : ""}.`);
  if (r.certainty !== "complete") lines.push(r.certainty === "incomplete" ? "The work shown is incomplete, so part of this could not be judged." : "This answer could not be checked from what was given.");
  return lines;
}

/** What a tutor marking an answer in conversation is asked to add to its attempt line. */
export const ATTEMPT_REASONING = `When you mark the answer, add "reasoning" to the attempt line: {"result":"correct|partial|incorrect|unclear","method":"sound|flawed|missing|unclear","assumptions":"sound|unstated|wrong|none-needed|unclear","earliest_error":"the first wrong step, quoted briefly, or empty","certainty":"complete|incomplete|uncheckable"}. ${REASONING_RULE}`;
