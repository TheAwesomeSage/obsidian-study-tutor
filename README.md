# Study Tutor

An Obsidian plugin that teaches you from your own notes. It has a Socratic tutor, a strict quizzer and a subject expert in a sidebar chat, plus flashcard review that uses no tokens. It runs on the Claude CLI (your Claude subscription), and is built to load as little as possible on every turn.

Desktop only: it starts the `claude` program, which mobile Obsidian cannot do.

## Install

1. Install [Claude Code](https://claude.com/claude-code) and sign in once by running `claude` in a terminal.
2. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/TheAwesomeSage/obsidian-study-tutor/releases/latest) and put them in `<your vault>/.obsidian/plugins/study-tutor/`. To build them yourself instead, run `npm install` and then `npm run build`; the files are written to `release/study-tutor/`.
3. In Obsidian: Settings → Community plugins → enable **Study Tutor**.
4. Settings → Study Tutor → **Test** checks that the CLI is found and shows the overhead of one call.

The plugin works in any vault. On first load it creates one folder (default `Tutor/`) and keeps everything there.

## Use

- **New topic** (ribbon icon, or the command "Study Tutor: New topic"). Choose what to teach from:
  - the active note and the notes it links to,
  - the active note only,
  - a folder of notes,
  - a spec or syllabus note,
  - the subject alone, with no notes.
- Give a level in the Goal box (for example "second-year university"). With a spec or a bare subject you can switch on **Research on the web**: the compile step then searches for what courses at that level cover and cites its sources. This is the only time any tool is enabled, and only web search and fetch.
- The topic is **compiled once** into a topic card (subskills, key claims with links back to your notes, common misconceptions) and a question bank.
- The header shows your progress and a suggested **next step**, following the cheapest sensible order: learn a subskill, practise it with code-marked questions, then master it with the tutor.
- **Chat** tab: pick a mode. The modes are laid out as that path: Learn (Teacher), Practise (Quizzer), Master (Tutor), with Ask (Expert) available at any time.
  - *Tutor* places you with a short diagnostic, then teaches one question at a time and only raises a level on demonstrated performance.
  - *Teacher* explains one subskill at a time: why it matters, the idea, a worked example, a diagram where it helps, the common pitfall, then a problem for you. It opens with a short plan and closes with a summary.
  - *Quizzer* asks from the question bank first, weakest subskills first. Multiple-choice and exact short answers are marked by the plugin with no tokens. Only an answer that needs judgement costs a small grading call, and when the bank runs out the model writes fresh questions.
  - *Expert* answers questions directly, grounded in your notes.
- **Review** tab: spaced flashcards from the question bank. Multiple choice and exact short answers are marked by the plugin. For anything else you grade yourself, or ask Claude to grade one answer.
- **Skill map** tab: levels 0 to 5 per subskill, tracked misconceptions, recompile, flashcard export, and "Write summary note", which saves a revision summary with a concept map into the topic folder.

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
- **The plugin does what needs no model.** Review scheduling, marking, the skill map, progress, quiz questions from the bank, and placing a new learner (one bank question per subskill) are plain code.
- **A router picks the model per turn, in code.** Short look-up questions to the expert ("what is a loop invariant?") go to the utility model. Everything else goes to the chat model, and proofs, derivations, code and answers containing maths get extra thinking. The router is lopsided on purpose: a turn only goes to the cheap model when every check agrees, the tutor and teacher never use it, and it can never change a level. It is tested against a labelled set of messages in `tests/router.test.ts`.
- **Model defaults.** Chat and compile use `sonnet`; reading large note sets, summarising and grading plain-prose answers use `haiku`. All are settings, under "Token saving".
- **Parallel helpers only where they pay.** A large note set (default over 6,000 words) is read in parallel batches by the cheap model, and one call then builds the card from the extracts.

## Files in the vault

```
Tutor/
  Dashboard.base            a Bases table of every topic's progress
  _skills/                  the teaching rules, as markdown you can edit
    core.md  mode-tutor.md  mode-quiz.md  mode-expert.md
    compile.md  utility.md
    subjects/               one short card per field; add your own
  Topics/<topic>/
    topic.md                the compiled topic card
    questions.md            the question bank
    state.md                skill map, misconceptions, review schedule
    flashcards.md           optional export
    chats/                  one file per chat part
```

Everything is markdown, so you can read, edit, link and search it. Edits to `_skills/` take effect on the next turn. To add a subject card, add `subjects/<name>.md`; the compiler can then pick it for new topics. To change a topic's card by hand, edit `topic.md` and set `subject:` in its properties.

## Working with other plugins

- **Bases** (core): `Tutor/Dashboard.base` lists topics with progress and cards due.
- **Spaced Repetition** (community): "Export flashcards" writes the bank in its format, tagged `#flashcards/<topic>`.
- **Execute Code** (community): chat files are notes, so code blocks the tutor writes can be run from the chat file.
- Maths is written in LaTeX and renders in the chat and in every file.

## Development

```
npm install
npm test          # unit tests and a jsdom run of the view; no model calls
npm run test:live # end-to-end against the real CLI; spends a little usage
npm run test:features # live check of research, lessons, quiz and summaries; spends more
npm run preview   # writes tests/out/preview.html, a static look at the sidebar design
npm run build     # writes main.js
```

## Limits

- Used inside Obsidian on Windows only; never tried on macOS or Linux. The logic is covered by unit tests, a jsdom run of the view with a stubbed `obsidian` module, and live CLI tests.
- Replies are not streamed; a turn appears when it is complete.
- A model can grade maths wrongly. The tutor is told to check steps before grading, and the topic card ties it to your notes, but treat a surprising verdict with care.
- The flashcard schedule is a simple SM-2 style scheme, not FSRS.

## Licence

MIT. See `LICENSE`. `NOTICE.md` lists the sources the teaching method draws on.
