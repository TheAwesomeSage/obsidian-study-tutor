// Drives the built plugin in a fresh Obsidian vault, with scripted Claude responses.
// Set VERIFY_ROOT to a NEW folder, and optionally OBSIDIAN_EXE / VERIFY_PORT.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

if (!process.env.VERIFY_ROOT) throw new Error("Set VERIFY_ROOT to a new verification folder.");
const root = path.resolve(process.env.VERIFY_ROOT);
await fs.mkdir(root);
const exe = process.env.OBSIDIAN_EXE ?? path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Obsidian", "Obsidian.exe");
const vault = path.join(root, "vault"), profile = path.join(root, "profile");
const port = Number(process.env.VERIFY_PORT ?? 9334);
await fs.mkdir(path.join(vault, ".obsidian", "plugins"), { recursive: true });
await fs.mkdir(profile);
if (process.env.OBSIDIAN_ASAR) await fs.copyFile(process.env.OBSIDIAN_ASAR, path.join(profile, path.basename(process.env.OBSIDIAN_ASAR)));
await fs.cp("release/study-tutor", path.join(vault, ".obsidian", "plugins", "study-tutor"), { recursive: true });
await fs.writeFile(path.join(vault, ".obsidian", "community-plugins.json"), '["study-tutor"]');
await fs.writeFile(path.join(vault, ".obsidian", "plugins", "study-tutor", "data.json"), JSON.stringify({ settings: { root: "Tutor", localActivities: false, localCompilation: false }, settingsVersion: 3 }));
await fs.writeFile(path.join(vault, "Kernels.md"), "# Kernels\n\nThe kernel of T consists of x satisfying T(x) = 0.\n");
await fs.writeFile(path.join(vault, "Cancelled.md"), "# Cancelled\n\nA different source to exercise the cancellation button.\n");
await fs.writeFile(path.join(profile, "obsidian.json"), JSON.stringify({ vaults: { verify0000000002: { path: vault, ts: Date.now(), open: true } } }));
const child = spawn(exe, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], { stdio: "ignore", windowsHide: true });
let browser;
let page;
const output = [];
try {
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await fetch(url + "/json/version").then(r => r.ok).catch(() => false)) break;
    if (child.exitCode !== null) throw new Error(`Obsidian exited with ${child.exitCode}`);
    await new Promise(r => setTimeout(r, 350));
  }
  browser = await chromium.connectOverCDP(url);
  const pageDeadline = Date.now() + 30_000;
  while (!page && Date.now() < pageDeadline) {
    page = browser.contexts().flatMap(c => c.pages()).find(x => x.url().startsWith("app://obsidian.md/index.html"));
    if (!page) await new Promise(r => setTimeout(r, 300));
  }
  assert.ok(page);
  async function findControl(buildLocator) {
    const until = Date.now() + 10000;
    do {
      for (const candidate of browser.contexts().flatMap(c => c.pages())) {
        const locator = buildLocator(candidate);
        if (await locator.isVisible().catch(() => false)) return { candidate, locator };
      }
      await new Promise(r => setTimeout(r, 250));
    } while (Date.now() < until);
    throw new Error("Expected Obsidian control was not visible in any app window.");
  }
  const errors = [];
  page.on("pageerror", err => errors.push(err.message));
  page.on("console", entry => { if (entry.type() === "error") console.error(entry.text()); });
  await page.waitForFunction(() => !!window.app?.vault?.adapter);
  const openedVault = await page.evaluate(() => window.app.vault.adapter.getBasePath());
  assert.equal(path.normalize(openedVault), path.normalize(vault));
  const trust = page.getByRole("button", { name: /Trust author and enable plugins/i });
  if (await trust.waitFor({ state: "visible", timeout: 8000 }).then(() => true, () => false)) {
    await trust.click();
    const readyBy = Date.now() + 15000;
    while (Date.now() < readyBy) {
      const reopened = browser.contexts().flatMap(c => c.pages()).find(x => x.url().startsWith("app://obsidian.md/index.html") && !x.isClosed());
      if (reopened) { page = reopened; break; }
      await new Promise(r => setTimeout(r, 250));
    }
  }
  await page.waitForFunction(() => !!window.app?.plugins?.plugins?.["study-tutor"]?.engine);
  const initial = await page.evaluate(async () => {
    const app = window.app, plugin = app.plugins.plugins["study-tutor"];
    plugin.engine.compilationLocal = null;
    plugin.engine.call = async o => {
      const input = JSON.parse(o.input), p = o.jsonSchema.properties;
      const usage = { input: 10, cacheRead: 0, cacheWrite: 0, output: 1, costUsd: 0, calls: 1 };
      if (p.objectives) {
        const pass = input.passages.find(x => x.text.includes("T(x)"));
        return { usage, structured: { objectives: [{ text: "Determine the kernel of a linear map", references: [pass.id], search: "" }] } };
      }
      const objective = input.objectives[0].id;
      const refs = [input.packet[0].passages.find(x => x.text.includes("T(x)")).id];
      if (p.units) return { usage, structured: {
        overview: "A kernel tells you what the map sends to zero.", subject: "none",
        units: [{ objective, name: "Kernels", prerequisites: [], claims: ["Solve T(x)=0."], example: "T(0,2)=0.", misconceptions: [], details: "If T(x,y)=x, solve x=0. Then (0,2) is in the kernel.", passages: refs, visualKind: "", visualReason: "", questions: [{ type: "short", question: "What is T(0,2)?", options: [], answer: "0", rubric: "", explanation: "T returns the first coordinate.", task: "application", family: "kernel", difficulty: 2 }] }],
      } };
      return { usage, structured: { rows: [{ objective, sources: refs, teaching: true, questions: ["Q1"], gap: "" }] } };
    };
    await app.workspace.getLeaf("tab").openFile(app.vault.getAbstractFileByPath("Kernels.md"));
    const result = await plugin.compileTopic({ title: "Kernels", kind: "active", folder: "", goal: "First course in linear algebra" });
    return result && { status: result.status, dir: result.dir, questions: result.questions };
  });
  assert.deepEqual([initial?.status, initial?.questions], ["complete", 1]);
  output.push("Packaged plugin compiled a note and saved one verified assessment.");
  const tutored = await page.evaluate(async parent => {
    const plugin = window.app.plugins.plugins["study-tutor"];
    const engine = plugin.engine;
    const compile = engine.call;
    engine.call = o => o.jsonSchema ? compile(o) : Promise.resolve({
      text: "The first coordinate determines the output. What happens to the second coordinate?",
      usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 1, costUsd: 0, calls: 1 },
    });
    const chat = await plugin.store.newChat(parent, "Kernels", "tutor");
    const explained = await engine.turn(parent, chat, "Why does the kernel include every value of y?");
    const turn = await engine.turn(parent, chat, "I want to go further with the kernel.");
    const linked = turn.expansion ? await engine.expansionSettled(turn.expansion.request.id) : null;
    return {
      source: explained.tools?.some(tool => tool.tool === "vault.source" && tool.output?.passages?.some(p => p.id.startsWith("p-"))),
      lesson: explained.tools?.some(tool => tool.tool === "course.lesson" && tool.output?.from === "compiled"),
      move: !!explained.move, linked: linked?.status, stillStudying: plugin.data.activeTopic === parent,
    };
  }, initial.dir);
  assert.deepEqual(tutored, { source: true, lesson: true, move: true, linked: "complete", stillStudying: true });
  output.push("A Master turn read the compiled lesson and source passages. Chat expansion finished without switching topics.");
  const executed = await page.evaluate(() => window.app.commands.executeCommandById("study-tutor:expand-topic"));
  assert.ok(executed);
  const { candidate: dialog, locator: gap } = await findControl(p => p.getByPlaceholder("For example: why projecting twice gives the same result"));
  await gap.fill("Test a projection onto one axis");
  await dialog.getByRole("button", { name: "Compile linked topic" }).click();
  await page.waitForFunction(parent => {
    const plugin = window.app.plugins.plugins["study-tutor"];
    return plugin.data.activeTopic !== parent && !plugin.activeCompile;
  }, initial.dir);
  const linked = await page.evaluate(async () => {
    const plugin = window.app.plugins.plugins["study-tutor"];
    return (await plugin.store.loadPackage(plugin.data.activeTopic)).staged.expansion;
  });
  assert.equal(linked.anchorDir, initial.dir);
  output.push("The command palette built a linked prerequisite from the saved course.");
  await page.evaluate(async () => {
    const app = window.app, plugin = app.plugins.plugins["study-tutor"];
    plugin.engine.call = o => new Promise((_, reject) => o.onSpawn(() => reject(new Error("Stopped."))));
    await app.workspace.getLeaf("tab").openFile(app.vault.getAbstractFileByPath("Cancelled.md"));
    window.cancelledCourse = plugin.compileTopic({ title: "Cancelled lesson", kind: "active", folder: "", goal: "" });
  });
  const { locator: cancel } = await findControl(p => p.locator("button").filter({ hasText: /^Cancel$/ }));
  await cancel.click();
  assert.equal(await page.evaluate(() => window.cancelledCourse), null);
  assert.equal(await page.evaluate(async () => (await window.app.plugins.plugins["study-tutor"].store.listTopics()).length), 3);
  assert.deepEqual(errors, []);
  output.push("The Obsidian notice cancelled compilation without creating a topic. No page errors.");
  console.log(output.join("\n"));
} catch (error) {
  if (browser) console.error(await Promise.all(browser.contexts().flatMap(c => c.pages()).map(p => p.evaluate(() => ({ url: location.href, body: document.body.innerText.slice(-300), dialogs: [...document.querySelectorAll(".modal, .prompt")].map(x => x.innerText.slice(0, 300)) })).catch(() => null))));
  throw error;
} finally {
  await browser?.close().catch(() => {});
  child.kill();
}
