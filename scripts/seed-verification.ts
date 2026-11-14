// Seeds an isolated vault for normal-entry-point UI verification in real Obsidian. It never
// touches a learner's vault: the target folder is given explicitly and must not exist yet.
//
//   VERIFY_VAULT=<new folder> node tests/out/seed-verification.cjs
//
// The topic is a SYNTHETIC engineering fixture. One activity is pre-saved from a scripted local
// model reply (labelled as such in the note), so the cached path can be checked without
// inference; the other concepts have none, so a request there runs the real local model.
// Claude is blocked by an invalid chat model name: a turn that would call it fails at once.
import fs from "node:fs/promises";
import path from "node:path";
import { Store } from "../src/store";
import { Engine } from "../src/engine";
import { adaptRegistry } from "../src/visualcontract";
import * as registry from "../src/visuals/registry";
import { FIXTURES } from "../src/visuals/fixtures";

async function main(): Promise<void> {
  const target = process.env.VERIFY_VAULT;
  if (!target) throw new Error("Set VERIFY_VAULT to a new folder for the verification vault.");
  const root = path.resolve(target);
  if (await fs.stat(root).catch(() => null)) throw new Error(`${root} already exists; choose a new folder so nothing is overwritten.`);
  await fs.mkdir(root, { recursive: true });
  const disk = {
    read: (p: string) => fs.readFile(path.join(root, p), "utf8"),
    write: async (p: string, s: string) => {
      await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true });
      await fs.writeFile(path.join(root, p), s);
    },
    exists: async (p: string) => !!(await fs.stat(path.join(root, p)).catch(() => null)),
    mkdir: async (p: string) => {
      await fs.mkdir(path.join(root, p), { recursive: true });
    },
    list: async (p: string) => {
      const entries = await fs.readdir(path.join(root, p), { withFileTypes: true });
      return { files: entries.filter((e) => e.isFile()).map((e) => `${p}/${e.name}`), folders: entries.filter((e) => e.isDirectory()).map((e) => `${p}/${e.name}`) };
    },
  };
  const store = new Store(disk, "Tutor");
  const topicBody = [
    "# Numeric array indexing",
    "",
    "## Overview",
    "Synthetic verification course: reading, searching and sorting small numeric arrays.",
    "",
    "## Subskills",
    "",
    "### 1. Zero-based numeric array indexing",
    "prerequisites: none",
    "visual: simulation | reading one element by its position",
    "- Read an element using its zero-based numeric array index: a[0] is the first element.",
    "worked example:",
    "For a = [4, 7, 9], a[1] is 7 because indices start at 0.",
    "",
    "### 2. Linear search",
    "prerequisites: 1",
    "visual: simulation | checking each element in turn",
    "- Linear search compares each numeric array element with a target, from index 0, and stops at the first match.",
    "worked example:",
    "Search 9 in [4, 7, 9]: 4 no, 7 no, 9 yes, so it returns index 2.",
    "",
    "### 3. Binary search",
    "prerequisites: 1, 2",
    "- Binary search halves a sorted array by comparing the target with the middle element.",
    "",
    "### 4. Process states",
    "prerequisites: none",
    "- A process moves between running, ready and blocked.",
    "worked example:",
    "A process waiting for a disk read is blocked; when the read completes it becomes ready.",
  ].join("\n");
  const dir = await store.saveCompiled({ title: "Numeric array indexing", fm: { subject: "none" }, topicBody, questionsBody: "", target: 4 });
  const settings = { claudePath: "", chatModel: "no-claude-during-verification", compileModel: "no-claude-during-verification", utilityModel: "no-claude-during-verification", effort: "low", targetLevel: 4, maxChatWords: 600, maxTopicWords: 2000, singlePassWords: 6000, smartRouting: false, hardEffort: "high", localActivities: true, localModel: "qwen2.5:3b" };
  const engine = new Engine(store, () => settings);
  engine.visuals = adaptRegistry(registry as unknown as Record<string, unknown>);
  // SCRIPTED local reply for concept 1 only, so the cached path is checked without inference.
  engine.local = {
    model: "qwen2.5:3b",
    chatJson: async () => ({ text: JSON.stringify({ fits: true, objective: "Read an element using its zero-based numeric array index", settings: { algorithm: "index", values: [4, 7, 9, 12], index: 1, target: 0 }, assetIds: [], assessmentId: "trace-result", predictionQuestion: "Which value will be read at index 1?", hint: "Count positions starting from zero.", missingOperation: "" }), model: "qwen2.5:3b", doneReason: "stop", timing: { wallMs: 0, loadMs: 0, promptTokens: 0, promptMs: 0, evalTokens: 0, evalMs: 0, totalMs: 0 } }),
  };
  const seeded = await engine.requestActivity(dir, { kind: "simulation", concept: 1 });
  if (!seeded.lesson) throw new Error(`The seeded activity did not validate: ${JSON.stringify(seeded.result)}`);
  const config = path.join(root, ".obsidian");
  await fs.mkdir(path.join(config, "plugins", "study-tutor"), { recursive: true });
  await fs.cp("release/study-tutor", path.join(config, "plugins", "study-tutor"), { recursive: true });
  await fs.writeFile(path.join(config, "community-plugins.json"), JSON.stringify(["study-tutor"]));
  await fs.writeFile(path.join(config, "plugins", "study-tutor", "data.json"), JSON.stringify({ settings: { root: "Tutor", ...settings, codePlacement: false, useSpacedRepetition: false, bankQuiz: true }, activeTopic: dir, settingsVersion: 2 }));
  await fs.writeFile(path.join(root, "Verification.md"), "# Study Tutor verification\n\nSYNTHETIC engineering fixtures only. Concept 1 has an activity saved from a scripted local-model reply, not a real model output. Other concepts have none, so asking for a simulation there runs the real local model (Ollama). Claude is blocked here by an invalid model name.\n");
  for (const [id, lesson] of Object.entries(FIXTURES)) await fs.writeFile(path.join(root, `fixture-${id}.json`), JSON.stringify(lesson, null, 2));
  console.log(JSON.stringify({ root, dir, activity: seeded.activity?.id }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
