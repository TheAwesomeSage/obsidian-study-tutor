// Backend adapter over the authoritative v1 visual contract.
import type { PresentationKind, JsonObject, SourceRef, PresentationRequest, VisualLesson, ValidationError, GenerationResult, ModuleDescriptor } from "./visuals/contracts";
export type { PresentationKind, JsonObject, SourceRef, PresentationRequest, VisualLesson, ValidationError, GenerationResult, ModuleDescriptor } from "./visuals/contracts";
export type { Json as JsonValue } from "./visuals/contracts";
export const PRESENTATION_KINDS: PresentationKind[] = ["text", "worked-example", "diagram", "simulation", "game", "external"];
/** Kinds a module renders. The others are written by the tutor in the reply. */
export const INTERACTIVE_KINDS: PresentationKind[] = ["diagram", "simulation", "game", "external"];

/**
 * Backend record of a capability no module has yet, for a development pass. Never generated as
 * code. The contract's GenerationResult carries only its `operation` as `missingCapability`.
 */
export interface MissingCapability {
  /** The operation or representation that is missing, in a few words. */
  operation: string;
  objective: string;
  kind: PresentationKind;
  /** The task or difficulty that motivated the request. */
  motivatingTask: string;
}

/** "path: message" strings, as the backend records them, back into the contract's error objects. */
export const toValidationErrors = (errors: string[]): ValidationError[] =>
  errors.map((e) => {
    const m = /^(\$[^:\s]*|[\w.[\]$-]+): (.*)$/.exec(e);
    return m ? { path: m[1], message: m[2] } : { path: "$", message: e };
  });

/** An approved asset as the configuration step sees it: an id and a description, never a path. */
export interface AssetDescriptor {
  id: string;
  tags: string[];
  description: string;
}

export type LessonValidation = { ok: true; lesson: VisualLesson } | { ok: false; errors: string[] };

/**
 * A module's assessment as the backend records it. The contract's AssessmentResult has
 * `status` (correct | incorrect | ungraded | invalid) and `independentMastery: false`; the
 * adapter maps status to `correct` (null for ungraded and invalid).
 */
export interface AssessmentResult {
  /** null when the response could not be assessed (ungraded, invalid, or not an answer). */
  correct: boolean | null;
  score: number | null;
  feedback: string;
  /** The module's own status word, when it gave one. */
  status: string;
  /** Module-defined detail kept with the record. */
  detail: JsonObject;
}

