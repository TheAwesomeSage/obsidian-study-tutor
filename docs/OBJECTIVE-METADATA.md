# Exam metadata on objectives

An objective line in a topic card can say how the exam treats it: its share of the marks, the paper, the command words, typical marks and minutes, and a date. Study Tutor reads this in code (`src/objective-meta.ts`), keeps it in the course package, and uses it in the study policy in a small, bounded way. Nothing about it is sent to a model, and the compiler's schemas are unchanged.

## Syntax

Add a group in round brackets or braces after the objective's text, beside or instead of its source:

```
## Objectives
- O1: Derive the power rule (Spec 2.1) (weight 8%, paper 2, command: derive, 6 marks, 8 min)
- O2: Apply the chain rule {weight 12, explain, marks 4-6}
- O3: Sketch a gradient function (Spec 2.4; 3 marks; exam 2027-06-03)
Exam: 2027-06-12
```

Parts are separated by commas or semicolons, in any order. Case does not matter.

| Field | Written as | Kept as |
|---|---|---|
| Weight: share of the exam's marks | `weight 8%`, `weight: 8`, `8%`, `8% of marks`, `share 8%` | 0.08. A bare number is a percentage. Must be above 0 and at most 100. |
| Paper or component | `paper 2`, `paper: 1A`, `component B`, `unit 3`, `paper II`, `paper two` | `Paper 2`, `Component B`. The label is a number, a letter, a letter and digits, a Roman numeral or one to four in words. |
| Command words | `command: derive`, `commands: calculate/explain`, `command words: compare and contrast` | lower-case list. A known command word on its own (`explain`, `derive`, `sketch`…) counts too, but only in a group that has another exam field. |
| Typical marks | `6 marks`, `marks 6`, `marks: 4-6` | 6. A range is kept as its middle, rounded. 1 to 200. |
| Typical minutes | `8 min`, `8 minutes`, `minutes: 8`, `time 8` | 8. Above 0, at most 300. |
| This objective's exam date | `exam 2027-06-03`, `date 2027-06-03`, `2027-06-03` | `2027-06-03`. Written year-month-day, with `-`, `/` or `.`; it must be a real date. |

The topic's exam date goes in the card's properties (`exam: 2027-06-12`, also `exam-date` or `exam_date`) or on its own line under `## Objectives` (`Exam: 2027-06-12` or `Exam date: 2027-06-12`). The property wins when both are given. An objective's own date wins over the topic's.

## Tolerance

- A part that does not read cleanly (`weight lots`, `paper two-ish`) is ignored. The objective, the rest of the group and the card are unaffected; nothing is ever an error.
- A group with nothing that reads as metadata is treated exactly as before: the last such group in round brackets is the objective's source. So `(Spec 3.4)`, `(weight banana)` and `(derive)` alone are sources, and cards written before this syntax read as they always did.
- In a mixed group, parts that are not metadata become the source when there is no separate source group: `(Spec 1; time 5 minutes)` gives the source `Spec 1` and 5 minutes.
- Metadata groups may come before or after the source group. A field given twice keeps its leftmost value; command words are combined.
- A group whose only content reads as metadata (for example `(Paper 2)` or `(2027-06-03)`) is taken as metadata, not as the source.

## Where it is kept

`Objective.exam` on the parsed card, `PackageObjective.exam` and `CoursePackage.examDate` in `package.md`. A staged compile reads the same syntax from the specification's wording of each objective, strips it from the objective's text and falls back to the card's line for that id.

A recompile writes the card again from the compiled objectives. Metadata typed on the card by hand survives only if the compiled text still carries it, so keep it on the objective's line in the specification note as well, and check the card after compiling. The compile prompts do not ask the model to copy it; whether a model keeps it is not verified.

## What the policy does with it

`examSignals` (in `src/policy.ts`) gives each subskill a signal from the objectives it teaches: the share of the marks (an objective's weight is split evenly over the subskills that teach it), the days to the nearest exam date that has not passed, and the minutes, marks, papers and command words. `examEffect` turns that into a factor on the subskill's study priority:

- Weight counts relative to the topic's average share, so it only reorders concepts within a topic. It needs at least two weighted subskills to compare.
- An exam date within 60 days raises the factor by up to 25% on the day itself, falling linearly to nothing at 60 days. A date that has passed has no effect.
- The factor is held between ×0.75 and ×1.5, and the priority stays within its usual 0.1 to 5. With the default exam weight of 1 and a neutral priority, the exam term of a score's lift moves by at most +0.125 or −0.0625; the observed-errors weight alone can add 1.5.
- Whenever the factor is not 1, the decision's reason says so, with the numbers: "Exam weighting: it carries 20% of the marks, 1.8× this topic's average, so its priority is scaled ×1.50, the most exam metadata can add (1 → 1.5)."
- Unaided practice (independent practice, transfer, retrieval) on a subskill whose objectives give minutes adds a timed-practice suggestion, "Exam practice: allow about 8 minutes, as in the exam (6 marks, derive, Paper 2)", when the time you have holds those minutes and the exam is not past or more than 60 days away. Learn mode and lessons are never timed.

Levels are untouched: metadata only ranks what to study next. `decide()` stays deterministic, because the days to the exam are worked out by the caller from today's date. The rules are also summarised in `_skills/policy.md`.
