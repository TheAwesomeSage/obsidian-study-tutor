# Staged compilation · Codex handoff

The compilation branch starts from `1252dca915dd94826ff3fad952449e29d91e95f8` (v0.8.0). The preview integrates the compiler, desktop controls and visual configuration changes. Live tutoring policy, grade interpretation and learner evidence remain on the tutoring workstream.

## Release notes (preview)

- Build courses in stages: map the objectives to the original specification, collect evidence, write a compact card and fuller worked lessons, then audit questions and coverage. A failed fetch or an unmapped clause appears in the compilation report.
- Use optional Ollama passage selection without sending local model prose as evidence. Every selected ID is checked and the plugin copies the original passage. Text matching works if the local model is disabled, missing or returns invalid IDs.
- Optional web research now has enforceable whole-run limits (12 search attempts/20 distinct pages by default, with a reasoned extension to 20/40 for a large specification). Brave Search needs `BRAVE_SEARCH_API_KEY` in the Obsidian process environment. Cached sources do not burn an external request. Only public HTML or text pages are supported; PDFs, IPv6-only hosts and nonstandard ports are reported as unsupported.
- Cancel without losing completed source work. An incomplete recompile is saved as a distinct partial topic. Use the command palette to compile a linked prerequisite or beyond-spec application without changing the existing course or grading history.
- Visual configurations can return a compact unsupported reply. External activities show the module's prediction question; an unchecked duplicate from the settings is no longer shown.

## Integration surface

- `Store.compiledSources(dir)`: saved source revisions with original readable text and stable passage IDs. `Store.compiledPassage(dir, id, radius)` returns the exact passage and up to two neighbors on each side. Authorize `dir` and any graph traversal in the corresponding tutoring tool.
- `Store.loadPackage(dir)?.staged`: optional revision IDs, original objective references, detailed lessons, and audited per-objective `availability`. Each detailed lesson lists its objective, subskill number, passage IDs and question IDs. `CoursePackage.lessons` maps subskill numbers to stable concept IDs. Use audited availability to choose deep material; old packages can lack this field and should continue reading their cards.
- `Engine.expandCourse(request, signal?, progress?)`: typed anchor (directory and concept ID or objective ID), scope, and gap; complete, partial, cancelled or failed outcome. It stores the linked topic and does not modify the anchor topic. Compile through the desktop wrapper when a cancellable progress notice is needed.
- `Engine.compile` and `Engine.refresh` own course writes. Staged course recompiles with changed files or unresolved objectives recheck the whole inventory; the legacy package path still supports its original partial refresh. The topic remains unchanged if a staged candidate is partial.
- Topics synthesized in several objective groups can reference earlier objectives as prerequisites. During release review, check a specification large enough to cross a group boundary and inspect its order and references.

No latency or token savings are claimed without a paired measurement on the same input, model settings and provider conditions. Verify provider-enabled research, live Ollama, the packaged Obsidian build and the merged tutoring workflow before a public release.
