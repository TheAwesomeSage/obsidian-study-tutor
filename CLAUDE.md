# Study Tutor (Obsidian plugin)

Desktop-only Obsidian plugin in strict TypeScript, bundled by esbuild into `main.js`, `player.js` (activity player) and `plot.js` (JSXGraph plotter). It runs the Claude Code or Codex CLI on the user's machine (`src/claude.ts`, `src/codex-cli.ts`, `src/model-provider.ts`). Pyodide + SymPy (`vendor/pyodide`) do the maths checks offline. `skills/*.md` are the tutor's own prompts, not Claude Code skills.

## Commands
- Type check: `npx tsc --noEmit`
- Build (type check, fetch pinned Pyodide/SymPy, bundles, `release/study-tutor/`): `npm run build`
- Unit tests: `npm test`
- Browser tests (Playwright, drives Edge): `npm run test:visual-browser`
- `test:live`, `test:features`, `test:session`, `test:compile-live`, `bench:qwen` call a real model and spend usage: run them only when asked.

## Hard rules
- Validate changes with the build/type check and focused tests for the functionality changed. Do not rerun the full suite for routine rebuilds; broaden coverage when shared changes, failures or integration risk justify it. CI still runs the full build and unit suite on Windows and Ubuntu, and browser tests on Windows.
- `main.js`, `player.js`, `plot.js`, `release/`, `vendor/`, `tests/out/` are build output: edit `src/`, never the bundles.
- Model replies and researched pages must never load anything from outside the vault. Pass that text through `src/safemd.ts` before it is saved or rendered.
- Works on Windows and Linux: no case-only path differences, build paths with `path` joins.
- User-visible changes go in `CHANGELOG.md`. A release bumps `manifest.json`, `package.json`, `package-lock.json` and `versions.json` together.

## graphify

A code graph of the repo is in `graphify-out/` (AST only). Before grepping for "what uses / what breaks / how do these connect", ask it: `graphify explain "<file or symbol>"`, `graphify affected "<file or symbol>"`, `graphify path "<A>" "<B>"`; `graphify query "<question>"` works best with symbol names in it. `graphify-out/GRAPH_REPORT.md` lists the hub nodes, for architecture questions only. After changing code, run `graphify update .` (no API cost).
