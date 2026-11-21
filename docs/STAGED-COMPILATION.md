# Staged compilation and tutoring

The compilation and tutoring branches share the v0.8.0 base at `1252dca915dd94826ff3fad952449e29d91e95f8`. The desktop plugin connects both workstreams through the adapters in `src/tutoring-adapters.ts`.

## Compilation changes in 0.9.0

- Build courses in stages: map the objectives to the original specification, collect evidence, write a compact card and fuller worked lessons, then audit questions and coverage. A failed fetch or an unmapped clause appears in the compilation report.
- Use optional Ollama passage selection without sending local model prose as evidence. Every selected ID is checked and the plugin copies the original passage. Text matching works if the local model is disabled, missing or returns invalid IDs.
- Optional web research now has enforceable whole-run limits (12 search attempts/20 distinct pages by default, with a reasoned extension to 20/40 for a large specification). Brave Search needs `BRAVE_SEARCH_API_KEY` in the Obsidian process environment. Cached sources do not burn an external request. Only public HTML or text pages are supported; PDFs, IPv6-only hosts and nonstandard ports are reported as unsupported.
- Cancel without losing completed source work. An incomplete recompile is saved as a distinct partial topic. Use the command palette to compile a linked prerequisite or beyond-spec application without changing the existing course or grading history.
- Visual configurations can return a compact unsupported reply. External activities show the module's prediction question; an unchecked duplicate from the settings is no longer shown.

## Integration surface

- The source adapter reads saved revisions within the concept's topic. It also finds sources cited by the course package, including web pages. The tutor can request surrounding passages only for excerpts already quoted in the turn.
- The lesson adapter uses the course package's stable concept IDs and audited availability. Older courses use the card and any worked examples they already have.
- The expansion adapter passes the tutor's cancellation signal and objective limit to the compiler. Completed lessons can add an inferred graph relation to the anchor concept. The tutor keeps the current study topic open during compilation.
- `Engine.compile` and `Engine.refresh` own course writes. Staged course recompiles with changed files or unresolved objectives recheck the whole inventory; the legacy package path still supports its original partial refresh. The topic remains unchanged if a staged candidate is partial.
- Topics synthesized in several objective groups can reference earlier objectives as prerequisites. During release review, check a specification large enough to cross a group boundary and inspect its order and references.

## Compile strategies

Settings → Study Tutor → Compile strategy (`compileStrategy`) chooses which models do the stages plan → select → research review → synthesis → audit:

- **Main provider only** (`main`): Claude Code or Codex does every stage, passage selection included. Ollama is never asked.
- **Hybrid** (`hybrid`, the default): Ollama selects evidence passages, and the main provider plans, reviews research, writes and audits. This is the split used before strategies existed; settings saved with the old "Use Ollama for compilation" toggle off become `main`. If Ollama is not running, the model is not installed or the call fails outright, selection falls back to text matching, as before. If Ollama answers but its reply fails the checks (an invalid ID, a reply cut off at the output limit, a timeout), that selection and every later one go to the main provider. This escalation happens in hybrid only. It is counted in `localEscalations`, listed in the issues and shown in the compile notice.
- **Local only** (`local`): Ollama does every model stage, with a 16k-token context and a 6k-token output limit per call, and the main provider is never called for compilation. A stage that fails on the local model is never sent elsewhere. It is reported as "… was not done …" in the issues, the objectives it affects get an explicit gap ("lesson synthesis: the local model could not do this stage …" or "coverage audit: …"), and the course is saved as partial. A partial refresh also needs a main-provider call, so in this strategy a refresh always recompiles the whole topic. Web research, when asked for, still uses Brave and public pages; only inference is local. Lesson prose from the local model passes through `src/safemd.ts`, like a main-provider reply.

### Where inference actually runs

A loopback Ollama can still run a model on ollama.com. Ollama's cloud models (tags such as `gpt-oss:120b-cloud` or `glm-4.6:cloud`) are served by a local Ollama that forwards the request. So the server address does not prove that a model is local. `locateLocal` (`src/ollama.ts`) decides:

1. A cloud tag (`:cloud` or ending in `-cloud`) means cloud, without a request.
2. Otherwise the client asks `POST /api/show`. A `remote_host` that is not a loopback address, or a `remote_model`, in that reply or in the model's `/api/tags` entry, means cloud. A server that is not on this computer is cloud too.
3. If Ollama cannot be asked (not running, model missing, a reply that is not a description), the result is "unknown". Unknown is never treated as proof of local inference.

The local strategy refuses any model that is not proven local, before any prompt is sent: the topic is saved as partial with the reason. Hybrid uses the model but labels it (`localRuns`: `local`, `cloud` or `unknown`), and a cloud model adds a "Cloud inference" issue. Local activity configuration (`src/configure.ts`) is described as running on this computer, so it refuses a cloud or unknown model before any call. The refusal is transient, so it is not cached. A `LocalModel` without `describe()`, such as a test double, is judged by its name alone. The plugin's Ollama client always asks the server. The settings' Test button reports where the configured model runs.

