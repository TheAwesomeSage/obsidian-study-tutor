import { test } from "node:test";
import assert from "node:assert/strict";
import * as F from "../src/formats";
import { BUNDLED, buildSystem, buildTurnInput, topicForPrompt, utilityPrompt } from "../src/prompts";
import { Store } from "../src/store";
import { Engine, batchMaterial } from "../src/engine";
import { findClaude, workDir } from "../src/claude";
import { CodexTurn, codexSchema } from "../src/codex-cli";
import { modelFor, providerFor } from "../src/model-provider";
import { neutraliseDeep, neutraliseRemote } from "../src/safemd";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MemFS } from "./memfs";

const COMPILED = `# Linear maps
subject: linear-algebra

## Overview
Linear maps preserve addition and scaling. Mastering them lets you reason about $Ax=b$.

## Subskills

### 1. Definition of a linear map
prerequisites: none
- $T(u+v)=T(u)+T(v)$ and $T(cu)=cT(u)$ ([[Linear maps]])
- Every linear map sends $0$ to $0$ (added)
misconceptions:
- Thinks $f(x)=x+1$ is linear

### 2. Kernel and image
prerequisites: 1
- $\\ker T=\\{v : T(v)=0\\}$ ([[Kernel]])
misconceptions:
- Confuses kernel with image

=====QUESTIONS=====

### Q1
subskill: 1
type: mcq
question: Which map is linear?
options:
- A. $f(x)=x+1$
- B. $f(x)=3x$
- C. $f(x)=x^2$
- D. $f(x)=|x|$
answer: B
explanation: Only $3x$ preserves sums and scaling.

### Q2
subskill: 2
type: short
question: What is $\\dim\\ker T$ for the identity on $\\mathbb{R}^3$?
answer: 0
explanation: Only the zero vector maps to zero.

### Q3
subskill: 2
type: open
question: Why is the kernel a subspace?
It is asked on two lines.
answer: It contains 0 and is closed under addition and scaling,
because T is linear.
explanation: Uses both linearity properties.
`;

test("frontmatter round trip keeps strings, numbers and lists", () => {
  const md = F.withFrontmatter({ tutor: "topic", title: 'Maps: "linear" ones', progress: 40, sources: ["[[A]]", "[[B c]]"], empty: [], created: "2026-11-12", previous: "" }, "body\n");
  const { fm, body } = F.splitFrontmatter(md);
  assert.equal(fm.title, 'Maps: "linear" ones');
  assert.equal(fm.progress, 40);
  assert.deepEqual(fm.sources, ["[[A]]", "[[B c]]"]);
  assert.deepEqual(fm.empty, []);
  assert.equal(fm.created, "2026-11-12");
  assert.equal(F.fmStr(fm, "previous"), "");
  assert.equal(body, "body\n");
});

test("compile output splits into topic card and question bank", () => {
  const out = F.parseCompileOutput("```markdown\n" + COMPILED.trim() + "\n```");
  assert.equal(out.subject, "linear-algebra");
  assert.ok(!/^subject:/m.test(out.topicBody));
  const topic = F.parseTopic(out.topicBody);
  assert.equal(topic.title, "Linear maps");
  assert.equal(topic.subskills.length, 2);
  assert.deepEqual(topic.subskills[1].prerequisites, [1]);
  assert.match(topic.subskills[0].section, /sends \$0\$ to \$0\$/);
  assert.ok(!topic.subskills[0].section.includes("Kernel and image"));
  assert.match(topic.overview, /preserve addition/);
  const qs = F.parseQuestions(out.questionsBody);
  assert.equal(qs.length, 3);
  assert.equal(qs[0].type, "mcq");
  assert.equal(qs[0].options.length, 4);
  assert.equal(F.mcqLetter(qs[0].answer), "B");
  assert.equal(qs[1].answer, "0");
  assert.match(qs[2].question, /two lines/);
  assert.match(qs[2].answer, /because T is linear/);
});

test("question parsing tolerates the ways a model drifts from the format", () => {
  const qs = F.parseQuestions(`## Q1.
**subskill:** 2
**type:** mcq
**question:** Which is prime?
**options:**
- 4
- 7
- 9
**answer:** 7
**explanation:** Only 7 has no divisors.

### **Q2**
- subskill: 1
- type: mcq
- question: Pick the even number.
- options:
  - (a) 3
  - (b) 8
- answer: (b) 8
- explanation: 8 = 2 x 4.

### Q3
subskill: 1
type: mcq
question: A linear map sends zero to?
options:
- A. zero
- B. one
answer: A linear map sends it to zero
explanation: none

### Q4
subskill: 1
type: short
question: 2+2?
options:
- stray
answer: 4
`);
  assert.equal(qs.length, 4);
  assert.deepEqual(qs[0].options, ["A. 4", "B. 7", "C. 9"]);
  assert.equal(qs[0].answer, "B");
  assert.equal(qs[0].subskill, 2);
  assert.equal(F.answerText(qs[0]), "B. 7");
  assert.deepEqual(qs[1].options, ["A. 3", "B. 8"]);
  assert.equal(qs[1].answer, "B");
  assert.equal(qs[2].type, "open", "an answer that matches no option is not marked automatically");
  assert.match(qs[2].question, /- A\. zero/);
  assert.equal(qs[2].answer, "A linear map sends it to zero");
  assert.deepEqual(qs[3].options, []);
});

