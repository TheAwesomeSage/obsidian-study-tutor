import type { AssessmentResponse, AssessmentResult, JsonObject, LessonValidation, ModuleDescriptor, ValidationError, VisualLesson } from "./contracts";
import { evaluate, numericVariant, plotSegments, projectile, rangeBounds, traceAlgorithm, type AlgorithmSettings, type PlotSettings, type ProjectileSettings } from "./models";
import { ASSETS } from "./assets";
import { contentHash } from "../formats";

const num = (minimum: number, maximum: number) => ({ type: "number", minimum, maximum });
const pair = (minimum: number, maximum: number) => ({ type: "array", items: num(minimum, maximum), minItems: 2, maxItems: 2 });
const schema = (properties: JsonObject): JsonObject => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const descriptors: ModuleDescriptor[] = [
  { id: "function-plotter", version: "1.0.0", supportedObjectives: ["Polynomial (degree 0–5) and elementary function values, translations, scaling, derivatives and undefined slopes"], assessmentIds: ["slope-at-point"], assetTags: [], settingsSchema: schema({
    family: { enum: ["polynomial", "sin", "cos", "exp", "log", "sqrt", "reciprocal", "abs"] },
    coefficients: { type: "array", items: num(-100, 100), minItems: 1, maxItems: 6 }, scale: num(-10, 10), shiftX: num(-10, 10), shiftY: num(-10, 10), domain: pair(-50, 50),
    viewport: { type: "array", items: num(-1000, 1000), minItems: 4, maxItems: 4 }, pointX: num(-50, 50),
  }) },
  { id: "projectile", version: "1.0.0", supportedObjectives: ["No-drag projectile motion, constant gravity, equal launch/landing heights; range, velocity components, target prediction"], assessmentIds: ["range-prediction"], assetTags: ["ball", "badge"], settingsSchema: schema({
    speed: num(1, 50), angle: num(5, 85), gravity: num(0.5, 25), speedRange: pair(1, 50), angleRange: pair(5, 85), target: num(0.01, 5000), tolerance: num(0.05, 5),
  }) },
  { id: "algorithm", version: "1.0.0", supportedObjectives: ["Zero-based numeric array indexing", "Bubble sort (ascending)", "Linear search (first match)", "Binary search on sorted numbers (one matching index)"], assessmentIds: ["trace-result"], assetTags: ["badge"], settingsSchema: schema({
    algorithm: { enum: ["index", "bubble-sort", "linear-search", "binary-search"] }, values: { type: "array", items: { type: "integer", minimum: -999, maximum: 999 }, minItems: 1, maxItems: 16 }, target: { type: "integer", minimum: -999, maximum: 999 }, index: { type: "integer", minimum: 0, maximum: 15 },
  }) },
  { id: "phet-external", version: "1.0.0", supportedObjectives: ["Source-based prediction and reflection around an external PhET activity; no access to simulation state"], assessmentIds: ["external-reflection"], assetTags: [], settingsSchema: schema({ simulation: { enum: ["projectile-motion", "function-builder", "forces-and-motion-basics"] }, question: { type: "string", minLength: 10, maxLength: 1000 } }) },
];
export function listModuleDescriptors(): ModuleDescriptor[] { return JSON.parse(JSON.stringify(descriptors)); }
export function listAssets() { return ASSETS.map(a => ({...a, tags:[...a.tags], description:a.tags.join(", ")})); }
export function catalogVersion(): string { return "visuals-v1.1.0/kenney-2026-11-14"; }
for (const d of descriptors) {
  d.kinds = d.id === "phet-external" ? ["external"] : d.id === "projectile" ? ["game", "simulation"] : ["diagram", "simulation"];
  d.summary = d.supportedObjectives.join("; ");
  d.questionTemplates = {
    "slope-at-point": "Predict the tangent slope at the initial point x = {pointX}. Then explain how it changes as you move the point.",
    "range-prediction": "Predict the horizontal landing distance at speed {speed} m/s, angle {angle} degrees and gravity {gravity} m/s². Assume no drag and equal heights.",
    "trace-result": "Predict this algorithm's final result. Indexing returns a value, search returns an index (-1 if absent), and sorting returns the final ascending array.",
    "external-reflection": "Use the source excerpt to predict what will happen in this external activity, then explain your observation.",
  };
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
/** Small strict validator for the complete subset of JSON Schema used by descriptors. */
function check(value: unknown, rule: Record<string, unknown>, path: string, errors: ValidationError[]): void {
  const fail = (message: string) => errors.push({ path, message });
  if (Array.isArray(rule.enum) && !rule.enum.includes(value)) fail("Unknown supported value");
  if (rule.type === "object") {
    if (!object(value)) { fail("Expected a JSON object"); return; }
    const props = rule.properties as Record<string, Record<string, unknown>>;
    for (const key of Object.keys(value)) if (!(key in props)) errors.push({ path: `${path}.${key}`, message: "Unknown setting" });
    for (const key of rule.required as string[]) check(value[key], props[key], `${path}.${key}`, errors);
  } else if (rule.type === "array") {
    if (!Array.isArray(value)) { fail("Expected an array"); return; }
    if (value.length < Number(rule.minItems) || value.length > Number(rule.maxItems)) { fail("Array length outside supported bounds"); return; }
    value.forEach((v, i) => check(v, rule.items as Record<string, unknown>, `${path}[${i}]`, errors));
  } else if (rule.type === "number" || rule.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || value < Number(rule.minimum) || value > Number(rule.maximum) || (rule.type === "integer" && !Number.isInteger(value))) fail("Number outside supported bounds");
  } else if (rule.type === "string") {
    if (typeof value !== "string" || value.trim().length < Number(rule.minLength) || value.length > Number(rule.maxLength)) fail("Text outside supported bounds");
  }
}
export function validateLesson(value: unknown): LessonValidation {
  const errors: ValidationError[] = [];
  const fail = (path: string, message: string) => errors.push({ path, message });
  if (!object(value)) return { valid: false, errors: [{ path: "$", message: "Expected a lesson object" }] };
  if (value.schemaVersion !== 1) fail("schemaVersion", "Only version 1 is supported");
  for (const key of ["objective", "predictionQuestion", "hint"]) check(value[key], { type: "string", minLength: 1, maxLength: 2000 }, key, errors);
  const allowed = ["schemaVersion", "moduleId", "moduleVersion", "objective", "sourceRefs", "settings", "assetIds", "assessmentId", "predictionQuestion", "hint"];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(key, "Unknown lesson field");
  if (!Array.isArray(value.sourceRefs) || value.sourceRefs.length < 1 || value.sourceRefs.length > 10) fail("sourceRefs", "Provide 1–10 excerpt references");
  else value.sourceRefs.forEach((r, i) => {
    if (!object(r)) { fail(`sourceRefs[${i}]`, "Expected a source object"); return; }
    check(r.path, { type: "string", minLength: 1, maxLength: 1024 }, `sourceRefs[${i}].path`, errors);
    check(r.excerpt, { type: "string", minLength: 1, maxLength: 12000 }, `sourceRefs[${i}].excerpt`, errors);
    if (typeof r.contentHash !== "string" || !/^[a-f0-9]{64}$/i.test(r.contentHash)) fail(`sourceRefs[${i}].contentHash`, "Use a SHA-256 hex digest");
    else if (typeof r.excerpt === "string" && r.contentHash.toLowerCase() !== contentHash(r.excerpt)) fail(`sourceRefs[${i}].contentHash`, "Hash does not match the source excerpt");
  });
  if (!Array.isArray(value.assetIds) || value.assetIds.length > 8 || value.assetIds.some(id => typeof id !== "string" || !ASSETS.some(a => a.id === id))) fail("assetIds", "Unknown asset ID or more than 8 assets");
  const descriptor = descriptors.find(d => d.id === value.moduleId);
  if (!descriptor) fail("moduleId", "Unsupported capability; route to backend");
  else {
    if (value.moduleVersion !== descriptor.version) fail("moduleVersion", "Unsupported module version");
    if (!descriptor.assessmentIds.includes(value.assessmentId as string)) fail("assessmentId", "Unknown module assessment");
    const before = errors.length;
    check(value.settings, descriptor.settingsSchema, "settings", errors);
    if (errors.length === before) {
      if (descriptor.id === "projectile") {
        const s = value.settings as unknown as ProjectileSettings;
        if (s.speedRange[0] > s.speedRange[1] || s.angleRange[0] > s.angleRange[1] || s.speed < s.speedRange[0] || s.speed > s.speedRange[1] || s.angle < s.angleRange[0] || s.angle > s.angleRange[1]) fail("settings", "Controls must be ordered and include initial settings");
        const [lo, hi] = rangeBounds(s);
        if (s.target + s.tolerance < lo || s.target - s.tolerance > hi) fail("settings.target", "Target is unreachable with allowed controls");
      } else if (descriptor.id === "function-plotter") {
        const s = value.settings as unknown as PlotSettings;
        if (s.domain[0] >= s.domain[1] || s.viewport[0] >= s.viewport[2] || s.viewport[1] <= s.viewport[3] || s.viewport[2] - s.viewport[0] < 0.1 || s.viewport[1] - s.viewport[3] < 0.1) fail("settings", "Domain/viewport must be ordered with a visible extent (left, top, right, bottom)");
        if (s.pointX < s.domain[0] || s.pointX > s.domain[1]) fail("settings.pointX", "Point must be in the domain");
        if (!plotSegments(s).length) fail("settings.domain", "Function is undefined over the entire domain");
        if (!plotSegments(s).some(([a,b]) => b > s.viewport[0] && a < s.viewport[2])) fail("settings.viewport", "Viewport must intersect the function domain");
      } else if (descriptor.id === "algorithm") {
        const s = value.settings as unknown as AlgorithmSettings;
        if (s.index >= s.values.length) fail("settings.index", "Index outside the array");
        if (s.algorithm === "binary-search" && s.values.some((n, i) => i > 0 && n < s.values[i - 1])) fail("settings.values", "Binary search requires ascending sorted input");
      }
    }
  }
  return errors.length ? { valid: false, errors } : { valid: true, lesson: JSON.parse(JSON.stringify(value)) as VisualLesson };
}
export function assessLesson(lesson: VisualLesson, response: AssessmentResponse): AssessmentResult {
  const result = (status: AssessmentResult["status"], feedback: string): AssessmentResult => ({ status, feedback, independentMastery: false });
  const validation = validateLesson(lesson);
  if (!validation.valid) return result("invalid", validation.errors.map(e => e.message).join("; "));
  if (!object(response) || !("answer" in response)) return result("invalid", "Expected a structured assessment response");
  if (response.settings !== undefined) {
    if (!object(response.settings)) return result("invalid", "Expected model settings");
    const editable = lesson.moduleId === "projectile" ? ["speed", "angle"] : lesson.moduleId === "function-plotter" ? ["pointX", "scale", "shiftY"] : [];
    for (const key of Object.keys(response.settings)) if (!editable.includes(key) && JSON.stringify(response.settings[key]) !== JSON.stringify(lesson.settings[key])) return result("invalid", "Only the module's learner controls may change");
    const edited = validateLesson({...lesson, settings:{...lesson.settings,...response.settings}});
    if (!edited.valid) return result("invalid", edited.errors.map(e=>e.message).join("; "));
    lesson = edited.lesson;
  }
  let expected: unknown;
  if (lesson.moduleId === "function-plotter") expected = evaluate(lesson.settings as unknown as PlotSettings, Number(lesson.settings.pointX)).slope;
  else if (lesson.moduleId === "algorithm") { const trace = traceAlgorithm(lesson.settings as unknown as AlgorithmSettings); expected = trace[trace.length - 1].result; }
  else if (lesson.moduleId === "projectile") {
    const s = lesson.settings as unknown as ProjectileSettings;
    expected = s.speed ** 2 * Math.sin(2 * s.angle * Math.PI / 180) / s.gravity;
  } else return result("ungraded", "External simulation state is opaque. Discuss your source-based explanation with your tutor.");
  const correct = typeof expected === "number" ? typeof response.answer === "number" && Number.isFinite(response.answer) && Math.abs(expected - response.answer) <= 0.001 : JSON.stringify(expected) === JSON.stringify(response.answer);
  return result(correct ? "correct" : "incorrect", correct ? "Matches the model. Explain why, then try a fresh unaided problem." : "Does not match this model. Inspect the components or execution trace and explain the difference.");
}

