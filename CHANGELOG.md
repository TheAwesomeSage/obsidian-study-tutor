# Changelog

What changed in each version of Study Tutor, newest first.

## Unreleased

- Optional semantic source recovery uses the configured local Ollama model when keyword evidence is thin. It selects existing passage IDs, preserves source text/citations, and falls back within a four-second budget. Cloud/unknown models are refused; repeated failures cool down and successful results are cached. It never grades answers or changes mastery. See docs/SEMANTIC-RETRIEVAL.md.

- Activity-aware tutoring: the study screen passes a bounded snapshot of the learner's latest visual prediction, controls, action and response to the next tutor call on the same chat and focus. Playback itself still uses no inference.
- Placement now has a Skip pretest control that leaves remaining questions unmarked.
- Confidence mismatches now produce specific reflection feedback and tutor context. A later-day fresh check wins otherwise tied practice selection without changing marks or overriding existing policy constraints.
- Coding coach is an opt-in, chat-scoped control beside the composer. It guides goal, prediction and repair; Stop returns to normal routing. Enabling it on an open question records help.
- Added a combined feature evaluation and source/limitation ledger in docs/FEATURE-EVALUATION.md and docs/CLAIM-LEDGER.md. Neural tracing and learned sequencing remain explicitly unimplemented experiments.

- **Cold probes measure transfer to unseen work.** The compile now writes one extra question per lesson to `sealed.md`, kept out of the question bank, flashcards and review so they stay unseen. A cold probe asks up to six of them with no help; the topic page shows the unseen-task score (after 3 answers) and tags a concept "not transferring" when its latest probe answer was wrong at level 4 or higher.
  - The coverage audit checks each sealed question like any other, but a sealed question never counts as assessing its objective. Lesson groups saved by an earlier version are synthesised again on the next compile, so that compile asks for the probes.
  - The audit is now told each lesson's probe ids, so it cannot leave a probe out as outside its lesson. After a probe answer, "How this was checked" says it counts toward the unseen-task score only, not "unaided evidence".
  - A recompile keeps an old sealed question, with its id, over a reworded copy of it, and drops one that a new bank question nearly copies. `sealed.md` counts these with the other near-copies it dropped.
  - Home says when a probe is due on any topic, and which topic it is for (first one, every 14 days, or weekly in the last 7 days before an exam). Starting a probe while one is unfinished goes back to it.
  - Practise always opens a normal chat rather than continuing a probe, and a finished probe is no longer the chat its topic reopens on.
  - Only a closing "?" makes a probe answer a question, so an answer that starts with "when" or "how" is marked. Requests for a hint or a visual are still refused.
  - When a recompile has retired a probe's remaining questions, the probe says so as it closes, and a probe that asked nothing does not report "0/0 right".
  - Probe answers are recorded with `probe: true` and change no level, estimate, card or misconception, and their timings do not decide whether a practice answer was slow. Disputing a probe mark takes that answer out of the unseen-task score; a sealed question has no regrade.
- Questions kept for the transfer check no longer appear as new review cards or in the Spaced Repetition note, so they are still unseen when the check comes.
- **A mark can no longer say more than the judgement behind it.** Every grading path (the question bank's grading call, the tutor's mark in conversation, a regrade after a dispute) now goes through one set of rules in `src/grading.ts`:
  - An answer the grader says it could not check is left ungraded, whatever overall mark came with it.
  - A right final answer, even one SymPy checked, is no longer counted fully correct when the rubric asks for a method or assumptions nobody could judge. It is recorded as partly right and kept out of the evidence either way.
  - A flawed method or a wrong assumption still earns justified partial credit.
  - A lower mark that the breakdown gives no reason for is not counted against you.
  - The feedback panel shows the mark as proposed, the mark as recorded, and why.