test("topic headings and hand-edited frontmatter lists are tolerated", () => {
  const t = F.parseTopic("---\ntutor: topic\ntitle: T\nsources:\n- \"[[A]]\"\n- \"[[B]]\"\nsubject: none\n---\n# T\n\n## Subskills\n\n### 1: First\nprerequisites: none\n### 2 - Second\nprerequisites: 1\n### 3) Third\n");
  assert.deepEqual(F.fmList(t.fm, "sources"), ["[[A]]", "[[B]]"]);
  assert.equal(t.fm.subject, "none");
  assert.deepEqual(t.subskills.map((s) => s.name), ["First", "Second", "Third"]);
});

test("short answers compare loosely but not emptily", () => {
  assert.ok(F.sameShortAnswer(" $0$ ", "0"));
  assert.ok(F.sameShortAnswer("Rank Nullity.", "rank nullity"));
  assert.ok(!F.sameShortAnswer("", ""));
  assert.ok(!F.sameShortAnswer("1", "0"));
});

test("state round trip, trailer extraction and validated updates", () => {
  const topic = F.parseTopic(F.parseCompileOutput(COMPILED).topicBody);
  const s = F.newState(topic, 4);
  assert.equal(F.progress(s), 0);
  const { text, update } = F.extractStateTrailer('Good.\n\nWhat is $T(0)$?\n`<state>{"levels":{"1":3,"9":5,"2":7},"focus":2,"add_misconceptions":["confuses kernel with image"]}</state>`');
  assert.equal(text, "Good.\n\nWhat is $T(0)$?");
  const changes = F.applyStateUpdate(s, update!);
  assert.equal(s.levels[1], null, "promotion requires recorded evidence");
  assert.equal(s.levels[2], null, "level 7 is out of range and subskill 9 does not exist");
  assert.equal(s.focus, 2);
  assert.equal(changes.length, 2);
  s.cards["Q1"] = F.schedule(undefined, "good", "2026-11-12");
  s.bank[1] = { right: 1, total: 1 };
  const back = F.parseState(F.serializeState(s, "2026-11-12"));
  assert.deepEqual(back.levels, s.levels);
  assert.deepEqual(back.names, s.names);
  assert.deepEqual(back.misconceptions, ["confuses kernel with image"]);
  assert.deepEqual(back.cards, s.cards);
  assert.deepEqual(back.bank[1], { right: 1, total: 1 });
  assert.equal(back.focus, 2);
  assert.equal(F.progress(back), 0);
  // Expert mode may add misconceptions but not change levels.
  F.applyStateUpdate(back, { levels: { "2": 5 }, clear_misconceptions: ["Confuses kernel with image"] }, { levels: false });
  assert.equal(back.levels[2], null);
  assert.equal(back.misconceptions.length, 0);
  assert.equal(F.extractStateTrailer("hi <state>{broken</state>").update, null);
  assert.equal(F.extractStateTrailer("hi <state>{broken</state>").text, "hi");
});

test("scheduling grows intervals and resets on a lapse", () => {
  let c = F.schedule(undefined, "good", "2026-11-12");
  assert.equal(c.due, "2026-11-13");
  c = F.schedule(c, "good", c.due);
  assert.equal(c.interval, 3);
  c = F.schedule(c, "good", c.due);
  assert.equal(c.interval, 8);
  c = F.schedule(c, "again", c.due);
  assert.equal(c.interval, 0);
  assert.equal(c.lapses, 1);
  assert.equal(c.reps, 0);
  assert.equal(F.addDays("2026-12-31", 1), "2027-01-01");
});

test("review queue puts due cards first and limits new ones", () => {
  const qs = F.parseQuestions(F.parseCompileOutput(COMPILED).questionsBody);
  const s = F.newState(F.parseTopic(F.parseCompileOutput(COMPILED).topicBody), 4);
  s.cards["Q3"] = { due: "2026-11-10", interval: 1, ease: 2.5, reps: 1, lapses: 0 };
  assert.deepEqual(F.reviewQueue(qs, s, "2026-11-12", 1).map((q) => q.id), ["Q3", "Q1"]);
  s.newDate = "2026-11-12";
  s.newCount = 1;
  assert.deepEqual(F.reviewQueue(qs, s, "2026-11-12", 1).map((q) => q.id), ["Q3"]);
});