const round2 = (x: number) => Math.round(x * 100) / 100;
/** Deterministic fraction in [0, 1) from a seed and a salt. */
const unit = (seed: number, salt: number) => (Math.imul((seed ^ Math.imul(salt, 0x9e3779b1)) >>> 0, 2654435761) >>> 0) / 4294967296;

/**
 * A fresh numeric variant of a saved lesson, made by module code from an integer seed: new
 * array values for the algorithm trace, new launch settings and a reachable target for the
 * projectile, a new point for the plotter. The question is rewritten from the module's template
 * for the new settings, and the variant is validated like any lesson. Null when the module has
 * no variants (external activities) or the variant does not validate. No model is involved.
 */
export function createVariant(value: unknown, seed: number): VisualLesson | null {
  const valid = validateLesson(value);
  if (!valid.valid || !Number.isInteger(seed)) return null;
  const lesson = valid.lesson;
  const s = lesson.settings;
  let next: JsonObject | null = null;
  if (lesson.moduleId === "algorithm") {
    const a = s as unknown as AlgorithmSettings;
    let values = numericVariant(seed >>> 0, Math.max(1, Math.min(16, a.values.length)));
    // Binary search here has one matching index, so its values are distinct and ascending.
    if (a.algorithm === "binary-search") values = [...new Set(values)].sort((x, y) => x - y);
    const index = Math.floor(unit(seed, 1) * values.length);
    const target = values[Math.floor(unit(seed, 2) * values.length)];
    next = { ...s, values, index, target };
  } else if (lesson.moduleId === "projectile") {
    const p = s as unknown as ProjectileSettings;
    const pick = (lo: number, hi: number, salt: number) => round2(lo + unit(seed, salt) * (hi - lo));
    const speed = pick(p.speedRange[0], p.speedRange[1], 1), angle = pick(p.angleRange[0], p.angleRange[1], 2);
    // The target is the landing point of another allowed setting, so it is always reachable.
    const target = round2(projectile({ speed: pick(p.speedRange[0], p.speedRange[1], 3), angle: pick(p.angleRange[0], p.angleRange[1], 4), gravity: p.gravity }).range);
    next = { ...s, speed, angle, target };
  } else if (lesson.moduleId === "function-plotter") {
    const p = s as unknown as PlotSettings;
    next = { ...s, pointX: round2(p.domain[0] + unit(seed, 1) * (p.domain[1] - p.domain[0])) };
  }
  if (!next) return null;
  const descriptor = descriptors.find((d) => d.id === lesson.moduleId);
  const template = descriptor?.questionTemplates?.[lesson.assessmentId];
  const settings = next;
  const predictionQuestion = template ? template.replace(/\{(\w+)\}/g, (all, k: string) => (k in settings ? String(settings[k]) : all)) : lesson.predictionQuestion;
  const checked = validateLesson({ ...lesson, settings, predictionQuestion });
  return checked.valid ? checked.lesson : null;
}
