# Learning feature evaluation and implementation

Evaluated 2026-11-21 against feat/learning-system at d60ac67. Earlier features were implemented in that branch before this change; they were not built by this review. Evidence and limitations: [claim ledger](CLAIM-LEDGER.md).

| Feature | Evaluation | Delivery |
|---|---|---|
| Grading consistency | Required before adaptive learning | Existing grading.ts normalization retained |
| Objective revision awareness | Preserve history without overstating current competence | Existing objective-version.ts retained |
| Synthesis/audit checkpoints | Reduce repeat provider work | Existing compiler.ts retained |
| Tested numerical question families | Reusable, locally marked practice | Existing families.ts retained |
| Faded examples, mistake repairs and contrast pairs | Supported scaffolding pattern; gains here remain unmeasured | Existing bankvariants.ts retained |
| Programming tasks and execution | Useful technical feedback; passing tests is not proof | Existing code task/runner paths retained |
| Structured visual blueprints and systems modules | Reusable visuals with trusted executable semantics | Existing visual modules retained |
| FSRS-6 and scheduler ownership | Memory scheduling, not conceptual mastery | Existing scheduler.ts retained |
| Exam weights, workload and mixed review | Useful planning; no validated pass probability | Existing objective metadata and mixed review retained |
| Sealed cold probes | Useful unseen assessment; novelty alone is not broad transfer | Existing sealed/probe paths retained |
| BKT shadow comparison | Empirical prediction baseline | Existing bkt.ts retained; does not route |
| Activity-aware explanations | Useful, bounded reference context | Added event snapshot from the player to the next tutor call, scoped to chat and focus. No calls on sliders; state is in memory and does not survive an app restart |
| Optional pretesting | Existing placement already diagnoses; needs an escape | Added Skip pretest control/message, stopping remaining questions without grading them |
| Actionable metacognition | Confidence affects feedback, not marks | Added mismatch feedback, tutor follow-up and later-day fresh-item tie-break within existing ranking; later evidence determines whether another check is needed |
| Optional coding coach | Explicit choice, not work interruption | Added chat-scoped Coding coach/Stop control, goal/code/prediction prompting and repair-first guidance. Explicit reveal remains allowed; enabling on an open question marks it helped |
| Recommendation claim ledger | Makes implementation assumptions auditable | Added CLAIM-LEDGER.md. This is a design evidence ledger, not a claim that every generated lesson has been independently validated |
| Neural semantic source recovery | Useful bounded pretrained-model application | Implemented opt-in local passage selection for thin keyword evidence; exact sources, cache, deadline, cooldown and lexical fallback. No skill-remapping model or embedding index |
| Neural knowledge tracing | Potential content-aware predictor | Not trained or deployed: needs model selection, temporal evaluation and representative histories; BKT baseline remains |
| Learned bandit/DRL sequencing | Research-supported possibility, not guaranteed benefit | Not deployed: needs logged action probabilities, supported comparisons and delayed outcome evaluation; no fabricated training/model |

## User flow

- Open a new Master/Adaptive session for placement; choose Skip pretest to leave remaining items unmarked.
- Open a visual, predict, change controls, pause/step and return to ask about it. The next tutoring call receives the latest bounded snapshot. A different chat/focus does not receive it.
- Give confidence before answering. High-confidence errors and low-confidence correct answers receive a specific reflection cue. On later days, a different eligible item on that skill wins otherwise tied practice selection. Normal prerequisite, coverage, assessment holdout and due ordering remain in control.
- Choose Coding coach beside the composer. Paste code or attach an appropriate note and describe the expected behavior. Coaching is a prompt-guided study interface, not an external IDE hook or guaranteed code-verification service. Stop coding coach returns to normal routing.

## Remaining experimental work

For semantic retrieval, first label paraphrase/formula/identifier/gap examples and compare with lexical retrieval at matched latency/memory budgets. For neural prediction, score before-answer predictions on a temporal holdout against BKT and the current estimate. For sequencing, log eligible actions and selection probabilities, compare only suitable alternatives, and evaluate delayed unaided outcomes alongside learner time. Keep a final held-out assessment outside model selection. More accurate prediction alone is not evidence that a routing intervention teaches better.
