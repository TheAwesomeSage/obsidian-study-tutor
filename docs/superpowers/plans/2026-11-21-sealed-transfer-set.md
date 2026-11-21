# Sealed Transfer Set (Cold Probes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At compile time, hold out one never-taught question family per concept, and use it in cold probes that report an unseen-task score without changing levels.

**Architecture:**
- Compile asks for a `probe` family per subskill. `Store.saveCompiled` splits those questions out of questions.md into sealed.md, keyed by stable concept id, so no existing bank reader can see them.
- Pure functions in `src/probe.ts` decide when a probe is due, what it asks and how it scores.
- `src/engine-probe.ts` runs a probe chat with no help. Answers are marked by the bank's own marking path (extracted from `quizTurn`), and the attempts are flagged `probe`; evidence, BKT, cards and the policy skip them.

**Tech Stack:** strict TypeScript, esbuild, `node:test` with `node:assert/strict`, the `MemFS` test store (tests/memfs.ts), the jsdom UI harness (tests/ui.test.ts), and Pyodide/SymPy for marking.

**Spec:** `docs/superpowers/specs/2026-11-21-sealed-transfer-set.md`

## Global Constraints

- Edit `src/`, `skills/`, docs and `tests/`. Never edit `main.js`, `player.js`, `plot.js`, `release/`, `vendor/` or `tests/out/`.
- Done means `npm run build` and `npm test` pass. Never run `test:live`, `test:features`, `test:session`, `test:compile-live` or `bench:qwen`.
- Probe questions are model text from compile. They render only through the paths bank questions already use, so they pass `src/safemd.ts`. Add no rendering path that skips it.
- Build paths the way store.ts does (`${dir}/sealed.md`), with no case-only differences, so they work on Windows and Linux.
- User-visible changes go in CHANGELOG.md under `## Unreleased`.
- Commit messages carry no Co-Authored-By or Claude trailer, and the branch has no `claude/` prefix. Work on `feat/cold-probes`, branched from `feat/learning-system`.
- After the last code change, run `graphify update .`.
- Constants, verbatim from the spec:
  - `SEAL_SIMILARITY = 0.5`, `PROBE_MAX = 6`
  - `PROBE_INTERVAL_DAYS = 14`, `PROBE_EXAM_DAYS = 7`, `PROBE_MIN_SHOWN = 3`
  - `PROBE_ELIGIBLE_LEVEL = 3`, `NOT_TRANSFERRING_LEVEL = 4`
  - sealed id = `"P" + digest(question).slice(0, 10)`

## Review Focus

1. **A recompile or refresh renumbers, renames or retires subskills.** Sealed questions follow their concept id to the new number, and a retired concept's sealed questions are dropped. *(Task 3 test)*
2. **A topic compiled before this change has no sealed.md.** Nothing throws, `probeStatus` reports `sealedTotal: 0`, and the topic page offers a recompile. *(Tasks 5 and 8 tests)*
3. **The model ignores the probe instruction, or writes a near-copy of a practice question.** Near-copies are dropped, and zero sealed questions is a valid result. *(Task 2 test)*
4. **The learner types "hint", "why?" or asks for a diagram mid-probe.** The request is refused locally with no model call, and nothing is recorded or marked as assisted. *(Task 7 test)*
5. **A probe is left half done and reopened, or a second probe is started the same day.** The open probe resumes where it was, and answered sealed questions are spent and never asked again. *(Task 7 test)*

---

### Task 1: Families kept for assessment stay out of new review cards and the flashcard export *(optional, spec D5)*

**Files:**
- Modify: `src/formats.ts:742-747` (`reviewQueue`), `src/formats.ts:858-867` (`buildSrNote`)
- Test: `tests/learning.test.ts`, next to "question families: practice never uses a family kept for assessment…" (:1128)

**Interfaces:**
- Consumes: `reservedQuestions(questions: Question[]): Set<string>` from `src/coursepkg.ts:123`. formats.ts already imports it.
- Produces: no new names. The signatures don't change.

