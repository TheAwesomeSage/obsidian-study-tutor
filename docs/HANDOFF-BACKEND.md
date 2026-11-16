# Backend handoff: Claude Code → Codex

Branch `claude/learning-backend`, base `6f496c0`, worktree
`C:\Users\Ojas0\Documents\Codex\2026-11-13\can-you-scan-this-repo-https\work\obsidian-study-tutor-backend`
(the repository that also holds `work/v0.5.1`). Not pushed. Commits are listed at the end, and in
`git log 6f496c0..claude/learning-backend`.

Everything here is verified against **test fixtures** and, for the benchmark, against a read-only
bundle of the visual workstream's **uncommitted** `src/visuals/registry.ts` (working tree of
`codex/visual-player`, `registry.ts` SHA-256 prefix `b60b68e3d2bc4918`, 17:29 on 2026-11-14).
**End-to-end integration with the real player has not been done or claimed.**

## Contract alignment

`src/visualcontract.ts` is the temporary adapter. Its shared types match `src/visuals/contracts.ts`
at `fc98165` field for field (`GenerationResult` with `missingCapability: string` and
`validationErrors: {path,message}[]`; `LessonValidation` with `valid`; `AssessmentResult` with
`status` and `independentMastery: false`). At integration:

1. Replace the shared type declarations in `visualcontract.ts` with re-exports from
   `./visuals/contracts`, keeping the backend-only types (`MissingCapability`, the backend
   `AssessmentResult` with `correct`, `ModuleRegistry`) and `adaptRegistry`.
2. In `main.ts` `buildStore()`, after `this.buildLocal()`:
   `this.engine.visuals = adaptRegistry(registry as unknown as Record<string, unknown>)`
   with `import * as registry from "./visuals/registry"`.

`SourceRef.contentHash` is SHA-256 of the excerpt (pure implementation, `formats.ts` `sha256`),
which is what `validateLesson` checks. Paths are provenance only.

## Entry points and examples

All return without calling Claude unless stated. `dir` is a topic folder, `chatPath` a chat file.

```ts
// A study turn. When the learner asks "show me a simulation" and a module fits, the reply is
// local (r.local === true, no Claude call) and r.presentation carries the lesson.
const r = await engine.study(dir, chatPath, "can you show me a simulation of this?");
r.presentation?.decision   // { kind, trigger: "explicit"|"difficulty"|"tutor", status, reason (≤140 chars), moduleId, activityId, candidates }
r.presentation?.lesson     // VisualLesson | null: ready to mount
r.presentation?.request    // PresentationRequest (version 1, kind, reason, objective, sourceRefs, preferredModuleId)
r.presentation?.result     // GenerationResult in the contract's shape
r.presentation?.activity   // ActivityRecord: provenance, versions, timing, localCalls, repairs, claudeCalls: 0
r.presentation?.fallback   // compiled worked example shown when no interactive is available
r.presentation?.calls      // { local: n, claude: 0 }

// decision.status: "cached" | "configure" → lesson is set (explicit requests execute directly)
//                  "offer"               → nothing generated; show a button with decision.reason
//                  "text"                → the tutor wrote it (worked example, or a Mermaid diagram)
//                  "unsupported"         → no module; activity.missingCapability; fallback shown

// The offer button, or any explicit "Show a simulation" control:
const out = await engine.requestActivity(dir, { kind: "simulation", concept: n, chatPath });
// Reopen a saved activity (no model at all); with a seed, a module-made variant if supported:
const again = await engine.openActivity(dir, out.activity!.id, { chatPath, variantSeed: 7 });
// The player's "assessment" event: the backend re-assesses with module code and records
// helped evidence. Pass the contract's AssessmentResponse unchanged.
const res = await engine.recordActivityResult(dir, out.activity!.id, { answer: 9, prediction: "index 9", hintsUsed: false }, { chatPath });
// res.assessment.correct (true|false|null), res.attempt (assisted: true, taskType: "interactive"), res.changes

await engine.activityReport(dir);   // offered, unopened (unnecessary activations), generated, reused, failed, unsupported, resolved/unresolved
await engine.recommendTopic(dir);   // Home: { step, decision }, the same decision Adaptive makes first
await engine.refresh({ ...compileRequest, existingDir: dir }); // recompile: unchanged | partial | full
```

