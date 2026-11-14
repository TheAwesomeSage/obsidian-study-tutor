# Visual activities and learning backend: final integration

Branch `claude/finish-integration`, built on the visual workstream's `codex/visual-player` (which
already contained the backend branch `claude/learning-backend`). Verified on 2026-11-14 on the
learner's Windows machine (i5-1335U, 8 GB, Iris Xe), Obsidian 1.15.1, Ollama 0.40.16 with qwen2.5:3b.

## How the branch was assembled

| Commit | What |
|---|---|
| `fc98165`, `8f6465f` | Visual workstream: contract, player, function plotter (JSXGraph), projectile, algorithm player, CC0 assets, graph details |
| `f277763`, `557881f`, `da382c3` | Learning backend (the `claude/learning-backend` commits as the visual workstream merged them) |
| `7bf673b` | The visual workstream's last integration pass, which was left uncommitted in its working tree, committed unchanged |
| `a180efc` | Fixes found while verifying in real Obsidian |
| later commits | Numeric variants, verification tooling and record, this report |

The visual workstream's own checkout was not modified.

## Install and set up

1. `npm install`, then `npm run build`. Copy the whole `release/study-tutor/` folder (`main.js`,
   `manifest.json`, `styles.css`, `player.js`, `plot.js`, `assets/`) to
   `<vault>/.obsidian/plugins/study-tutor/`, and enable Study Tutor. `player.js` and `plot.js` load
   only when an activity opens; without them the rest of the plugin still works. Obsidian's own
   updater fetches only the first three files, so update by copying the folder.