## Checkpoints

Compilation saves each finished stage under `_compile-cache/`, so a repeated or cancelled compile does not ask the model again for work it already has:

- Source revisions, searches (one day) and pages (seven days), as before.
- Objective plans (`plan-`) and local passage selections (`select-`), as before.
- Each lesson group's synthesis (`synth-`) and coverage audit (`audit-`). A group holds up to six objectives.

A synthesis or audit key is the SHA-256 of the stage's version constant, the model identity (provider and model, with the CLI default named), a digest of the exact system prompt (which includes the compile skill), a digest of the JSON schema and the exact input sent to the model. The synthesis input holds the group's objectives, the passages in its evidence packet, the earlier objectives it may build on, inspected excerpts, the subjects and the target. The audit input holds the lessons and questions derived from the synthesis, so a reused synthesis gives the same audit key. A checkpoint is therefore invalidated by a change to any of these: an edited note or fetched page that reaches the group's packet, different objectives, another model or provider, an edited compile skill or prompt, a schema change, or a bumped stage version (bump it whenever that stage's prompt, schema or reply validation changes). A change in one group's evidence reruns that group only; a later group's audit also reruns if the subskill numbers or question IDs before it shift.

Stage keys name the model by its configured alias (for example `sonnet`, `codex:gpt-5`, or `ollama:qwen2.5:3b` in the local strategy). Each plan, selection, synthesis and audit checkpoint is saved as `{ model, value }`, where `model` is the concrete model that wrote the reply:

- Claude Code: the id the CLI reports in its JSON result's `modelUsage`, keyed by the model id the API was called with (for example `claude-sonnet-4-5-20250929`). With several entries, the one with the most output tokens is used.
- Codex CLI: its `exec --json` events name no model, so the configured identity is kept.
- Ollama: the tag with the digest from `/api/tags`.

A checkpoint is reused only if its model matches the current concrete model. For the main provider, the current model is the one the CLI last reported for that alias in this session. Any call counts, a chat turn included (`reportedModel` in `src/model-provider.ts`). With no report yet, the first checkpoint read sets it. Once a call reports a different model, later checkpoints from the old one miss and are recomputed, and an issue says so. A fully reused compile makes no call, so it can only notice that an alias has moved through a report from earlier in the session. Entries written before identities were recorded are bare replies. They are read and miss once, and the recomputed reply is saved with its identity. `metrics.mainModel` and `metrics.localModel` name the models used.

Only replies that pass schema validation are saved, and a saved reply is validated again when read; an invalid or edited entry is ignored and recomputed. Failed or invalid replies are never saved. After a cancellation, the message says how many lesson groups finished; the next compile on the same sources reuses them. The compile metrics count checkpoint reuse (`stageCacheHits`, `groupsReused` of `groups`) and replies that failed validation (`rejected`). An objective whose lesson lists an unverified prerequisite gets the gap "prerequisite <objective> is not verified", so the course stays partial.

Checkpoint reuse skips model calls on unchanged input; no token or latency saving is claimed for it without a paired measurement.

No latency or token savings are claimed without a paired measurement on the same input, model settings and provider conditions. Verify provider-enabled research, live Ollama, the packaged Obsidian build and the merged tutoring workflow before a public release.

## Question generators

A short question whose answer is one number worked out from values in the question may carry a `generator`: a bounded family spec written once by the synthesis call, as data. The spec gives parameter ranges, conditions, a question template, an answer expression, worked steps and expected mistakes (`src/families.ts`). The model never supplies code. The plugin's own parser accepts a small expression grammar, with no `eval`.

A spec is kept only when trusted code accepts it and one of its tests gives the answer the question states. Otherwise it is dropped and the question keeps its own numbers. `generators` and `generatorsRejected` in the compile metrics count both outcomes. The synthesis stage version is `synthesis-2`, so checkpoints saved before generators existed are recomputed once.

In the bank (`src/bankvariants.ts`), a question you have met comes back with new numbers. Its id records where it came from: `Q3~17` is question Q3 with seed 17, `Q3~17#fix0` is the repair task for that instance's first expected mistake, and `Q3~17#fade2` is that instance as a worked example with two steps left to the learner. Every one of these is rebuilt from its id and marked by code. New numbers share the question's family and its review card, so they count as practice, never as transfer. Repairs and faded examples are recorded as helped work.

Question families kept for assessment (`questionFamilies` in `src/coursepkg.ts`) are never used by practice or placement when there is another family. A delayed check uses one only as a last resort, and a transfer check takes a kept family you have not met first.
