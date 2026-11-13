// Design preview. Renders the real view code with the stubbed "obsidian" module and writes
// tests/out/preview.html: each screen at a wide and a narrow width, in stand-in dark and light
// themes. No model calls. Run with `npm run preview`, then open the file in a browser.
// Icons, rendered maths and the graph canvas are placeholders here; Obsidian draws the real
// ones, so this is for checking layout and wording, not the final look.

/* eslint-disable @typescript-eslint/no-explicit-any */
import "./obsidian-stub";
import * as nodefs from "node:fs";
import StudyTutorPlugin from "../src/main";
import { parseCompileOutput } from "../src/formats";
import { MemFS } from "./memfs";

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

const THEMES: Record<string, string> = {
  "theme-dark": `--background-primary:#1e1e1e;--background-secondary:#262626;--background-modifier-border:#3a3a3a;--background-modifier-form-field:#2a2a2a;--background-modifier-hover:rgba(255,255,255,.075);--background-modifier-box-shadow:rgba(0,0,0,.3);--text-normal:#dadada;--text-muted:#b3b3b3;--text-faint:#777;--text-accent:#a68af9;--interactive-accent:#8a5cf5;--text-on-accent:#fff;--text-error:#fb464c;--text-success:#44cf6e;--interactive-normal:#363636;--color-orange:#e9973f;--color-blue:#027aff;`,
  "theme-light": `--background-primary:#ffffff;--background-secondary:#f6f6f6;--background-modifier-border:#e0e0e0;--background-modifier-form-field:#fafafa;--background-modifier-hover:rgba(0,0,0,.06);--background-modifier-box-shadow:rgba(0,0,0,.1);--text-normal:#222;--text-muted:#5c5c5c;--text-faint:#ababab;--text-accent:#8a5cf5;--interactive-accent:#8a5cf5;--text-on-accent:#fff;--text-error:#e93147;--text-success:#08b94e;--interactive-normal:#f2f3f5;--color-orange:#ec7500;--color-blue:#086ddd;`,
};

// A rough stand-in for Obsidian's own base styles, so the plugin's stylesheet has something to sit on.
const BASE = `
body{margin:0;font-family:Inter,-apple-system,"Segoe UI",sans-serif;font-size:15px;background:#111}
.theme{padding:20px;display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start;background:var(--background-secondary);color:var(--text-normal);
  --font-ui-small:13px;--font-ui-smaller:12px;--font-ui-medium:15px;--font-ui-large:20px;--font-semibold:600;--font-text-size:16px;--font-monospace:ui-monospace,Consolas,monospace;--font-interface:Inter,"Segoe UI",sans-serif}
.pane{height:780px;border:1px solid var(--background-modifier-border);border-radius:8px;overflow:hidden}
.cap{font:600 12px sans-serif;color:var(--text-faint);margin:0 0 6px;text-transform:uppercase;letter-spacing:.08em}
button{font:inherit;font-size:13px;color:var(--text-normal);background:var(--interactive-normal);border:0;border-radius:5px;padding:4px 12px;height:30px;cursor:pointer}
select{font:inherit;font-size:13px;height:30px;color:var(--text-normal);background:var(--interactive-normal);border:0;border-radius:5px;padding:0 8px}
input[type=search],input[type=number]{font:inherit;color:var(--text-normal);background:var(--background-modifier-form-field);border:1px solid var(--background-modifier-border);padding:0 8px}
textarea{font:inherit;color:var(--text-normal)}
table{border-collapse:collapse} p{margin:8px 0}
[data-icon]::before{content:"";display:block;width:14px;height:14px;border:1.5px solid currentColor;border-radius:4px;box-sizing:border-box}
`;

