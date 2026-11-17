# Changelog

What changed in each version of Study Tutor, newest first.

## Version 0.9.1

- Choose Claude Code or Codex CLI (ChatGPT) in Study Tutor settings. The selected provider handles tutoring, compilation and grading. Settings remember the path and models for each CLI.
- Replies and researched web pages can no longer load anything from outside the vault. A remote picture becomes a plain link, a tag that would fetch something is shown as text, and a block that Dataview or JS Engine would run as JavaScript is shown as ordinary code. Fenced code is left exactly as written. The same check runs again on whatever the study view renders, so chats saved by earlier versions are covered when they are reopened.
- Prompt files, which hold the topic card, are written to a folder only your account can read, and are rewritten on every call.
- For anyone reading the code: `src/engine.ts` is split by concern. Activities, question-bank turns, compilation, linked-material requests, marks and the turn's tools each have their own `src/engine-*.ts` file, and the shared types and rules are in `src/engine-common.ts`. The method bodies moved unchanged, and `Engine` exports what it did before. The study turn itself (`turn()`) is still one long method.
- Every push and pull request now runs the type check, the build, the unit tests and the browser tests on Windows and Linux (`.github/workflows/ci.yml`).

## Version 0.9.0

- Master mode chooses a tutoring move and shows its reason in Details. Misconceptions are tied to attempts and can change when an answer is disputed or regraded.
- Open-answer feedback separates the result, method and assumptions. SymPy is identified separately when it checks the result.
- Detailed turns can read the compiled lesson and original passages. Retrieval follows at most one relevant course link and skips rejected links.
- Study Tutor can compile a prerequisite or an application beyond the specification from chat. The session can continue during compilation, and the request can be cancelled.
- Course packages show which objectives have sources, teaching and assessment. Research is optional and has configurable limits. Completed source work is cached, and partial recompiles keep the previous course.

Versions before 0.9.0 retain the plain misconception list. If an older version saves the topic, it drops the new misconception history and reasoning breakdowns.

## Version 0.8.0

SymPy now ships with the plugin and works offline.

- **Why it did not work before.** Maths checking was off by default, and switching it on made the first use download Python and SymPy (about 20 MB) from the jsDelivr CDN, so it failed without a connection or when the CDN was blocked.
- **Now** Pyodide 0.26.4 (Python 3.12), SymPy 1.12 and mpmath 1.3.0 are in the release's `pyodide` folder (about 30 MB). The plugin checks each file's SHA-256, hands the files to the SymPy worker, and the worker fetches nothing from the network. A damaged or missing file is reported in Settings → Study Tutor → Maths instead of being replaced by a download.
- **On by default.** Maths checking is switched on for new installs, and switched on once for an earlier install that has the `pyodide` folder (a notice says so; switch it off under Maths if you prefer). The CDN is used only when the folder is missing.
- The SymPy test in `npm test` now runs on the bundled runtime, so it is no longer skipped.

Verified in Obsidian 1.15.1 with an isolated vault: with the bundle, SymPy loaded from the plugin folder in about 7 s and with the network cut in about 11 s, computed and checked `integrate(x*exp(x), x)`, accepted `1/2` for `0.5` and rejected `(x+1)^2 + 1` for `x^2+2x+1`; without the bundle and with the network cut it fails as 0.7.0 did. Unit tests: 132 of 132 pass. Install by unzipping `study-tutor-0.8.0.zip` into `<vault>/.obsidian/plugins/`; the `pyodide` folder must come too.

## Version 0.7.0

More room for the chat and the map, and a way to delete a session.

- **Study screen.** The open question is no longer pinned above the answer box: it is the last message in the chat. **Hint**, **Explain**, **Skip** and **Visual** sit beside the box instead of above it. The strip that explained the chosen step ("Master mode, chosen by you") is gone; in Adaptive and Learn the step is a small header button whose reasons open on demand.
- **Confidence** is five points (None, Low, Medium, High, Very high) instead of a long slider, and can be chosen at any time, not only while a question is detected as open. Saved confidences are shown in the same words.
- **Delete a session** from the study header (then a new one starts in the same mode) or from **Recent sessions** on Home. It asks first, moves the chat, its earlier parts and its session notes to the trash, and keeps your answers, levels and saved activities.
- **Graph.** The controls moved from a bar above the map into the sidebar on the right, with a smaller title, and the view buttons into a small island at the map's top left. With a single topic the map is coloured by demonstrated level.
- The logo and "Study Tutor" name are gone from the top bar; the pane's tab already says it.

Verified in Obsidian 1.15.1 with an isolated vault (screenshots in `docs/verification/`, 0 console errors), plus the unit tests (130 of 131 pass; the native SymPy test is skipped without a local Python) and 6 browser tests. Install as for 0.6.0: the whole release folder, or unzip `study-tutor-0.7.0.zip`.

