// Design preview. Renders the real view code with the stubbed "obsidian" module and writes
// tests/out/preview.html: the three tabs side by side, in stand-in dark and light themes.
// No model calls. Run with `npm run preview`, then open the file in a browser.
// Icons and rendered maths are placeholders here; Obsidian draws the real ones.

/* eslint-disable @typescript-eslint/no-explicit-any */
import "./obsidian-stub";
import * as nodefs from "node:fs";
import StudyTutorPlugin from "../src/main";
import { parseCompileOutput } from "../src/formats";
import { MemFS } from "./memfs";

const COMPILED = `# Eigenvalues and eigenvectors
subject: linear-algebra

## Overview
Eigenvectors are the directions a matrix only stretches.

## Subskills

### 1. Definition of an eigenvector
prerequisites: none
- A nonzero v with Av = tv.

### 2. Characteristic polynomial
prerequisites: 1
- det(A - tI) = 0.

### 3. Diagonalisation
prerequisites: 2
- A = PDP^-1 when there is a basis of eigenvectors.

### 4. Applications
prerequisites: 3
- Powers of a matrix.

=====QUESTIONS=====

### Q1
subskill: 2
type: mcq
question: Which equation gives the eigenvalues of A?
options:
- A. det(A) = 0
- B. det(A - tI) = 0
- C. A = tI
- D. tr(A) = t
answer: B
explanation: Av = tv has a nonzero solution exactly when A - tI is singular.
`;

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const THEMES: Record<string, string> = {
  dark: `--background-primary:#1e1e1e;--background-secondary:#262626;--background-modifier-border:#3a3a3a;--background-modifier-form-field:#2a2a2a;--background-modifier-hover:rgba(255,255,255,.075);--background-modifier-box-shadow:rgba(0,0,0,.3);--text-normal:#dadada;--text-muted:#b3b3b3;--text-faint:#777;--text-accent:#a68af9;--interactive-accent:#8a5cf5;--text-on-accent:#fff;--text-error:#fb464c;--text-success:#44cf6e;--interactive-normal:#363636;`,
  light: `--background-primary:#ffffff;--background-secondary:#f6f6f6;--background-modifier-border:#e0e0e0;--background-modifier-form-field:#fafafa;--background-modifier-hover:rgba(0,0,0,.06);--background-modifier-box-shadow:rgba(0,0,0,.1);--text-normal:#222;--text-muted:#5c5c5c;--text-faint:#ababab;--text-accent:#8a5cf5;--interactive-accent:#8a5cf5;--text-on-accent:#fff;--text-error:#e93147;--text-success:#08b94e;--interactive-normal:#f2f3f5;`,
};

// A rough stand-in for Obsidian's own base styles, so the plugin's stylesheet has something to sit on.
const BASE = `
body{margin:0;font-family:Inter,-apple-system,"Segoe UI",sans-serif;font-size:15px;}
.theme{padding:20px;display:flex;gap:18px;flex-wrap:wrap;background:var(--background-secondary);color:var(--text-normal);
  --font-ui-small:13px;--font-ui-smaller:12px;--font-semibold:600;--font-monospace:ui-monospace,Consolas,monospace;}
.pane{width:380px;height:760px;background:var(--background-secondary);border:1px solid var(--background-modifier-border);border-radius:8px;overflow:hidden;}
.cap{font:600 12px sans-serif;color:var(--text-faint);margin:0 0 6px;text-transform:uppercase;letter-spacing:.08em}
button{font:inherit;font-size:13px;color:var(--text-normal);background:var(--interactive-normal);border:0;border-radius:5px;padding:4px 12px;height:30px;cursor:pointer;box-shadow:0 1px 1px rgba(0,0,0,.2)}
button.mod-cta{background:var(--interactive-accent);color:var(--text-on-accent)}
select.dropdown{font:inherit;font-size:13px;height:30px;color:var(--text-normal);background:var(--interactive-normal);border:0;border-radius:5px;padding:0 8px}
textarea{font:inherit;font-size:14px;color:var(--text-normal);background:var(--background-modifier-form-field);border:1px solid var(--background-modifier-border);padding:6px;box-sizing:border-box}
table{border-collapse:collapse} p{margin:8px 0}
[data-icon]::before{content:"";display:block;width:16px;height:16px;border:1.5px solid currentColor;border-radius:4px;box-sizing:border-box}
.st-welcome-icon[data-icon]::before{width:20px;height:20px}
`;