/** The registry as the backend uses it, whatever exact shape the module side exposes. */
export interface ModuleRegistry {
  listModuleDescriptors(): ModuleDescriptor[];
  validateLesson(lesson: unknown): LessonValidation;
  assessLesson(lesson: VisualLesson, response: unknown): AssessmentResult;
  /** Assets the modules may use. Optional on the module side; none when absent. */
  listAssets(): AssetDescriptor[];
  /** Changes whenever the module or asset catalogue changes, for cache keys. */
  catalogVersion(): string;
  /** A fresh numeric variant made and checked by module code, when the module supports it. */
  createVariant(lesson: VisualLesson, seed: number): VisualLesson | null;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/**
 * Wraps whatever the module side exports into the backend's registry shape. It accepts:
 *   validateLesson returning a boolean, { ok, errors }, { valid, errors }, or { ok:true, lesson };
 *   assessLesson returning a boolean, { correct, ... } or { ok, ... };
 *   missing listAssets, catalogVersion and createVariant.
 * A thrown error inside module code becomes a validation error, never a crash of the turn.
 */
export function adaptRegistry(raw: Record<string, unknown>): ModuleRegistry {
  const call = <T>(name: string, ...args: unknown[]): T | undefined => {
    const fn = raw[name];
    return typeof fn === "function" ? (fn as (...a: unknown[]) => T).apply(raw, args) : undefined;
  };
  const descriptors = (): ModuleDescriptor[] => {
    const list = call<unknown[]>("listModuleDescriptors") ?? [];
    return list.filter((d): d is ModuleDescriptor => isObj(d) && typeof d.id === "string" && typeof d.version === "string" && Array.isArray(d.supportedObjectives) && isObj(d.settingsSchema) && Array.isArray(d.assessmentIds));
  };
  return {
    listModuleDescriptors: descriptors,
    validateLesson(lesson: unknown): LessonValidation {
      let r: unknown;
      try {
        r = call("validateLesson", lesson);
      } catch (e) {
        return { ok: false, errors: [`module validation threw: ${(e as Error)?.message ?? String(e)}`] };
      }
      const errors = (x: unknown): string[] => (Array.isArray(x) ? x.map((e) => (typeof e === "string" ? e : isObj(e) && typeof e.message === "string" ? `${typeof e.path === "string" ? `${e.path}: ` : ""}${e.message}` : JSON.stringify(e))) : []);
      if (r === true) return { ok: true, lesson: lesson as VisualLesson };
      if (r === false || r === undefined) return { ok: false, errors: [r === undefined ? "the module registry has no validateLesson" : "the module rejected the lesson"] };
      if (isObj(r)) {
        const ok = r.ok === true || r.valid === true;
        if (ok) return { ok: true, lesson: (isObj(r.lesson) ? r.lesson : lesson) as VisualLesson };
        const list = errors(r.errors ?? r.validationErrors);
        return { ok: false, errors: list.length ? list : ["the module rejected the lesson"] };
      }
      return { ok: false, errors: ["the module returned an unreadable validation result"] };
    },
    assessLesson(lesson: VisualLesson, response: unknown): AssessmentResult {
      let r: unknown;
      try {
        r = call("assessLesson", lesson, response);
      } catch (e) {
        return { correct: null, score: null, feedback: `The activity could not assess this: ${(e as Error)?.message ?? String(e)}`, status: "invalid", detail: {} };
      }
      if (typeof r === "boolean") return { correct: r, score: r ? 1 : 0, feedback: "", status: r ? "correct" : "incorrect", detail: {} };
      if (!isObj(r)) return { correct: null, score: null, feedback: "The activity returned no assessment.", status: "invalid", detail: {} };
      // contracts.ts: { status: "correct" | "incorrect" | "ungraded" | "invalid", feedback, independentMastery: false }
      const status = typeof r.status === "string" ? r.status : "";
      const correct = status ? (status === "correct" ? true : status === "incorrect" ? false : null) : typeof r.correct === "boolean" ? r.correct : typeof r.ok === "boolean" ? r.ok : null;
      return { correct, score: typeof r.score === "number" ? r.score : correct === null ? null : correct ? 1 : 0, feedback: typeof r.feedback === "string" ? r.feedback : "", status: status || (correct === null ? "ungraded" : correct ? "correct" : "incorrect"), detail: isObj(r.detail) ? (r.detail as JsonObject) : {} };
    },
    listAssets(): AssetDescriptor[] {
      const list = call<unknown[]>("listAssets") ?? call<unknown[]>("listAssetDescriptors") ?? [];
      return list.filter((a): a is AssetDescriptor => isObj(a) && typeof a.id === "string").map((a) => ({ id: a.id, tags: Array.isArray(a.tags) ? a.tags.filter((t): t is string => typeof t === "string") : [], description: typeof a.description === "string" ? a.description : "" }));
    },
    catalogVersion(): string {
      const v = call<unknown>("catalogVersion");
      if (typeof v === "string" && v) return v;
      // Without an explicit version, the catalogue's own contents stand in for one.
      return descriptors().map((d) => `${d.id}@${d.version}`).sort().join(",") + "|" + this.listAssets().map((a) => a.id).sort().join(",");
    },
    createVariant(lesson: VisualLesson, seed: number): VisualLesson | null {
      try {
        const v = call<unknown>("createVariant", lesson, seed);
        return isObj(v) ? (v as unknown as VisualLesson) : null;
      } catch {
        return null;
      }
    },
  };
}