## Version 0.6.0

Install the whole release folder: besides `main.js`, `manifest.json` and `styles.css`, copy `player.js`, `plot.js` and the `assets` folder (or unzip `study-tutor-0.6.0.zip` into `<vault>/.obsidian/plugins/study-tutor/`).

- **Visual activities on demand.** Ask for a simulation, diagram or game while studying, or open one the guide offers after a repeated difficulty. Four modules: a function plotter (JSXGraph) with a draggable point and tangent, a projectile target challenge with velocity and acceleration components, an algorithm player that follows real traces (indexing, bubble sort, linear and binary search), and PhET links with a source-based question. Each asks for a prediction first, and moving controls, playing and resetting use no model.
- **Configured locally, never by Claude.** A new activity is configured from a short excerpt of your notes by qwen2.5:3b through Ollama on this computer, checked by the module itself, and saved; it reopens with no model at all, and **New numbers** gives fresh values made by the module. When no module fits, the compiled worked example is shown and the request is noted in `_logs/capability-requests.md`.
- **Evidence and study choices.** Each concept has a next unaided check, and help no longer counts as renewed retention. A transfer question is set only when it can count, and question families decide what is new. Prerequisites in other topics are checked one by one and taught when a check fails. Level 5 now needs an unaided teach-back and an edge case; an older level 5 shows as not yet backed. Home suggests exactly what Adaptive study would do first. Answers inside activities count as helped work.
- **Compilation.** Each topic gets a course package (`package.md`) with objectives and their coverage, worked examples, question families, rubrics, sources and visual eligibility. Recompiling rewrites only the subskills whose notes changed, and calls no model when nothing did.
- **SymPy** lines now say when a stated result could not be checked, or was checked only numerically.
- **Graph.** Arrows show what each concept requires, inferred prerequisites are dashed, and a concept's panel shows what you can do now, the evidence, the next step and the next unaided check.

Verified in Obsidian 1.15.1 with an isolated vault and the real local model (`docs/INTEGRATION.md`, screenshots in `docs/verification/`), plus the unit tests (129 of 130 pass; the native SymPy test is skipped without a local Python) and 6 browser tests. Local inference runs on the CPU: about 20–30 s to configure a new activity on an i5-1335U.

## Version 0.5.2

Fixes found by running 0.5.1 in Obsidian 1.15.1 and in scripted live sessions (`npm run test:session`).

- A quick check on a prerequisite from another topic is recorded against that prerequisite, in its own topic. Before, a wrong answer counted as a failure on the concept being studied, and a hint in between relabelled the check as guided practice. After a revealed or skipped check, the tutor's mark may name the prerequisite its next question tested; only a real prerequisite of the concept is accepted, and otherwise the answer counts for the concept being studied. A worked example on the prerequisite no longer counts as a lesson on that concept. A disputed answer is found in whichever topic keeps it.
- The Knowledge Graph opens fitted to the pane, and keeps fitting as the pane settles until you pan or zoom. Every topic gets its colour, name and count, including one compiled since the view opened. Topic names sit above their own cluster. Switching between light and dark repaints the map. Maps of 40 concepts or fewer label every concept, and the key folds away (folded at first on a narrow pane).
- Home: study tiles are left-aligned when stacked.

Measured in four live sessions: the first turn of a chat with a cold cache reads nothing from it; later turns read 42–57% of prompt tokens from the cache (the fixed instructions, about 2.5–2.8k tokens). An 8–9 turn session cost $0.12–0.14.

## Version 0.5.1

The Home screen brings together resume, topic search, review, study modes and the course graph. The study composer has an initially unset confidence slider. Adaptive mode chooses teaching, local practice and checking; Learn mode stays within guided learning. Session records and exact working survive interruption and rotation. Attempts retain grading provenance and assistance; unsupported level changes are refused.

### Synoptic connections

Select a concept in the Knowledge Graph and use **Suggest a synoptic connection** (one model call), or add a **synoptic** relation manually. A connection includes an explanation and a joint problem requiring both concepts. Suggested links are unreviewed until confirmed. After confirmation, **Study connection** opens the joint question in a new tutoring session. Existing sessions remain saved. The selected concept receives assessment evidence; the link itself never awards mastery to either concept or becomes a prerequisite. Rejected suggestions stay recorded so the same pair is not repeatedly suggested. Connections are symmetric and duplicates in the reverse direction are refused.

Model suggestions are limited to up to 40 candidate concepts and need review for correctness and syllabus relevance. No WolframAlpha adapter is present in this version. The registered tools cover SymPy checks, vault retrieval and graph inspection. Numerical sampling and symbolic agreement have explicit limits and do not certify a complete proof.