2. For new activities: install [Ollama](https://ollama.com), run `ollama pull qwen2.5:3b`, and keep
   Ollama running. Settings → Study Tutor → **Interactive activities** → **Test** checks it. Saved
   activities open without it.
3. Recompile a topic once to get its course package, worked examples and visual eligibility. Older
   topics still work; explicit requests work on them, but the guide never offers an activity on a
   topic compiled before this version.

## Verified in real Obsidian (normal entry points)

`scripts/verify-obsidian.mjs` starts Obsidian with an **isolated profile and a seeded isolated
vault** (`scripts/seed-verification.ts`; never the learner's vault), drives it over the Chrome
DevTools protocol through the ribbon icon, tiles, composer, buttons and command palette, and saves
the screenshots in `docs/verification/`. The topic is a synthetic fixture. The one pre-saved
activity came from a scripted local-model reply. Claude was blocked by an invalid model name.

| Step | Result |
|---|---|
| Ribbon → Home | Home shows the policy's step ("Diagnosis"), same as Adaptive (`01`) |
| "Show me a simulation for this concept." in Adaptive | Saved activity opened in 0.3–0.6 s, no model call (`02`) |
| Predict → step → explain → check | Module code marked it correct; recorded as helped (`assisted`, deterministic), level unset → 2 (`03`, `04`) |
| New numbers | Module-made variant opened in 0.2 s, values 66, 13, 16, 87; no model (`04b`) |
| Graph → Linear search → Study this → ask for a simulation | Real qwen2.5:3b configuration, player opened in 18.9–30.3 s over four runs (`06`, `07`) |
| Ask for a simulation of process states | No module; the reply says so and shows the compiled worked example; the gap is logged (`09`) |
| Projectile fixture (v = 10 m/s, 45°, g = 9.81) | Lands at t = 1.442 s, x = 10.19 m; the answer 10.19367992 m is accepted (`15`) |
| Function plotter fixture | JSXGraph loaded on demand in 1.3 s; tangent slope 2.000 at x = 1 (`16`) |
| PhET fixture | Link-out with a source-based question; marked as opaque (`17`) |
| Dark theme; 496 px pane | Home, Study and Graph lay out without overlap (`10`–`14`) |
| Console | 0 errors |
| Files written | `activities.md`, `activity-log.md`, `evidence.md`, `_logs/capability-requests.md` |

Fixed during verification: the topic picker drew over the Graph tab at medium widths; the "why"
strip collapsed to one word per line in a narrow pane; an offer opened for the current focus rather
than its concept; the linear-search activity named the wrong supported objective; an unsupported
request showed its message twice; prose with backticks was rejected as code.

## Tests

- `npm test`: 130 tests, 129 pass, 1 skipped (native SymPy; no Python with SymPy on this machine).
- `npm run test:visual-browser` (Playwright in Edge): 6 of 6 pass: projectile (exact landing,
  pause, reset), plotter (JSXGraph, slider, tangent), algorithm (real trace, reduced motion),
  graph light and dark (keyboard, details), dense graph (1,920 concepts) and 390 px player without
  horizontal overflow.
- `npx tsc --noEmit` clean; `npm run build` produces `main.js` 342 kB, `player.js` 32 kB, `plot.js` 900 kB.
- Not run (they spend Claude usage): `test:live`, `test:features`, `test:session`.

## Benchmark

`bench/REPORT.md`. On ten real Software Systems excerpts the final code routes 9 of 10 as I had
labelled them before running, configures 0 activities (the one expected-supported excerpt is
declined), makes 0 Claude calls, and reopens everything with 0 model calls. On CPU, a cold first
call takes about 34 s and warm calls about 23 s (median). Synthetic controls, kept apart, show the
fit check does configure supported texts.

## Requirements: status

| Requirement | Status |
|---|---|
| Player: labelled native controls, play/pause, step, reset, keyboard, reduced motion, instructional reason, no inference during playback | Done; verified in Obsidian and Edge |
| Contract `src/visuals/contracts.ts`, registry `listModuleDescriptors` / `validateLesson` / `assessLesson` | Done, plus `kinds`, `summary`, `questionTemplates`, `listAssets`, `catalogVersion`, `createVariant` |
| Function plotter (JSXGraph): families, transformations, draggable point, tangent, discontinuities, undefined slopes | Done. **Vectors extension not built** |
| Projectile target challenge: prediction, launch, components, scaled arrows, reachability, fixed camera, exact landing, frame-rate independent | Done; reference values verified |
| Algorithm player: indexing, bubble sort, linear and binary search from real traces | Done. **Recursion, call stack and memory modules not built** (no agreed semantics; the benchmark shows which OS capabilities are missing) |
| CC0 Kenney assets with provenance; PhET external activity | Done (3 assets; PhET as an opaque link). **Commons search not built**: nothing in the workflow needs it yet |
| Graph: stable ids, relations, prerequisites, priorities, colours, search, pan/zoom, saved positions, keyboard; capability, evidence and next action; statistics on demand | Done; verified light/dark, narrow, dense. The **reference image** the brief mentions was not available, so the look was not compared with it |
| Lightweight runtime: lazy modules, paused hidden animation | Done; open times measured above |
| On-demand gate, local configuration, cache, evidence rules, course package, refresh | Done (backend) |
| Fresh numeric variants on reopen | Done: module-made, validated, answers checked against the variant |
| Physics benchmark | **Not possible from these notes**: there are no physics excerpts in Software Systems |
| qwen3:1.7b comparison | Optional, later; `LOCAL_MODEL=qwen3:1.7b npm run bench:qwen` |
| Agent-browser research fallback | Not needed by the current sources; not built |

## Reproduce

```
npm run build
npx esbuild scripts/seed-verification.ts --bundle --platform=node --format=cjs --loader:.md=text --loader:.png=dataurl --outfile=tests/out/seed-verification.cjs
VERIFY_VAULT=<new folder> node tests/out/seed-verification.cjs
VERIFY_VAULT=<that folder> VERIFY_PROFILE=<new folder> VERIFY_OUT=docs/verification node scripts/verify-obsidian.mjs
```

The isolated profile downloads its own Obsidian update into the profile folder; the installed
Obsidian and the learner's settings are not touched.