Store: `loadActivities(dir)`, `loadActivityLog(dir)`, `loadCapabilities()`, `loadPackage(dir)`.

### Player wiring (recommended, Codex-owned files)

- After `engine.study(...)` in the study screen: if `r.presentation?.lesson`, call
  `view.presentActivity(r.presentation.lesson, r.presentation.request)` and show
  `decision.reason`. If `decision.status === "offer"`, render an "Open {kind}" button with the
  reason that calls `engine.requestActivity(dir, { kind, concept, chatPath })`, then presents the
  returned lesson. If `"unsupported"`, the reply already says so; nothing to mount.
- `PlayerEvent` handling: `assessment` → `engine.recordActivityResult(dir, activityId, event.response, { chatPath })`.
  `hint` → remember it and pass `hintsUsed: true` in the response. `play/pause/step/reset/settings`
  → nothing: no backend call, no model call. Keep the activity id with the mounted player
  (`r.presentation.activity.id`).
- Never call `requestActivity` on opening a topic, a note or a graph node. Graph node details may
  show eligibility from `package.md` (`lessons[].visual`) as text only.

## Recommendations for Codex-owned files

1. Add optional `kinds?: PresentationKind[]` to `ModuleDescriptor`. Until then the backend infers
   `external` for `phet-external` (id/objective mention PhET or external) and diagram, simulation
   and game for the rest.
2. Add optional `questionTemplates?: Record<assessmentId, string>` with `{setting}` placeholders.
   The backend already uses it in place of the local model's question. The benchmark shows why:
   for `bubble-sort` the model asked about "the value after the first pass" while `trace-result`
   checks the final sorted array.
3. Export `listAssets(): {id, tags, description}[]`. Assets currently have no description, so the
   backend offers none to the model and `assetIds` is always `[]`.
4. Export `catalogVersion()`; the backend otherwise derives one from descriptor ids/versions.
5. Export `createVariant(lesson, seed)` (for example from `numericVariant`); the backend validates
   any variant with `validateLesson` before using it.
6. `algorithm` requires `target` and `index` even where unused. In the benchmark the model set
   `target` equal to the expected answer for `index` mode, so hide unused settings in the player,
   or the answer is on screen.
7. `supportedObjectives` as long sentences is fine: the backend shortlists a module when at least
   two specific words of one objective appear in the card or the source excerpt. A one-line
   `summary` per descriptor helps the 3B model.
8. `tests/ui.test.ts` (jsdom UI test): two assertions changed: Home now shows the policy's
   Diagnosis step, and the policy version is 3.

## Migrations (all backward compatible, nothing deleted)

- Attempts gain optional `taskType` and `family`. Older attempts read as `""` ("untyped").
- Level 5 now needs an unaided teach-back and edge case. An older level 5 reads as **not yet
  backed** with the reason, including how many earlier answers predate task types.
- Chats gain `prereq_checks` (JSON, by prerequisite id → asked | correct | partial | incorrect |
  skipped | ungraded | taught). The old `checked` list (subskill numbers) is still honoured.
- Topic cards may have `## Objectives`, `objectives:`, `visual:` and `worked example:`; question
  banks may have `family:`, `task:`, `difficulty:`, `rubric:`. Older cards parse as before; their
  package lists objectives from subskills and is marked incomplete (no worked examples).
- New per-topic files, created lazily: `package.md`, `activities.md`, `activity-log.md`; and
  `_logs/capability-requests.md`. The first recompile of a pre-0.6 topic is a full compile (no
  package yet); later ones refresh only what changed.
- Changed bundled skills: `compile.md`, `core.md`, `mode-tutor.md`, `policy.md`. The existing
  installer updates vault copies the user has not edited and keeps edited ones.