const COMPILED = (title: string, names: [string, string][]) =>
  [`# ${title}`, "subject: none", "", "## Overview", "An overview.", "", "## Subskills", "", ...names.flatMap(([name, pre], i) => [`### ${i + 1}. ${name}`, `prerequisites: ${pre}`, "- A key claim ([[Lecture notes]]).", ""]), "=====QUESTIONS=====", "", ...names.flatMap(([name], i) => [`### Q${i + 1}`, `subskill: ${i + 1}`, "type: short", `question: A question on ${name}, with some maths: what is $\\int_0^1 x^${i + 1}\\,dx$?`, `answer: 1/${i + 2}`, "explanation: Power rule.", ""])].join("\n");

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
      getLeaf: () => {
        const leaf: any = { app, view: null, getRoot: () => app.workspace.rootSplit };
        leaf.setViewState = async ({ type }: { type: string }) => {
          leaf.view = plugin.viewCreators[type](leaf);
          leaves.push(leaf);
          await leaf.view.onOpen();
        };
        return leaf;
      },
    },
  };
  plugin = new (StudyTutorPlugin as any)(app, { id: "study-tutor" });
  await plugin.onload();
  await tick();
  const save = async (title: string, names: [string, string][]) => {
    const out = parseCompileOutput(COMPILED(title, names));
    return plugin.store.saveCompiled({ title, fm: { source: "notes", subject: "none" }, topicBody: out.topicBody, questionsBody: out.questionsBody, target: 4 });
  };
  const sig = await save("Signals and systems for second-year electrical engineering", [["Complex numbers", "none"], ["Sinusoids and phasors", "1"], ["Linear time-invariant systems", "none"], ["Convolution", "3"], ["Laplace transform", "1, 3"], ["Transfer functions and poles", "5"], ["Fourier series", "2"], ["Frequency response and Bode plots", "6, 7"]]);
  await save("Circuit analysis", [["Kirchhoff's laws", "none"], ["Impedance", "1"], ["Filters", "2"]]);
  const state = await plugin.store.loadState(sig, 4);
  state.levels = { 1: 2, 2: 4, 3: 5, 4: 3, 5: 3, 6: 1, 7: null, 8: null };
  state.focus = 5;
  state.misconceptions = ["treats the Laplace variable s as real"];
  const at = (d: string) => `${d}T10:00:00.000Z`;
  const a = (id: string, skill: number, result: string, day: string, extra: any = {}) => ({ id, v: 2, skill, concept: state.concepts[skill], questionId: id, question: `Question ${id}: find $H(s)$ for the circuit.`, answer: "1/(1+sRC)", activity: "independent-practice", mode: "auto", difficulty: 3, result, errorType: result === "incorrect" ? "procedural" : "", note: "", confidence: 0.8, assisted: false, assistance: [], answerExposed: false, transfer: false, seconds: 70, timestamp: at(day), grading: "symbolic", verification: "verified", assumptions: "", ...extra });
  state.attempts = [a("a1", 5, "correct", "2026-11-08"), a("a2", 5, "correct", "2026-11-09"), a("a3", 5, "incorrect", "2026-11-11"), a("a4", 5, "correct", "2026-11-12", { assisted: true }), a("b1", 2, "correct", "2026-11-05"), a("b2", 2, "correct", "2026-11-05"), a("b3", 2, "correct", "2026-11-07", { transfer: true })];
  await plugin.store.saveState(sig, state);
  const chatPath = await plugin.store.newChat(sig, "Signals and systems", "auto", new Date(2026, 10, 13, 9, 30));
  const chat = await plugin.store.loadChat(chatPath);
  chat.messages.push(
    { role: "tutor", text: "The Laplace transform turns a differential equation in $t$ into algebra in $s$. For example:\n\n$$\\mathcal{L}\\{e^{-at}\\} = \\int_0^\\infty e^{-at}e^{-st}\\,dt = \\frac{1}{s+a}$$\n\nYour turn: what is $\\mathcal{L}\\{t\\,e^{-2t}\\}$?" },
    { role: "you", text: "1/(s+2)^2" },
    { role: "tutor", text: "Correct. Now a harder one, in a different setting: an RC low-pass filter has $v_{out}(t)$ satisfying $RC\\,\\dot v_{out} + v_{out} = v_{in}$. Find $H(s) = V_{out}(s)/V_{in}(s)$ and say where its pole is.\n\n*SymPy checked 1 result: it agrees.*" },
  );
  chat.fm.session = JSON.stringify({ version: 2, pendingQuestion: "Find $H(s) = V_{out}(s)/V_{in}(s)$ for the RC low-pass filter and say where its pole is.", action: "transfer", reason: "You have answered Laplace transform correctly without help. A new kind of problem shows whether it transfers.", helpGiven: [] });
  await plugin.store.saveChat(chatPath, chat);
  plugin.data.activeTopic = sig;

  const view: any = await plugin.activateView();
  await view.reload();
  const shots: [string, string][] = [];
  const shot = async (name: string) => {
    await tick(60);
    shots.push([name, view.contentEl.outerHTML]);
  };
  view.go("home");
  await shot("Home");
  await view.startStudy({ dir: sig, chatPath });
  await shot("Study");
  view.go("topic");
  await shot("Topic");
  view.go("review");
  await shot("Review");
  view.graphFocus = state.concepts[5];
  view.go("graph");
  await shot("Graph");

  const css = nodefs.readFileSync("styles.css", "utf8");
  const panes = (w: number) => shots.map(([name, html]) => `<div><p class="cap">${name} · ${w}px</p><div class="pane" style="width:${w}px">${html}</div></div>`).join("");
  const page = `<!doctype html><meta charset="utf-8"><title>Study Tutor preview</title><style>${BASE}${css}</style>` + Object.entries(THEMES).map(([cls, vars]) => `<div class="theme ${cls}" style="${vars}">${panes(1100)}${panes(420)}</div>`).join("");
  nodefs.mkdirSync("tests/out", { recursive: true });
  nodefs.writeFileSync("tests/out/preview.html", page);
  console.log("wrote tests/out/preview.html");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
