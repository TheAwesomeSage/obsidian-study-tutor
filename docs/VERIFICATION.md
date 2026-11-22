# Verification of the question-to-course work

What was checked for each part of the question-to-course work (branch `feat/question-to-course`, commits `f7b9231` to the slice 9 commit), and by what: **code** (no model involved), **fixture** (a scripted model reply, which proves the code path and never the model's judgement), **real tool** (a real compiler or browser on this machine) or **real provider** (a call to Claude Code or Codex). The success criterion is time to independent performance, and nothing here measures it in people: that is [BASE-MODEL-COMPARISON.md](BASE-MODEL-COMPARISON.md), part A, which has not been run.

## Summary

- **No real provider was called** in any check of this work. Every model reply in the tests is a fixture.
- **Real tools:** g++ and gcc compiled and ran the C++ example's code tasks (`tests/coderun.test.ts`, where installed; sanitizers were not available on the Windows machine used, and the tests say so). Edge, through Playwright, ran the player and screens (`npm run test:visual-browser`).
- **Not run:** `npm run test:journey-live`, `npm run bench:base`, `test:live`, `test:session`, `test:features`, `test:compile-live` and `bench:qwen`. They spend usage, and none was asked for. The journey and the process check have been run only on fixtures.
- **Not verified in Obsidian itself:** the screens were checked in the browser preview, not in a running Obsidian vault.

## By slice

| Slice | Feature | Checks | By |
|---|---|---|---|
| 1 | Ask anything | tutoring.test.ts "ask anything" ×6; ui.test.ts "ask anything" ×6 (Home and the study screen); journey step 1 | fixture, code |
| 2 | Grow a question into a course | tutoring.test.ts "grow a question into a course"; journey step 2 (links an installed course; compiling is not in the journey) | fixture, code |
| 3 | Plan backwards from the outcome | compiler.test.ts "backward design" ×2; journey step 3 | fixture, code |
| 4 | Outcome check | tutoring.test.ts "outcome check"; journey step "Outcome check" | fixture, code |
| 5 | Diagnose then teach | tutoring.test.ts "diagnose then teach" ×3; journey step 5 | code, fixture |
| 6 | C++ concurrency course, tasks in parts | tutoring.test.ts "multi-part tasks" ×2; coderun.test.ts (g++, ThreadSanitizer where available); ui.test.ts "example course" | code, real tool, fixture |
| 7 | Signals course, plotter part, SymPy statement | tutoring.test.ts "signals example" ×2, `finalExpression`, `sameSequence`; browser tests; journey parts 1–4 | code, fixture, real tool |
| 8 | Bridges between topics | tutoring.test.ts "structures", "bridge" ×2, "time to independence"; compiler.test.ts structure proposal; journey step 8 | code, fixture |
| 9 | Journey, metrics, base-model check | journey.test.ts (journey, process-check scoring, metrics); learning.test.ts metrics summary | code, fixture |

SymPy (Pyodide) is checked by its own maths tests; the journey runs without it, and the derive step's record says the grader judged the final line.

## How to run what was not run

```
npm run test:journey-live
npm run bench:base
```

Both use the Claude Code CLI by default. Set `TUTOR_TEST_PROVIDER=codex` (with `TUTOR_TEST_CODEX_PATH` and `TUTOR_TEST_CODEX_MODEL`) for Codex. The journey writes `tests/out/journey-live.md`, in which every row says whether code or the real provider did the work, with models, tokens and cost. The process check writes `tests/out/base-bench.md`. When either has been run, add its date, provider, model and result here.
