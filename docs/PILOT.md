# Pilot protocol: does the improved workflow help people learn?

[BASE-MODEL-COMPARISON.md](BASE-MODEL-COMPARISON.md) narrows this to one question, time to independent performance against the same model in its plain chat, and [VERIFICATION.md](VERIFICATION.md) lists what has been checked and how.

This is a protocol for a human-learning pilot, written before any data exist. Nothing in it has been run. Its job is to say in advance what would count as evidence that Study Tutor's improved workflow helps people learn, so that a result cannot be read into the data afterwards. The second half lists exactly what the code already measures, and what it does not.

## Question

At equal learner time, do learners who study with the improved workflow answer **unseen** tasks better, immediately and about 7 and 30 days later, than learners who study the same notes with (a) Study Tutor as it was at 0.9.1 or (c) a strong notes-based chat?

## Arms

| Arm | What the learner uses | Frozen as |
|---|---|---|
| A. Study Tutor 0.9.1 | The plugin at commit `f8bcc9d` ("Study Tutor 0.9.1"), default settings, Adaptive mode. | The commit, the model CLI and version, and the settings file. |
| B. Improved workflow | The plugin at the release under test (this branch line), default settings, Adaptive mode. | The commit, recorded in the pre-registration before the first participant; the model CLI and version; the settings file. |
| C. Notes-based chat | The same model through its ordinary chat, with the unit's notes attached and a fixed tutoring instruction (retrieval practice, one question at a time, feedback after each answer, no answers before an attempt). No plugin. | The instruction text, the model and version. |

All three arms use the same model family and version where the arm uses a model, the same notes, and the same time. Arm C is meant to be strong, not a straw man: the instruction is written by someone who did not build the plugin and is piloted for clarity before the study.

## Design

- **Within participants, three units.** Each participant studies three units of comparable size and difficulty from one course, one unit per arm. Studying the same unit twice would carry learning over, so arms are crossed with units, not repeated on them.
- **Counterbalancing.** Arm order and the unit given to each arm follow a Williams design for three conditions (six sequences), so each arm appears equally often in each period and follows each other arm equally often. Participants are assigned to sequences by a computer-generated random permutation in blocks of six, by someone not involved in marking.
- **Equal learner time.** Each unit gets three study sessions of 30 minutes on separate days within one week, timed by the session lead, not by the plugin. A session ends at 30 minutes whatever the tool suggests. Time actually used is logged, so under-use can be reported.
- **Tests.** A short pretest on all three units before any study (prior knowledge). Then for each unit: an immediate test within 10 minutes of its last session, a delayed test 7 ± 1 days later and another 30 ± 3 days later. Participants agree not to study the units between sessions and tests, and are asked at each test whether they did.
- **Blinding.** Markers do not know the arm. Participants cannot be blind to the tool, so the tests are identical across arms and are taken outside every tool.

## Materials

- **Notes.** Synthetic notes written for the pilot, or real notes whose author has authorised their use in writing. No personal data in them. The same notes are given to all three arms.
- **Units.** Three units from one course (for example, in calculus: differentiation rules, integration by substitution, and series), each about the size of one compiled topic of 6 to 10 subskills.
- **Unseen tasks.** For each unit, an item pool written by a person independent of the plugin's development, from the unit's objectives, before any arm is run. Items are checked to appear in none of: the notes, any arm's question bank or generated variants, and the chat transcripts (a text-similarity screen after the study, with near matches removed from scoring and reported). Each unit has three parallel forms (immediate, 7 days, 30 days) matched on difficulty in a small calibration sample, and each form has:
  - near items: the unit's objectives, in task forms the learner may have met;
  - transfer items: the same ideas in an unfamiliar setting or representation;
  - a confidence rating (0 to 100%) before each answer.
