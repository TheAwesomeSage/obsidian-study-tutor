// Live benchmark of local activity configuration on ten real excerpts from the learner's notes.
//
//   STUDY_VAULT=<vault folder> [VISUAL_REGISTRY=<bundled registry .cjs>] [LOCAL_MODEL=qwen2.5:3b] npm run bench:qwen
//
// The notes are read only; the excerpts are located by bench/software-systems-excerpts.json and
// checked against their SHA-256 before anything runs. Activities are configured through the real
// engine path (gate, shortlist, local model, validation, cache) into an in-memory store, so
// nothing is written to the vault. Claude is replaced by a stub that counts calls and fails.
// Results go to bench/out/. Without VISUAL_REGISTRY the test FIXTURE modules are used, and the
// report says so.

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from "fs";
import * as path from "path";
import { Engine } from "../src/engine";
import { Store } from "../src/store";
import { configureActivity } from "../src/configure";
import { OllamaClient } from "../src/ollama";
import { adaptRegistry } from "../src/visualcontract";
import { makeFixtureRegistry } from "./fixtures/visual-modules";
import { MemFS } from "./memfs";

interface Excerpt { id: string; path: string; lines: [number, number]; sha256: string; kind: any; objective: string; expected: { route: string; reason: string }; synthetic?: boolean; text?: string }

