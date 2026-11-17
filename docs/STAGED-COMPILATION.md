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

## Checkpoints

Compilation saves each finished stage under `_compile-cache/`, so a repeated or cancelled compile does not ask the model again for work it already has:

- Source revisions, searches (one day) and pages (seven days), as before.
- Objective plans (`plan-`) and local passage selections (`select-`), as before.
- Each lesson group's synthesis (`synth-`) and coverage audit (`audit-`). A group holds up to six objectives.

A synthesis or audit key is the SHA-256 of the stage's version constant, the model identity (provider and model, with the CLI default named), a digest of the exact system prompt (which includes the compile skill), a digest of the JSON schema and the exact input sent to the model. The synthesis input holds the group's objectives, the passages in its evidence packet, the earlier objectives it may build on, inspected excerpts, the subjects and the target. The audit input holds the lessons and questions derived from the synthesis, so a reused synthesis gives the same audit key. A checkpoint is therefore invalidated by a change to any of these: an edited note or fetched page that reaches the group's packet, different objectives, another model or provider, an edited compile skill or prompt, a schema change, or a bumped stage version (bump it whenever that stage's prompt, schema or reply validation changes). A change in one group's evidence reruns that group only; a later group's audit also reruns if the subskill numbers or question IDs before it shift.

Only replies that pass schema validation are saved, and a saved reply is validated again when read; an invalid or edited entry is ignored and recomputed. Failed or invalid replies are never saved. After a cancellation, the message says how many lesson groups finished; the next compile on the same sources reuses them. The compile metrics count checkpoint reuse (`stageCacheHits`, `groupsReused` of `groups`) and replies that failed validation (`rejected`). An objective whose lesson lists an unverified prerequisite gets the gap "prerequisite <objective> is not verified", so the course stays partial.

Checkpoint reuse skips model calls on unchanged input; no token or latency saving is claimed for it without a paired measurement.

No latency or token savings are claimed without a paired measurement on the same input, model settings and provider conditions. Verify provider-enabled research, live Ollama, the packaged Obsidian build and the merged tutoring workflow before a public release.
