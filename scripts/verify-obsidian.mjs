// Drives a real Obsidian instance with an ISOLATED profile and vault through its normal entry
// points (ribbon, tiles, composer, player), over the Chrome DevTools protocol, and saves
// screenshots and console errors. It never opens the learner's own vault.
//
//   VERIFY_VAULT=<seeded vault> VERIFY_PROFILE=<new profile dir> VERIFY_OUT=<screenshot dir> node scripts/verify-obsidian.mjs
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const exe = process.env.OBSIDIAN_EXE || path.join(process.env.LOCALAPPDATA || "", "Programs", "Obsidian", "Obsidian.exe");
const vault = path.resolve(process.env.VERIFY_VAULT || "");
const profile = path.resolve(process.env.VERIFY_PROFILE || "");
const out = path.resolve(process.env.VERIFY_OUT || "verify-out");
const port = Number(process.env.VERIFY_PORT || 9333);
if (!fs.existsSync(path.join(vault, ".obsidian", "plugins", "study-tutor", "main.js"))) throw new Error("Seed the vault first (scripts/seed-verification.ts).");
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(profile, { recursive: true });
// The profile lists only the verification vault, open.
fs.writeFileSync(path.join(profile, "obsidian.json"), JSON.stringify({ vaults: { verify0000000001: { path: vault, ts: Date.now(), open: true } } }));

