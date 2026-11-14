# Study Tutor

An Obsidian plugin that teaches you from your own notes. It has a Socratic tutor, a strict quizzer and a subject expert in a main-workspace study view, plus flashcard review that uses no tokens. It runs on the Claude CLI (your Claude subscription), and is built to load as little as possible on every turn.

Desktop only: it starts the `claude` program, which mobile Obsidian cannot do.

## Install

1. Install [Claude Code](https://claude.com/claude-code) and sign in once by running `claude` in a terminal.
2. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/TheAwesomeSage/obsidian-study-tutor/releases/latest) and put them in `<your vault>/.obsidian/plugins/study-tutor/`. To build them yourself instead, run `npm install` and then `npm run build`; the files are written to `release/study-tutor/`.
3. In Obsidian: Settings → Community plugins → enable **Study Tutor**.
4. Settings → Study Tutor → **Test** checks that the CLI is found and shows the overhead of one call.

The plugin works in any vault. On first load it creates one folder (default `Tutor/`) and keeps everything there.

## Use

Open Study Tutor from the ribbon (the graduation cap) or with the command "Study Tutor: Open tutor". It opens in the main workspace. Along the top are **Home**, **Study**, **Review** and **Graph**; on the right are the current topic, **+** for a new topic, the settings, and a **⋯** menu.

### Making a topic

Use **New topic** (the **+**, a button on Home, or the command "Study Tutor: New topic"). Choose what to teach from:

- the active note and the notes it links to,
- the active note only,
- a folder of notes,
- a spec or syllabus note,
- the subject alone, with no notes.

Give a level in the Goal box (for example "second-year university"). With a spec or a bare subject you can switch on **Research on the web**: the compile step then searches for what courses at that level cover and cites its sources. This is the only time any tool is enabled, and only web search and fetch.

The topic is **compiled once** into a topic card (objectives, concepts, key claims with links back to your notes, common misconceptions, a short worked example each), a question bank grouped into question families with rubrics for open answers, a course graph of how its concepts depend on one another, and a course package (`package.md`) that shows which objectives are covered by lessons and questions and which are not. **Recompile from notes** compares each note with the fingerprint taken at the last compile: with no change it calls no model, a change that reaches a few subskills rewrites only those (keeping every other section, question and review schedule), and new notes get a full compile.

### Home

- **Pick up where you left off** shows your unfinished session: its topic, mode, and where it stopped. **Resume session** reopens it with its open question pinned.
- **Suggested next** gives one step and the reason for it. Choose 10, 25 or 45 minutes: with little time, quick practice comes before a new lesson. A step on a concept never comes before a weak prerequisite of it.
- The study tiles start a session on the current topic: **Adaptive study**, **Learn**, **Practise**, **Review**, **Ask** and **Knowledge graph**.
- **Topics** can be searched by topic or concept name. Each row shows progress to the target level, concepts secured, cards due, when you last practised, and a warning when a recorded level is not yet backed by your answers. Its button takes the topic's next step; select the row for the topic page.
- **Recent sessions** reopens any earlier session. The file icon opens its full transcript as a note.

### Study modes

- **Adaptive.** A study guide chooses each step: a quick check, an explanation, a hint, practice or a transfer question. It finishes one step before starting another. A new learner is placed with one question-bank question per concept, and unaided practice comes from the bank. Both are marked by the plugin with no tokens. A prerequisite in another topic is checked with one short question before it is assumed.
- **Learn.** Lessons on material you have not met: why it matters, the idea, a worked example, a diagram where it helps, the common pitfall, then a problem with help on hand. It stays within explanation, examples and guided practice, and says when you look ready to practise unaided.
- **Practise.** Strict questions from the question bank, weakest concepts first. Multiple-choice and exact short answers are marked by the plugin with no tokens; an answer that needs judgement costs a small grading call. When the bank runs out, the model writes fresh questions.
- **Master.** Socratic tutoring, one question at a time. The most thorough mode, and the one that uses the most tokens. Start it from the topic page or the Study screen's mode menu.
- **Ask.** Direct answers to anything about the topic, grounded in your notes.

### Study screen

