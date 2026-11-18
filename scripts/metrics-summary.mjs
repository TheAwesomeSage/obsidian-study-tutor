// Summarises what Study Tutor already records (compile metrics, attempts, activity configurations,
// policy decisions, and BKT in shadow against the existing estimate) for one Study Tutor folder.
// Read-only: no network, no model, nothing written. It bundles src/metrics.ts in memory with the
// esbuild the project already has, so the numbers come from the same code the plugin runs.
//
//   node scripts/metrics-summary.mjs "<vault>/Study Tutor"          markdown on stdout
//   node scripts/metrics-summary.mjs "<vault>/Study Tutor" --json   the summary as JSON
import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith("--"));
if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error('Usage: node scripts/metrics-summary.mjs "<vault>/Study Tutor" [--json]');
  process.exit(2);
}

const built = await esbuild.build({ entryPoints: [path.join(here, "..", "src", "metrics.ts")], bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent" });
const m = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);

/** Every file under `dir` with this name, skipping dot folders (.obsidian, .trash). */
function find(dir, name, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) find(p, name, out);
    else if (e.name === name) out.push(p);
  }
  return out;
}
const read = (p) => fs.readFileSync(p, "utf8");

const packages = find(root, "package.md").map((p) => m.packageFromText(read(p))).filter(Boolean);
const attempts = Object.fromEntries(find(root, "evidence.md").map((p) => [path.relative(root, path.dirname(p)), m.attemptsFromText(read(p))]));
const activities = find(root, "activities.md").flatMap((p) => m.jsonlFromText(read(p)));
const decisions = find(root, "decisions.md").flatMap((p) => m.jsonlFromText(read(p)));

const summary = m.summariseMetrics({ packages, attempts, activities, decisions });
process.stdout.write(args.includes("--json") ? JSON.stringify(summary, null, 2) + "\n" : m.metricsReport(summary));