- [ ] **Step 1: Write the failing test** `"question families: a family kept for assessment is never a new review card or a Spaced Repetition card"`
  - Build `bank = [q("Q1",1,"a"), q("Q2",1,"b"), q("Q3",1,"c"), q("Q4",1,"d","transfer")]` with the `q` helper from :1131, and a fresh state from `F.newState(F.parseTopic(CARD(NAMES)), 4)`.
  - `assert.deepEqual(F.reviewQueue(bank, s, "2026-11-17", 10).map((x) => x.id), ["Q1", "Q2", "Q3"])`
  - Give Q4 a card due today, made the way engine-bank.ts does with `schedule(...)`.
  - `assert.ok(F.reviewQueue(bank, s, "2026-11-17", 10).some((x) => x.id === "Q4"), "a family already met may be reviewed")`
  - `assert.ok(!F.buildSrNote(bank, "t").includes("Q4"))`
- [ ] **Step 2: Run** `npm test`. Expected: the new test fails, because Q4 is in the fresh list and the note.
- [ ] **Step 3: Implement.** In `reviewQueue`, leave `reservedQuestions(questions)` out of `fresh` only. In `buildSrNote`, skip questions in `reservedQuestions(questions)`.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5:** Add to CHANGELOG under Unreleased: "Questions kept for the transfer check no longer appear as new review cards or in the Spaced Repetition note, so they are still unseen when the check comes." Then commit with `git commit -m "Keep families reserved for assessment out of review and flashcards"`.

### Task 2: The `probe` task type, and splitting sealed questions out of a compiled bank

**Files:**
- Create: `src/sealed.ts`
- Modify: `src/formats.ts`
  - :289-314: add `concept?: string` to `Question`, with the doc comment "Stable concept id; set only on sealed questions."
  - :316: add `"concept"` to `Q_KEYS`.
  - :317: add `"probe"` to `Q_TASKS`.
  - near :379: parse `concept`.
- Test: `tests/learning.test.ts`

**Interfaces:**
- Consumes: `digest(text: string): string` (`src/compile-sources.ts:24`), `similarity(a: string, b: string): number` (`src/course.ts:71`), `parseQuestions(md: string): Question[]` (`src/formats.ts:345`).
- Produces, in `src/sealed.ts`:
  - `export const SEAL_SIMILARITY = 0.5`
  - `export interface SealedSection { id: string; subskill: number; section: string }`. `section` is the question's markdown with its `### <id>` line rewritten to the sealed id.
  - `export function sealedId(questionText: string): string` returns `"P" + digest(questionText).slice(0, 10)`.
  - `export function splitSealed(questionsBody: string): { bank: string; sealed: SealedSection[]; dropped: number }`
    - Sections begin at lines matching `/^### /m`.
    - A section whose parsed question has `task === "probe"` is sealed. It is dropped instead when `similarity(probe.question, other.question) >= SEAL_SIMILARITY` for any non-probe question on the same subskill.
    - Non-probe sections stay in `bank` byte for byte, in their original order.

- [ ] **Step 1: Write the failing test** `"cold probes: a probe family is split out of the bank, and a near-copy of practice is dropped"`
  - The body has four sections:
    - Q1: subskill 1, application.
    - Q2: subskill 1, `task: probe`, with text unlike Q1.
    - Q3: subskill 2, application: "A ball is thrown up at 5 m/s. How high does it rise?"
    - Q4: subskill 2, `task: probe`: "A ball is thrown up at 8 m/s. How high does it rise?"
  - `assert.deepEqual(F.parseQuestions(r.bank).map((x) => x.id), ["Q1", "Q3"])`
  - `assert.equal(r.sealed.length, 1)`, `assert.match(r.sealed[0].id, /^P[0-9a-f]{10}$/)`, `assert.equal(r.sealed[0].subskill, 1)`, `assert.equal(r.dropped, 1)`
  - `assert.equal(F.parseQuestions(r.sealed[0].section)[0].task, "probe")`
  - `assert.equal(sealedId("x"), sealedId("x"))`
  - `assert.equal(F.parseQuestions("### P1\nsubskill: 1\ntype: short\ntask: probe\nconcept: c-abc\nquestion: x\nanswer: 1\n")[0].concept, "c-abc")`
  - A body with no probe sections returns `{ sealed: [], dropped: 0 }`, and `bank` is unchanged.