async function main() {
  const manifestFile = process.env.BENCH_MANIFEST || "bench/software-systems-excerpts.json";
  const model = process.env.LOCAL_MODEL || "qwen2.5:3b";
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as { excerpts: Excerpt[] };
  const synthetic = manifest.excerpts.every((e) => e.synthetic);
  const vault = process.env.STUDY_VAULT;
  if (!vault && !synthetic) throw new Error("Set STUDY_VAULT to the vault folder.");
  const crypto = await import("crypto");
  const texts = new Map<string, string>();
  for (const e of manifest.excerpts) {
    if (e.synthetic) {
      // Labelled engineering controls carry their own text; they are never the learner's notes.
      texts.set(e.id, e.text!);
      e.path = `synthetic/${e.id}`;
      e.lines = [1, 1];
      continue;
    }
    const lines = fs.readFileSync(path.join(vault!, e.path), "utf8").split(/\r?\n/).slice(e.lines[0] - 1, e.lines[1]).join("\n");
    const h = crypto.createHash("sha256").update(lines, "utf8").digest("hex");
    if (h !== e.sha256) throw new Error(`${e.id}: the note changed since the excerpt was chosen (${e.path} lines ${e.lines.join("-")}). Choose it again; nothing was run.`);
    texts.set(e.id, lines);
  }
  const registryPath = process.env.VISUAL_REGISTRY;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const rawRegistry = registryPath ? require(path.resolve(registryPath)) : makeFixtureRegistry();
  const registry = adaptRegistry(rawRegistry);
  const registryLabel = registryPath ? `visual workstream registry bundled from ${registryPath}` : "TEST FIXTURE modules (not the real ones)";

  // A topic with one subskill per excerpt; each cites its excerpt as its only source note.
  const card = ["# Software Systems (benchmark)", "", "## Overview", "Ten excerpts from the learner's notes.", "", "## Subskills", "", ...manifest.excerpts.flatMap((e, i) => [`### ${i + 1}. ${e.id}`, "prerequisites: none", `- ${e.objective} ([[${e.id}]])`, ""])].join("\n");
  const fsm = new MemFS();
  const store = new Store(fsm, "Tutor", () => new Date().toISOString().slice(0, 10));
  const settings: any = { claudePath: "", chatModel: "sonnet", compileModel: "sonnet", utilityModel: "haiku", effort: "low", targetLevel: 4, maxChatWords: 6000, maxTopicWords: 8000, singlePassWords: 6000, smartRouting: false, hardEffort: "high", localActivities: true, localModel: model };
  const engine = new Engine(store, () => settings);
  const dir = await store.saveCompiled({ title: "Software Systems (benchmark)", fm: { subject: "none" }, topicBody: card, questionsBody: "", target: 4 });
  const byId = new Map(manifest.excerpts.map((e) => [e.id, e]));
  engine.readSource = async (name) => (texts.has(name) ? { path: `${byId.get(name)!.path}#L${byId.get(name)!.lines.join("-L")}`, text: texts.get(name)! } : null);
  engine.visuals = registry;
  const client = new OllamaClient({ model });
  engine.local = client;
  let claudeCalls = 0;
  (engine as any).call = async () => {
    claudeCalls++;
    throw new Error("Claude must not be called during configuration.");
  };

  const status = await client.status();
  if (!status.ok) throw new Error(`Ollama is not reachable: ${status.error}`);
  if (!status.hasModel) throw new Error(`${model} is not installed in Ollama ${status.version}.`);
  // Unload the model so the first configuration measures a cold start.
  await fetch("http://127.0.0.1:11434/api/generate", { method: "POST", body: JSON.stringify({ model, keep_alive: 0 }) }).then((r) => r.text()).catch(() => "");
  await new Promise((r) => setTimeout(r, 1500));

  const passA: any[] = [];
  for (const [i, e] of manifest.excerpts.entries()) {
    const t0 = Date.now();
    const out = await engine.requestActivity(dir, { kind: e.kind, concept: i + 1 });
    const a = out.activity;
    passA.push({
      id: e.id, kind: e.kind, expected: e.expected.route, gate: out.decision.status, candidates: out.decision.candidates,
      route: out.lesson ? "module" : out.decision.status === "text" ? "text" : a?.status ?? out.decision.status,
      status: a?.status ?? null, localCalls: out.calls.local, repairs: a?.repairs ?? 0, firstPassValid: a?.firstPassValid ?? null,
      wallMs: Date.now() - t0, timing: a?.timing ?? null, missing: a?.missingCapability?.operation ?? "", errors: a?.validationErrors ?? [], lesson: out.lesson,
      excerptWords: out.request?.sourceRefs.reduce((n, s) => n + s.excerpt.split(/\s+/).length, 0) ?? 0,
    });
    process.stdout.write(`A ${e.id} ${passA[passA.length - 1].route} (${passA[passA.length - 1].wallMs} ms)\n`);
  }
  // Reopening every saved activity must cost nothing.
  const passC: any[] = [];
  for (const [i, e] of manifest.excerpts.entries()) {
    const out = await engine.requestActivity(dir, { kind: e.kind, concept: i + 1 });
    passC.push({ id: e.id, cacheHit: out.cacheHit, localCalls: out.calls.local, status: out.decision.status });
  }
  // The local model's own fit judgement, with the shortlist bypassed: the programming module is
  // offered for every excerpt that asks for a simulation.
  const algorithm = registry.listModuleDescriptors().find((d) => d.id === "algorithm" || d.id === "fixture-array-trace")!;
  const passB: any[] = [];
  const topic = await store.loadTopic(dir);
  for (const [i, e] of manifest.excerpts.entries()) {
    if (e.kind !== "simulation") continue;
    const refs = await (engine as any).sourceRefsFor(dir, topic, i + 1, `${e.id}: ${e.objective}`);
    const t0 = Date.now();
    const rec = await configureActivity({ request: { version: 1, kind: "simulation", reason: "You asked for a simulation.", objective: `${e.id}: ${e.objective}`, sourceRefs: refs }, conceptId: `bench/${e.id}`, candidates: [algorithm], assets: registry.listAssets(), registry, model: client, catalogVersion: registry.catalogVersion(), trigger: "explicit" });
    passB.push({ id: e.id, expected: e.expected.route, status: rec.status, fits: rec.status !== "unsupported", localCalls: rec.localCalls, repairs: rec.repairs, firstPassValid: rec.firstPassValid, wallMs: Date.now() - t0, timing: rec.timing, missing: rec.missingCapability?.operation ?? "", errors: rec.validationErrors, lesson: rec.lesson });
    process.stdout.write(`B ${e.id} ${rec.status} (${Date.now() - t0} ms)\n`);
  }
  const ps = await fetch("http://127.0.0.1:11434/api/ps").then((r) => r.json()).catch(() => ({}));
  const result = { at: new Date().toISOString(), manifest: manifestFile, synthetic, model, ollama: status.version, registry: registryLabel, claudeCalls, passA, passB, passC, ps, host: { platform: process.platform, cpus: (await import("os")).cpus()[0]?.model, cores: (await import("os")).cpus().length, ramGB: Math.round((await import("os")).totalmem() / 1e9) } };
  fs.mkdirSync("bench/out", { recursive: true });
  const file = `bench/out/${synthetic ? "synthetic-" : ""}${model.replace(/[^a-z0-9.]+/gi, "_")}-${result.at.replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(file, JSON.stringify(result, null, 1));
  console.log(`\nwritten ${file}\nClaude calls: ${claudeCalls}\nregistry: ${registryLabel}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
