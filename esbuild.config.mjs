import esbuild from "esbuild";
import { builtinModules } from "node:module";
import fs, { cpSync, mkdirSync } from "node:fs";

const mode = process.argv[2] ?? "dev";
const external = ["obsidian", "electron", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)];
const common = { bundle: true, format: "cjs", target: "es2020", loader: { ".md": "text", ".png": "dataurl" }, external, logLevel: "info" };

if (mode === "test") {
  const t = { ...common, platform: "node", outdir: "tests/out", outExtension: { ".js": ".cjs" } };
  await esbuild.build({ ...t, external: [...external, "pyodide"], entryPoints: ["tests/unit.test.ts", "tests/learning.test.ts", "tests/tutoring.test.ts", "tests/graph.test.ts", "tests/router.test.ts", "tests/maths.test.ts", "tests/families.test.ts", "tests/visuals.test.ts", "tests/qwen-bench.ts", "tests/presentation.test.ts", "tests/compiler.test.ts", "tests/coderun.test.ts", "tests/live.test.ts", "tests/live-compile.ts", "tests/live-features.test.ts", "tests/live-session.test.ts"] });
  // The UI test swaps the real "obsidian" module for a stub and runs under jsdom.
  await esbuild.build({ ...t, entryPoints: ["tests/ui.test.ts", "tests/preview.ts"], external: [...external.filter((e) => e !== "obsidian"), "jsdom"], alias: { obsidian: "./tests/obsidian-stub.ts" } });
  // Browser pages for looking at things no Node test can show: the real SymPy worker and the concept graph.
  await esbuild.build({ ...common, format: "iife", platform: "browser", entryPoints: ["tests/sympy-harness.ts"], outdir: "tests/out" });
  fs.writeFileSync("tests/out/sympy.html", '<!doctype html><meta charset="utf-8"><title>running</title><pre id="log" style="font:13px/1.5 monospace;padding:16px;white-space:pre-wrap"></pre><script src="sympy-harness.js"></script>');
} else {
  // Real lazy chunks in Obsidian: JSXGraph is not parsed until a plot is requested.
  await esbuild.build({ ...common, external: [...external, "./player", "./plot"], entryPoints: ["src/main.ts"], outfile: "main.js", minify: mode === "production", sourcemap: mode === "production" ? false : "inline" });
  await esbuild.build({ ...common, external: [...external, "./plot"], entryPoints: ["src/visuals/player.ts"], outfile: "player.js", minify: mode === "production" });
  await esbuild.build({ ...common, entryPoints: ["src/visuals/plot.ts"], outfile: "plot.js", minify: mode === "production" });
  if (mode === "production") {
    // The three files Obsidian needs, ready to copy into <vault>/.obsidian/plugins/study-tutor/.
    mkdirSync("release/study-tutor", { recursive: true });
    for (const f of ["main.js", "player.js", "plot.js", "manifest.json"]) cpSync(f, "release/study-tutor/" + f);
    fs.writeFileSync("release/study-tutor/research-licenses.txt", ["parse5", "entities"].map(name => name + "\n\n" + fs.readFileSync(`node_modules/${name}/LICENSE`, "utf8")).join("\n\n"));
    fs.writeFileSync("release/study-tutor/styles.css", fs.readFileSync("styles.css", "utf8") + "\n" + fs.readFileSync("src/visuals/player.css", "utf8"));
    if (fs.existsSync("assets/visuals")) cpSync("assets/visuals", "release/study-tutor/assets/visuals", {recursive:true});
    // SymPy and the Python runtime it needs (scripts/vendor-pyodide.mjs), so maths checking runs offline.
    if (!fs.existsSync("vendor/pyodide/bundle.json")) throw new Error("vendor/pyodide is missing: run node scripts/vendor-pyodide.mjs (npm run build does).");
    fs.rmSync("release/study-tutor/pyodide", { recursive: true, force: true });
    cpSync("vendor/pyodide", "release/study-tutor/pyodide", { recursive: true });
  }
}


