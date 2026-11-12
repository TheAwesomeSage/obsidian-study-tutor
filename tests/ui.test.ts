// Drives the real plugin and view code under jsdom with a stubbed "obsidian" module and a
// stubbed model call. It checks the click paths, not the look, and not Obsidian itself.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { test } from "node:test";
import assert from "node:assert/strict";
import { notices } from "./obsidian-stub";
import StudyTutorPlugin from "../src/main";
import { parseCompileOutput, parseState } from "../src/formats";
import { MemFS } from "./memfs";

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
  assert.ok(b, `button "${text}" should exist; found: ${$$(root, "button").map((x) => x.textContent).join(" | ")}`);
  return b;
};

test("plugin loads, chats, reviews and shows the skill map", async () => {
  const fs = new MemFS();
  const leaves: any[] = [];
  const opened: string[] = [];
  const app: any = {
    vault: { adapter: fs, getMarkdownFiles: () => [], cachedRead: async () => "", getAbstractFileByPath: () => null },
    metadataCache: { resolvedLinks: {}, getFirstLinkpathDest: () => null },
    workspace: {
      onLayoutReady: (cb: () => void) => cb(),
      getLeavesOfType: () => leaves,
      getActiveFile: () => null,
      revealLeaf: async () => {},
      openLinkText: async (href: string) => {
        opened.push(href);
      },
      getRightLeaf: () => {
        const leaf: any = { app, view: null };
        leaf.setViewState = async ({ type }: { type: string }) => {
          leaf.view = (plugin as any).viewCreators[type](leaf);
          leaves.push(leaf);
          await leaf.view.onOpen();
        };
        return leaf;
      },
    },
  };
  const plugin = new (StudyTutorPlugin as any)(app, {}) as StudyTutorPlugin;
  await plugin.onload();
  await tick();
  assert.ok(await fs.exists("Tutor/_skills/core.md"), "skills are installed into the vault");
  assert.ok(await fs.exists("Tutor/Dashboard.base"));

  // Empty vault: the view offers to create a topic.
  let view: any = await plugin.activateView();
  assert.ok(view, "the view opens");
  assert.match(view.contentEl.textContent, /No topics yet/);

  // Seed a compiled topic and stub the model.
  const out = parseCompileOutput(COMPILED);
  const dir = await plugin.store.saveCompiled({ title: "Linear maps", fm: { source: "notes", subject: out.subject, kind: "subject" }, topicBody: out.topicBody, questionsBody: out.questionsBody, target: 4 });
  const calls: { system: string; input: string; model: string }[] = [];
  const replies = ['I will ask a few questions to place you.\n\nIs $f(x)=x+1$ linear?\n<state>{"focus":1}</state>', 'Why not?\n<state>{"levels":{"1":2},"add_misconceptions":["thinks translation is linear"]}</state>'];
  (plugin.engine as any).call = async (o: any) => {
    calls.push(o);
    return { text: replies[calls.length - 1] ?? "ok", usage: { input: 10, cacheRead: calls.length > 1 ? 3000 : 0, cacheWrite: 1000, output: 50, costUsd: 0.01, calls: 1 } };
  };
  plugin.opts.codePlacement = false; // placement has its own test; here the tutor's first turn is the model's
  await view.reload();
  const root = view.contentEl;
  assert.match(root.textContent, /Next step · Learn/);
  assert.equal($(root, ".st-head select").value, dir);
  assert.match(root.textContent, /Skill map 0%/);

  // Tutor chat: Start, then answer.
  button(root, "Start").click();
  await tick(60);
  assert.match($(root, ".st-messages").textContent, /Is \$f\(x\)=x\+1\$ linear\?/);
  assert.ok(!/<state>/.test(root.textContent), "the hidden state line is never shown");
  assert.match(root.textContent, /Skill map updated: focus → Definition of a linear map/);
  assert.match(calls[0].system, /# Tutor core[\s\S]*# Subject card: linear-algebra[\s\S]*# Topic card[\s\S]*# Mode: Socratic tutor/);
  assert.match(calls[0].input, /just opened this chat\. Begin\.$/);
  assert.equal(calls[0].model, "sonnet");

  const input = $(root, ".st-composer textarea");
  input.value = "Yes, it is linear.";
  button(root, "Send").click();
  await tick(60);
  assert.equal($$(root, ".st-msg").length, 3);
  assert.match(calls[1].input, /LEARNER: Yes, it is linear\.[\s\S]*Reply to the learner's last message\.$/);
  assert.equal(calls[1].system, calls[0].system, "the system prompt is identical between turns, so it is cached");
  assert.match(root.textContent, /Last turn: 4\.0k tokens in \(3\.0k from cache\)/);
  const state1 = parseState(await fs.read(`${dir}/state.md`));
  assert.equal(state1.levels[1], 2);
  assert.deepEqual(state1.misconceptions, ["thinks translation is linear"]);
  const chats = await plugin.store.listChats(dir);
  assert.equal(chats.length, 1);
  assert.match(await fs.read(chats[0]), /%%msg:you%%\n###### You\nYes, it is linear\./);

  // Switching mode keeps the chat and changes the mode skill.
  button(root, "Ask").click();
  await tick();
  input.value = "";
  const input2 = $(root, ".st-composer textarea");
  input2.value = "What is a kernel?";
  button(root, "Send").click();
  await tick(60);
  assert.match(calls[2].system, /# Mode: Subject expert/);

  // A [[note]] the tutor cites opens when clicked.
  (plugin.engine as any).call = async () => ({ text: "See [[Linear maps]] for the definition.", usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, costUsd: 0, calls: 1 } });
  $(root, ".st-composer textarea").value = "Where is that in my notes?";
  button(root, "Send").click();
  await tick(60);
  const link = $(root, ".st-messages a.internal-link");
  assert.ok(link, "the cited note is rendered as a link");
  link.dispatchEvent(new (globalThis as any).window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.deepEqual(opened, ["Linear maps"]);
  assert.equal(view.children.length, 1, "each render releases the previous render's markdown");

  // A failed call shows the error with a retry, and the learner's message is kept.
  (plugin.engine as any).call = async () => {
    throw new Error("usage limit reached");
  };
  $(root, ".st-composer textarea").value = "Another question";
  button(root, "Send").click();
  await tick(60);
  assert.match($(root, ".st-error").textContent, /usage limit reached/);
  assert.match(await fs.read(chats[0]), /Another question/);
  button(root, "Retry");

  // Review: no model calls at all.
  let modelCalls = 0;
  (plugin.engine as any).call = async () => {
    modelCalls++;
    throw new Error("review must not call the model");
  };
  await view.showTab("review");
  assert.match(root.textContent, /3 left · Definition of a linear map/);
  $$(root, ".st-option")[1].click(); // option B
  assert.match(root.textContent, /Correct\./);
  assert.match($(root, ".st-answer .st-card").textContent, /B\. \$f\(x\)=3x\$/, "the answer shows the whole option, not just its letter");
  button(root, "Next").click();
  await tick();
  const short = $(root, ".st-answer textarea");
  short.value = " $0$ ";
  button(root, "Check").click();
  assert.match(root.textContent, /Correct\./);
  button(root, "Next").click();
  await tick();
  button(root, "Show answer").click();
  button(root, "Again").click();
  await tick();
  assert.match(root.textContent, /1 left/, "a failed card comes back once");
  button(root, "Show answer").click();
  button(root, "Good").click();
  await tick();
  assert.match(root.textContent, /Done\. 4 cards reviewed without using any tokens\./);
  assert.equal(modelCalls, 0);
  const state2 = parseState(await fs.read(`${dir}/state.md`));
  assert.deepEqual(Object.keys(state2.cards).sort(), ["Q1", "Q2", "Q3"]);
  assert.deepEqual(state2.bank[1], { right: 1, total: 1 });
  assert.deepEqual(state2.bank[2], { right: 1, total: 2 });
  assert.equal(state2.newCount, 3);
  assert.equal(state2.levels[1], 2, "reviewing does not disturb levels");

  // Skill map and extras.
  await view.showTab("map");
  assert.equal($$(root, ".st-table tr").length, 3);
  assert.match(root.textContent, /thinks translation is linear/);
  button(root, "Export flashcards").click();
  await tick();
  assert.ok(await fs.exists(`${dir}/flashcards.md`));

  // The modal and settings tab build without errors.
  plugin.openNewTopic();
  assert.ok(notices.every((n) => !/could not/i.test(n)), notices.join(" | "));
});
