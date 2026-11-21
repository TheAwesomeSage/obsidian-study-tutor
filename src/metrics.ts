// What the plugin already records about its own running, summarised without calling any model:
// compile metrics from each course package, the attempts in each evidence log, the saved activity
// configurations and the decision log. docs/PILOT.md lists the fields and what they can and cannot
// show; scripts/metrics-summary.mjs runs this over a Study Tutor folder. Pure functions.

import { Attempt, normaliseAttempt, skillEvidence } from "./evidence";
import { BrierComparison, bktAll, brierComparison } from "./bkt";

/** Said with every summary: a count of calls is not a saving. */
export const CALL_COUNT_CAVEAT = "Call counts are not savings. Fewer model calls says nothing about cost, time or learning until tokens, cost, time and outcomes are measured on matched work, with the same learners, material and model.";

/** What the code does not save, so a pilot has to log it separately. */
export const NOT_RECORDED = [
  "Token use and cost per study turn: shown in Details for the current sitting only, not saved.",
  "Token use and cost of a compile: shown in the compile notice and returned to the caller, not saved in the course package.",
  "Time spent reading lessons or worked examples: only the time from a question being asked to its answer is saved (Attempt.seconds).",
  "Outcomes outside the plugin: unseen tasks, delayed tests and transfer tasks must be set and marked by the pilot itself.",
];

export interface Stat {
  n: number;
  median: number | null;
  p90: number | null;
}

export interface MetricsInput {
  /** Course packages as saved (package.md); only `topic` and `staged.metrics` are read. */
  packages: { topic?: string; staged?: { metrics?: Record<string, unknown> } | null }[];
  /** Attempts by topic, as saved in each evidence.md. */
  attempts: Record<string, Attempt[]>;
  /** Saved activity configurations (activities.md records). */
  activities?: Record<string, unknown>[];
  /** Logged policy decisions (_logs/decisions.md). */
  decisions?: { decision?: { version?: number; local?: string | null } }[];
}

export interface MetricsSummary {
  compile: { packages: number; staged: number; totals: Record<string, number>; elapsedMs: Stat };
  attempts: { total: number; byGrading: Record<string, number>; markedByCode: number; markedByModel: number; selfRated: number; ungraded: number; disputed: number; assisted: number; answerSeen: number; independent: number; probes: number; probeCorrect: number; seconds: Stat };
  activities: { records: number; byStatus: Record<string, number>; localCalls: number; repairs: number; claudeCalls: number; firstPassValid: number; firstPassKnown: number; wallMs: Stat; localMs: Stat; loadMs: Stat; promptTokens: number; evalTokens: number };
  decisions: { total: number; bank: number; placement: number; model: number; byVersion: Record<string, number> };
  /** BKT (shadow) against the existing estimate, over every unaided answer. */
  shadow: BrierComparison;
  notRecorded: string[];
  caveat: string;
}

function stat(xs: number[]): Stat {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return { n: 0, median: null, p90: null };
  const at = (q: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
  const median = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return { n: s.length, median, p90: at(0.9) };
}

const count = (xs: string[]): Record<string, number> => xs.reduce<Record<string, number>>((o, k) => ((o[k] = (o[k] ?? 0) + 1), o), {});
const sum = (xs: number[]): number => xs.reduce((s, x) => s + x, 0);
const positive = (xs: number[]): number[] => xs.filter((x) => x > 0);
const numberAt = (o: unknown, k: string): number => (o && typeof o === "object" && typeof (o as Record<string, unknown>)[k] === "number" ? ((o as Record<string, unknown>)[k] as number) : 0);

/** Summarises the saved records. No model is called and nothing is written. */
export function summariseMetrics(input: MetricsInput): MetricsSummary {
  // Compile metrics: every numeric counter is summed, so counters added later show up unchanged.
  const metrics = input.packages.map((p) => p.staged?.metrics).filter((m): m is Record<string, unknown> => !!m && typeof m === "object");
  const totals: Record<string, number> = {};
  for (const m of metrics) for (const [k, v] of Object.entries(m)) if (typeof v === "number" && Number.isFinite(v) && k !== "elapsedMs") totals[k] = (totals[k] ?? 0) + v;

  const every = Object.values(input.attempts).flat();
  const probed = every.filter((a) => a.probe && a.verification !== "disputed" && a.result !== "ungraded");
  const all = every.filter((a) => !a.probe);
  const kept = all.filter((a) => a.verification !== "disputed");
  const graded = kept.filter((a) => a.result !== "ungraded");
  let independent = 0;
  for (const list of Object.values(input.attempts)) for (const n of new Set(list.map((a) => a.skill).filter((n) => n > 0))) independent += skillEvidence(list, n).independent;

  const acts = input.activities ?? [];
  const field = (pick: (a: (typeof acts)[number]) => unknown, k: string): number[] => acts.map((a) => numberAt(pick(a), k));
  const own = (k: string) => field((a) => a, k);
  const timing = (k: string) => field((a) => a.timing, k);
  const decisions = input.decisions ?? [];
  return {
    compile: { packages: input.packages.length, staged: metrics.length, totals, elapsedMs: stat(positive(metrics.map((m) => numberAt(m, "elapsedMs")))) },
    attempts: {
      total: all.length,
      byGrading: count(graded.map((a) => a.grading)),
      markedByCode: graded.filter((a) => a.grading === "deterministic" || a.grading === "symbolic" || a.grading === "numeric").length,
      markedByModel: graded.filter((a) => a.grading === "model").length,
      selfRated: graded.filter((a) => a.grading === "self").length,
      ungraded: kept.length - graded.length,
      disputed: all.length - kept.length,
      assisted: graded.filter((a) => a.assisted).length,
      answerSeen: graded.filter((a) => a.answerExposed).length,
      independent,
      probes: probed.length,
      probeCorrect: probed.filter((a) => a.result === "correct").length,
      seconds: stat(graded.map((a) => a.seconds ?? NaN)),
    },
    activities: {
      records: acts.length,
      byStatus: count(acts.map((a) => (typeof a.status === "string" ? a.status : "unknown"))),
      localCalls: sum(own("localCalls")),
      repairs: sum(own("repairs")),
      claudeCalls: sum(own("claudeCalls")),
      firstPassValid: acts.filter((a) => a.firstPassValid === true).length,
      firstPassKnown: acts.filter((a) => typeof a.firstPassValid === "boolean").length,
      wallMs: stat(positive(timing("wallMs"))),
      localMs: stat(positive(timing("localMs"))),
      loadMs: stat(positive(timing("loadMs"))),
      promptTokens: sum(timing("promptTokens")),
      evalTokens: sum(timing("evalTokens")),
    },
    decisions: {
      total: decisions.length,
      bank: decisions.filter((d) => d.decision?.local === "bank").length,
      placement: decisions.filter((d) => d.decision?.local === "placement").length,
      model: decisions.filter((d) => !d.decision?.local).length,
      byVersion: count(decisions.map((d) => String(d.decision?.version ?? "unknown"))),
    },
    shadow: brierComparison(Object.values(input.attempts).flatMap((list) => bktAll(list))),
    notRecorded: NOT_RECORDED,
    caveat: CALL_COUNT_CAVEAT,
  };
}

/** The JSON in a saved package.md, or null. */
export function packageFromText(text: string): MetricsInput["packages"][number] | null {
  const m = /```json\s*\n([\s\S]*?)\n```/.exec(text);
  if (!m) return null;
  try {
    const v = JSON.parse(m[1]);
    return v && v.format === "study-tutor-course" ? v : null;
  } catch {
    return null;
  }
}

/** The records in a saved jsonl block (evidence.md, activities.md, decisions.md). Damaged lines are skipped. */
export function jsonlFromText(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object") out.push(v);
    } catch {
      /* skip */
    }
  }
  return out;
}