- A tutor's mark is no longer labelled "confirmed" when SymPy only recomputed the results in the tutor's own reply. That check is still shown, but it does not verify how your answer was marked.
- **Objective versions.** Each compile records a version for every objective. The version goes up only when what the objective asks for changes materially, for example a corrected number, an added condition or a new requirement. Tidying a note (spacing, formatting, a typo) leaves versions and mastery alone. After a material change, your earlier answers stay on record and count as before, but the concept gets one focused recheck. The study plan says what changed, and so does the graph view's Current capability panel. Every new attempt records the objective versions it assessed. The first compile after updating sets the baseline and flags nothing.
- **Compilation checkpoints.** Lesson synthesis and the coverage audit are saved per lesson group once they pass validation. A repeated compile, or a rerun after you cancel, reuses the finished groups instead of asking the model again. A different model, prompt, schema or source passage invalidates the saved group. The cancel notice says how many groups were saved. A lesson that builds on an unverified prerequisite is now reported as a gap, so partial coverage stays explicit.
- **Question families kept for assessment stay unseen.** The course package already marked some question families as kept for assessment: the transfer ones, or the last of three or more on a subskill. Nothing enforced that, so practice could use them up. Now Practise mode, practice in Adaptive and placement never take a question from a kept family when there is another. A delayed check uses one only when nothing else is left, and a transfer check takes a kept family you have not met first. Practise mode can therefore reach the end of the bank sooner than before.
- **New numbers without a model call.** When compiling, a short question whose answer is one number worked out from values in the question can come with a family spec: the values' ranges, the formula, the worked steps and the common mistakes. The model writes only the spec. The plugin's own code checks it, and keeps it only when the formula gives the question's stated answer. A spec the plugin rejects is dropped, and the question keeps its own numbers. From then on:
  - A question you have met comes back with new numbers. The plugin works out and marks the answer, so no model call is needed. New numbers on a family you have met count as practice, not transfer, and as the same question when distinct questions are counted.
  - An answer that matches a known mistake is recorded with that mistake's name. The next task is a worked solution that makes the same mistake: find the wrong step and give the right answer. Then a fresh set of numbers checks the fix without help. The repair counts as helped work; only the fresh check can count as unaided.
  - In Adaptive mode, guided practice on such a question is a faded worked example: the first steps are shown, you finish it, and each right answer leaves one more step to you. It counts as helped work.
  - The compile summary records how many specs were kept and how many were dropped.
  - **A repair or a faded example no longer moves the question's review card.** Both show the solution, so they used to push the card's next review out as if you had answered unaided. Now only an unaided answer on new numbers does. Cards already scheduled stay as they are.
  - **Mistakes get a review of their own.** A mistake the plugin recognises starts a small card that is checked inside Practise and Adaptive sessions, not in the Review screen or the due counts. When it falls due, the next question is the same family on new numbers, without help. A right answer moves the card out; the same mistake again brings it back. Cards of known mistakes are kept when a refresh keeps their question.
  - **Contrasting pairs.** In Adaptive mode, once the faded examples have run out, guided practice can show one case worked in full and then the same question with one value changed, and ask for the second answer. Code marks it, it counts as helped work, and it moves no card. At most two a question.
- **Coding exercises marked by running your code.** For a programming objective the compiler can write a coding exercise in Python, C or C++. Its tests are data, inputs with expected outputs or arguments with an expected return value, and the plugin checks every task before keeping it. A task that fails the check is dropped whole and counted in the compile summary. In Practise mode your code runs against the tests:
  - all tests passing is right; some passing is partly right; none passing, a compile error or a sanitizer report is wrong.
  - The feedback shows each test's result, what ran the code and the limits it ran under. Hidden tests are named only after your answer is marked.
  - Passing tests is strong evidence, not proof. A rubric that also asks for a method keeps the answer partly right until someone judges the method. Threaded code counts as fully right only when a thread sanitizer checked the run, because tests cannot show a program is free of races.
  - When the code cannot be run here, one grading call judges it, and the attempt says it was not run.
- **Where code runs.** A new *Code* section in settings controls it:
  - Python answers run in the plugin's bundled Python, in a worker of their own. It works offline, cannot reach your vault, your files or the network, and each test has a time limit. It is on by default. It keeps ordinary code contained, but it is not a hardened sandbox against code written to break out.
  - C and C++ answers are built and run with a compiler already on your computer (g++ or clang++). This is off by default, because the program then runs with no sandbox. Turn it on and set the compiler path in the same section.
  - When your compiler has them, C and C++ builds turn on checks for memory errors and undefined behaviour, and a thread sanitizer for multi-threaded tasks. The result says when a check was not available.
  - The *Check* button runs a tiny program in each runner and shows what it found.
- **Compile strategy.** A new setting chooses which models compile a course:
  - *Main provider:* Claude Code or Codex does every stage, and Ollama is never asked.
  - *Hybrid* (the default, the same split as before): Ollama picks the passages and the main provider does the rest. A local reply that fails its checks hands that step, and later ones, to the main provider, and the compile notice counts how often that happened.
  - *Local only:* Ollama does every stage and the main provider is never called. A stage the local model cannot do is shown as a gap in the coverage.
  - Nothing falls back to the cloud without saying so. An Ollama address on this computer can still serve a cloud model, so the plugin checks the model itself. Local only refuses a cloud model, or one it cannot prove is local, before any prompt is sent. Hybrid labels it as cloud inference. The compile notice says which model answered and where it ran.
  - The old Ollama toggle, when it was off, becomes *Main provider*.
