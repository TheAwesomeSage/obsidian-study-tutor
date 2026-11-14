# Local configuration benchmark: qwen2.5:3b on ten Software Systems excerpts

Measured 2026-11-14 on the learner's machine. Raw results are in `bench/out/` (not committed).
Ten excerpts is a small sample: these are raw counts, not reliability estimates.

## Setup

- Machine: Intel Core i5-1335U (10 cores, 12 threads), 8 GB RAM, Intel Iris Xe. Windows 11.
- Ollama 0.40.16 on 127.0.0.1:11434, qwen2.5:3b (Q4_K_M, 3.1B). **CPU only**: `/api/ps` reports
  `size_vram: 0`; Iris Xe was not used. Model resident size 2.09 GB; the `llama-server` process held
  2.37 GB private (1.55 GB working set). Only about 0.8 GB of RAM was free during the runs, with
  Claude, Codex and ChatGPT desktop apps open, which likely explains latency variance.
- Localhost was reachable. Running `ollama --version` started the Ollama desktop app, which was
  not running before this session; it is still running.
- Modules: a read-only bundle of the visual workstream's **uncommitted** `src/visuals/registry.ts`
  (working tree of `codex/visual-player`, SHA-256 prefix `b60b68e3d2bc4918`). Its `algorithm`
  module covers numeric arrays: zero-based index, bubble sort, linear search, binary search. This
  is work in progress, not the final module set.
- Path: the real engine (`engine.requestActivity`): gate, shortlist, local model, local
  validation including the module's own `validateLesson`, cache. In-memory store; nothing was
  written to the vault. Claude was a stub that fails if called. Prompt version `cfg-1`,
  temperature 0.1, seed 7, `num_predict` 400, `num_ctx` 2048, one repair.
- Excerpts: `bench/software-systems-excerpts.json`, by path, line range and SHA-256, read-only.
  Objectives and expected routes were written before any model ran. The expected routes are my
  judgement as implementer.

## Results

Classification is against my expected route. "Shortlist" is the code step that decides whether
the local model is asked at all.

| Excerpt | Topic (location) | Expected | Run 1 shortlist → result | Run 2 shortlist → result | Forced fit check (runs 1 and 2) |
|---|---|---|---|---|---|
| E01 | memory as an array of addressed bytes (Intro L17) | module (index) | none → declined | none → declined | refused, twice |
| E02 | argv strings (Intro L40–42) | unsupported | none → declined | none → declined | refused |
| E03 | pipe circular buffer (PM II L92–104) | unsupported | none → declined | algorithm → refused | refused |
| E04 | `sort` is alphabetical (Question Bank L1691–1694) | unsupported | none → declined | none → declined | refused |
| E05 | threads on odd/even indices (QB L895–904) | unsupported | algorithm → refused | algorithm → refused | refused |
| E06 | `index_counter` critical section (QB L909–929) | unsupported | none → declined | algorithm → refused | refused |
| E07 | race condition on a counter (Conc. I L90–101) | unsupported | none → declined | none → declined | refused |
| E08 | test-and-set spinlock (Conc. II L15–25) | unsupported | none → declined | none → declined | refused |
| E09 | process states (PM I L36–44), diagram | text | text (tutor draws it) | text | not applicable |
| E10 | file descriptor tables (Revision Guide L167–168) | unsupported | none → declined | none → declined | refused |

- Routing correct against my labels: **9 of 10** in both runs. The miss is E01, which I labelled
  as an index trace; code did not shortlist it (no word for indexing in it) and the model refused
  it when it was offered the module directly. Whether an integer-array trace teaches "memory is an
  array of addressed bytes" is debatable; I count it as a miss.
- Supported-module success on real notes: **0 of 1** expected-supported excerpt configured.
  Coverage: **0 of 10** real excerpts produced an activity. That is the honest state for an
  operating-systems course against an array/search/sort module: the needed capabilities are
  thread interleaving, circular buffers, string sorting, state machines and reference tables.
- Forced fit check (module offered for all nine simulation requests): 8 of 9 refused correctly in
  both runs (the miss is E01 again). Outputs were identical across runs at seed 7.
- Run 2 differs from run 1 only in the shortlist, which now also reads the source excerpt (not
  just the card), so E03 and E06 reached the fit check. The change was made after run 1.
- Claude calls: **0** in every run. Reopening every saved result: **0 model calls**, cache hits.
- First-pass validity: every reply parsed as JSON. For refusals the check stops at `fits: false`,
  so their field-level schema validity was not recorded separately. No repair was needed for any
  real excerpt.
- The model's description of what is missing was poor ("None of the above", "none",
  "bubble-sort", one restatement of the excerpt). Since these runs, code replaces vague or
  module-valued text with a plain description of the objective.

### Latency

| | Run 1 | Run 2 |
|---|---|---|
| Cold first call (model load) | 36.2 s (6.4 s load) | 36.7 s (4.1 s load) |
| Warm calls, forced pass | median 25.7 s, 19.9–34.7 s, n = 9 | median 25.4 s, 20.4–51.3 s, n = 9 |
| Prompt / output tokens | 426–569 / 164–221 | same |
| Code-only decisions | 1–19 ms | 2–42 ms |

About 8 output tokens per second. Most of the time is output tokens: the schema makes a refusal
write every field, so a refusal costs as much as a configuration. A two-stage fit check, or a
schema that lets `fits: false` stop early, would roughly halve refusal time; not done here.

## Synthetic controls (not the learner's notes)

`bench/synthetic-controls.json`: four short supported texts (binary search, bubble sort, linear
search, zero-based indexing) and one unsupported (hash table chaining), written for engineering.
They exist to show the fit check can say yes. They are not counted above.

| | Shipped path | Forced fit check |
|---|---|---|
| Supported (4) | 3 configured (S2, S3, S4); S1 failed its first check, then refused on repair | 3 configured (S1, S3, S4); S2 refused |
| Unsupported (1) | declined in code | refused |
| Warm latency | 13.8–18.4 s per configuration | median 18.8 s, 18.0–19.5 s |

Content review of the configured lessons, by me (the implementer, not an independent reviewer):

| Lesson | Settings valid (module) | Answer correct (module computes it) | Source fidelity | Question asks what the assessment checks | Hint leak |
|---|---|---|---|---|---|
| S1 binary search, values 1–16, target 10 | yes | yes | partial: asks the found index, not the halving | yes | no |
| S2 bubble sort [4, 2, 3, 1] | yes | yes | yes | **no**: asks the value "after the first pass"; `trace-result` checks the final array | no |
| S3 linear search, target −10 | yes | yes | yes | yes | no |
| S4 index 15 | yes | yes | yes | vague ("a[index]") | **settings leak**: `target` was set to the answer, visible if the player shows it |

Two follow-ups came from this: module-owned question templates per assessment (supported by the
backend now, `questionTemplates` on a descriptor), and hiding unused settings in the player.

## Not done

- qwen3:1.7b comparison: optional and later. Same prompts:
  `LOCAL_MODEL=qwen3:1.7b STUDY_VAULT=... VISUAL_REGISTRY=... npm run bench:qwen`
  (the client sends `think: false` for qwen3).
- Physics excerpts: none in these notes; the projectile module was not benchmarked.
- Benchmark against the final committed modules, and inside Obsidian.