- **Marking.** Items that code can mark (multiple choice, exact numeric or symbolic answers) are marked by code. Open items are marked by two markers against a rubric written with the items; agreement is reported (Cohen's κ) and disagreements are settled by a third marker.

## Outcome measures

Primary (one, fixed in advance): **accuracy on unseen near-and-transfer items at the 7-day test**, as the share of items fully correct.

Secondary:

- Unseen-task accuracy at the immediate and 30-day tests.
- Transfer accuracy on its own, at each test.
- Calibration: the Brier score of the learner's confidence against correctness on test items, and the calibration gap (mean confidence minus accuracy).
- Time: study minutes actually used per unit; time per test item.
- Model cost per participant and unit: input, cached and output tokens, and USD where the provider reports it, for every model call in arms A, B and C, logged by the session lead from the CLI's own usage output (the plugin does not save it; see below). Local-model time and tokens for arm B's local activity configurations.
- Exploratory, not used for any claim: the plugin's own records in arms A and B (levels, estimates, BKT in shadow), compared with test results.

## Sample size

The two primary comparisons are B against A and B against C, each at α = 0.025 two-sided (Holm correction over two tests). For a paired difference in 7-day accuracy, with a standardised effect d_z = 0.4 and 80% power:

n ≈ (z₀.₉₈₇₅ + z₀.₈₀)² / d_z² = (2.241 + 0.842)² / 0.16 ≈ 59.4, about 61 with the t correction.

Allowing 15% loss by the 30-day test, recruit **72** (twelve per Williams sequence). d_z = 0.4 is an assumption: it corresponds to about 7 percentage points of accuracy if the paired standard deviation of differences is about 18 points. A feasibility pilot of 12 participants (two per sequence) comes first, to check timings, the item forms and the variance; its accuracy results are not analysed for effect, and the sample size is recomputed from its variance before the main study under a rule written in the pre-registration.

## Pre-registered analysis

Registered (for example on OSF) before the first main-study participant, with the frozen commits, prompts, model versions, item forms and the analysis code run on simulated data.

- **Model.** A mixed-effects logistic regression on item correctness at the 7-day test: fixed effects for arm, period and unit; random intercepts for participant and item. Contrasts B − A and B − C, Holm-adjusted, reported as odds ratios and as differences in percentage points with 95% confidence intervals.
- **Secondary outcomes** use the same model with the test time or item type as the outcome set, without adjustment for multiplicity, and are labelled exploratory. Calibration and time use linear mixed models. Cost is reported descriptively per arm.
- **Missing data.** Mixed models on all available data (missing at random assumed), with a per-protocol sensitivity analysis excluding sessions that ended more than 5 minutes early or tests with reported study in between.
- **No interim looks** at outcomes. Only feasibility and safety are checked during the study.
- **Deviations** from this plan are reported as such, with the reason.

## What would count as evidence of improvement

- **Improvement over 0.9.1:** B − A on the primary outcome is positive with its Holm-adjusted 95% interval above zero, and the point estimate is at least 5 percentage points (the smallest effect worth acting on, fixed now), and B is not worse than A at 30 days by more than 3 points (non-inferiority margin).
- **Against a strong chat:** B − C is at least non-inferior (lower bound of the interval above −5 points); superiority is claimed only if the interval is above zero.
- **Cost or time:** a saving is claimed only from measured tokens, USD or minutes per participant and unit, with outcomes equal or better. **No saving may be claimed from call counts alone**: fewer calls can mean longer calls, more cached input moved elsewhere, or less teaching.
- **Not evidence:** the plugin's own levels, estimates, BKT values or mastery counts (they measure what the plugin asked, not unseen tasks); satisfaction ratings on their own; any result from the feasibility pilot; results from a single unit or a single test time.

## Consent and privacy

- Ethical approval from the host institution before recruitment, and informed written consent from every participant, with the right to withdraw at any time and have their data removed.
- Only synthetic notes, or notes their author has authorised in writing, are used. Participants do not bring their own notes.
- The consent form says which model provider receives text in each arm (the notes, the participant's answers and messages) and under which data terms.
- Participants are identified by a code. The vault folders collected are limited to the files named in the measurement section; chats are kept only as long as the analysis plan says, then deleted.
- Published data are aggregated or pseudonymised, with free-text answers released only with consent.

## Threats to validity

Novelty and expectation effects (arm B is the newest tool); experimenter effects (the session lead must not coach); model or CLI updates during the study (versions pinned, and checked at each session); units not truly comparable (handled by counterbalancing and the unit term, and checked in the calibration sample); unequal use of the time allowed (time logged and reported); leakage of test items into banks or chats (the similarity screen).

## Measurement: what the code already records

The plugin records the following without any extra setup. File paths are inside the Study Tutor folder of the vault.

| Record | Where | Fields |
|---|---|---|
| Every marked answer | `Topics/<topic>/evidence.md` (one JSON record per line, `kind: "attempt"`) | result; how it was marked (`grading`: deterministic, symbolic, numeric, model, self) and `verification`; `assisted` with what help was given; `answerExposed`; stated `confidence`; `seconds` from the question being asked to the answer (capped at 3600, null when unknown): the only latency recorded per answer; task type and question family; the mark basis and whether it is conclusive; objective versions assessed; timestamp. |
| Level changes | the same file, `kind: "change"` | from, to, cause, note. |
| Policy decisions | `_logs/decisions.md` (the last 300) | the full policy input (now with exam signals and the BKT shadow values), the action, the focus, the policy version, and `local`: `bank` or `placement` when plain code handled the turn with no model call. |
| Compile metrics | `Topics/<topic>/package.md`, `staged.metrics` | `searches`, `pages`, `fetchAttempts`, `cacheHits` (research and passage cache reuse), `stageCacheHits` (synthesis and audit checkpoints reused), `localCalls` and `localMs` (Ollama passage selection), `elapsedMs` (compile wall time), `rejected` (model replies that failed their schema), `generators` and `generatorsRejected` (question generators kept or dropped by trusted code checks), `groups` and `groupsReused` (lesson groups compiled, and those needing no model call), `escalated`. Also per-objective availability and gaps, and the compile issues. |
| Activity configurations | `Topics/<topic>/activities.md` | status (ready, unsupported, invalid); `localCalls`; `repairs` (at most one repair attempt after a failed validation); `claudeCalls` (always 0); `firstPassValid`; `timing`: `wallMs`, `localMs`, `loadMs`, `promptTokens`, `evalTokens`; validation errors. |
| Token use and cost | shown, not saved | per turn in Details (input, cached read and write, output, calls) and summed for the sitting; compile usage in the compile notice. Neither is written to the vault, so the pilot must log usage from the CLI separately. |

Not recorded at this version: time spent reading lessons; a per-turn usage log; blueprint fidelity counts (if a later version adds counters to the compile metrics, the summary below sums them without change); unseen tasks beyond the sealed questions: cold probes record answers on those in evidence.md with `probe: true`, but the same compile wrote them, so they do not replace the pilot's own unseen tasks.

### Summarising it

`src/metrics.ts` has a pure function, `summariseMetrics`, that totals these records, and `scripts/metrics-summary.mjs` runs it over a Study Tutor folder:

```
node scripts/metrics-summary.mjs "<vault>/Study Tutor"          # markdown
node scripts/metrics-summary.mjs "<vault>/Study Tutor" --json   # JSON
```

It reads `package.md`, `evidence.md`, `activities.md` and `decisions.md` files, calls no model, uses no network and writes nothing. It reports compile totals (every numeric counter), answers by marking method, help and exposure, unaided data points and answer-time quantiles, local-model calls, repairs, first-pass validity and timing, decisions handled by code, and BKT (shadow) against the existing estimate. Every report starts with the same caveat: **call counts are not savings**. A smaller number of model calls says nothing about cost, time or learning until tokens, cost, time and outcomes are measured on matched work.

### BKT in shadow

`src/bkt.ts` runs standard Bayesian Knowledge Tracing per subskill beside the existing evidence rules. Its observations are exactly the independent data points `skillEvidence` counts (conclusive, unaided, answer not seen, not self-rated, not a same-day repeat); everything else leaves P(known) where it was. Parameters are untuned defaults (P(L0) 0.3, P(T) 0.15, P(S) 0.1, P(G) 0.2, with the guess raised to 1/options for multiple choice). Before each observation it predicts P(correct) = P(L)(1 − S) + (1 − P(L))G; after it, P(L) is updated by Bayes' rule and then by the learning transition P(L) + (1 − P(L))T.

It is shown in the graph's details and the study screen's Details as "BKT (shadow, not used for decisions): P(known) 0.74", logged with each decision, and scored: the Brier score of its predictions against outcomes is reported next to the Brier score of the existing estimate (the smoothed share of unaided answers correct, as it stood before each answer) over the same answers, with the counts, and with the learner's own confidence where it was given. `replay()` re-scores it over a decision log. `decide()` never reads it. In the pilot it is an exploratory measure only: whether BKT predicts unseen-task results better than the existing estimate would decide whether it is worth tuning, never whether the workflow helps.