- Policy version 3 in `_logs/decisions.md`.
- Settings: `localActivities` (on), `localModel` (`qwen2.5:3b`), `ollamaUrl` (`http://127.0.0.1:11434`, loopback only).

## Commits and touched files

| Commit | What |
|---|---|
| `12f2de9` | Gate, local configuration, cache, evidence and policy v3, course package and refresh, tests |
| `e898b0b` | Contract alignment (SHA-256, result shapes), excerpt-aware shortlist, question templates, benchmark |
| tip | This handoff |

Shared files Codex resolves at integration: `src/main.ts` (settings, `buildLocal`, `readSource`,
refresh on recompile, "Interactive activities" settings), `src/view.ts` (Home uses
`engine.recommendTopic`, one line), `package.json` (`test` includes `presentation.test.cjs`;
`bench:qwen`), `esbuild.config.mjs` (two test entry points), `.gitignore` (`bench/out/`),
`README.md`, `tests/ui.test.ts` (two assertions). No stylesheet changes.

Backend files: `src/configure.ts`, `src/coursepkg.ts`, `src/jsonschema.ts`, `src/ollama.ts`,
`src/presentation.ts`, `src/visualcontract.ts` (new); `src/engine.ts`, `src/evidence.ts`,
`src/formats.ts`, `src/overview.ts`, `src/policy.ts`, `src/prompts.ts`, `src/store.ts`,
`src/sympy.ts`; `skills/compile.md`, `core.md`, `mode-tutor.md`, `policy.md`; tests
`tests/presentation.test.ts`, `tests/fixtures/visual-modules.ts` (FIXTURES), `tests/qwen-bench.ts`,
and small updates to `learning`, `maths` and `router` tests; `bench/`.

## Test and build results

- `npx tsc --noEmit`: clean. `npm run build`: `main.js` 321.7 kb.
- `npm test`: 110 tests, 109 pass, 1 skipped (native SymPy; no Python with SymPy here). Baseline
  at `6f496c0` was 77 tests, 76 pass, 1 skipped. Five baseline tests were updated for intended rule
  changes (level 5, honest SymPy lines, a due delayed check, Home's suggestion, policy version).
- New coverage: explicit requests, sufficient text-only turns, opening a chat, cache reuse and
  invalidation, unsupported capabilities (code and model), impossible challenges, malformed JSON,
  bounded repair, repeated failures (no retry by either model), helped attempts after an
  activity, assessed activity answers, Practise bank questions, the tutor's `<present>` field,
  delayed checks, same-day transfer, families, teach-back/edge case, prerequisite checks by id,
  Home/Adaptive agreement, package coverage, partial refresh, SHA-256 vectors, Ollama request shape.

## Benchmark (details in bench/REPORT.md)

qwen2.5:3b on CPU (Iris Xe unused, `size_vram 0`), Ollama 0.40.16 on localhost, against the
uncommitted registry bundle. Ten real Software Systems excerpts: routing matched my labels 9/10;
the one expected-supported excerpt (memory as an array of bytes) was declined, so 0 activities
were produced from real notes; the nine refusals were correct. 0 Claude calls; reopening costs 0
model calls. Cold first call about 36 s, warm median about 25 s (about 8 tokens/s; a refusal costs
as much as a configuration). Synthetic controls, labelled separately: 3 of 4 supported texts
configured. One configured lesson asked a question its assessment does not check, and one put the
answer in an unused setting: see recommendations 2 and 6. qwen3:1.7b not run (optional, later).

## Pending integration items

- Registry wiring in `main.ts`, player mounting and offer UI in the study screen, assessment
  events to `recordActivityResult`. Then an end-to-end run in Obsidian with the real modules.
- Re-run `npm run bench:qwen` against the committed registry once `src/visuals` is final.
- Topic page could show `coverageLine(pkg)` from `package.md` (the compile notice already does).
- Not run here (cost): `test:live`, `test:features`, `test:session` against the real Claude CLI.
- Agent-browser: not implemented. Nothing in the current source workflow needs browser
  interaction; research stays WebSearch/WebFetch, compile-only.
- SymPy's native Python test is still skipped (no Python with SymPy on this machine).
