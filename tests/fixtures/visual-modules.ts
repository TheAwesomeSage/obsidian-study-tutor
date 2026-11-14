// FIXTURE MODULES. These stand in for the visual workstream's modules (src/visuals/**) so the
// backend boundary can be tested before they exist. They are not the real modules: their
// descriptors, schemas and checks are plausible guesses written for tests, and passing tests
// against them says nothing about end-to-end behaviour with the real player. Final integration
// is pending.

import type { AssetDescriptor, JsonObject, ModuleDescriptor, VisualLesson } from "../../src/visualcontract";

/** The shapes of src/visuals/contracts.ts (fc98165), which the backend adapter must accept. */
type ContractValidation = { valid: true; lesson: VisualLesson } | { valid: false; errors: { path: string; message: string }[] };
type ContractAssessment = { status: "correct" | "incorrect" | "ungraded" | "invalid"; feedback: string; independentMastery: false };

export const ARRAY_TRACE: ModuleDescriptor = {
  id: "fixture-array-trace",
  version: "0.0.0-fixture",
  summary: "steps through linear search, binary search (sorted values only) or insertion sort on up to 10 integers, highlighting each read, comparison and swap",
  supportedObjectives: ["array indexing", "linear search", "binary search", "insertion sort", "sorting algorithm"],
  kinds: ["simulation", "game"],
  settingsSchema: {
    type: "object",
    properties: {
      algorithm: { type: "string", enum: ["linear-search", "binary-search", "insertion-sort"] },
      values: { type: "array", items: { type: "integer", minimum: -99, maximum: 99 }, minItems: 3, maxItems: 10 },
      target: { type: "integer", minimum: -99, maximum: 99 },
    },
    required: ["algorithm", "values", "target"],
    additionalProperties: false,
  },
  assessmentIds: ["predict-comparisons", "predict-final-index"],
  assetTags: [],
};

export const PROJECTILE: ModuleDescriptor = {
  id: "fixture-projectile",
  version: "0.0.0-fixture",
  summary: "a target-range challenge: no drag, constant downward gravity, equal launch and landing height",
  supportedObjectives: ["projectile range", "projectile motion", "launch angle"],
  kinds: ["simulation", "game"],
  settingsSchema: {
    type: "object",
    properties: {
      speed: { type: "number", minimum: 1, maximum: 30, description: "launch speed in m/s" },
      minAngle: { type: "number", minimum: 5, maximum: 85 },
      maxAngle: { type: "number", minimum: 5, maximum: 85 },
      gravity: { type: "number", enum: [9.81] },
      targetDistance: { type: "number", minimum: 1, maximum: 100 },
      targetWidth: { type: "number", minimum: 0.2, maximum: 5 },
    },
    required: ["speed", "minAngle", "maxAngle", "gravity", "targetDistance", "targetWidth"],
    additionalProperties: false,
  },
  assessmentIds: ["predict-range", "hit-target"],
  assetTags: ["projectile"],
};

export const FUNCTION_PLOT: ModuleDescriptor = {
  id: "fixture-function-plot",
  version: "0.0.0-fixture",
  supportedObjectives: ["function graph", "tangent line", "gradient of a curve"],
  kinds: ["diagram", "simulation"],
  settingsSchema: { type: "object", properties: { family: { type: "string", enum: ["polynomial"] }, coefficients: { type: "array", items: { type: "number", minimum: -10, maximum: 10 }, minItems: 1, maxItems: 4 } }, required: ["family", "coefficients"], additionalProperties: false },
  assessmentIds: ["predict-slope"],
  assetTags: [],
};

export const ASSETS: AssetDescriptor[] = [
  { id: "fixture-ball", tags: ["projectile"], description: "a round ball sprite (decorative; the hit test uses the module's geometry)" },
  { id: "fixture-target", tags: ["projectile"], description: "a target board" },
];

/** The real algorithms, instrumented, so the fixture's expected answers come from running them. */
export function trace(settings: JsonObject): { comparisons: number; index: number } {
  const values = (settings.values as number[]).slice();
  const target = settings.target as number;
  let comparisons = 0;
  if (settings.algorithm === "linear-search") {
    for (let i = 0; i < values.length; i++) {
      comparisons++;
      if (values[i] === target) return { comparisons, index: i };
    }
    return { comparisons, index: -1 };
  }
  if (settings.algorithm === "binary-search") {
    let lo = 0;
    let hi = values.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      comparisons++;
      if (values[mid] === target) return { comparisons, index: mid };
      if (values[mid] < target) lo = mid + 1;
      else hi = mid - 1;
    }
    return { comparisons, index: -1 };
  }
  for (let i = 1; i < values.length; i++) {
    let j = i;
    while (j > 0) {
      comparisons++;
      if (values[j - 1] <= values[j]) break;
      [values[j - 1], values[j]] = [values[j], values[j - 1]];
      j--;
    }
  }
  return { comparisons, index: values.indexOf(target) };
}

