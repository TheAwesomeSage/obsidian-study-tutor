import esbuild from "esbuild";
import { builtinModules } from "node:module";
import fs, { cpSync, mkdirSync } from "node:fs";

const mode = process.argv[2] ?? "dev";
const external = ["obsidian", "electron", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)];
const common = { bundle: true, format: "cjs", target: "es2020", loader: { ".md": "text" }, external, logLevel: "info" };

if (mode === "test") {
  const t = { ...common, platform: "node", outdir: "tests/out", outExtension: { ".js": ".cjs" } };
  await esbuild.build({ ...t, entryPoints: ["tests/unit.test.ts", "tests/router.test.ts", "tests/maths.test.ts", "tests/live.test.ts", "tests/live-features.test.ts"] });
  // The UI test swaps the real "obsidian" module for a stub and runs under jsdom.
  await esbuild.build({ ...t, entryPoints: ["tests/ui.test.ts", "tests/preview.ts"], external: [...external.filter((e) => e !== "obsidian"), "jsdom"], alias: { obsidian: "./tests/obsidian-stub.ts" } });
  // Browser pages for looking at things no Node test can show: the real SymPy worker and the concept graph.
  await esbuild.build({ ...common, format: "iife", platform: "browser", entryPoints: ["tests/sympy-harness.ts"], outdir: "tests/out" });
  fs.writeFileSync("tests/out/sympy.html", '<!doctype html><meta charset="utf-8"><title>running</title><pre id="log" style="font:13px/1.5 monospace;padding:16px;white-space:pre-wrap"></pre><script src="sympy-harness.js"></script>');
} else {
  await esbuild.build({ ...common, entryPoints: ["src/main.ts"], outfile: "main.js", minify: mode === "production", sourcemap: mode === "production" ? false : "inline" });
  if (mode === "production") {
    // The three files Obsidian needs, ready to copy into <vault>/.obsidian/plugins/study-tutor/.
    mkdirSync("release/study-tutor", { recursive: true });
    for (const f of ["main.js", "manifest.json", "styles.css"]) cpSync(f, "release/study-tutor/" + f);
  }
}
