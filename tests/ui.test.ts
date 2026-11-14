// Drives the real plugin and view code under jsdom with a stubbed "obsidian" module and a
// stubbed model call. It checks the click paths, not the look, and not Obsidian itself.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { test } from "node:test";
import assert from "node:assert/strict";
import { menus, notices } from "./obsidian-stub";
import StudyTutorPlugin from "../src/main";
import { parseCompileOutput, parseState } from "../src/formats";
import { MemFS } from "./memfs";
import { FIXTURES } from "../src/visuals/fixtures";

const COMPILED = `# Linear maps
subject: linear-algebra

## Overview
Linear maps preserve addition and scaling.

## Subskills

### 1. Definition of a linear map
prerequisites: none
- $T(u+v)=T(u)+T(v)$ ([[Linear maps]])

### 2. Kernel and image
prerequisites: 1
relations: contrasts_with 1
- $\\ker T=\\{v : T(v)=0\\}$

=====QUESTIONS=====

### Q1
subskill: 1
type: mcq
question: Which map is linear?
options:
- A. $f(x)=x+1$
- B. $f(x)=3x$
answer: B
explanation: Only $3x$ preserves sums.

### Q2
subskill: 2
type: short
question: What is $\\dim\\ker$ of the identity?
answer: 0
explanation: Only zero maps to zero.

### Q3
subskill: 2
type: open
question: Why is the kernel a subspace?
answer: It is closed under addition and scaling.
explanation: Uses linearity.
`;

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const $ = (root: any, sel: string): any => root.querySelector(sel);
const $$ = (root: any, sel: string): any[] => [...root.querySelectorAll(sel)];
const button = (root: any, text: string): any => {
  const b = $$(root, "button").find((x) => x.textContent.trim().startsWith(text));
  assert.ok(b, `button "${text}" should exist; found: ${$$(root, "button").map((x) => x.textContent.trim() || x.getAttribute("aria-label")).join(" | ")}`);
  return b;
};
const labelled = (root: any, label: string): any => {
  const b = $$(root, "[aria-label]").find((x) => x.getAttribute("aria-label").startsWith(label));
  assert.ok(b, `a control labelled "${label}" should exist`);
  return b;
};
const fire = (el: any, type: string, init: any = {}) => el.dispatchEvent(new (globalThis as any).window.Event(type, { bubbles: true, ...init }));
const session = (o: object) => `<session>${JSON.stringify({ helpGiven: [], nextAction: "next", completedStep: false, ...o })}</session>`;

function makeApp(fs: MemFS, leaves: any[], opened: string[], getPlugin: () => any): any {
  const app: any = {
    vault: { adapter: fs, getMarkdownFiles: () => [], cachedRead: async () => "", getAbstractFileByPath: () => null },
    metadataCache: { resolvedLinks: {}, getFirstLinkpathDest: () => null },
    workspace: {
      onLayoutReady: (cb: () => void) => cb(),
      on: () => ({}),
      getLeavesOfType: () => leaves,
      getActiveFile: () => null,
      revealLeaf: async () => {},
      openLinkText: async (href: string) => {
        opened.push(href);
      },
      getLeaf: () => {
        const leaf: any = { app, view: null, getRoot: () => app.workspace.rootSplit };
        leaf.setViewState = async ({ type }: { type: string }) => {
          leaf.view = getPlugin().viewCreators[type](leaf);
          leaves.push(leaf);
          await leaf.view.onOpen();
        };
        return leaf;
      },
    },
  };
  return app;
}

