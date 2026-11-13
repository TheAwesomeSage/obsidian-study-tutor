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
| 5 | can teach it | as 4, with three such questions over two or more days and no recent failure |

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

## Estimates and confidence

The estimate shown for a concept is the chance that **the next unaided first answer on that concept is fully correct**. It is the smoothed share of unaided answers that were correct, it is labelled provisional, and it is not shown at all with fewer than three unaided answers.

Your stated confidence is compared with the same yes-or-no outcome. The Brier score is the mean squared gap between the two, where lower is better, and it is not shown with fewer than three rated answers. Your confidence, the plugin's estimate and the level are three separate things.

## Choosing what to do next

Adaptive mode and the home screen rank concepts with a score:

`score = gap × (1 + exam × priority + prerequisite × dependents + errors × recent errors + uncertainty × lack of evidence + recency × time since practice + time × fit to the time you have)`

The weights are in settings. They only rank suggestions; they cannot change a level.

Explicit rules come before the ranking, in this order:

1. An open step is finished before another starts, unless you ask to move on.
2. A concept is not taught while a prerequisite is weak. A prerequisite that has never been checked is diagnosed with one question before it is treated as weak. This applies to prerequisites in other topics too.
3. Learn mode stays within explanation, examples and guided practice. When you look ready it suggests unaided practice and leaves the choice to you.
4. In Adaptive mode, what plain code can mark (placement questions, bank questions) is handled without a model.

Every decision is logged with what the policy saw, under `_logs/decisions.md`. "Compare policy with logged decisions" in the More menu replays that log through other weights and writes what would have changed. The policy carries a version number, bumped whenever its rules change.

## Session memory

Each chat keeps a compact record: the goal, the mode, the current concept, the pending question, your latest attempt word for word, help given, whether the answer has been shown, unresolved misconceptions, the next action and the sources in use. It is mirrored as a readable note under the topic's `sessions` folder.

A long chat is summarised and continued in a new file only at a finished step. A reply that ends with a question never counts as finished, whatever the model reports, so an open question or a half-done proof keeps its whole transcript. The earlier parts stay linked, and exact passages are fetched back when you refer to them.
