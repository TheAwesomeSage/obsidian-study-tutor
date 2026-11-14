# Visual boundary v1 — early handoff to Claude Code

Base: 6f496c0. Codex branch: codex/visual-player. Authoritative types: src/visuals/contracts.ts.

Registry exports (synchronous, browser/Node safe, no inference):

```ts
listModuleDescriptors(): ModuleDescriptor[]
validateLesson(value: unknown): LessonValidation
assessLesson(lesson: VisualLesson, response: AssessmentResponse): AssessmentResult
```

`LessonValidation = {valid:true;lesson:VisualLesson} | {valid:false;errors:{path:string;message:string}[]}`.
`AssessmentResult = {status:'correct'|'incorrect'|'ungraded'|'invalid';feedback:string;independentMastery:false}`.
`AssessmentResponse = {answer:Json;explanation?:string;prediction?:string;hintsUsed?:boolean}`.

Player: `mountPlayer(host: HTMLElement, value: unknown, options: PlayerOptions): Promise<PlayerHandle>`.
Options carry instructional `reason` and optional `onEvent(event:PlayerEvent):void`. Handle owns `destroy()`.
PlayerEvent is a version:1 discriminated union: opened(moduleId,reason), prediction(text), hint,
play/pause/step/reset(position), settings(settings), completed(response,independentMastery:false),
assessment(response,result). Full exact types live in contracts.ts. Persist attempts separately.
Displayed results/solutions and hints are assisted practice; backend must never promote from a hit.

Module IDs / version: `function-plotter`, `projectile`, `algorithm`, `phet-external`, all `1.0.0`.
Read settingsSchema and assessmentIds from descriptors; do not invent module IDs or executable code.
Use content hashes of the supplied excerpt in SourceRef; paths are provenance, never read by player.

Opening a topic/node must not invoke a generator. Supply a saved validated lesson only after your
on-demand gate or an explicit learner request. Reason travels alongside the saved lesson in the
PresentationRequest. Non-interactive kinds stay with backend. Unsupported objectives return the
missing capability; no paid fallback. Source fidelity still needs backend/human review.

Integration hook will be `TutorView.presentActivity(lesson:unknown, request:PresentationRequest)`.
Please provide backend commit/branch and gate/generator/cache/store entry points for final integration.
Codex owns shared entry/build wiring at integration time; backend files are reserved for Claude.