- Saved compile checkpoints now record the exact model that wrote them, not only its alias. A checkpoint from a different model is not reused. Checkpoints saved by earlier versions are redone once.
- **Exam details on objectives.** An objective line can end with exam details in brackets, such as `(weight 8%, paper 2, command: derive, 6 marks, 8 min)`, and a topic can have an exam date. See `docs/OBJECTIVE-METADATA.md`. A heavier weight and a near exam raise a concept's study priority, always between ×0.75 and ×1.5, and the study plan says by how much. Unaided practice suggests the exam's time per question when you have that long. Without exam details nothing changes.
- **Knowledge tracing, shown but not used.** Diagnostics and the graph view show a Bayesian knowledge tracing estimate for the focus concept, labelled "shadow", with its prediction score next to the current estimate's. It counts only unaided answers, as the levels do. It never chooses a step or changes a level. It is there to be measured before anyone relies on it.
- **Every idea gets asked, and questions follow on from each other.** A subskill is now made of ideas (the objectives it teaches, or the claims on its card), and the plugin keeps which of them your answers have touched. Previously a concept could reach its level on a few questions about one idea while others were never asked.
  - Within a concept, the next bank question prefers an idea you have not been asked. At target, a concept is not treated as done while an idea its bank can ask has never been asked; the step says which. Levels are not affected. Policy version is now 4.
  - After each answer the next question builds on it or moves on. It builds on it, on the same idea from another angle, when the answer had help, was wrong or partly right, was right but you said you were unsure, or was right but much slower than your usual while not sure. It moves on when you were right and sure, once an idea has two unaided right answers, or after two follow-ups on one idea. Confidence is self-reported, so it never decides against the mark.
  - A line above each bank question says which: "Builds on the last question (…)" with the reason, or "A new idea: …". It is written by code, with no model call.
  - Tutor turns in Learn, Adaptive and Master are given the same list of ideas, what each answer showed, and whether to build on the last answer, so the tutor stops circling one idea. The study screen's "why" panel shows how many of a concept's ideas have been asked and secured.
  - Which idea a question tests is matched by wording, so it steers questions and the next step but never changes a level. Older courses work without recompiling.
- **Software Systems activities.** Five new visual activities: process states, a race condition with a lock you can switch on and off, a circular buffer (full against empty, overflow and underflow), descriptor tables (open, dup, dup2, fork, close) and static diagrams.
  - The local model plans each activity once, as a blueprint that is plain data with separate forms for a diagram and a simulation. The plugin checks it and runs every step of a simulation with its own code before showing it. A blueprint that fails gets one repair with the errors listed; after that, the worked example is shown and the reason is recorded. A saved blueprint reopens with no model call.
  - The model never writes code, HTML or scripts for these. Blueprint text with markup, scripts or links is refused. The plugin draws everything itself, and the drawings work by keyboard, respect reduced motion and suit light and dark themes.
  - The question about what happens next is written by code, not by the model.
  - A concept that calls for a diagram can now offer one after you have struggled with it more than once.
  - Activities saved by earlier versions are rebuilt once, because the activity catalogue changed.
  - With the *Main provider* compile strategy, the main provider can plan these activities while compiling: each diagram or simulation the course marks as worth one, up to 8 per compile, one or two calls each. Study time then opens the finished activity with no model call. A plan goes through the same checks as a local one. A plan that fails is recorded and never fails the compile, and the local model still gets its turn at study time. Turn it off in Settings (Plan diagrams and simulations when compiling). Hybrid and Local only never do this.
  - The activity report now counts the main-provider calls instead of showing zero.
- Internal: calendar-day arithmetic is now written once (`src/dates.ts`) instead of in five places, and a few helpers that duplicated shared ones were removed. No behaviour changes.
- **FSRS scheduling.** Flashcards can be scheduled by FSRS-6, with a desired retention you choose (Settings → Teaching → Card scheduler). SM-2 stays the default.
  - Every card now keeps a short log of its reviews. Switching to FSRS rebuilds each card from that log, and switching back restores SM-2's dates exactly. Each topic records which scheduler set its dates and when it was switched.
  - Exactly one plugin schedules your flashcards. When the Spaced Repetition plugin is enabled and chosen, Study Tutor no longer schedules those cards as well. Settings shows which plugin keeps the schedule.
  - Topics saved by earlier versions read back unchanged, and are not rewritten while SM-2 is chosen.
- **Workload and timed mixed sessions.** Home shows the coming workload: cards and delayed checks due today and over the next 14 days, with an estimate in minutes from your own answer times (60 seconds an item until five answers have been timed). Review has a timed mixed session: the most overdue cards from every topic, cut to the time chosen on Home, and never the same subskill twice in a row when that can be avoided.
- `docs/PILOT.md` sets out a pilot study of the tutor against version 0.9.1 and against plain note-taking with a chat, at equal study time. `scripts/metrics-summary.mjs` summarises what the plugin already records, with no model or network.

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