- [ ] **Step 2: Run** `npm test`. Expected: fails, because `../src/sealed` is not found.
- [ ] **Step 3: Implement** `sealedId` and `splitSealed` in `src/sealed.ts`, and the formats.ts changes.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** with `git commit -m "Add the probe task type and split sealed questions out of a bank"`.

### Task 3: The store writes sealed.md and keeps it by concept id; compile asks for the probe family

**Files:**
- Modify:
  - `src/store.ts`: add `sealedPath` and `loadSealed` next to `loadQuestions` (:406); change `saveCompiled` (:515-540).
  - `skills/compile.md:69`
  - `src/main.ts:478` (the compile notice)
- Test: `tests/learning.test.ts`

**Interfaces:**
- Consumes: `splitSealed` and `SealedSection` (Task 2), the graph built inside `saveCompiled` (`graph.concepts` with `n`, `id` and `retired`).
- Produces:
  - `Store.sealedPath(dir: string): string` returns `` `${dir}/sealed.md` ``.
  - `Store.loadSealed(dir: string): Promise<Question[]>` returns the sealed questions, each with `concept` set, or `[]` when there's no file.
  - sealed.md is `withFrontmatter({ tutor: "sealed", topic: title, dropped }, sections.join("\n"))`.
  - `saveCompiled`:
    - writes `splitSealed(p.questionsBody).bank` to questions.md;
    - inserts a `concept: <id>` line after `subskill:` in each sealed section, using the new graph, and skips a section with no matching concept;
    - keeps an existing sealed question when its concept is still in the new graph and not retired, and the new body brought no sealed question for that concept, rewriting its `subskill:` line to the concept's new `n`.
  - `saveCompiled`'s return type stays `Promise<string>`.
- `skills/compile.md:69`: append the sentence: `Also write one more family per subskill with "task: probe": a fresh problem in a setting unlike every other family, the transfer one included. The app seals it away for cold probes, so the learner never practises it.`
- Notice: when `n = (await this.store.loadSealed(res.dir)).length` is above 0, append `` ` ${n} sealed for cold probes.` `` after the questions count.

- [ ] **Step 1: Write the failing test** `"cold probes: questions.md never holds a sealed question, so no bank reader, review or flashcard export can show it"`
  - Call `saveCompiled` with Task 2's body, using `CARD(NAMES)`.
  - `assert.ok((await store.loadQuestions(dir)).every((x) => x.task !== "probe"))`
  - `const sealed = await store.loadSealed(dir)`, then `assert.equal(sealed.length, 1)` and `assert.equal(sealed[0].concept, (await store.loadState(dir, 4)).concepts[1])`
  - `assert.ok(!(await fs.read(`${dir}/questions.md`)).includes(sealedText))`
  - `assert.ok(!F.buildSrNote(await store.loadQuestions(dir), "t").includes(sealedText))`
  - The same is true for `F.reviewQueue(...)`.
- [ ] **Step 2: Write the failing test** `"cold probes: a recompile keeps sealed questions with their concept, a new probe replaces the old one, and a retired concept loses its own"`
  - Compile 1: three subskills, each with a probe.
  - Compile 2 (`existingDir`) changes three things:
    - the card lists the first two subskills in swapped order, with the same names;
    - the body has a new probe only for the concept that was subskill 1;
    - the third subskill is removed.
  - Assert:
    - the old subskill 2 concept keeps its old sealed id, with `subskill` now 1;
    - the old subskill 1 concept has only the new sealed id;
    - the removed concept has none;
    - `loadSealed` on a topic saved without probes returns `[]`.
- [ ] **Step 3: Run** `npm test`. Expected: both new tests fail.
- [ ] **Step 4: Implement** `sealedPath`, `loadSealed`, the `saveCompiled` split and merge, the compile.md sentence and the notice.
- [ ] **Step 5: Run** `npm test`. Expected: all pass.
- [ ] **Step 6: Commit** with `git commit -m "Seal probe questions into sealed.md at compile and keep them by concept id"`.

### Task 4: Evidence, BKT, cards and metrics ignore probe answers