test("chat round trip keeps maths, code and multi-paragraph messages", () => {
  const chat: F.Chat = {
    fm: { tutor: "chat", topic: "Linear maps", mode: "tutor", part: 1, previous: "", next: "", created: "2026-11-12" },
    summary: "",
    messages: [
      { role: "tutor", text: "What does this print?\n\n```python\nprint(1)\n```" },
      { role: "you", text: "It prints 1.\n\n$$\\ker T = 0$$" },
    ],
  };
  const back = F.parseChat(F.serializeChat(chat));
  assert.deepEqual(back.messages, chat.messages);
  assert.equal(back.summary, "");
  assert.equal(back.fm.mode, "tutor");
  assert.match(F.chatForPrompt(back), /^## Messages\nTUTOR: What does/);
});

test("bundled skills include every mode, the utilities and the subject cards", () => {
  for (const k of ["core.md", "mode-tutor.md", "mode-teach.md", "summary.md", "mode-quiz.md", "mode-expert.md", "compile.md", "utility.md", "subjects/linear-algebra.md", "subjects/architecture-compilers.md", "subjects/neural-networks-ai.md", "subjects/discrete-maths.md"]) {
    assert.ok(BUNDLED[k] && BUNDLED[k].length > 100, k);
  }
  assert.equal(Object.keys(BUNDLED).filter((k) => k.startsWith("subjects/")).length, 9);
  const u = BUNDLED["utility.md"];
  assert.match(utilityPrompt(u, "extract"), /^Extract the study content[\s\S]*## \[\[Note name\]\][\s\S]*no commentary\.$/);
  assert.match(utilityPrompt(u, "summarise"), /^Compress this tutoring chat/);
  assert.match(utilityPrompt(u, "grade"), /^You grade one answer/);
});

test("prompts keep the stable part first and trim large topic cards", () => {
  const topic = F.parseTopic(F.parseCompileOutput(COMPILED).topicBody);
  const sys = buildSystem({ core: "CORE", subject: "SUBJECT", topicText: topicForPrompt(topic, null, 5000), mode: "MODE" });
  assert.ok(sys.indexOf("CORE") < sys.indexOf("SUBJECT") && sys.indexOf("SUBJECT") < sys.indexOf("# Topic card") && sys.indexOf("# Topic card") < sys.indexOf("MODE"));
  const trimmed = topicForPrompt(topic, 2, 10);
  assert.match(trimmed, /1\. Definition of a linear map/);
  assert.match(trimmed, /\\ker T/);
  assert.ok(trimmed.includes("sends $0$ to $0$"), "prerequisite definitions remain available");
  const state = F.newState(topic, 4);
  const empty: F.Chat = { fm: {}, summary: "", messages: [] };
  assert.match(buildTurnInput({ state, today: "2026-11-12", chat: empty }), /just opened this chat\. Begin\.$/);
  const input = buildTurnInput({ state, today: "2026-11-12", chat: { ...empty, summary: "Covered kernels.", messages: [{ role: "you", text: "hi" }] }, attached: { name: "Kernel", text: "notes" } });
  assert.match(input, /# Learner state[\s\S]*Covered kernels\.[\s\S]*LEARNER: hi[\s\S]*# Attached note: \[\[Kernel\]\][\s\S]*Reply to the learner's last message\.$/);
});

test("large material is batched and long notes are split", () => {
  const long = Array.from({ length: 250 }, (_, i) => `w${i}`).join(" ");
  const batches = batchMaterial([{ name: "A", text: "one two three" }, { name: "B", text: long }, { name: "C", text: "four" }], 100);
  assert.equal(batches.length, 4);
  assert.match(batches[0], /^## \[\[A\]\]\none two three$/);
  assert.match(batches[1], /\[\[B\]\]\n\(part 1\)/);
  assert.match(batches[3], /\(part 3\)[\s\S]*\[\[C\]\]/);
});

test("store installs skills once, saves a compiled topic, rotates chats and exports flashcards", async () => {
  const fs = new MemFS();
  const store = new Store(fs, "Tutor", () => "2026-11-12");
  const first = await store.installSkills();
  assert.equal(first.written, Object.keys(BUNDLED).length);
  assert.equal(first.record["core.md"], F.textHash(BUNDLED["core.md"]));
  // A file left as an older version of the plugin wrote it is refreshed on upgrade...
  fs.files.set("Tutor/_skills/mode-quiz.md", "OLD VERSION\r\n");
  const upgraded = await store.installSkills({ ...first.record, "mode-quiz.md": F.textHash("OLD VERSION\n") });
  assert.equal(upgraded.updated, 1);
  assert.equal(await fs.read("Tutor/_skills/mode-quiz.md"), BUNDLED["mode-quiz.md"]);
  // ...but a file the user has edited is never overwritten.
  fs.files.set("Tutor/_skills/core.md", "EDITED");
  const kept = await store.installSkills(upgraded.record);
  assert.deepEqual([kept.written, kept.updated], [0, 0], "user edits are not overwritten");
  assert.equal(kept.record["core.md"], first.record["core.md"]);
  assert.equal(await store.skill("core.md"), "EDITED");
  assert.ok((await store.subjectNames()).includes("linear-algebra"));

  const out = F.parseCompileOutput(COMPILED);
  const dir = await store.saveCompiled({ title: "Linear maps: intro", fm: { source: "notes", subject: out.subject, sources: ["[[Linear maps]]"] }, topicBody: out.topicBody, questionsBody: out.questionsBody, target: 4 });
  assert.equal(dir, "Tutor/Topics/Linear maps intro");
  assert.deepEqual(await store.listTopics(), [{ dir, title: "Linear maps: intro" }]);
  assert.equal((await store.loadQuestions(dir)).length, 3);
  const state = await store.loadState(dir, 4);
  state.levels[1] = 3;
  await store.saveState(dir, state);

  // Recompiling in place keeps levels for subskills whose names still match.
  await store.saveCompiled({ title: "Linear maps: intro", fm: { source: "notes", subject: out.subject }, topicBody: out.topicBody, questionsBody: out.questionsBody, target: 4, existingDir: dir });
  assert.equal((await store.loadState(dir, 4)).levels[1], 3);
  const other = await store.saveCompiled({ title: "Linear maps: intro", fm: {}, topicBody: out.topicBody, questionsBody: out.questionsBody, target: 4 });
  assert.equal(other, "Tutor/Topics/Linear maps intro 2");

  const chatPath = await store.newChat(dir, "Linear maps: intro", "tutor", new Date(2026, 10, 12, 9, 5));
  assert.equal(chatPath, `${dir}/chats/2026-11-12 0905 tutor.md`);
  const chat = await store.loadChat(chatPath);
  chat.messages.push({ role: "tutor", text: "q1" }, { role: "you", text: "a1" }, { role: "tutor", text: "q2" }, { role: "you", text: "a2" }, { role: "tutor", text: "q3" });
  const next = await store.rotateChat(chatPath, chat, "Learner answered q1 and q2.");
  assert.equal(next, `${dir}/chats/2026-11-12 0905 tutor p2.md`);
  const part2 = await store.loadChat(next);
  assert.equal(part2.summary, "Learner answered q1 and q2.");
  assert.deepEqual(part2.messages.map((m) => m.text), ["a2", "q3"]);
  assert.equal(part2.fm.part, 2);
  assert.match(String(part2.fm.previous), /0905 tutor\|2026-11-12 0905 tutor\]\]$/);
  assert.match(String((await store.loadChat(chatPath)).fm.next), /tutor p2\]\]$/);
  const part3 = await store.rotateChat(next, part2, "More.");
  assert.equal(part3, `${dir}/chats/2026-11-12 0905 tutor p3.md`);
  for (let p = 4; p <= 10; p++) fs.files.set(`${dir}/chats/2026-11-12 0905 tutor p${p}.md`, "");
  fs.files.set(`${dir}/chats/2026-11-11 2300 quiz.md`, "");
  const order = (await store.listChats(dir)).map((f) => f.split("/").pop());
  assert.equal(order[0], "2026-11-11 2300 quiz.md");
  assert.equal(order[1], "2026-11-12 0905 tutor.md", "part 1 comes before part 2");
  assert.equal(order[order.length - 1], "2026-11-12 0905 tutor p10.md", "the newest part is last, and p10 sorts after p9");

  const cards = await fs.read(await store.exportFlashcards(dir));
  assert.match(cards, /^#flashcards\/linear-maps-intro\n\nWhich map is linear\?\n- A\. /);
  assert.equal(cards.split("\n?\n").length, 4);
  await store.writeDashboard();
  assert.match(await fs.read("Tutor/Dashboard.base"), /tutor == "state"/);
});

test("deleting a session trashes every part and its session notes, and keeps the evidence", async () => {
  const fs = new MemFS();
  const store = new Store(fs, "Tutor", () => "2026-11-12");
  const out = F.parseCompileOutput(COMPILED);
  const dir = await store.saveCompiled({ title: "Linear maps", fm: {}, topicBody: out.topicBody, questionsBody: out.questionsBody, target: 4 });
  const first = await store.newChat(dir, "Linear maps", "tutor", new Date(2026, 10, 12, 9, 5));
  const chat = await store.loadChat(first);
  chat.messages.push({ role: "tutor", text: "q1" }, { role: "you", text: "a1" }, { role: "tutor", text: "q2" });
  const second = await store.rotateChat(first, chat, "Answered q1.");
  const third = await store.rotateChat(second, await store.loadChat(second), "More.");
  const other = await store.newChat(dir, "Linear maps", "quiz", new Date(2026, 10, 12, 10, 0));
  fs.dirs.add(`${dir}/sessions`);
  for (const p of [first, third, other]) fs.files.set(p.replace("/chats/", "/sessions/"), "session note");
  const state = await store.loadState(dir, 4);
  state.levels[1] = 2;
  await store.saveState(dir, state);
  const stateText = await fs.read(`${dir}/state.md`);

  // Deleting from the middle part follows the links both ways.
  const removed = await store.deleteChat(second);
  assert.deepEqual([...removed].sort(), [first, second, third].sort());
  assert.deepEqual([...fs.trashed].sort(), [first, second, third, first.replace("/chats/", "/sessions/"), third.replace("/chats/", "/sessions/")].sort());
  assert.deepEqual(await store.listChats(dir), [other], "other sessions are untouched");
  assert.ok(await fs.exists(other.replace("/chats/", "/sessions/")));
  assert.equal(await fs.read(`${dir}/state.md`), stateText, "levels and evidence are kept");

  // The system trash is used where there is one, then the vault's own .trash folder.
  const system: string[] = [];
  const local: string[] = [];
  const withTrash = Object.assign(fs, {
    trashSystem: async (p: string) => (system.push(p), fs.files.delete(p), true),
    trashLocal: async (p: string) => void local.push(p),
  });
  await new Store(withTrash, "Tutor", () => "2026-11-12").deleteChat(other);
  assert.deepEqual(system, [other, other.replace("/chats/", "/sessions/")]);
  assert.deepEqual(local, []);
  const next = await store.newChat(dir, "Linear maps", "quiz", new Date(2026, 10, 12, 11, 0));
  withTrash.trashSystem = async () => false;
  await new Store(withTrash, "Tutor", () => "2026-11-12").deleteChat(next);
  assert.deepEqual(local, [next], "with no system trash, the vault's .trash folder is used");
});

test("quiz replies are read as letters, give-ups or questions to the tutor", () => {
  assert.equal(F.parseMcqReply("b", 4), "B");
  assert.equal(F.parseMcqReply(" (C) ", 4), "C");
  assert.equal(F.parseMcqReply("B. because it scales", 4), "B");
  assert.equal(F.parseMcqReply("A matrix is linear", 4), null);
  assert.equal(F.parseMcqReply("E", 4), null, "there is no fifth option");
  assert.ok(F.givesUp("idk") && F.givesUp("I don't know.") && F.givesUp("skip") && !F.givesUp("skip the proof and use rank"));
  assert.ok(F.looksLikeQuestion("why is that?") && F.looksLikeQuestion("explain the kernel") && !F.looksLikeQuestion("the kernel is zero"));
});

test("a bank quiz is marked by code and calls the model only when judgement is needed", async () => {
  const fs = new MemFS();
  const store = new Store(fs, "Tutor", () => "2026-11-12");
  const settings = { claudePath: "", chatModel: "sonnet", compileModel: "sonnet", utilityModel: "haiku", effort: "low", targetLevel: 4, maxChatWords: 1200, maxTopicWords: 2000, singlePassWords: 6000, smartRouting: false, hardEffort: "high" };
  const engine = new Engine(store, () => settings, () => "2026-11-12");
  const out = F.parseCompileOutput(COMPILED);
  const dir = await store.saveCompiled({ title: "Linear maps", fm: { subject: "none" }, topicBody: out.topicBody, questionsBody: out.questionsBody, target: 4 });
  const calls: any[] = [];
  const usage = { input: 5, cacheRead: 0, cacheWrite: 0, output: 5, costUsd: 0, calls: 1 };
  (engine as any).call = async (o: any) => {
    calls.push(o);
    return o.jsonSchema ? { text: "", structured: { grade: "hard", feedback: "Scaling is missing." }, usage } : { text: "Here is a fresh question?", usage };
  };
  const chat = await store.newChat(dir, "Linear maps", "quiz", new Date(2026, 10, 12, 9, 0));

  let r = await engine.quizTurn(dir, chat, "");
  assert.match(r.reply, /Which map is linear\?[\s\S]*- B\. \$f\(x\)=3x\$[\s\S]*Reply with a letter/);
  assert.equal(r.local, true);
  r = await engine.quizTurn(dir, chat, "A matrix is linear");
  assert.match(r.reply, /Reply with one letter/);
  r = await engine.quizTurn(dir, chat, "b");
  assert.match(r.reply, /^\*\*Correct\.\*\*[\s\S]*dim\\ker T/);
  assert.equal(calls.length, 0, "three turns so far, no model calls");
  assert.equal(r.usage.calls, 0);

  r = await engine.quizTurn(dir, chat, "why is that?");
  assert.equal(calls.length, 1, "a question to the tutor goes to the model");
  assert.match(calls[0].system, /# Mode: Quizzer/);
  assert.equal((await store.loadChat(chat)).fm.card, "Q2", "the pending bank question is kept");

  r = await engine.quizTurn(dir, chat, " $0$ ");
  assert.match(r.reply, /^\*\*Correct\.\*\*[\s\S]*Why is the kernel a subspace\?/);
  assert.equal(calls.length, 1, "an exact short answer is marked by code");

  r = await engine.quizTurn(dir, chat, "because it is closed under addition");
  assert.equal(calls.length, 2, "an open answer needs one grading call");
  assert.equal(calls[1].model, "haiku");
  assert.match(r.reply, /^\*\*Partly right\.\*\* Scaling is missing\.[\s\S]*Answer: It contains 0[\s\S]*last question in the bank \(2\/3\)/);
  assert.equal(r.local, false);

  const state = await store.loadState(dir, 4);
  assert.deepEqual(Object.keys(state.cards).sort(), ["Q1", "Q2", "Q3"]);
  assert.deepEqual(state.bank[1], { right: 1, total: 1 });
  assert.deepEqual(state.bank[2], { right: 1, total: 2 });
  assert.deepEqual(state.levels, { 1: 2, 2: 2 }, "one marked success each: both can be followed, and no more than that");
  assert.deepEqual(
    state.attempts.map((a) => [a.questionId, a.result, a.grading, a.assisted]),
    [["Q1", "correct", "deterministic", false], ["Q2", "correct", "deterministic", true], ["Q3", "partial", "model", false]],
    "asking the tutor while Q2 was open makes that answer assisted",
  );

  r = await engine.quizTurn(dir, chat, "another one please");
  assert.equal(calls.length, 3, "with the bank used up, the model-run quizzer takes over");
  assert.equal(r.reply, "Here is a fresh question?");
  const saved = await store.loadChat(chat);
  assert.deepEqual(saved.fm.asked, ["Q1", "Q2", "Q3"]);
  assert.equal(saved.messages.filter((m) => m.role === "you").length, 6);
});

test("a summary keeps its Mermaid block in a saved note", async () => {
  const fs = new MemFS();
  const store = new Store(fs, "Tutor", () => "2026-11-12");
  const settings = { claudePath: "", chatModel: "sonnet", compileModel: "sonnet", utilityModel: "haiku", effort: "low", targetLevel: 4, maxChatWords: 1200, maxTopicWords: 2000, singlePassWords: 6000, smartRouting: false, hardEffort: "high" };
  const engine = new Engine(store, () => settings, () => "2026-11-12");
  const parsed = F.parseCompileOutput(COMPILED);
  const dir = await store.saveCompiled({ title: "Linear maps", fm: {}, topicBody: parsed.topicBody, questionsBody: parsed.questionsBody, target: 4 });
  (engine as any).call = async () => ({ text: "# Linear maps summary\n\n## Map\n```mermaid\ngraph TD\n```", usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, costUsd: 0, calls: 1 } });
  const sheet = await engine.summarySheet(dir);
  assert.match(await fs.read(sheet.path), /tutor: summary[\s\S]*```mermaid/);
});

// A machine without the CLI (the CI runner) has nothing to find; the lookup itself is still
// checked wherever the CLI is installed.
test("the Claude CLI is found on this machine", { skip: findClaude() ? false : "the Claude CLI is not installed here" }, () => {
  const p = findClaude();
  assert.ok(p, "claude should be on PATH or in a known install location");
  assert.ok(!/\.cmd$/i.test(p!), "a .cmd shim must be resolved to the real binary");
});

// ---------- nothing a model or a web page wrote may load from outside the vault ----------

const TICKS = "`".repeat(3);

test("remote pictures become links, and local ones are left alone", () => {
  const safe = (s: string) => neutraliseRemote(s);
  assert.equal(safe("See ![the curve](https://host.example/c.png?d=secret) here."), "See [the curve](https://host.example/c.png?d=secret) here.");
  assert.equal(safe("![](http://host.example/x)"), "[image](http://host.example/x)", "a link needs text to click");
  for (const address of ["//host.example/x.png", "\\\\\\\\host\\\\share\\\\x.png", "file://host/share/x.png", "https\\://host.example/x", "&#104;ttps://host.example/x", "<https://host.example/a b>", "HTTPS://HOST.EXAMPLE/x", "ftp://host.example/x"]) {
    assert.ok(!safe(`a ![x](${address}) b`).includes("!["), `${address} would have been fetched`);
  }
  // The address can sit past brackets, code and another picture nested in the label.
  for (const tricky of ["![a `]` b](https://host.example/x)", "![a ![b](local.png) c](https://host.example/x)", "![a\nb](\nhttps://host.example/x)", "[![x](https://host.example/badge.svg)](https://host.example)"]) {
    assert.ok(!safe(tricky).includes("!["), tricky);
  }
  // Through a reference definition, wherever it is.
  assert.ok(!safe("![chart][c]\n\ntext\n\n[c]: https://host.example/c.png").includes("!["));
  assert.ok(!safe("![chart]\n\n> [chart]:\n> https://host.example/c.png").includes("!["));

  for (const local of ["![diagram](attachments/diagram.png)", "![[Kernel diagram.png]]", "![[Note#Section|300]]", "![dot](data:image/png;base64,iVBORw0KGgo//AA==)", "Is $5! [x]$ defined? See [the page](https://host.example).", "[c]: https://host.example/page\n\nRead [this][c]."]) {
    assert.equal(safe(local), local);
  }
});

const STILL_LIVE = /<(?:img|iframe|video|audio|object|embed|link|base|meta|image|div|p|td|a|style|script)\b[^>]*(?:host\.example|rl\()|<(?:style|script)>/i;

test("tags that would fetch something are shown as text, and ordinary markup and maths are untouched", () => {
  const safe = (s: string) => neutraliseRemote(s);
  for (const tag of [
    '<img src="https://host.example/x.png">',
    "<img src=//host.example/x>",
    '<img\nsrc="https://host.example/x"\n>',
    '<IMG SRC="https:host.example/x">',
    '<img/src="https://host.example/x">',
    '<img title=">" src="https://host.example/x">',
    '<img src="ht\ttps://host.example/x">',
    '<img src="&#104;ttps://host.example/x">',
    '<img src="x.png" srcset="//host.example/x 2x">',
    '<iframe src="https://host.example"></iframe>',
    '<iframe srcdoc="<img src=https://host.example/x>"></iframe>',
    '<video poster="https://host.example/p.png"></video>',
    '<audio src="https://host.example/a.mp3"></audio>',
    '<object data="https://host.example/o"></object>',
    '<embed src="https://host.example/e">',
    '<link rel="stylesheet" href="https://host.example/s.css">',
    '<base href="https://host.example/">',
    '<meta http-equiv="refresh" content="0;url=https://host.example">',
    '<svg><image href="https://host.example/x.png"/></svg>',
    '<div style="background:url(https://host.example/x)">x</div>',
    "<p style='background-image:\\75rl(x)'>x</p>",
    '<td background="//host.example/x">x</td>',
    '<a href="note.md" ping="https://host.example/p">x</a>',
    "<style>@import 'https://host.example/s.css';</style>",
    "<script>fetch('https://host.example')</script>",
  ]) {
    const out = safe(`Before ${tag} after.`);
    assert.ok(!STILL_LIVE.test(out), `${tag} is still live in: ${out}`);
    assert.equal(safe(out), out, "running it again changes nothing");
  }

  // Whatever it points at, a raw picture tag is shown as text: its attributes are never guessed about.
  assert.equal(safe('<img src="attachments/diagram.png" alt="A diagram">'), '&lt;img src="attachments/diagram.png" alt="A diagram">');
  // Quotes that do not pair, a bracket inside a value, a tag never closed, a tag inside another's attribute.
  for (const odd of ['<img " src=//host.example/x>', "<img src=//host.example/x alt=a<b>", "Before <img src=//host.example/x", '<span title="<img src=//host.example/x>" 5>x</span>', '<div style="background:url(//host.example/x)"']) {
    assert.ok(!/<(?:img|div)/.test(safe(odd)), `still live: ${safe(odd)}`);
  }
  for (const fine of [
    "<b>bold</b>, <sub>2</sub>, a line<br>break and <details><summary>Hint</summary>Try $n=0$.</details>",
    '<a href="https://host.example/page">a link</a> and <span style="color:red">red</span>',
    "When $0<s \\leq 1$ and $t>0$, and if $a<b$ then $\\frac{1}{b}<\\frac{1}{a}$ for $a>0$.",
    "Is `List<T>` valid? For 0<s = t \\leq 1 and u>0 it holds, and Map<K, V> too.",
    'Correct.\n<attempt>{"skill":2,"result":"correct","assisted":false}</attempt>\n<verify>[{"type":"equal","a":"x//2","b":"floor(x/2)"}]</verify>\n<state>{"levels":{"2":3},"add_misconceptions":["reads a<b as a>b"]}</state>',
  ]) {
    assert.equal(safe(fine), fine);
  }
});

test("code stays exactly as written, and code that only looks like code is not trusted", () => {
  const html = '<img src="https://host.example/x.png">\n![x](https://host.example/y.png)';
  // A fenced block is code: nothing in it is touched, with or without a blank line before it.
  for (const block of [`Here it is:\n${TICKS}html\n${html}\n${TICKS}\nDone.`, `Here it is:\n\n~~~~\n${html}\n~~~~\n`, `1. Step one:\n   ${TICKS}html\n   ${html.replace("\n", "\n   ")}\n   ${TICKS}\n2. Step two.`, `${TICKS}\n${html}`]) {
    assert.equal(neutraliseRemote(block), block);
  }
  // Inline code reads the same afterwards, but as an element nothing can be parsed out of.
  const inline = neutraliseRemote('Use `<img src="https://host.example/x.png">` or `![alt](https://host.example/x.png)` like so. `plain code` stays.');
  assert.ok(!/<img|!\[/.test(inline));
  assert.match(inline, /<code>&#60;img src&#61;&#34;https&#58;&#47;&#47;host&#46;example&#47;x&#46;png&#34;&#62;<\/code>/);
  assert.match(inline, /`plain code` stays\.$/);
  assert.equal(neutraliseRemote(inline), inline);

  const payload = '<img src="https://host.example/x.png">';
  for (const fake of [
    // "```" inside an HTML block is text, so what follows it is live.
    `<div>\n${TICKS}\n${payload}\n${TICKS}\n</div>`,
    `<!--\n\n${TICKS}\n--> ${payload}\n${TICKS}`,
    // A fence under a list item ends with the item, closed or not.
    `- item\n\n  ${TICKS}\n  code\n${payload}`,
    // Backticks inside a tag, or across a table cell or a heading, are not code spans.
    `<span title="\`"> ${payload} <span title="\`">`,
    `| \`a | ${payload} | b\` |`,
    `text \`open\n# heading ${payload} \`close`,
  ]) {
    const out = neutraliseRemote(fake);
    assert.ok(!out.includes("<img"), `still live: ${out}`);
  }
  // A page's author chooses where its fences fall, so none of a page is skipped.
  assert.ok(!neutraliseRemote(`~~~\n${payload}\n~~~`, { trustFences: false }).includes("<img"));
  // A block a plugin would run as JavaScript is relabelled, and so is Dataview's inline form.
  assert.equal(neutraliseRemote(`${TICKS}dataviewjs\ndv.span(1)\n${TICKS}`), `${TICKS}js\ndv.span(1)\n${TICKS}`);
  assert.equal(neutraliseRemote(`  - ${TICKS} js-engine\n    1\n    ${TICKS}`), `  - ${TICKS} js\n    1\n    ${TICKS}`);
  assert.equal(neutraliseRemote("Total: `$= dv.pages().length`"), "Total: `$ = dv.pages().length`");
});

test("every string of a parsed reply is cleaned, and the plugin's own files pass through unchanged", () => {
  const reply = { overview: "![x](https://host.example/x.png)", units: [{ name: "Kernel", questions: [{ question: '<img src="https://host.example/q.png"> What is $\\ker T$?', difficulty: 2, options: ["$\\{0\\}$", "`0`"] }] }], url: "https://host.example/page", ok: true, none: null };
  const clean = neutraliseDeep(reply);
  assert.equal(clean.overview, "[x](https://host.example/x.png)");
  assert.equal(clean.units[0].questions[0].question, '&lt;img src="https://host.example/q.png"> What is $\\ker T$?');
  assert.deepEqual([clean.units[0].questions[0].options, clean.units[0].questions[0].difficulty, clean.url, clean.ok, clean.none], [["$\\{0\\}$", "`0`"], 2, "https://host.example/page", true, null]);
  // A skill file that changed on the way to the vault would look edited by the user and never be updated again.
  for (const [name, text] of Object.entries(BUNDLED)) assert.equal(neutraliseRemote(text), text, name);
  assert.equal(neutraliseRemote(COMPILED), COMPILED);
});

test("prompt files are written where only this user can read them", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "study-tutor-work-"));
  const taken = fs.mkdtempSync(path.join(os.tmpdir(), "study-tutor-work-"));
  try {
    const dir = workDir(base);
    assert.equal(dir, path.join(base, "study-tutor-cli"));
    assert.ok(fs.statSync(dir).isDirectory());
    // Windows has no permission bits to check.
    if (process.platform !== "win32") assert.equal(fs.statSync(dir).mode & 0o077, 0, "no access for other accounts");
    assert.equal(workDir(base), dir, "the same folder every time");

    // Something else already sits at that name: a folder made for this run is used instead.
    fs.writeFileSync(path.join(taken, "study-tutor-cli"), "not a folder");
    const own = workDir(taken);
    assert.notEqual(own, path.join(taken, "study-tutor-cli"));
    assert.ok(fs.statSync(own).isDirectory() && path.dirname(own) === taken);
    assert.equal(workDir(taken), own);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(taken, { recursive: true, force: true });
  }
});

test("model selection preserves saved settings and uses an independent Codex default", () => {
  const legacy = { claudePath: "", chatModel: "opus", compileModel: "sonnet", utilityModel: "haiku" };
  assert.equal(providerFor(legacy), "claude");
  assert.equal(modelFor(legacy, "chatModel"), "opus");
  const settings = { ...legacy, modelProvider: "codex" as const, codexCompileModel: " test-model " };
  assert.equal(modelFor(settings, "chatModel"), "");
  assert.equal(modelFor(settings, "compileModel"), "test-model");
  assert.equal(modelFor({ ...settings, modelProvider: "claude" }, "compileModel"), "sonnet");
});

test("Codex final events produce sanitized structured output and account for cached tokens once", () => {
  const schema = {
    type: "object", required: ["feedback"], properties: {
      feedback: { type: "string" }, reasoning: { type: "object", properties: { result: { type: "string" } } },
    },
  };
  assert.deepEqual(codexSchema(schema), {
    type: "object", required: ["feedback", "reasoning"], additionalProperties: false, properties: {
      feedback: { type: "string" }, reasoning: { anyOf: [
        { type: "object", required: ["result"], additionalProperties: false, properties: { result: { anyOf: [{ type: "string" }, { type: "null" }] } } },
        { type: "null" },
      ] },
    },
  });
  const turn = new CodexTurn();
  turn.read(JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "private reasoning" } }));
  turn.read(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"feedback":"![remote](https://example.org/pixel.png)","reasoning":null}' } }));
  turn.read(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 25, cache_write_input_tokens: 10, output_tokens: 20 } }));
  const result = turn.result(0, "", schema);
  assert.deepEqual(result.structured, { feedback: neutraliseRemote("![remote](https://example.org/pixel.png)") });
  assert.deepEqual(result.usage, { input: 65, cacheRead: 25, cacheWrite: 10, output: 20, costUsd: 0, calls: 1 });
  assert.throws(() => turn.read(JSON.stringify({ type: "item.started", item: { type: "command_execution" } })), /tool outside the tutor/);
  assert.throws(() => new CodexTurn().result(1, "Sign in"), /Sign in/);
});