- The header has the way back to Home, the topic, the mode menu, a new chat, and the transcript as a note.
- A line under it says what the guide chose and why. **Why this?** shows the details.
- The question waiting for your answer is pinned above the answer box. **Hint**, **Explain** and **Skip** are one click away. After a hint or an explanation the answer counts as helped; a skip is recorded as skipped and the answer is shown.
- **Confidence** is an optional slider from 0 to 100%. It stays unset until you move it, is read before you see the feedback, and resets after each marked answer. It is compared with your results; it never raises a level.
- **Attach open note**, when switched on, sends the note you have open with your message.
- A marked answer shows the result and how it was checked (by the plugin, by SymPy, or by the model), and whether help was given or the answer had been seen. **Dispute this mark** sets it aside. A question-bank answer can then be regraded with more thinking; for an answer marked in conversation, the tutor looks again on your next message.
- If a reply fails, your message is kept and **Retry** asks again. An unsent draft is kept if you leave. **Details** shows the tokens used and the checks run on the last turn.

### Topic page

Select a topic on Home to open it. It shows progress to the target level, the next step (**Do this**), and every mode. The **Concepts** table lists each concept with its level, the evidence behind it (unaided answers correct, answers given with help, and a provisional estimate once there are three unaided answers), what is missing for the next level, and when you last practised it. Each row can start a session on that concept or show it in the graph. Below are the misconceptions being tracked and the topic tools: target level (3, 4 or 5), topic card, question bank, evidence log, **Write summary note** (one model call; saves a revision summary with a concept map), **Export flashcards** and **Recompile from notes**. Recompiling keeps your levels, answers and relations with each concept, even one that has been renumbered or renamed.

### Review

Built-in spaced flashcards from the question bank, with no tokens. Multiple-choice and exact short answers are marked by the plugin. For anything else you rate yourself, or ask Claude to grade that one answer. A self-rating schedules the card; it does not count as evidence for a level. With the Spaced Repetition plugin enabled, Review shows its due and new counts and starts its review of the topic instead.

### Knowledge graph

Every concept from every topic on one map, drawn by the plugin with no tokens. The map shows the course; your progress only changes the colours.

- **Find a concept** (or press `/`) searches by name. **Colour** switches between topic, demonstrated level, estimated success, last practised, and confidence against results. **Show** limits the map to one topic, and the relation buttons hide or show each kind of link.
- Drag to pan and scroll to zoom. The buttons fit the map, zoom, lay it out again, and expand it to fill the pane. With the map focused, the arrow keys move between concepts, `+` and `-` zoom, `0` fits, Enter shows only the selected concept's neighbourhood, and Escape clears the selection. Positions are remembered.
- Select a concept for its details: its level and whether your answers back it, the suggested next step (**Study this**), its evidence, and what it rests on and what builds on it. Relations read from the topic card are marked inferred; confirm (✓) or reject (✕) each one. **Add a relation or set priority** adds a link by hand or changes how strongly the concept is preferred. Only "requires" orders study; supports, applies to, contrasts with and derived from are for understanding.
- **Suggest a synoptic connection** (one model call) proposes a link to another concept, with an explanation and a joint problem that needs both. It stays unreviewed until you confirm it, and then **Study connection** opens the joint problem in a new session. A connection never awards mastery.
- Estimated success is a provisional estimate that your next unaided first answer on the concept is fully correct. It is shown only once there are three unaided answers.

### Diagrams, simulations and games

Interactive activities are used on demand. Opening a topic, a note or a concept in the graph never starts one.