**Files:**
- Modify:
  - `src/evidence.ts`: add `probe?: boolean` to `Attempt` (:45-109); read `r.probe === true` in `normaliseAttempt` (near :186); leave `a.probe` attempts out of `mine` in `skillEvidence` (:301-302).
  - `src/engine-common.ts:233`: `applyAttempt` returns `[]` for `a.probe`.
  - `src/bkt.ts`: `bktTrace` and `bktShadow` (:120) skip probe attempts.
  - `src/metrics.ts`: `summariseMetrics` (:62, :83-90) and `metricsReport` (:155).
- Test: `tests/learning.test.ts`

**Interfaces:**
- Produces:
  - `Attempt.probe?: boolean`, true only on cold-probe answers. It is written to evidence.md and read back.
  - `MetricsSummary` gains `probes: number; probeCorrect: number`, and probe attempts are excluded from its `independent` count.
  - `metricsReport` adds the line `Cold probes: ${probes} answers, ${probeCorrect} correct.`

- [ ] **Step 1: Write the failing test** `"cold probes: a probe answer is recorded but moves no level, estimate, BKT value or delayed check"`
  - Set up a concept at level 3 after two unaided correct answers on 2026-11-14, and record `e0 = skillEvidence(s.attempts, 1)`.
  - Add a correct, unaided attempt on 2026-11-17 with `probe: true`, `taskType: "transfer"` and an unmet family.
  - `assert.deepEqual(skillEvidence(s.attempts, 1), e0)`
  - `assert.deepEqual(applyAttempt(s, a), [])`, `assert.equal(s.levels[1], 3)`
  - `assert.equal(bktShadow(s.attempts, 1)?.observations, bktShadow(s.attempts.filter((x) => !x.probe), 1)?.observations)`
  - `assert.equal(normaliseAttempt(JSON.parse(JSON.stringify(a))).probe, true)`
  - An incorrect probe attempt at level 4 leaves the level at 4.
- [ ] **Step 2: Write the failing test** `"cold probes: the metrics report counts probe answers apart from unaided practice"`. Using the input shape the existing metrics tests use, one correct probe attempt gives `probes === 1` and `probeCorrect === 1`, and leaves `independent` unchanged.
- [ ] **Step 3: Run** `npm test`. Expected: both fail.
- [ ] **Step 4: Implement** the field and the filters.
- [ ] **Step 5: Run** `npm test`. Expected: all pass.
- [ ] **Step 6: Commit** with `git commit -m "Record probe answers apart from the evidence that sets levels"`.

### Task 5: Probe decisions as pure functions

**Files:**
- Create: `src/probe.ts`
- Test: `tests/learning.test.ts`

**Interfaces:**
- Consumes:
  - `Question.concept` (Task 2) and `Attempt.probe` (Task 4);
  - `skillEvidence(...).firstIndependentDay` (`src/evidence.ts`);
  - `baseQuestionId` (`src/families.ts`) and `daysBetween` (`src/dates.ts:14`);
  - `LearnerState.levels`, `.concepts` (n → concept id) and `.attempts`.
- Produces:
  - The constants `PROBE_MAX = 6`, `PROBE_INTERVAL_DAYS = 14`, `PROBE_EXAM_DAYS = 7`, `PROBE_MIN_SHOWN = 3`, `PROBE_ELIGIBLE_LEVEL = 3` and `NOT_TRANSFERRING_LEVEL = 4`.
  - `export function currentSealed(sealed: Question[], s: LearnerState): Question[]` sets each question's `subskill` from its concept's current `n`, and drops a question whose concept isn't in `s.concepts`.
  - `export function spentSealed(sealed: Question[], attempts: Attempt[]): Set<string>` returns the ids of sealed questions with any attempt where `baseQuestionId(a.questionId) === q.id`.
  - `export function probeQueue(sealed: Question[], s: LearnerState, today: string): Question[]`
    - calls `currentSealed` first, as `probeStatus` does, so subskill numbers are current;
    - sealed ids hold no `~` or `#`, so `baseQuestionId` returns them unchanged;
    - takes one unspent question per eligible concept: level ≥ `PROBE_ELIGIBLE_LEVEL`, with `firstIndependentDay < today`;
    - orders concepts by level, highest first, then by `n`, lowest first;
    - within a concept, prefers a question with a `generator`;
    - returns at most `PROBE_MAX`.
  - `export interface ProbeStatus { count: number; due: boolean; why: string; asked: number; correct: number; lastProbe: string | null; notTransferring: number[]; sealedTotal: number }`
  - `export function probeStatus(sealed: Question[], s: LearnerState, today: string, examDate?: string): ProbeStatus`
    - `count = probeQueue(...).length`.
    - `due` and `why`, with this copy exactly:
      - `"no cold probe yet"` when `lastProbe === null`;
      - `"14 days since the last cold probe"` when `daysBetween(lastProbe, today) >= PROBE_INTERVAL_DAYS`;
      - `"the exam is within a week"` when `0 <= daysBetween(today, examDate) <= PROBE_EXAM_DAYS` and `daysBetween(lastProbe, today) >= PROBE_EXAM_DAYS`;
      - `due` is false whenever `count === 0`.
    - `asked` counts probe attempts whose result is not `ungraded` and whose verification is not `disputed`; `correct` counts those with result `correct`.
    - `lastProbe` is the latest probe attempt's day.
    - `notTransferring` lists the subskills at level ≥ `NOT_TRANSFERRING_LEVEL` whose latest probe attempt is `incorrect` or `skipped`.
    - `sealedTotal = currentSealed(...).length`.

