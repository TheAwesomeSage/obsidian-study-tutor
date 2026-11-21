# Sealed transfer set (cold probes)

Status: proposed, 2026-11-21. Source: idea A1 from the research-to-features pipeline (ranked first).

## Problem

Every number Study Tutor shows (level, estimate, BKT) comes from questions it set and taught around. The repo says so itself: those numbers are "not evidence" that the workflow helps (docs/PILOT.md:73), and nothing about unseen tasks is recorded (docs/PILOT.md:100). Studies of AI tutoring keep finding a large gap between performance with the tool and performance on unseen, unaided work (Bastani et al., PNAS 2025: +127% in practice, ±0 on the exam). A learner who wants to become an expert needs one honest number: how they do on problems the tool never showed them.

## What exists already

- Families **reserved for assessment** (`questionFamilies`, src/coursepkg.ts:104): the transfer families, or else the last of three or more. Practice and placement skip them; the level-4 transfer check spends them. They are part of the learning loop, not a measure kept apart from it.
- **Leak:** reserved families still reach the learner through the built-in review's new cards (`reviewQueue`, src/formats.ts:742) and the Spaced Repetition export (`buildSrNote`, src/formats.ts:858), answers included.

## Decisions

- **D1. A probe is a ruler, not a lever.** Probe answers are written to evidence.md with `probe: true`. Levels, estimates, the Brier score, BKT, card schedules, misconception records and the policy all ignore them. No `POLICY_VERSION` bump. *(This changes the PRD, which had probes count as ordinary unaided evidence.)*
- **D2. The sealed pool is its own compile output.** Compile asks for one extra family per subskill with `task: probe`. `Store.saveCompiled` moves those questions from questions.md to sealed.md, so no existing reader of the bank can see them. Each sealed question is tagged with its stable concept id, keeps that id across recompiles, and gets a content-hash id (`P` + 10 hex characters), so a regenerated question is never mistaken for a spent one. Reserved families keep their current role.
- **D3. Near-copies are dropped.** A probe question whose word-set Jaccard similarity (`similarity`, src/course.ts:71) with any bank question on the same subskill is ≥ 0.5 is dropped. The count dropped is kept in sealed.md's frontmatter.
- **D4. When a probe is due.** A concept is eligible when its level is ≥ 3, its first unaided success was before today, and it has an unspent sealed question. A probe asks at most 6 questions, one per eligible concept (highest level first). It is due when at least one concept is eligible and either there has been no probe yet, or 14 days have passed since the last one, or the exam date is within 7 days and 7 days have passed since the last one. The score is shown once 3 probe answers exist. A concept at level ≥ 4 whose latest probe answer was wrong is marked "not transferring".
- **D5. The reserved-family leak is fixed first.** Reserved families no longer appear as new review cards or in the Spaced Repetition export. This is optional: drop Task 1 of the plan if the leak is intended.

## Behaviour

- **Compile notice:** "… N sealed for cold probes."
- **Topic page:** the unseen-task score (or how many answers are still needed), a "Take a cold probe (N)" button, and a "not transferring" tag in the concept table.
- **Home:** a "Cold probe due" card with the reason.
- **Probe chat:**
  - no hints, explanations, visuals or tutor turns; help requests are refused locally with no model call;
  - answers are marked by the same code, SymPy or grader path as bank questions;
  - the answer is shown after each attempt;
  - a summary at the end says levels are unchanged.

## Non-goals (v1)

- Probe results do not move levels or schedule anything.
- No extra compile call is made to top up a depleted pool: recompiling adds new sealed questions.
- No fresh-number variants of sealed questions.
- No cross-topic probes.

## Success

- Within a month of use, the gap between levels and probes (the share of concepts at level ≥ 4 that fail their probe) is measurable.
- The leak tests prove that sealed text reaches no bank reader, review or flashcard export.
- `npm run build` and `npm test` pass on Windows and Ubuntu.
