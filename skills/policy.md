# How Study Tutor decides

This note describes the rules the plugin enforces in code. It is documentation: editing it changes nothing. The teaching instructions in the other files of this folder are prompts, and a prompt can be ignored by a model. Nothing below depends on a prompt being followed.

## Two layers

- The **course graph** says which concepts exist and how they relate. It lives in each topic's `graph.md` and holds nothing about you.
- The **learner layer** says what you have shown you can do. Levels are in `state.md`, and every marked answer and every change of level is in `evidence.md`.

Concepts have stable ids, so recompiling a topic, renumbering or renaming a subskill does not detach its evidence or its relations.

## Relations

| Relation | Meaning | Orders study? |
| --- | --- | --- |
| `requires` | cannot be learned without the other | yes |
| `supports` | helps with the other, without being necessary | no |
| `applies_to` | is used in the other, an application | no |
| `contrasts_with` | commonly confused with the other | no |
| `derived_from` | derived mathematically from the other | no |

Each relation is `inferred` (proposed when the topic was compiled), `reviewed` (confirmed by you) or `rejected` (ruled out by you, and ignored). A `requires` relation that would close a loop is refused.

## What is recorded for every answer

A stable id, the question and its identity, the concept, the activity, the difficulty where known, your answer, your confidence if you gave one, any help given, whether the answer had been shown, the outcome, the kind of error, the time taken, the time of day, how it was marked and whether that mark was verified.

How it was marked is one of:

- **deterministic**: plain code compared a letter or an exact answer;
- **symbolic**: SymPy simplified the difference to zero;
- **numeric**: SymPy compared values at test points or to the decimal places written, which is strong evidence and not a proof;
- **model**: a language model judged it. Unverified unless SymPy recomputed the results the reply states;
- **self**: you rated yourself after seeing the answer.

## What counts as unaided evidence

An answer is unaided evidence only if all of these hold:

1. no hint, explanation or worked step was given for that question, and it was not asked straight after an explanation;
2. the answer had not been shown;
3. it was not self-rated;
4. it is not a repeat of a question you already answered that day. Once an answer has been marked you know what it is. The same question on a later day counts again, as delayed recall.

A retried turn has the same id as the first try, so it replaces the record instead of adding one.

## What each level needs

| Level | Meaning | Needs |
| --- | --- | --- |
| 1 | heard of it | a lesson was delivered, or any answer was marked |
| 2 | can follow along | one answer at least partly right, help allowed |
| 3 | can do with help | two different questions answered fully correctly, help allowed |
| 4 | can do independently | two different questions correct and unaided, one of them a transfer question on a later day than the first success, and at most one recent failure |
| 5 | can teach it and handle edge cases | as 4, with three such questions over two or more days, no recent failure, and, unaided, an explanation good enough to teach from (a teach-back task) and an edge case handled |

Answers recorded before 0.6 have no task type, so they cannot show a teach-back or an edge case. A level 5 from before then reads as not yet backed until both are shown; nothing is deleted.

A question is a transfer only if its question family has not been met before. A family already met is practice of a known kind, whatever the tutor's mark says; a family met for the first time, asked as an application on a later day than the first unaided success, counts as a transfer. Questions without a family keep the earlier rule (the tutor's transfer mark, where the app set a transfer question).

Further rules:

- A level rises one step per answer at most.
- A model may propose a level. A proposal above what the table supports is ignored.
- A level falls by one when an unaided answer is wrong after earlier success and that happens twice in a row or on a later day. A model may lower a level by one, and only on a turn where your answer was not correct.
- Confidence never moves a level in either direction.
- An answer that could not be marked, or whose marking failed, is recorded as ungraded. It is never treated as wrong.
- If a tool fails (SymPy unavailable, a check that times out), the failure is recorded and decides nothing.
- The solution to an assessment question is shown only after an attempt or an explicit skip. Teaching examples are always available in Learn mode.
- A mark you dispute stops counting in either direction, and a level change it caused is undone.

"At target" is only said when every level at target is backed by this evidence. A level carried over from an older version, or set by a single placement question, is shown as not yet backed and is checked before it is trusted.

## Covering every idea (policy version 4)

A subskill is made of ideas: the objectives it teaches when the card gives it two or more, otherwise the claims on its card. Code keeps which of them the learner's answers have touched. At target, a subskill that has an idea its bank can ask and that no answer has touched is not done: the next step is practice on that idea. This never changes a level. Within a subskill, the next question prefers an idea not yet asked.

After each answer the next question either builds on it or moves on. It builds on it, staying on the same idea from another angle, when the answer had help or showed the answer, was wrong or partly right, or was right but the learner said they were unsure, or right but much slower than their usual and not sure. It moves on when the answer was right and sure, when the idea has two unaided right answers, or after two follow-ups on one idea in a row. Confidence is self-reported, so it never decides against the mark, and it never moves a level.

## Estimates and confidence

The estimate shown for a concept is the chance that **the next unaided first answer on that concept is fully correct**. It is the smoothed share of unaided answers that were correct, it is labelled provisional, and it is not shown at all with fewer than three unaided answers.