- [ ] **Step 1: Write the failing test** `"cold probes: the queue takes one unspent sealed question per concept ready for it, at most six"`
  - Set up eight concepts at level 3 or 4, each with two unaided correct answers on 2026-11-15; one concept at level 2; and one at level 3 whose first unaided success is 2026-11-17 (today).
  - Assert:
    - the length is 6, and the first ids belong to the level-4 concepts;
    - the level-2 concept and the today concept are absent;
    - a spent question is skipped in favour of the same concept's other sealed question;
    - the question with a generator is picked first;
    - `currentSealed` drops a question whose concept is unknown.
- [ ] **Step 2: Write the failing test** `"cold probes: a probe is due first, then every 14 days, sooner before an exam, never with nothing to ask"`
  - no probe yet: `due` is true and `why` is `"no cold probe yet"`;
  - last probe 10 days ago: `due` is false;
  - 14 days ago: `due` is true;
  - 8 days ago with the exam 5 days ahead: `due` is true and `why` is `"the exam is within a week"`;
  - all sealed questions spent: `count` is 0 and `due` is false;
  - a level-4 concept whose latest probe is incorrect is in `notTransferring`;
  - `probeStatus([], s, today).sealedTotal === 0`.
- [ ] **Step 3: Run** `npm test`. Expected: fails, because `../src/probe` is not found.
- [ ] **Step 4: Implement** `src/probe.ts`.
- [ ] **Step 5: Run** `npm test`. Expected: all pass.
- [ ] **Step 6: Commit** with `git commit -m "Decide when a cold probe is due, what it asks and how it scores"`.

### Task 6: Bank marking as one function (refactor, no change in behaviour)