/** The attempts in a saved evidence.md. */
export const attemptsFromText = (text: string): Attempt[] => jsonlFromText(text).filter((r) => r.kind === "attempt").map(normaliseAttempt).filter((a): a is Attempt => !!a);

const ms = (s: Stat): string => (s.n ? `median ${Math.round(s.median!)} ms, 90th percentile ${Math.round(s.p90!)} ms (n = ${s.n})` : "none recorded");
const f2 = (x: number | null): string => (x === null ? "n/a" : x.toFixed(3));

/** The summary as markdown. */
export function metricsReport(s: MetricsSummary): string {
  const a = s.attempts;
  const act = s.activities;
  const totals = Object.entries(s.compile.totals).sort(([x], [y]) => x.localeCompare(y)).map(([k, v]) => `${k} ${v}`).join(", ");
  return [
    "# Study Tutor measurement summary",
    "",
    `> ${s.caveat}`,
    "",
    "## Compilation",
    `- Course packages: ${s.compile.packages}, of which ${s.compile.staged} carry staged compile metrics.`,
    `- Totals over those: ${totals || "none"}.`,
    `- Compile wall time: ${ms(s.compile.elapsedMs)}.`,
    "",
    "## Answers",
    `- Attempts: ${a.total} (${a.ungraded} unmarked, ${a.disputed} disputed).`,
    `- Marked by code: ${a.markedByCode}; by a model: ${a.markedByModel}; self-rated: ${a.selfRated}. By method: ${Object.entries(a.byGrading).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}.`,
    `- With help: ${a.assisted}; after seeing the answer: ${a.answerSeen}; unaided data points: ${a.independent}.`,
    `- Cold probes: ${a.probes} answers, ${a.probeCorrect} correct.`,
    `- Seconds from question to answer: ${a.seconds.n ? `median ${a.seconds.median}, 90th percentile ${a.seconds.p90} (n = ${a.seconds.n})` : "none recorded"}.`,
    "",
    "## Activity configurations (local model)",
    `- Records: ${act.records} (${Object.entries(act.byStatus).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}).`,
    `- Local calls ${act.localCalls}, repairs ${act.repairs}, Claude calls ${act.claudeCalls}; first answer valid ${act.firstPassValid} of ${act.firstPassKnown}.`,
    `- Wall time ${ms(act.wallMs)}; local model time ${ms(act.localMs)}; load time ${ms(act.loadMs)}.`,
    `- Local tokens: ${act.promptTokens} prompt, ${act.evalTokens} generated.`,
    "",
    "## Policy decisions",
    `- Logged: ${s.decisions.total}; handled by code: ${s.decisions.bank} bank, ${s.decisions.placement} placement; left to a model: ${s.decisions.model}. By policy version: ${Object.entries(s.decisions.byVersion).map(([k, v]) => `v${k} ${v}`).join(", ") || "none"}.`,
    "",
    "## BKT (shadow, not used for decisions)",
    `- Unaided answers scored: ${s.shadow.n}. Brier (lower is better): BKT ${f2(s.shadow.bkt)}, existing estimate ${f2(s.shadow.estimate)}.`,
    `- With stated confidence: ${s.shadow.rated}. On those: BKT ${f2(s.shadow.bktRated)}, estimate ${f2(s.shadow.estimateRated)}, learner confidence ${f2(s.shadow.confidence)}.`,
    "",
    "## Not recorded by the plugin",
    ...s.notRecorded.map((x) => `- ${x}`),
    "",
  ].join("\n");
}