Your stated confidence is compared with the same yes-or-no outcome. The Brier score is the mean squared gap between the two, where lower is better, and it is not shown with fewer than three rated answers. Your confidence, the plugin's estimate and the level are three separate things.

A fourth number, labelled **BKT (shadow, not used for decisions)**, is a standard knowledge-tracing model run alongside for comparison. It learns only from the same unaided answers, and its predictions are scored against what happened next, next to the estimate's. Nothing uses it to choose a step or set a level.

## Choosing what to do next

Adaptive mode and the home screen rank concepts with a score:

`score = gap × (1 + exam × priority + prerequisite × dependents + errors × recent errors + uncertainty × lack of evidence + recency × time since unaided practice + time × fit to the time you have)`

The weights are in settings. They only rank suggestions; they cannot change a level.

When a topic card's objectives give exam metadata (a share of the marks, a paper, command words, typical marks and minutes, an exam date), a concept's priority is scaled by it, never by more than ×1.5 or less than ×0.75: its share of the marks counts against the topic's average, and an exam within 60 days adds up to a quarter. The reason shown says when this happened and by how much. Unaided practice on a concept with typical minutes suggests answering in that time, as in the exam, when you have that long. The syntax is in the plugin's docs/OBJECTIVE-METADATA.md.

Explicit rules come before the ranking, in this order:

1. An open step is finished before another starts, unless you ask to move on.
2. A concept is not taught while a prerequisite is weak. A prerequisite that has never been checked is diagnosed with one question before it is treated as weak. This applies to prerequisites in other topics too: each weak one is checked once per chat, by its id, and its outcome is kept with the chat; one that fails its check is explained (as a lesson on that prerequisite, not on the concept you are studying) before the next is checked. Answering the concept itself correctly without help settles its prerequisites in use.
3. Learn mode stays within explanation, examples and guided practice. When you look ready it suggests unaided practice and leaves the choice to you.
4. In Adaptive mode, what plain code can mark (placement questions, bank questions) is handled without a model.
5. Each concept has a next delayed check: 1, 3, 7, 14, 30 and then 60 days after its last unaided success, by how many separate days in a row it has been answered correctly without help, and the next day after an unaided failure. A due check is part of Adaptive study. Helped work never moves it. These intervals are a starting hypothesis, to be tuned against later unaided answers.
6. A transfer question is set only when it can count: not on the same day as the first unaided success. A transfer question on a later day is also the delayed check.
7. On the way to level 5, Adaptive asks you to teach the idea back and to handle an edge case.

The home screen's suggestion is the decision Adaptive study would make first on that topic, so the two always agree. Flashcards are item recall, kept apart from concept evidence: they come first only when nothing pressing (a lapse, a due delayed check, an unchecked prerequisite) is waiting.

## Cold probes

A cold probe asks sealed questions: ones the compile wrote and kept out of the question bank, so they were never practised. It measures transfer to unseen work and moves nothing.

1. A concept is eligible at level 3 or higher, with a first unaided success before today and an unspent sealed question.
2. A probe asks at most 6 questions, one per concept, highest level first.
3. A probe is due when there has been none yet, or 14 days have passed since the last one, or the exam is within 7 days and 7 days have passed since the last one.
4. The unseen-task score is shown after 3 answers.
5. "Not transferring" means level 4 or higher with the latest probe answer wrong.
6. Probe answers move no level, estimate, BKT value, card or misconception, and their timings do not set what counts as a slow answer. They are recorded with `probe: true`.
7. Help requests (a message ending in "?", hints, explanations, visuals) are refused locally during a probe. Skip is allowed.

## Diagrams, simulations and games

They are used on demand, never on opening a topic, a note or a concept in the graph.

- You can ask for one ("show me a simulation"). A saved activity opens at once; a new one is configured from a short excerpt of your notes by a small model on this computer (Ollama), and nothing calls Claude. If no module can show it, you are told so, the compiled worked example is shown instead, and the request is noted for a later development pass.
- The guide offers one beside its reply only for a repeated difficulty whose kind is known (two recent unaided failures, diagnosed as conceptual or with a misconception recorded) on a concept the course marked as suited to it. A first error gets a narrower question instead.
- Moving controls, playing, stepping and resetting use no model at all. An answer inside an activity is assessed by the module's own code and recorded as helped work: it can support "can do with help", and never counts as unaided evidence. Opening an activity while a question is open makes your answer to that question helped too.
- A saved activity is reused only while the passage it rests on, the module, the asset catalogue, the configuration prompt and the local model are all unchanged. A configuration that failed its checks is saved too, so it is not tried again.

Every decision is logged with what the policy saw, under `_logs/decisions.md`. "Compare policy with logged decisions" in the More menu replays that log through other weights and writes what would have changed. The policy carries a version number, bumped whenever its rules change.

## Session memory

Each chat keeps a compact record: the goal, the mode, the current concept, the pending question, your latest attempt word for word, help given, whether the answer has been shown, unresolved misconceptions, the next action and the sources in use. It is mirrored as a readable note under the topic's `sessions` folder.

A long chat is summarised and continued in a new file only at a finished step. A reply that ends with a question never counts as finished, whatever the model reports, so an open question or a half-done proof keeps its whole transcript. The earlier parts stay linked, and exact passages are fetched back when you refer to them.
