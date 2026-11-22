# Base-model comparison: does the plugin get people to independent performance sooner?

This is a protocol, written before any data exist. Nothing in part A has been run. It narrows [PILOT.md](PILOT.md) to one question, with one primary measure, so that a result cannot be read into the data afterwards. Part B is a process check that can run today. It measures how answers are marked and recorded, not learning, and must never be reported as evidence that either arm teaches better.

## Question

With the same model, the same notes and the same learner time, do learners who study with Study Tutor reach **independent performance on unseen tasks** in less study time than learners who study with the same model in its plain chat?

## Part A: the learning comparison (people)

### Arms

| Arm | What the learner uses | Frozen as |
|---|---|---|
| P. Study Tutor | The plugin at the commit under test, default settings, Adaptive mode, the unit compiled from the notes before the study. | The commit, the provider CLI and version, the model, the settings file, the compiled unit. |
| B. Base model | The same model through its ordinary chat, the unit's notes attached, and this fixed instruction: "Tutor me on these notes. Ask one question at a time, wait for my answer before giving any solution, give feedback on each answer, and move on when I can do it without help." | The instruction text, the model and version. |

Both arms use the same provider, model and version (Claude Code or Codex, never one of each). Arm B is meant to be strong, not a straw man: the instruction is piloted for clarity with two people who take no further part.

### Design

- Within participants, two units of one course, one unit per arm. Arm order and the unit given to each arm are counterbalanced (four sequences: AB/BA crossed with unit order), and participants are assigned to sequences by a computer-generated permutation in blocks of four, by someone not involved in marking.
- Study happens in 20-minute sessions, timed by the session lead, not by either tool, up to six sessions per unit on separate days.
- **Checkpoints.** After each session the participant takes a checkpoint form for that unit, outside both tools, unaided and timed: 8 unseen items (4 near, 4 transfer), marked blind to arm. Each unit has six parallel forms, matched on difficulty in a calibration sample, and no form is taken twice.
- Items are written by someone independent of the plugin from the unit's objectives, before any arm runs, and screened after the study against every bank, generated variant and chat transcript; near matches are removed from scoring and reported.

### Primary measure (one, fixed in advance)

**Time to independent performance:** cumulative study minutes until the participant first scores at least 6 of 8 (75%) on a checkpoint form, with no help. A participant who does not reach it in six sessions is censored at 120 minutes.

Analysis: a Cox model (or, if proportional hazards fail, a comparison of restricted mean time to the criterion) with arm, period and unit as fixed effects and participant as a frailty term. The estimate is the hazard ratio for reaching the criterion, P against B, with its 95% interval.

### Secondary measures (exploratory, labelled as such)

- Checkpoint score at each session.
- The 7-day and 30-day delayed tests from PILOT.md, on fresh forms.
- Tokens and cost per participant and unit, from each CLI's own usage output, logged by the session lead.
- Minutes actually used per session.

### What counts, and what does not

- **Counts:** a difference in time to the criterion whose interval excludes no difference, with equal or better delayed scores.
- **Does not count:** the plugin's own levels, estimates, bridge marks, outcome-check verdicts, time to independence as the plugin records it (`summariseMetrics`), or anything from part B. They measure what the plugin asked, on questions it set.
- **Not a saving:** fewer model calls. A cost claim needs measured tokens or USD per participant and unit, with outcomes equal or better.

### Threats

Novelty (the plugin is newer and has more interface); the session lead coaching; model or CLI updates during the study (versions pinned and checked each session); units not comparable (counterbalancing and the unit term); unequal use of the time; leakage of checkpoint items (the similarity screen). The plain chat cannot record evidence, so arm B is never scored on anything the plugin records.

## Part B: the process check (no people)

`npm run bench:base` (tests/base-bench.ts) gives both arms the same answers to the same questions of the signals example course, and scores each verdict by code against a fixed key:

- **Study Tutor:** each answer goes into a Practise chat with the question open, through `engine.study`, as a learner's would. Most are marked by code; one case ("1000 rad/s") goes to the plugin's grader.
- **Base model:** the same question, options and answer, with the course notes and no key, and the instruction to reply "correct" or "incorrect".

It reports, per arm: agreement with the key, undecided answers, whether the same answer got the same verdict on every repeat (`BENCH_REPEATS`, default 3), and whether the answer was recorded as evidence. It spends one base-model call per case and repeat. Its scoring is tested on fixtures in `npm test` (journey.test.ts).

What it can show: whether marking is reliable and repeatable, and whether a record is kept. What it cannot show: that either arm helps anyone learn. A simulated learner is not used for that, here or anywhere.

## The journey check

`npm test` runs one learner's journey through every feature of the question-to-course work (tests/journey.ts) on fixtures, and writes `tests/out/journey-fixture.md`. `npm run test:journey-live` runs the same journey on the configured provider and writes `tests/out/journey-live.md`. Each row says whether code, a fixture or the real provider did the work, with the models, tokens and cost. See [VERIFICATION.md](VERIFICATION.md) for what has and has not been run.