const log = [];
const note = (s) => { log.push(`${new Date().toISOString().slice(11, 19)} ${s}`); console.log(s); };
const child = spawn(exe, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser;
try {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) break; } catch { /* not up yet */ }
    await sleep(500);
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => /app:\/\/obsidian\.md\/index\.html/.test(p.url()));
    if (!page) await sleep(500);
  }
  if (!page) throw new Error("No Obsidian window appeared.");
  const errors = [];
  const shot = async (name) => { await sleep(700); await page.screenshot({ path: path.join(out, `${name}.png`) }); note(`screenshot ${name}`); };
  const theme = async (dark) => { await page.evaluate((d) => window.app.commands.executeCommandById(d ? "theme:use-dark" : "theme:use-light"), dark); await sleep(500); };
  // Window size, through the renderer's own Electron window when CDP cannot set bounds.
  const size = async (width, height) => {
    const ok = await page.evaluate(([w, h]) => {
      try { const win = window.require("electron").remote?.getCurrentWindow?.(); if (win) { win.setSize(w, h); return true; } } catch { /* no remote module */ }
      try { window.resizeTo(w, h); return window.outerWidth === w; } catch { return false; }
    }, [width, height]).catch(() => false);
    if (!ok) note(`could not resize the window to ${width}×${height}; the narrow check uses the pane width instead`);
    await sleep(900);
    return ok;
  };

  await page.waitForSelector(".workspace", { timeout: 60000 });
  // First open of a vault with community plugins asks whether to trust it. Accepting reloads
  // the window, so the page is found again afterwards.
  const trust = page.getByRole("button", { name: /Trust author and enable plugins/i });
  if (await trust.isVisible({ timeout: 8000 }).catch(() => false)) {
    await trust.click();
    note("trusted the verification vault's plugins");
    await sleep(6000);
    const again = browser.contexts().flatMap((c) => c.pages()).find((p) => /index\.html/.test(p.url()) && !p.isClosed());
    if (again && again !== page) { note("window reloaded after trust; reattached"); page = again; }
    await page.waitForSelector(".workspace", { timeout: 60000 });
    await sleep(2000);
  }
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await size(1400, 900);
  await theme(false);

  // Normal entry point: the ribbon icon.
  await page.locator('[aria-label="Open Study Tutor"]').first().click();
  await page.waitForSelector(".study-tutor .st-home", { timeout: 30000 });
  await shot("01-home-light");

  // Study: Adaptive tile, then an explicit request in the composer. Concept 1 has a saved activity.
  await page.locator(".st-tile", { hasText: "Adaptive study" }).click();
  await page.waitForSelector(".st-input", { timeout: 15000 });
  const ask = async (text) => { await page.fill(".st-input", text); await page.keyboard.press("Enter"); };
  let t0 = Date.now();
  await ask("Show me a simulation for this concept.");
  await page.waitForSelector(".stv-modal .stv-player", { timeout: 120000 });
  note(`saved activity opened in ${Date.now() - t0} ms`);
  await shot("02-player-saved-index");
  // Predict, step through the trace, explain, check: the module assesses, the backend records helped work.
  const modal = page.locator(".stv-modal");
  await modal.locator("textarea").first().fill("It reads the second element, 7.");
  await modal.getByRole("button", { name: "Save prediction" }).click();
  for (let i = 0; i < 3; i++) await modal.getByRole("button", { name: "Step" }).click().catch(() => {});
  await modal.locator(".stv-reflection textarea").fill("Indices start at 0, so index 1 is the second element.");
  await modal.locator(".stv-reflection input").fill("7");
  await modal.getByRole("button", { name: "Check practice answer" }).click();
  await sleep(1200);
  note(`assessment feedback: ${await modal.locator(".stv-reflection .stv-status").textContent()}`);
  await shot("03-player-assessed");
  await page.keyboard.press("Escape");
  await sleep(800);
  await shot("04-study-after-activity");
  // Fresh numbers from module code, reusing the saved configuration.
  const fresh = page.getByRole("button", { name: /^New numbers/ });
  if (await fresh.count()) {
    t0 = Date.now();
    await fresh.first().click();
    await page.waitForSelector(".stv-modal .stv-player", { timeout: 15000 });
    note(`numeric variant opened in ${Date.now() - t0} ms: ${(await page.locator(".stv-modal .stv-array").textContent())?.replace(/\s+/g, " ")}`);
    await shot("04b-player-new-numbers");
    await page.keyboard.press("Escape");
    await sleep(600);
  } else note("no New numbers button");

  // Concept 2 has no saved activity: the real local model configures one (synthetic topic).
  await page.locator(".st-nav-tab", { hasText: "Graph" }).click();
  await page.waitForSelector(".st-graph-canvas", { timeout: 15000 });
  await sleep(1500);
  await shot("05-graph-light");
  const search = page.locator(".st-graph-screen input[type=search]").first();
  if (await search.count()) { await search.fill("Linear search"); await page.keyboard.press("Enter"); await sleep(800); }
  await shot("06-graph-node-details");
  const study = page.getByRole("button", { name: "Study this" });
  if (await study.count()) {
    await study.first().click();
    await page.waitForSelector(".st-input", { timeout: 15000 });
    t0 = Date.now();
    await ask("Show me a simulation of linear search.");
    const opened = await page.waitForSelector(".stv-modal .stv-player", { timeout: 240000 }).then(() => true, () => false);
    note(`linear search request: ${opened ? "player opened" : "no player"} after ${Date.now() - t0} ms`);
    await shot("07-player-live-local-model");
    if (opened) { await page.keyboard.press("Escape"); await sleep(600); }
    await shot("08-study-reply-live");
  }

  // Concept 4 has no module: the reply says so and shows the compiled worked example.
  await page.locator(".st-nav-tab", { hasText: "Graph" }).click();
  await sleep(1200);
  if (await search.count()) { await search.fill("Process states"); await page.keyboard.press("Enter"); await sleep(800); }
  if (await study.count()) {
    await study.first().click();
    await page.waitForSelector(".st-input", { timeout: 15000 });
    await ask("Show me a simulation of process states.");
    await sleep(2500);
    await shot("09-unsupported-fallback");
  }

  // The other modules, through the explicit "Open saved visual lesson" command, with the
  // engineering FIXTURES seeded in the vault. No model is involved.
  for (const [id, name] of [["projectile", "15-player-projectile"], ["plot", "16-player-plot"], ["external", "17-player-external"]]) {
    const json = fs.readFileSync(path.join(vault, `fixture-${id}.json`), "utf8");
    await page.evaluate(() => window.app.commands.executeCommandById("study-tutor:open-saved-activity"));
    await page.waitForSelector(".stv-import", { timeout: 10000 });
    await page.fill(".stv-import", json);
    t0 = Date.now();
    await page.getByRole("button", { name: "Open activity" }).click();
    await page.waitForSelector(".stv-modal .stv-player", { timeout: 30000 });
    if (id === "plot") await page.waitForSelector(".stv-board svg, .stv-board .JXGtext, .stv-player p:has-text('Plot could not load')", { timeout: 30000 }).catch(() => {});
    note(`${id} fixture opened in ${Date.now() - t0} ms`);
    if (id === "projectile") {
      const m = page.locator(".stv-modal");
      await m.locator("textarea").first().fill("About 10 m: at 45° the range is v²/g.");
      await m.getByRole("button", { name: "Save prediction" }).click();
      await m.getByRole("button", { name: "Play" }).click();
      await sleep(2500);
      await m.locator(".stv-reflection textarea").fill("Horizontal velocity is constant because gravity only acts vertically.");
      await m.locator(".stv-reflection input").fill("10.19367992");
      await m.getByRole("button", { name: "Check practice answer" }).click();
      await sleep(600);
      note(`projectile check (v=10, 45°, g=9.81, answer 10.19367992 m): ${await m.locator(".stv-reflection .stv-status").textContent()}`);
    }
    await shot(name);
    await page.keyboard.press("Escape");
    await sleep(600);
  }

  // Dark theme, then a narrow pane.
  await theme(true);
  await page.locator(".st-nav-tab", { hasText: "Graph" }).click();
  await sleep(1500);
  await shot("10-graph-dark");
  await page.locator(".st-nav-tab", { hasText: "Home" }).click();
  await shot("11-home-dark");
  // A narrow pane: the window if it can be resized, otherwise the view's own width (the view's
  // layout follows its container width, not the window's, so this is the same check).
  // The file sidebar is collapsed first, as on a small screen, so the view itself is about 480 px.
  await page.evaluate(() => { const ws = window.app.workspace; if (!ws.leftSplit.collapsed) ws.leftSplit.collapse(); });
  if (!(await size(540, 900))) await page.evaluate(() => { const v = document.querySelector(".study-tutor"); if (v) { v.style.width = "480px"; v.style.maxWidth = "480px"; } });
  note(`view width in the narrow check: ${await page.evaluate(() => document.querySelector(".study-tutor")?.clientWidth)} px`);
  await shot("12-home-narrow-dark");
  await page.locator(".st-nav-tab", { hasText: "Study" }).click();
  await shot("13-study-narrow-dark");
  await page.locator(".st-nav-tab", { hasText: "Graph" }).click();
  await sleep(1200);
  await shot("14-graph-narrow-dark");
  const files = await page.evaluate(() => window.app.vault.getFiles().map((f) => f.path).filter((p) => /activities\.md|activity-log\.md|evidence\.md|capability-requests\.md/.test(p)));
  note(`files written: ${files.join(", ")}`);
  fs.writeFileSync(path.join(out, "console-errors.json"), JSON.stringify(errors, null, 1));
  note(`console errors: ${errors.length}`);
} finally {
  fs.writeFileSync(path.join(out, "run-log.txt"), log.join("\n"));
  await browser?.close().catch(() => {});
  child.kill();
}