test("home, study, review, topic page and graph work together from the normal entry points", async () => {
  const fs = new MemFS();
  const leaves: any[] = [];
  const opened: string[] = [];
  let plugin: any = null;
  const app = makeApp(fs, leaves, opened, () => plugin);
  plugin = new (StudyTutorPlugin as any)(app, { id: "study-tutor" }) as StudyTutorPlugin;
  await plugin.onload();
  await tick();
  assert.ok(await fs.exists("Tutor/_skills/core.md"), "skills are installed into the vault");
  assert.ok(await fs.exists("Tutor/_skills/policy.md"), "so is the note describing the enforced rules");
  assert.ok(await fs.exists("Tutor/Dashboard.base"));

  // ----- empty vault: home explains what to do, and only that -----
  const view: any = await plugin.activateView();
  assert.ok(view, "the view opens");
  const root = view.contentEl;
  assert.equal(root.getAttribute("data-screen"), "home");
  assert.match(root.textContent, /Start with a topic/);
  assert.equal($$(root, ".st-tile").length, 0, "no study actions are offered before there is anything to study");
  assert.deepEqual($$(root, ".st-nav-tab").map((b: any) => [b.textContent, b.disabled]), [["Home", false], ["Study", true], ["Review", true], ["Graph", false]]);
  view.go("study");
  assert.equal(root.getAttribute("data-screen"), "home", "a screen that needs a topic falls back to home");
  view.go("graph");
  await tick();
  assert.match(root.textContent, /The graph is empty/);

  // ----- a topic appears -----
  const out = parseCompileOutput(COMPILED);
  const dir = await plugin.store.saveCompiled({ title: "Linear maps", fm: { source: "notes", subject: out.subject, kind: "subject" }, topicBody: out.topicBody, questionsBody: out.questionsBody, target: 4 });
  const calls: { system: string; input: string; model: string }[] = [];
  const usage = (n: number) => ({ input: 10, cacheRead: n > 1 ? 3000 : 0, cacheWrite: 1000, output: 50, costUsd: 0.01, calls: 1 });
  const replies = [
    `Is $f(x)=x+1$ linear?\n<state>{"focus":1}</state>\n${session({ pendingQuestion: "Is $f(x)=x+1$ linear?" })}`,
    `Not quite: $f(0)=1$. Why does that matter?\n<attempt>{"skill":1,"result":"incorrect","assisted":false,"transfer":false,"error_type":"conceptual","error":"thinks translation is linear"}</attempt>\n<state>{"levels":{"1":4},"add_misconceptions":["thinks translation is linear"]}</state>\n${session({ pendingQuestion: "Why does $f(0)=1$ matter?" })}`,
  ];
  plugin.engine.call = async (o: any) => {
    calls.push(o);
    return { text: replies[calls.length - 1] ?? "ok", usage: usage(calls.length) };
  };
  plugin.opts.codePlacement = false; // placement has its own tests; here the first turn is the model's
  view.go("home");
  await view.reload();
  // Home suggests exactly what Adaptive study would do first (0.6): one diagnostic question, not a separate ranking.
  assert.match($(root, ".st-next").textContent, /Suggested next.*Diagnosis · Linear maps.*no evidence on Definition of a linear map yet, so one question finds your starting point.*Start: Diagnosis/s);
  assert.equal($(root, ".st-resume"), null, "nothing to resume yet");
  assert.deepEqual($$(root, ".st-tile-label").map((e: any) => e.textContent), ["Adaptive study", "Learn", "Practise", "Review", "Ask", "Knowledge graph"]);
  assert.match($(root, ".st-topics .st-row-item").textContent, /Linear maps0%.*2 concepts · 0 secured · practised not yet/s);
  assert.match($(root, ".st-recent").textContent, /Sessions you start will be listed here/);
  assert.equal($(root, ".st-topic-select").value, dir);
  // The topic search filters by topic and by concept name, without rebuilding the page.
  const search = $(root, ".st-topics .st-search");
  search.value = "kernel";
  fire(search, "input");
  assert.equal($$(root, ".st-topics .st-row-item").length, 1);
  search.value = "zzz";
  fire(search, "input");
  assert.match($(root, ".st-topics .st-list").textContent, /No topic or concept matches "zzz"/);
  search.value = "";
  fire(search, "input");
  // The time available is a real setting, kept.
  button(root, "10 min").click();
  await tick();
  assert.equal(plugin.opts.minutes, 10);
  button(root, "25 min").click();
  await tick();

  // ----- Adaptive study: start, answer with a confidence, see what was recorded -----
  $$(root, ".st-tile")[0].click();
  await tick(40);
  assert.equal(root.getAttribute("data-screen"), "study");
  assert.match($(root, ".st-tail .st-empty").textContent, /Adaptive · Linear maps/);
  const slider = () => $(root, ".st-conf-range");
  assert.equal($(root, ".st-conf-value").textContent, "Not set");
  assert.equal(slider().disabled, true, "confidence is offered only while a question is open");
  assert.equal(slider().getAttribute("aria-valuetext"), "not set");
  button(root, "Start session").click();
  await tick(80);
  assert.match($(root, ".st-messages").textContent, /Is \$f\(x\)=x\+1\$ linear\?/);
  assert.ok(!/<state>|<session>|<attempt>/.test(root.textContent), "hidden lines are never shown");
  assert.match($(root, ".st-why").textContent, /^DiagnosisChosen because other concepts rest on it\. There is no evidence on Definition of a linear map yet/);
  assert.match(calls[0].system, /# Tutor core[\s\S]*# Subject card: linear-algebra[\s\S]*# Topic card[\s\S]*# Mode: Adaptive study guide/);
  assert.match(calls[0].input, /just opened this chat\. Begin\./);
  assert.equal(calls[0].model, "sonnet");
  // The open question is pinned above the answer area, and help sits in a fixed place.
  assert.match($(root, ".st-pending").textContent, /Open questionIs \$f\(x\)=x\+1\$ linear\?/);
  assert.deepEqual($$(root, ".st-quick .st-btn").map((b: any) => [b.textContent, b.disabled]), [["Hint", false], ["Explain", false], ["Skip", false], ["Visual activity", false]]);
  // The reasoning behind the action is one click away.
  button(root, "Why this?").click();
  assert.match($(root, ".st-why-detail").textContent, /Definition of a linear map[\s\S]*Policy version 3\. Scores only rank what to study next\./);
  button(root, "Hide details").click();

  // The slider: unset until deliberately moved, readable, clearable by keyboard.
  assert.equal(slider().disabled, false);
  slider().value = "80";
  fire(slider(), "input");
  assert.equal($(root, ".st-conf-value").textContent, "80%");
  assert.equal(slider().getAttribute("aria-valuetext"), "80 percent confident");
  assert.ok($(root, ".st-conf").classList.contains("is-set"));
  slider().dispatchEvent(new (globalThis as any).window.KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
  assert.equal($(root, ".st-conf-value").textContent, "Not set");
  slider().value = "90";
  fire(slider(), "input");

  // A draft survives leaving the screen and coming back; so does the confidence.
  const input = () => $(root, ".st-composer textarea");
  input().value = "Yes, it is li";
  fire(input(), "input");
  button(root, "Home").click();
  await tick();
  assert.equal(root.getAttribute("data-screen"), "home");
  assert.match($(root, ".st-resume").textContent, /Pick up where you left offLinear mapsAdaptiveDiagnosis.*Is \$f\(x\)=x\+1\$ linear\?/s, "the unfinished session is first on the home screen, with where it was left");
  assert.match($(root, ".st-recent .st-row-item").textContent, /Adaptive · Linear maps.*Unfinished/s);
  button(root, "Resume session").click();
  await tick(40);
  assert.equal(root.getAttribute("data-screen"), "study");
  assert.equal(input().value, "Yes, it is li");
  assert.equal($(root, ".st-conf-value").textContent, "90%");
  assert.equal($$(root, ".st-msg").length, 1);

  // A failed send keeps the message, the confidence and the open question.
  plugin.engine.call = async () => {
    throw new Error("usage limit reached");
  };
  input().value = "Yes, it is linear.";
  button(root, "Send").click();
  await tick(80);
  assert.match($(root, ".st-notice.is-error").textContent, /That did not go through.*usage limit reached Your message was saved/s);
  const chats = await plugin.store.listChats(dir);
  assert.equal(chats.length, 1);
  assert.match(await fs.read(chats[0]), /%%msg:you%%\n###### You\nYes, it is linear\./);
  assert.equal($(root, ".st-conf-value").textContent, "90%", "the confidence is kept for the retry");
  assert.match($(root, ".st-pending").textContent, /Is \$f\(x\)=x\+1\$ linear\?/);

  // Retry: the same answer is marked, with the confidence given before feedback.
  plugin.engine.call = async (o: any) => {
    calls.push(o);
    return { text: replies[calls.length - 1] ?? "ok", usage: usage(calls.length) };
  };
  button(root, "Retry").click();
  await tick(80);
  assert.equal($$(root, ".st-msg").length, 3);
  assert.match(calls[1].input, /LEARNER: Yes, it is linear\.[\s\S]*Reply to the learner's last message\.[\s\S]*Instructional action: check\./);
  assert.equal(calls[1].system, calls[0].system, "the stable part of the prompt is byte-identical between turns");
  assert.match($(root, ".st-feedback").textContent, /Marked incorrectgraded by the model, unverified · your confidence 90%/);
  assert.match($(root, ".st-feedback-more").textContent, /How this was checkedBasis: one model judgement, not independently checked\.This counts as unaided evidence\.thinks translation is linear/);
  assert.equal($(root, ".st-conf-value").textContent, "Not set", "confidence resets for the next answer");
  const state1 = parseState(await fs.read(`${dir}/state.md`));
  assert.equal(state1.levels[1], 1, "a first wrong answer places the concept at 1; the model's proposed level 4 is ignored");
  assert.deepEqual(state1.misconceptions, ["thinks translation is linear"]);
  const evidence = await fs.read(`${dir}/evidence.md`);
  assert.match(evidence, /"result":"incorrect","errorType":"conceptual".*"confidence":0\.9/);
  // Diagnostics are there, tucked away, with measured cache use.
  assert.match($(root, ".st-diag").textContent, /DetailsLast turn: 4\.0k tokens in \(3\.0k read from cache, 1\.0k written to cache, 10 uncached\) · 50 out · 1 call\.Measured cache share of input this turn: 75%\./);
  assert.equal($(root, ".st-diag").hasAttribute("open"), false);

  // Disputing the mark sets it aside and tells the tutor to look again.
  button(root, "Dispute this mark").click();
  await tick(60);
  assert.match($(root, ".st-feedback").textContent, /Mark set aside.*The tutor will look at your answer again on your next message\./s);
  assert.match(await fs.read(`${dir}/evidence.md`), /"verification":"disputed"/);
  assert.equal(parseState(await fs.read(`${dir}/state.md`)).levels[1], null, "the level change the disputed mark caused is undone");

  // Switching mode keeps the chat and its open question, and changes only the mode's instructions.
  const modeSel = $(root, ".st-mode-select");
  modeSel.value = "expert";
  fire(modeSel, "change");
  await tick();
  assert.equal($(root, ".st-conf").classList.contains("is-hidden"), true, "asking a question needs no confidence");
  input().value = "What is a kernel?";
  button(root, "Send").click();
  await tick(80);
  assert.match(calls[2].system, /# Mode: Subject expert/);
  assert.match(calls[2].input, /# Disputed grading/);
  assert.match(calls[2].input, /"pendingQuestion":"Why does \$f\(0\)=1\$ matter\?"/, "the open question travelled with the chat into the other mode");

  // A [[note]] the tutor cites opens when clicked.
  plugin.engine.call = async () => ({ text: "See [[Linear maps]] for the definition.", usage: usage(1) });
  input().value = "Where is that in my notes?";
  button(root, "Send").click();
  await tick(80);
  const link = $(root, ".st-messages a.internal-link");
  assert.ok(link, "the cited note is rendered as a link");
  link.dispatchEvent(new (globalThis as any).window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.deepEqual(opened, ["Linear maps"]);
  assert.equal(view.children.length, 1, "leaving a screen releases what its markdown created");

  // ----- review: no model calls, and each card says how it was marked -----
  let modelCalls = 0;
  plugin.engine.call = async () => {
    modelCalls++;
    throw new Error("review must not call the model");
  };
  button($(root, ".st-nav"), "Review").click();
  await tick(40);
  assert.equal(root.getAttribute("data-screen"), "review");
  assert.match(root.textContent, /3 leftDefinition of a linear map/);
  $$(root, ".st-option")[1].click(); // option B
  assert.match(root.textContent, /Correct\./);
  assert.match($(root, ".st-answer .st-reveal").textContent, /B\. \$f\(x\)=3x\$/, "the answer shows the whole option, not just its letter");
  button(root, "Next").click();
  await tick(30);
  const short = $(root, ".st-answer textarea");
  short.value = " $0$ ";
  button(root, "Check").click();
  await tick();
  assert.match(root.textContent, /Correct\./);
  button(root, "Next").click();
  await tick(30);
  button(root, "Show answer").click();
  assert.match(root.textContent, /A self-rating schedules the card; it does not count as evidence for a level\./);
  button(root, "Again").click();
  await tick(30);
  assert.match(root.textContent, /1 left/, "a failed card comes back once");
  button(root, "Show answer").click();
  button(root, "Good").click();
  await tick(30);
  assert.match(root.textContent, /Done\. 4 cards reviewed\./);
  assert.equal(modelCalls, 0);
  const state2 = await plugin.store.loadState(dir, 4);
  assert.deepEqual(Object.keys(state2.cards).sort(), ["Q1", "Q2", "Q3"]);
  assert.deepEqual(state2.bank[1], { right: 1, total: 1 });
  assert.deepEqual(state2.bank[2], { right: 1, total: 2 });
  assert.equal(state2.newCount, 3);
  const reviews = state2.attempts.filter((a: any) => a.activity === "review");
  assert.deepEqual(reviews.map((a: any) => [a.questionId, a.grading, a.answerExposed]), [["Q1", "deterministic", false], ["Q2", "deterministic", false], ["Q3", "self", true], ["Q3", "self", true]]);
  assert.deepEqual([state2.levels[1], state2.levels[2]], [2, 2], "answers marked by code are evidence; self-ratings moved nothing");

  // ----- topic page: levels with the evidence behind them -----
  button($(root, ".st-nav"), "Home").click();
  await tick();
  $(root, ".st-topics .st-row-main").click();
  await tick(40);
  assert.equal(root.getAttribute("data-screen"), "topic");
  const rows = $$(root, ".st-table tbody tr");
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /1\. Definition of a linear map.* 21 of 1 unaided correcttoo few unaided answers for an estimateFor level 3: 1 more fully correct answer on different questions\./s);
  assert.match(root.textContent, /thinks translation is linear/);
  button(root, "Export flashcards").click();
  await tick();
  assert.ok(await fs.exists(`${dir}/flashcards.md`));
  // Study a concept straight from its row: it becomes the focus of a new Adaptive chat.
  plugin.engine.call = async (o: any) => (calls.push(o), { text: `Lesson on kernels. Your turn: what is $\\ker$ of the zero map?\n${session({ pendingQuestion: "What is $\\ker$ of the zero map?" })}`, usage: usage(2) });
  labelled(rows[1], "Study Kernel and image").click();
  await tick(60);
  assert.equal(root.getAttribute("data-screen"), "study");
  assert.equal((await plugin.store.loadState(dir, 4)).focus, 2);
  assert.match($(root, ".st-tail .st-empty").textContent, /Adaptive · Linear maps/, "a fresh chat, not the old one");
  assert.equal((await plugin.store.listChats(dir)).length, 2);

  // ----- graph: concepts, relations and the details panel, without a model -----
  modelCalls = 0;
  plugin.engine.call = async () => {
    modelCalls++;
    throw new Error("the graph must not call the model");
  };
  button($(root, ".st-nav"), "Graph").click();
  await tick(60);
  assert.equal(root.getAttribute("data-screen"), "graph");
  assert.ok($(root, "canvas.st-graph-canvas"));
  assert.match($(root, ".st-graph-panel").textContent, /2 concepts across 1 topic\./);
  assert.deepEqual($$(root, ".st-graph-rels .st-toggle").map((b: any) => b.textContent), ["Requires", "Supports", "Applies to", "Contrasts with", "Derived from", "Synoptic connections"]);
  const colour = labelled(root, "Colour concepts by");
  assert.deepEqual($$(colour, "option").map((o: any) => [o.value, o.disabled]), [["topic", false], ["level", false], ["estimate", true], ["recency", false], ["calibration", true]], "modes without enough data are not offered");
  assert.ok(Object.keys(plugin.data.graphLayout).length === 2, "positions are saved so the map stays put");
  // Search lists concepts; choosing one opens its details.
  const find = $(root, ".st-graph-find .st-search");
  find.value = "kern";
  fire(find, "input");
  assert.deepEqual($$(root, ".st-graph-result").map((b: any) => b.textContent), ["Kernel and imageLinear maps"]);
  $(root, ".st-graph-result").click();
  await tick(40);
  const panel = $(root, ".st-graph-panel");
  assert.match(panel.textContent, /Kernel and imageLinear maps.*Level 2 of 4 target.*Suggested next/s);
  assert.match(panel.textContent, /Guided practice\. You can follow Kernel and image, so the next step is practice with help on hand\./);
  assert.match(panel.textContent, /Evidence1 correct unaided/);
  assert.match(panel.querySelector(".st-graph-statistics")!.textContent!, /Unaided1 of 1 correctEstimatenot shown: 1 of 3 unaided answers needed/);
  assert.match(panel.textContent, /Latest answers.*correct.*checked by the plugin/s);
  assert.match(panel.textContent, /Rests onDefinition of a linear maplevel 2 · inferred, not yet reviewed · from topic card/);
  assert.match(panel.textContent, /Other relationscontrasts with Definition of a linear map/);
  // Reviewing a relation is stored in the course graph, not the learner state.
  labelled(panel, "Confirm that Kernel and image requires Definition of a linear map").click();
  await tick(60);
  assert.match(await fs.read(`${dir}/graph.md`), /"type": "requires",\s+"status": "reviewed"/);
  assert.match($(root, ".st-graph-panel").textContent, /reviewed by you/);
  // Priority is a ranking input; it is saved and changes no level.
  const pr = $(root, ".st-graph-panel .st-number");
  pr.value = "3";
  fire(pr, "change");
  await tick(60);
  const state3 = await plugin.store.loadState(dir, 4);
  assert.deepEqual([state3.priorities[2], state3.levels[2]], [3, 2]);
  assert.equal(modelCalls, 0, "nothing in the graph calls the model");
  button($(root, ".st-graph-panel"), "Study this").click();
  await tick(60);
  assert.equal(root.getAttribute("data-screen"), "study");

  // ----- the More menu, the new-topic modal and settings -----
  labelled(root, "More tools").click();
  const menu = menus[menus.length - 1];
  assert.deepEqual(menu.items.map((i) => i.title), ["Topic overview", "Open topic card", "Open question bank", "Open evidence log", "How levels and choices are decided", "Compare policy with logged decisions", "Edit teaching instructions", "Reload from vault"]);
  opened.length = 0;
  menu.items.find((i) => i.title === "Compare policy with logged decisions")!.run();
  await tick(60);
  assert.deepEqual(opened, ["Tutor/_logs/Policy comparison.md"]);
  assert.match(await fs.read("Tutor/_logs/Policy comparison.md"), /# Policy comparison[\s\S]*## Your current weights\n\n\d+ of \d+ logged decisions would be the same\./);
  plugin.openNewTopic();
  assert.ok(notices.every((n) => !/could not/i.test(n)), notices.join(" | "));
  const tab = plugin.settingTabs[0];
  tab.display();
  const item = (re: RegExp) => $$(tab.containerEl, ".setting-item").find((e: any) => re.test(e.textContent));
  assert.ok(item(/Observed errors/), "policy weights are editable");
  const errors = $(item(/Observed errors/), "input");
  errors.value = "2";
  await errors.onchange();
  assert.equal(plugin.opts.weights.errors, 2);
  errors.value = "-1";
  await errors.onchange();
  assert.equal(plugin.opts.weights.errors, 2, "an invalid weight is ignored");
  const sympySetting = () => item(/Compute and check maths with SymPy/);
  assert.match(sympySetting().textContent, /Status: not loaded yet\./);
  assert.equal(plugin.opts.mathCheck, false, "off until asked for, because the first use downloads SymPy");
  // There are no web workers under jsdom: switching it on must fail quietly, never throw.
  const toggle = $(sympySetting(), "input[type=checkbox]");
  toggle.checked = true;
  await toggle.onchange();
  assert.equal(plugin.opts.mathCheck, true);
  assert.match(sympySetting().textContent, /Status: unavailable: /);
  assert.equal(await plugin.engine.mathEquivalent("1/2", "0.5"), null, "an unavailable checker decides nothing");
  plugin.opts.mathCheck = false;

  // ----- with the Spaced Repetition plugin enabled, review is handed to it -----
  assert.equal(plugin.usesSr(), false, "without that plugin the built-in review is used");
  const ran: string[] = [];
  app.plugins = { enabledPlugins: new Set(["obsidian-spaced-repetition"]) };
  app.commands = { executeCommandById: (id: string) => (ran.push(id), true) };
  assert.equal(plugin.usesSr(), true);
  // Pretend that plugin has already reviewed the first card and scheduled it for a past date.
  const note = await fs.read(`${dir}/flashcards.md`);
  fs.files.set(`${dir}/flashcards.md`, note.replace("\n\nWhat is $\\dim", "\n<!--SR:!2020-01-01,3,250-->\n\nWhat is $\\dim"));
  button($(root, ".st-nav"), "Review").click();
  await tick(60);
  assert.match(root.textContent, /Flashcards · Spaced Repetition/);
  assert.deepEqual($$(root, ".st-count-num").map((e: any) => e.textContent), ["1", "2", "3"], "one due, two new, three cards");
  await view.stateChanged();
  assert.match($(root, ".st-nav").textContent, /Review1/, "the due count is on the navigation tab");
  opened.length = 0;
  button(root, "Review this topic").click();
  await tick(450);
  assert.deepEqual(opened, [`${dir}/flashcards.md`]);
  assert.deepEqual(ran, ["obsidian-spaced-repetition:srs-review-flashcards-in-note"]);
  assert.match(await fs.read(`${dir}/flashcards.md`), /<!--SR:!2020-01-01,3,250-->/, "syncing the note keeps the review history");
  plugin.opts.useSpacedRepetition = false;
  assert.equal(plugin.usesSr(), false, "the setting switches back to the built-in review");
});

test("a chat saved by an older version reopens with its question open, and nothing in the vault is lost", async () => {
  const fs = new MemFS();
  const leaves: any[] = [];
  const opened: string[] = [];
  let plugin: any = null;
  const app = makeApp(fs, leaves, opened, () => plugin);
  plugin = new (StudyTutorPlugin as any)(app, { id: "study-tutor" });
  // Settings saved by 0.4.0: no weights, no drafts, no layout.
  plugin.stored = { settings: { root: "Tutor", chatModel: "opus" }, activeTopic: "Tutor/Topics/Linear maps", activeChat: {}, skills: {}, settingsVersion: 2 };
  await plugin.onload();
  await tick();
  assert.equal(plugin.opts.chatModel, "opus", "saved settings are kept");
  assert.equal(plugin.opts.weights.errors, 1.5, "and new ones take their defaults");
  const out = parseCompileOutput(COMPILED);
  const dir = await plugin.store.saveCompiled({ title: "Linear maps", fm: { subject: "none" }, topicBody: out.topicBody, questionsBody: out.questionsBody, target: 4 });
  // A user-edited teaching file, and a chat with no session record, exactly as 0.4.0 wrote them.
  fs.files.set("Tutor/_skills/mode-teach.md", "# Mode: Teacher\n\nMy own rules.");
  const old = ["---", "tutor: chat", "topic: Linear maps", "mode: tutor", "part: 1", 'previous: ""', 'next: ""', "created: 2026-11-12", "---", "## Summary of earlier parts", "", "None.", "", "## Transcript", "", "%%msg:tutor%%", "###### Tutor", "Question 2 is still open, so here it is again:", "", "```c", "int x = 5;", "```", "", "What does it print, and why?", ""].join("\n");
  fs.dirs.add(`${dir}/chats`);
  fs.files.set(`${dir}/chats/2026-11-12 1701 tutor.md`, old);
  await plugin.store.installSkills(plugin.data.skills);
  assert.equal(await fs.read("Tutor/_skills/mode-teach.md"), "# Mode: Teacher\n\nMy own rules.", "edited teaching instructions are never overwritten");

  const view: any = await plugin.activateView();
  await view.reload();
  const root = view.contentEl;
  assert.match($(root, ".st-resume").textContent, /Linear mapsMaster.*What does it print, and why\?/s, "the old chat is offered for resuming");
  $(root, ".st-recent .st-row-main").click();
  await tick(60);
  assert.equal(root.getAttribute("data-screen"), "study");
  assert.equal($$(root, ".st-msg").length, 1);
  assert.match($(root, ".st-pending").textContent, /Open questionWhat does it print, and why\?/);
  assert.equal($(root, ".st-conf-range").disabled, false);
  assert.equal(await fs.read(`${dir}/chats/2026-11-12 1701 tutor.md`), old, "opening a chat does not rewrite it");
  // Answering it carries the question into the record, and the transcript keeps every earlier line.
  let seen = "";
  plugin.engine.call = async (o: any) => ((seen = o.input), { text: `Right.\n<attempt>{"skill":1,"result":"correct","assisted":false,"transfer":false,"error_type":"","error":""}</attempt>\n${session({ pendingQuestion: "", completedStep: true })}`, usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, costUsd: 0, calls: 1 } });
  $(root, ".st-composer textarea").value = "5, because x is passed by value";
  button(root, "Send").click();
  await tick(80);
  assert.match(seen, /"pendingQuestion":"What does it print, and why\?"/);
  const saved = await fs.read(`${dir}/chats/2026-11-12 1701 tutor.md`);
  assert.match(saved, /Question 2 is still open[\s\S]*```c\nint x = 5;\n```[\s\S]*5, because x is passed by value[\s\S]*Right\./);
  assert.match($(root, ".st-feedback").textContent, /Marked correct/);
  assert.ok(button(root, "Continue"), "with nothing open, the next step is one click away");

  // A proposed joint problem is reviewed in the graph and opens without rewriting this chat.
  const graph = await plugin.store.loadGraph(dir);
  const [a, b] = graph.concepts;
  const jointQuestion = "Use linearity to show that the kernel is closed under addition.";
  plugin.engine.call = async () => ({ structured: { target: b.id, rationale: "Linearity explains the subspace structure of the kernel.", challenge: jointQuestion }, usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, costUsd: 0, calls: 1 } });
  view.graphFocus = a.id;
  view.go("graph");
  await tick(60);
  button(root, "Suggest a synoptic connection").click();
  await tick(80);
  assert.equal(button(root, "Study connection").disabled, true);
  labelled(root, `Confirm that ${a.name} connects in a synoptic problem`).click();
  await tick(80);
  assert.equal(button(root, "Study connection").disabled, false);
  button(root, "Study connection").click();
  await tick(80);
  assert.equal(root.getAttribute("data-screen"), "study");
  assert.match($(root, ".st-pending").textContent, /Use linearity/);
  assert.notEqual(view.chatPath, `${dir}/chats/2026-11-12 1701 tutor.md`);
  assert.equal(await fs.read(`${dir}/chats/2026-11-12 1701 tutor.md`), saved);
  assert.equal(JSON.parse(String(view.chat.fm.session)).pendingQuestion, jointQuestion);
  plugin.engine.call = async () => ({ text: `Correct.\n<attempt>{"skill":${b.n},"result":"correct","assisted":false,"transfer":true,"error_type":"","error":""}</attempt>\n${session({ pendingQuestion: "", completedStep: true })}`, usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, costUsd: 0, calls: 1 } });
  $(root, ".st-composer textarea").value = "T(u+v) = T(u)+T(v) = 0+0 = 0.";
  button(root, "Send").click();
  await tick(100);
  const jointAttempt = (await plugin.store.loadState(dir, 4)).attempts.at(-1);
  assert.equal(jointAttempt.concept, a.id, "joint practice assesses the selected concept even if a model tags the other one");
  assert.equal(jointAttempt.question, jointQuestion);
});

test("normal study entry mounts the real player, caches configurations and records helped evidence", async () => {
  const fs=new MemFS(), leaves:any[]=[], opened:string[]=[];let plugin:any=null;
  const app=makeApp(fs,leaves,opened,()=>plugin);plugin=new (StudyTutorPlugin as any)(app,{id:"study-tutor"});await plugin.onload();await tick();
  const dir=await plugin.store.saveCompiled({title:"Numeric array indexing",fm:{subject:"computing"},topicBody:"# Numeric array indexing\n\n## Subskills\n\n### 1. Zero-based numeric array indexing\nprerequisites: none\n- Read an element using its zero-based numeric array index.\n\n### 2. Linear search\nprerequisites: 1\n- Compare each numeric array element with a target.",questionsBody:"",target:4});
  let localCalls=0,claudeCalls=0;
  plugin.engine.call=async()=>{claudeCalls++;throw new Error("No paid model in this path");};
  plugin.engine.local={model:"qwen2.5:3b",chatJson:async()=>{localCalls++;return {text:JSON.stringify({fits:true,objective:"Read an element using its zero-based numeric array index",settings:{algorithm:"index",values:[4,7,9],index:1,target:0},assetIds:[],assessmentId:"trace-result",predictionQuestion:"What value does the numeric array contain at index 1?",hint:"Count positions starting with zero.",missingOperation:""}),model:"qwen2.5:3b",doneReason:"stop",timing:{wallMs:1,loadMs:0,promptTokens:1,promptMs:0,evalTokens:1,evalMs:0,totalMs:1}};}};
  const view:any=await plugin.activateView();await view.reload();view.go("graph");await tick(60);view.go("topic");await tick();assert.equal(localCalls,0,"navigation never generates an activity");
  view.go("study");await view.study.send("Show me a simulation of zero-based numeric array indexing.");await tick(80);
  const player=document.querySelector<HTMLElement>(".stv-player")!;assert.ok(player,"production ActivityModal mounts production player");assert.equal(localCalls,1);assert.equal(claudeCalls,0);
  labelled(player,"Your prediction").value="7 because index 1 is the second element";button(player,"Save prediction").click();button(player,"Step").click();button(player,"Step").click();
  assert.match(player.textContent!,/result 7/);
  const reflection=player.querySelector(".stv-reflection")!;(reflection.querySelector("textarea") as HTMLTextAreaElement).value="Zero-based indices put the second value at index one.";(reflection.querySelector("input") as HTMLInputElement).value="7";button(reflection,"Check practice answer").click();await tick(100);
  const state=await plugin.store.loadState(dir,4);assert.equal(state.attempts.length,1);assert.equal(state.attempts[0].assisted,true);assert.equal(state.attempts[0].result,"correct");assert.equal(state.attempts[0].taskType,"interactive");
  const again=await plugin.engine.requestActivity(dir,{kind:"simulation",concept:1,chatPath:view.chatPath});assert.ok(again.cacheHit);assert.equal(localCalls,1);assert.equal(claudeCalls,0);
  assert.ok(plugin.commands.find((c:any)=>c.id==="open-saved-activity"));
  assert.equal(FIXTURES.projectile.moduleId,"projectile");
  player.parentElement?.remove();await view.onClose();
});