**Files:**
- Modify: `src/engine-bank.ts`. Move the marking block of `quizTurn` (:276-353, from `let grade` through `normaliseMark`'s inputs) into an exported function, and call it from `quizTurn`.
- Test: `tests/learning.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type BankMark =
    | { kind: "reply"; reply: string }
    | { kind: "marked"; skipped: boolean; grade: Grade; note: string; grading: Grading; assumptions: string; reasoning: ReasoningAssessment | null; rubric: string | undefined; codeRun: CodeRunRecord | null; mistake: string; usage: Usage; tools: ToolResult[] };
  export async function markBankAnswer(eng: Engine, pending: Question, task: BankTask | null, answer: string, opts: TurnOpts): Promise<BankMark>
  ```
  - `"reply"` covers today's three re-prompts, with their copy unchanged: the letter one, the code one, and the number or "step N, answer X" one.
  - `quizTurn` pushes the reply as a tutor message and returns exactly as it does now.

- [ ] **Step 1: Write the failing test** `"bank marking: markBankAnswer marks a letter by code and asks again for a non-letter"`
  - Use the `motion()` harness (:1156), which allows no model call, and an mcq question.
  - `"B"` on an answer of B gives `{ kind: "marked", grade: "good", grading: "deterministic" }`.
  - `"maybe"` gives `{ kind: "reply", reply: "Reply with one letter, for example **B**." }`.
  - `calls() === 0`.
- [ ] **Step 2: Run** `npm test`. Expected: fails, because `markBankAnswer` is not exported.
- [ ] **Step 3: Implement** the extraction.
- [ ] **Step 4: Run** `npm test`. Expected: all pass, including every existing "question families:" and quiz test, with no test edits.
- [ ] **Step 5: Commit** with `git commit -m "Extract bank marking from quizTurn"`.

### Task 7: Running a cold probe

**Files:**
- Create: `src/engine-probe.ts`
- Modify: `src/engine.ts`
  - In `study()` (:261-263), right after `loadChat` and before the placement and mode routing: `if (fmStr(chat.fm, "probe") === "yes") return probeTurn(this, dir, chatPath, message, opts);`
  - Add two methods, `startProbe` and `probeStatus`.
- Test: `tests/learning.test.ts`

**Interfaces:**
- Consumes:
  - `Store.loadSealed` (Task 3) and `currentSealed`, `probeQueue`, `probeStatus` and `ProbeStatus` (Task 5);
  - `markBankAnswer` (Task 6);
  - `eng.bankAttempt` (engine.ts:898), `recordAttempt`, `Store.newChat(dir, title, "quiz")` (store.ts:609), `formatQuizQuestion`, `looksLikeQuestion`, `givesUp`, `readPresentationRequest`.
- Produces:
  - `export const PROBE_NO_HELP = "This is a cold probe, so there is no help until it ends. Answer as best you can, or say **skip**."`
  - `export async function startProbe(eng: Engine, dir: string): Promise<{ chatPath: string; count: number } | null>`
    - returns null when the queue is empty;
    - sets the chat's frontmatter: `mode: "quiz"`, `probe: "yes"`, `probe_queue` (the ids) and `card` (the first id);
    - writes a first tutor message: `` `**Cold probe** · ${count} question${count === 1 ? "" : "s"} · no hints or explanations until you finish.\n\n` + formatQuizQuestion(q, state) ``.
  - `export async function probeTurn(eng: Engine, dir: string, chatPath: string, message: string, opts: TurnOpts): Promise<TurnResult>`
    - The open question is `currentSealed(await eng.store.loadSealed(dir), state)` found by the id in `card`, so the attempt's `skill` is the concept's current number.
    - **Help request** while a question is open (`looksLikeQuestion` or `readPresentationRequest`, and not `givesUp`): reply `PROBE_NO_HELP`, `local: true`. Nothing is recorded.
    - **Answer:** call `markBankAnswer`.
      - A `"reply"` result is pushed to the chat.
      - A `"marked"` result: record the attempt via `eng.bankAttempt` with `activity: "probe"`, `mode: "quiz"`, then `probe: true` and `taskType: "transfer"`, and `recordAttempt` it.
      - Never schedule a card, call `applyAttempt` or record a misconception. Save the state.
      - The verdict uses `quizTurn`'s head line, plus the answer and explanation when the answer isn't correct.
    - **Next question:** the first id in `probe_queue` with no attempt yet.
    - **When none is left:**
      - append `` `**Cold probe finished:** ${correct}/${asked} right. These questions were sealed when the topic was compiled, so this shows what transfers. Levels are unchanged.` ``;
      - set `probe_done` to today and clear `card`.
  - `Engine.startProbe(dir: string)` delegates to `startProbe`.
  - `Engine.probeStatus(dir: string): Promise<ProbeStatus>` loads the sealed questions, the state and the topic's `examDate`, then calls `probeStatus`.

- [ ] **Step 1: Write the failing test** `"cold probes: a probe asks sealed questions with no help, marks them by code and changes no level"`
  - Use `motion()`-style setup with a bank question plus a short probe whose answer is 7, a concept at level 3 with unaided successes on 2026-11-15, and today 2026-11-17.
  - Assert:
    - `startProbe` gives `count` 1, and the chat's last message includes `"**Cold probe**"`;
    - `engine.study(dir, chatPath, "can I have a hint?")` and `engine.study(dir, chatPath, "show me a diagram")` each reply `PROBE_NO_HELP`, `calls()` is 0, and the attempts are unchanged;
    - `engine.study(dir, chatPath, "7")` records one attempt with `probe` true, `result` `"correct"` and `grading` `"deterministic"`;
    - the level is still 3, there's no card for the sealed id, and the reply includes `"1/1 right"`;
    - a second `startProbe` that day returns null.
- [ ] **Step 2: Write the failing test** `"cold probes: a probe left half done resumes with the next question and never asks an answered one again"`. Use two sealed questions. Answer the first, reload the chat, then `engine.study(dir, chatPath, "")`. The open question is the second one.
- [ ] **Step 3: Run** `npm test`. Expected: both fail.
- [ ] **Step 4: Implement** `src/engine-probe.ts` and the engine wiring.
- [ ] **Step 5: Run** `npm test`. Expected: all pass.
- [ ] **Step 6: Commit** with `git commit -m "Run cold probes from sealed questions with no help"`.

### Task 8: Showing probes on the topic page, Home and the study screen; docs

**Files:**
- Modify:
  - `src/topicscreen.ts`: `render` (:29) and the concept table (:66-94);
  - `src/home.ts:64-68`;
  - `src/study.ts`: `syncComposer` (:616-634);
  - `README.md`: the topic-page paragraph (:66-68);
  - `skills/policy.md`: a new section, "Cold probes", after "Choosing what to do next";
  - `docs/PILOT.md:100`;
  - `CHANGELOG.md`.
- Test: `tests/ui.test.ts`, following the harness of the test at :105.

**Interfaces:**
- Consumes: `Engine.probeStatus`, `Engine.startProbe`, `ProbeStatus` and `PROBE_MIN_SHOWN`.
- Copy (exact):
  - **Topic page**, under the coverage line:
    - when `sealedTotal === 0`: "No sealed questions yet. Recompile the topic to add cold probes."
    - else when `asked < 3`: `` `Unseen-task score: after 3 cold-probe answers (${asked} so far).` ``
    - else: `` `Unseen-task score: ${correct}/${asked} on sealed questions (last probe ${lastProbe}).` ``
    - a button `` `Take a cold probe (${count})` `` when `count > 0`, which calls `startProbe` and opens the chat;
    - the tag "not transferring" beside the level of each row in `notTransferring`.
  - **Home**, when `due`: a card below Suggested next, `` `Cold probe due · ${count} question${count === 1 ? "" : "s"} · ${why}` ``, with a **Start** button.
  - **Study**, when the chat's frontmatter has `probe: "yes"`:
    - Hint, Explain and Visual are disabled, with the title "No help during a cold probe";
    - Skip stays enabled;
    - a banner reads "Cold probe: sealed questions, no help, levels unchanged."
  - **Docs:**
    - policy.md states the rules of spec D1 and D4 with their constants.
    - In PILOT.md:100, "anything about unseen tasks" becomes: cold probes record answers on sealed questions in evidence.md with `probe: true`; the same compile wrote them, so they don't replace the pilot's own unseen tasks.
    - The CHANGELOG entry describes cold probes, sealed.md and that levels are unchanged.

- [ ] **Step 1: Write the failing test** `"cold probes: the topic page shows the unseen-task score and starts a probe, Home says when one is due, and the study screen offers no help during it"`. Assert:
  - the three topic-page texts at `sealedTotal` 0, at `asked` 1, and at `asked` 3 with 2 correct;
  - the button opens a chat whose frontmatter `probe` is `"yes"`;
  - the Home card text;
  - Hint, Explain and Visual are `disabled`, and Skip isn't.
- [ ] **Step 2: Run** `npm test`. Expected: fails.
- [ ] **Step 3: Implement** the UI and the docs.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** with `git commit -m "Show cold probes on the topic page, Home and the study screen"`.

### Task 9: Final verification

- [ ] **Step 1:** Run `npx tsc --noEmit`. Expected: no errors.
- [ ] **Step 2:** Run `npm run build`. Expected: it completes and writes `release/study-tutor/`.
- [ ] **Step 3:** Run `npm test`. Expected: every test passes.
- [ ] **Step 4:** Run `graphify update .`, then commit the graph if it's tracked, with `git commit -m "Update code graph"`.
- [ ] **Step 5 (the user, in Obsidian, spends a compile):**
  1. Recompile a small topic.
  2. Check that `Tutor/Topics/<topic>/sealed.md` exists and that questions.md has no `task: probe`.
  3. Take a cold probe, and check that the level stays the same.
