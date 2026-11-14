/** v1 is data only. No expressions, scripts, remote assets or model-defined answer checkers. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export interface SourceRef { path: string; contentHash: string; excerpt: string }
export type PresentationKind = "text" | "worked-example" | "diagram" | "simulation" | "game" | "external";
export interface PresentationRequest {
  version: 1; kind: PresentationKind; reason: string; objective: string;
  sourceRefs: SourceRef[]; preferredModuleId?: string;
}
export interface VisualLesson {
  schemaVersion: 1; moduleId: string; moduleVersion: string; objective: string;
  sourceRefs: SourceRef[]; settings: JsonObject; assetIds: string[];
  assessmentId: string; predictionQuestion: string; hint: string;
}
export interface ValidationError { path: string; message: string }
export type LessonValidation = { valid: true; lesson: VisualLesson } | { valid: false; errors: ValidationError[] };
export type GenerationResult =
  | { status: "ready"; lesson: VisualLesson }
  | { status: "unsupported"; reason: string; missingCapability: string }
  | { status: "invalid"; reason: string; validationErrors: ValidationError[] };
export interface ModuleDescriptor {
  id: string; version: string; supportedObjectives: string[];
  settingsSchema: JsonObject; assessmentIds: string[]; assetTags: string[];
}
export interface AssessmentResponse { answer: Json; explanation?: string; prediction?: string; hintsUsed?: boolean }
export interface AssessmentResult {
  status: "correct" | "incorrect" | "ungraded" | "invalid";
  feedback: string;
  /** Interactive practice, including hits, NEVER awards independent mastery. */
  independentMastery: false;
}
export type PlayerEvent =
  | { version: 1; type: "opened"; moduleId: string; reason: string }
  | { version: 1; type: "prediction"; text: string }
  | { version: 1; type: "hint" }
  | { version: 1; type: "play" | "pause" | "step" | "reset"; position: number }
  | { version: 1; type: "settings"; settings: JsonObject }
  | { version: 1; type: "completed"; response: JsonObject; independentMastery: false }
  | { version: 1; type: "assessment"; response: AssessmentResponse; result: AssessmentResult };
export interface PlayerOptions { reason: string; onEvent?: (event: PlayerEvent) => void }
export interface PlayerHandle { destroy(): void }