- **Ask for one** ("show me a simulation", "can I see a diagram?") in any study mode. A saved activity opens at once. A new one is configured from a short excerpt of your notes by a small model on this computer through [Ollama](https://ollama.com), and the reply says why it was chosen. Claude is never called for this. If no module can show the idea, you are told so, the compiled worked example is shown instead, and the request is noted in `_logs/capability-requests.md`.
- **The guide may offer one** beside its reply in Adaptive, Practise and Master, but only for a repeated difficulty of a known kind on a concept the course marked as suited to it. It is configured only if you open it. The tutor's reply may suggest one too; that can only become an offer, for a module that exists.
- Moving the controls, playing, stepping and resetting use no model at all. An answer inside an activity is marked by the module's own code and counts as helped work: it can show "can do with help" and never counts as unaided evidence. Opening an activity while a question is open makes your answer to that question helped.
- Saved activities live in each topic's `activities.md`, with the sources (path and SHA-256 of the excerpt), module, schema, model, prompt and catalogue versions, timing and model-call counts. One is reused only while all of those are unchanged; a configuration that failed its checks is saved too, so it is not tried again.

Local configuration needs Ollama running with `qwen2.5:3b` (`ollama pull qwen2.5:3b`). Settings → Study Tutor → **Interactive activities** has the switch, the model name and a **Test** button. Only a local server (127.0.0.1 or localhost) is ever used.

### The ⋯ menu and settings

The **⋯** menu opens the topic overview, topic card, question bank and evidence log. It also has **How levels and choices are decided** (the rules, in `_skills/policy.md`), **Compare policy with logged decisions**, **Edit teaching instructions** and **Reload from vault**. Under Settings → Study Tutor → **Study policy** you can weigh exam relevance, prerequisite importance, observed errors, uncertainty, recency and available time. The weights change what is suggested, never a level.

## Maths with SymPy

Switch on **Compute and check maths with SymPy** in the settings and the plugin runs [SymPy](https://www.sympy.org), a computer algebra system, for anything that is computation. The model does the reasoning and the teaching; SymPy does the algebra.

- **Typed answers cost nothing.** In quizzes, placement and the built-in review, an answer that does not match the expected one exactly is compared by SymPy: `1/2` is accepted for `0.5`, `(x+1)^2` for `x^2+2x+1`. No model is called. If SymPy cannot decide (a sentence, an equation, a different letter), the answer goes to the model as before.
- **The tutor hands over its computing.** On a topic with maths in it, the tutor can reply with a list of computations instead of an answer: an integral, a transform, a system to solve, a matrix inverse. Later items can use earlier results, so a chain of simple steps solves a harder problem. The plugin runs them and calls the model once more with the results. This costs one extra round, with the system prompt read from cache.
- **Every stated result is checked.** A reply that judges your expression or states a result ends with a hidden list of checks. If SymPy disagrees, the reply is rewritten once, with more thinking, before you see it; if it still disagrees you see the reply with a warning and no level changes. A line under the reply says what was computed and checked.
- **Less thinking where SymPy can decide.** An answer that is a bare expression gets the chat model's normal effort instead of extra thinking, because SymPy does the comparing.

SymPy is Python, so it runs through [Pyodide](https://pyodide.org) (Python compiled to WebAssembly) in a background worker. Nothing needs installing. The first use downloads about 20 MB from the jsDelivr CDN and needs a connection; after that it is cached. The expressions themselves never leave your machine. Every string is filtered before it is parsed (no attribute access, no imports, no names beginning with an underscore), the worker has no access to Node or the vault, and a computation that runs too long is stopped. SymPy checks results, not the steps of a derivation or a proof: those stay with the model.

## How usage is kept low

Measured with Claude Code 2.1.311 on one "reply OK" call:

| How the CLI is called | Input tokens |
|---|---|
| `claude -p` with defaults | about 40,300 |
| tools switched off (`--tools ""`) | about 4,300 |
| plus own system prompt (`--system-prompt-file`) | about 1,300 |
| plus no user settings or CLAUDE.md (`--setting-sources ""`) | about 1,070 |

The plugin always uses the last row, with `--strict-mcp-config`, `--disable-slash-commands` and `--no-session-persistence`. On top of that:

- **Compile once, teach many times.** Notes are read once. A chat turn loads the compiled card, not the notes.
- **Stable part first.** The tutor rules, subject card and topic card form the system prompt and are identical every turn, so after the first turn they are read from the prompt cache. In a live test a tutor turn was about 4,700 input tokens, 3,400 of them from cache.
- **Chats live in markdown, one part at a time.** Each chat is a file. Only the active part is sent. When it passes the size limit (default 600 words) the cheap model writes a 150-word handover, a new part starts with that summary and the last exchange, and the old part stays in the vault as a normal note.
- **The plugin does what needs no model.** Review scheduling, marking, levels and the evidence behind them, the knowledge graph, progress, quiz questions from the bank, the study guide's choice of step, and placing a new learner (one bank question per concept) are plain code.
- **A router picks the model per turn, in code.** Short look-up questions to the expert ("what is a loop invariant?") go to the utility model. Everything else goes to the chat model, and proofs, derivations, code and answers containing maths get extra thinking. The router is lopsided on purpose: a turn only goes to the cheap model when every check agrees, the tutor and teacher never use it, and it can never change a level. It is tested against a labelled set of messages in `tests/router.test.ts`.
- **Model defaults.** Chat and compile use `sonnet`; reading large note sets, summarising and grading plain-prose answers use `haiku`. All are settings, under "Token saving".
- **Parallel helpers only where they pay.** A large note set (default over 6,000 words) is read in parallel batches by the cheap model, and one call then builds the card from the extracts.

## Files in the vault

```
Tutor/
  Dashboard.base            a Bases table of every topic's progress
  _skills/                  the teaching rules, as markdown you can edit
    core.md  mode-auto.md  mode-tutor.md  mode-teach.md  mode-quiz.md  mode-expert.md
    compile.md  utility.md  summary.md  maths-check.md
    policy.md               how levels and study choices are decided, for reading
    subjects/               one short card per field; add your own
  _logs/decisions.md        what the study guide chose and why, for comparing policies
  _logs/capability-requests.md  activities learners asked for that no module has yet
  Topics/<topic>/
    topic.md                the compiled topic card
    questions.md            the question bank
    graph.md                the course graph: concept ids and relations, no progress
    state.md                levels, misconceptions, review schedule
    evidence.md             every marked answer and level change, with how it was marked
    package.md              the course package: objectives and their coverage, worked lessons,
                            question families, rubrics, sources, visual eligibility
    activities.md           saved activity configurations (and saved failures)
    activity-log.md         why each activity was chosen, whether it was opened, assessed answers
    flashcards.md           optional export
    chats/                  one file per chat part
    sessions/               a readable record of where each chat stands
```

Everything is markdown, so you can read, edit, link and search it. Edits to `_skills/` take effect on the next turn, except `policy.md`: it describes rules that the code enforces, and is never sent to a model. To add a subject card, add `subjects/<name>.md`; the compiler can then pick it for new topics. To change a topic's card by hand, edit `topic.md` and set `subject:` in its properties.

## Working with other plugins

- **Bases** (core): `Tutor/Dashboard.base` lists topics with progress and cards due.
- **Spaced Repetition** (community): when it is enabled, flashcards are handed to it. Each topic's question bank is kept as a note tagged `#flashcards/<topic>`, Spaced Repetition schedules and reviews it with your other decks (including on mobile), and the Review screen shows its due and new counts and starts its review on the topic. Regenerating the note keeps the review history. Without that plugin, or with the setting off, the built-in review is used. Checked against Spaced Repetition 1.15.4, including its own card parser.
- **Execute Code** (community): chat files are notes, so code blocks the tutor writes can be run from the chat file.
- Maths is written in LaTeX and renders in the chat and in every file.

## Development

```
npm install
npm test          # unit tests and a jsdom run of the view; no model calls
npm run test:live # end-to-end against the real CLI; spends a little usage
npm run test:features # live check of research, lessons, quiz and summaries; spends more
npm run test:session # a scripted live study session: hints, reveals, a restart, a dispute, a cross-topic prerequisite, cache use per turn
npm run preview   # writes tests/out/preview.html, light and dark previews at wide and narrow widths
npm run build     # writes main.js
STUDY_VAULT=<vault> VISUAL_REGISTRY=<bundled registry.cjs> npm run bench:qwen
                  # local-model benchmark on ten real excerpts listed in bench/; needs Ollama
```

`npm test` also runs the SymPy checker's Python against a labelled set of checks when a Python with SymPy is on the machine (set `SYMPY_PYTHON` to choose one); without it that one test is skipped. To run the same set through the real in-browser worker, serve `tests/out/` over HTTP after `npm run preview` and open `sympy.html`; the page title ends as "SYMPY PASSED".

## Limits

- Used inside Obsidian on Windows only; never tried on macOS or Linux. The logic is covered by unit tests, a jsdom run of the view with a stubbed `obsidian` module, and live CLI tests.
- Replies are not streamed; a turn appears when it is complete.
- A model can grade maths wrongly. With SymPy switched on, results are checked and a wrong one is rewritten or flagged, but the steps of a derivation or a proof are still judged by the model alone. Treat a surprising verdict with care.
- The course graph spans topics. Prerequisites and other relations are stored separately from learner evidence.
- The flashcard schedule is a simple SM-2 style scheme, not FSRS.

## Licence

MIT. See `LICENSE`. `NOTICE.md` lists the sources the teaching method draws on.


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