const rangeAt = (v: number, deg: number, g: number) => (v * v * Math.sin((2 * deg * Math.PI) / 180)) / g;

export function makeFixtureRegistry(over: { modules?: ModuleDescriptor[]; catalog?: string } = {}) {
  const modules = over.modules ?? [ARRAY_TRACE, PROJECTILE, FUNCTION_PLOT];
  const calls = { validate: 0, assess: 0, variant: 0 };
  return {
    calls,
    listModuleDescriptors: () => modules,
    listAssets: () => ASSETS,
    catalogVersion: () => over.catalog ?? "fixture-catalog-1",
    validateLesson(raw: unknown): ContractValidation {
      calls.validate++;
      const l = raw as VisualLesson;
      const m = modules.find((d) => d.id === l?.moduleId);
      if (!m) return { valid: false, errors: [{ path: "moduleId", message: `unknown module ${l?.moduleId}` }] };
      const s = l.settings;
      if (m.id === ARRAY_TRACE.id && s.algorithm === "binary-search") {
        const v = s.values as number[];
        if (v.some((x, i) => i > 0 && v[i - 1] > x)) return { valid: false, errors: [{ path: "settings.values", message: "binary search needs the values in ascending order" }] };
      }
      if (m.id === PROJECTILE.id) {
        const errors: string[] = [];
        const lo = s.minAngle as number;
        const hi = s.maxAngle as number;
        if (lo > hi) errors.push("minAngle is above maxAngle");
        // Reachability: the largest range over the allowed angles, against the near edge of the target.
        const best = lo <= 45 && hi >= 45 ? rangeAt(s.speed as number, 45, s.gravity as number) : Math.max(rangeAt(s.speed as number, lo, s.gravity as number), rangeAt(s.speed as number, hi, s.gravity as number));
        const near = (s.targetDistance as number) - (s.targetWidth as number) / 2;
        if (near > best) errors.push(`the target cannot be reached: the furthest landing point is ${best.toFixed(2)} m and the target starts at ${near.toFixed(2)} m`);
        if (errors.length) return { valid: false, errors: errors.map((message) => ({ path: "settings", message })) };
      }
      return { valid: true, lesson: l };
    },
    assessLesson(lesson: VisualLesson, response: unknown): ContractAssessment {
      calls.assess++;
      const r = (response ?? {}) as { answer?: unknown };
      if (typeof r.answer !== "number") return { status: "ungraded", feedback: "No prediction was made.", independentMastery: false };
      if (lesson.moduleId === ARRAY_TRACE.id) {
        const t = trace(lesson.settings);
        const want = lesson.assessmentId === "predict-comparisons" ? t.comparisons : t.index;
        return { status: r.answer === want ? "correct" : "incorrect", feedback: `The trace made ${t.comparisons} comparisons.`, independentMastery: false };
      }
      return { status: "ungraded", feedback: "", independentMastery: false };
    },
    createVariant(lesson: VisualLesson, seed: number): VisualLesson | null {
      calls.variant++;
      if (lesson.moduleId !== ARRAY_TRACE.id) return null;
      const values = (lesson.settings.values as number[]).map((x) => ((x + seed * 7) % 90) - 40);
      if (lesson.settings.algorithm === "binary-search") values.sort((a, b) => a - b);
      return { ...lesson, settings: { ...lesson.settings, values, target: values[Math.abs(seed) % values.length] } };
    },
  };
}

/** A scripted local model: replies in order, records every request, never touches the network. */
export function scriptedModel(replies: (string | Error)[], model = "qwen2.5:3b") {
  const requests: { system: string; user: string; schema: unknown; temperature?: number; maxTokens?: number }[] = [];
  return {
    model,
    requests,
    async chatJson(o: { system: string; user: string; schema: unknown; temperature?: number; maxTokens?: number }) {
      requests.push(o);
      const next = replies.shift();
      if (next === undefined) throw new Error("scripted model ran out of replies");
      if (next instanceof Error) throw next;
      return { text: next, model, doneReason: "stop", timing: { wallMs: 900, loadMs: 0, promptTokens: 160, promptMs: 600, evalTokens: 120, evalMs: 300, totalMs: 900 } };
    },
  };
}

/** A configuration reply as the local model would write it for the array trace. */
export const arrayReply = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ fits: true, objective: "see how binary search halves a sorted array", settings: { algorithm: "binary-search", values: [3, 8, 12, 19, 25, 31, 40], target: 25 }, assetIds: [], assessmentId: "predict-comparisons", predictionQuestion: "How many comparisons will binary search make before it finds 25?", hint: "Count how many times the middle element is checked.", missingOperation: "", ...over });
