# Code walkthroughs

Open **Code walkthrough** (terminal icon) in a study or free chat. Asking to simulate or trace a program also opens it when the current material is about code. The latest supported code fence or attached Python/C/C++ file fills the editor. You can also paste a program directly.

Choose the language and supply console input. **Build walkthrough** asks the configured main provider (Claude Code or Codex) for one structured teaching plan: compilation/structure notes, source-line references, control-flow blocks and arrows, and a narrated trace with variables and output. Schema, source lines and block references are checked before the plan is cached. Main-provider output passes through the normal remote-content cleaner and is rendered as text. Generated plans are never executed.

Trusted local UI constructs the views directly from that plan; another local-model generation is unnecessary. **Previous**, **Next**, **Restart**, trace tables and selecting diagram blocks use no inference. The cache in `Tutor/_cache/code/` survives restarts and changes when source, language, stdin, provider/model identity or prompt version changes. Programs over 24,000 characters and stdin over 4,000 characters are refused explicitly, rather than silently shortened.

**Run program** executes the code currently in the editor through the existing runner. It is separate from building the illustration and never awards mastery. Opening the workspace alone makes no model or execution call. Building or running it marks an existing study question as helped; cold probes and outcome checks cannot open it.

- Python uses the bundled isolated Pyodide worker and its existing execution/output limits. Inspection records up to 120 actual line, return and exception events, including function-local variables and bounded output snapshots. Line events show state **before** the line executes. Values and large containers are abbreviated; the final console output is retained separately within the existing output limit. This is a bounded trace, not an unlimited debugger.
- C and C++ use the existing compiler and native runner, which remains controlled by **Run C and C++ answers** in Settings. Native execution is off by default because it has no sandbox. Console output and compiler diagnostics are real. Their narrated variable/line trace and control-flow plan are model explanations, not debugger observations. The workspace flags a difference between illustrated final output and actual output; matching output does not verify every illustrated intermediate state.
- Source/input/language edits invalidate the current trace and explanation. Closing the workspace cancels active generation or execution. Keyboard focus is preserved when stepping, and flow blocks support Enter/Space.

## Attachments

The paperclip always opens a picker; it no longer depends on an active Markdown editor. Search vault notes or choose a text/source file from the computer. Binary/unsupported files and files over 128 KB are rejected explicitly. Indentation, line breaks and code fences are preserved; Markdown frontmatter is excluded from the attached body.

The attachment is stored separately from the learner's answer in that chat's frontmatter. Retries, follow-ups and restarts keep the exact reference text; another chat does not inherit it. The selected filename is shown beside the paperclip. Open the picker again to change or remove it. Images and PDFs are not supported by this text picker.

## Token savings and verification

The main teaching plan is generated only on an explicit build and reused unchanged afterwards. Playback, diagram drawing and execution are local. Normal tutor prompts omit exact session excerpts already included verbatim in the same prompt's chat; unseen excerpts, original transcripts, source material, grading rules and teaching context are retained. These changes do not establish a measured percentage reduction in usage.

Automated checks cover cache invalidation, malformed plans, request routing, attachment serialization, a picker with no active editor, real Python input/loops/function returns/output, bounded traces, hidden-output protection, native console capture and prompt deduplication. Browser fixtures exercise light/dark layouts, arrows, block selection, source highlighting, stepping, observed-versus-illustrated labels and narrow screens. Browser fixtures use scripted plans; they do not establish the main provider's teaching accuracy. No live-provider benchmark was run for this change.