async function main() {
  const fs = new MemFS();
  const leaves: any[] = [];
  let plugin: any = null;
  const app: any = {
    vault: { adapter: fs, getMarkdownFiles: () => [], cachedRead: async () => "", getAbstractFileByPath: () => null },
    metadataCache: { resolvedLinks: {}, getFirstLinkpathDest: () => null },
    workspace: {
      onLayoutReady: (cb: () => void) => cb(),
      getLeavesOfType: () => leaves,
      getActiveFile: () => null,
      revealLeaf: async () => {},
      openLinkText: async () => {},
      getRightLeaf: () => {
        const leaf: any = { app, view: null };
        leaf.setViewState = async ({ type }: { type: string }) => {
          leaf.view = plugin.viewCreators[type](leaf);
          leaves.push(leaf);
          await leaf.view.onOpen();
        };
        return leaf;
      },
    },
  };
  plugin = new (StudyTutorPlugin as any)(app, {});
  await plugin.onload();
  await tick();
  const out = parseCompileOutput(COMPILED);
  const dir = await plugin.store.saveCompiled({ title: "Eigenvalues and eigenvectors", fm: { source: "spec", subject: out.subject, research: "yes" }, topicBody: out.topicBody, questionsBody: out.questionsBody, target: 4 });
  const state = await plugin.store.loadState(dir, 4);
  state.levels = { 1: 4, 2: 3, 3: 1, 4: null };
  state.focus = 2;
  state.bank = { 1: { right: 5, total: 6 }, 2: { right: 2, total: 4 }, 3: { right: 0, total: 1 }, 4: { right: 0, total: 0 } };
  state.misconceptions = ["thinks the zero vector can be an eigenvector"];
  await plugin.store.saveState(dir, state);
  const chatPath = await plugin.store.newChat(dir, "Eigenvalues and eigenvectors", "tutor");
  const chat = await plugin.store.loadChat(chatPath);
  chat.summary = "Covered the definition. The learner first allowed the zero vector, then corrected it.";
  chat.messages.push(
    { role: "tutor", text: "Plan: characteristic polynomial first, then a re-test of the definition. For A = [[2, 0], [0, 3]], what do you expect det(A - tI) to look like before you compute it?" },
    { role: "you", text: "A quadratic in t, with roots 2 and 3, because the diagonal entries are the eigenvalues." },
    { role: "tutor", text: "Good. Why are the diagonal entries the eigenvalues here, and would that still hold for [[2, 1], [0, 3]]?" },
  );
  await plugin.store.saveChat(chatPath, chat);

  const view: any = await plugin.activateView();
  await view.reload();
  view.lastChanges = ["Characteristic polynomial: 2 → 3"];
  view.lastUsage = { input: 12, cacheRead: 3500, cacheWrite: 1200, output: 96, costUsd: 0, calls: 1 };
  view.lastRoute = "chat model";
  view.sessionUsage = { input: 40, cacheRead: 10500, cacheWrite: 5800, output: 610, costUsd: 0, calls: 4 };
  const shots: [string, string][] = [];
  await view.showTab("chat");
  await tick();
  shots.push(["Chat", view.contentEl.outerHTML]);
  await view.showTab("review");
  await tick();
  shots.push(["Review", view.contentEl.outerHTML]);
  await view.showTab("map");
  await tick();
  shots.push(["Skill map", view.contentEl.outerHTML]);

  // A second topic whose subskills branch, to show the concept graph: one subskill picked, and
  // one prerequisite (complex numbers) behind what was built on it (the Laplace transform).
  const names: [string, string][] = [
    ["Complex numbers", "none"],
    ["Sinusoids and phasors", "1"],
    ["Linear time-invariant systems", "none"],
    ["Convolution", "3"],
    ["Laplace transform", "1, 3"],
    ["Transfer functions and poles", "5"],
    ["Fourier series", "2"],
    ["Frequency response and Bode plots", "6, 7"],
  ];
  const card = ["# Signals and systems", "", "## Overview", "How linear systems respond to signals.", "", "## Subskills", "", ...names.flatMap(([name, pre], i) => [`### ${i + 1}. ${name}`, `prerequisites: ${pre}`, "- A key claim.", ""])].join("\n");
  const gdir = await plugin.store.saveCompiled({ title: "Signals and systems", fm: { source: "notes", subject: "none" }, topicBody: card, questionsBody: "### Q1\nsubskill: 1\ntype: short\nquestion: What is $|3+4j|$?\nanswer: 5\nexplanation: Pythagoras.", target: 4 });
  const gs = await plugin.store.loadState(gdir, 4);
  gs.levels = { 1: 2, 2: 4, 3: 5, 4: 3, 5: 3, 6: 1, 7: null, 8: null };
  gs.focus = 5;
  await plugin.store.saveState(gdir, gs);
  plugin.data.activeTopic = gdir;
  await view.reload();
  await view.showTab("map");
  view.picked = 5;
  view.render();
  await tick();
  shots.push(["Concept graph", view.contentEl.outerHTML]);

  const css = nodefs.readFileSync("styles.css", "utf8");
  const panes = shots.map(([name, html]) => `<div><p class="cap">${name}</p><div class="pane">${html}</div></div>`).join("");
  const page = `<!doctype html><meta charset="utf-8"><title>Study Tutor preview</title><style>${BASE}${css}</style>` + Object.entries(THEMES).map(([, vars]) => `<div class="theme" style="${vars}">${panes}</div>`).join("");
  nodefs.mkdirSync("tests/out", { recursive: true });
  nodefs.writeFileSync("tests/out/preview.html", page);
  console.log("wrote tests/out/preview.html");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
