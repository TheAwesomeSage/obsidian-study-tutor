import { test } from "node:test";
import assert from "node:assert/strict";
import * as F from "../src/formats";
import { BUNDLED, buildSystem, buildTurnInput, topicForPrompt, utilityPrompt } from "../src/prompts";
import { Store } from "../src/store";
import { Engine, batchMaterial } from "../src/engine";
import { findClaude } from "../src/claude";
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
  F.applyStateUpdate(back, { levels: { "2": 5 }, clear_misconceptions: ["Confuses kernel with image"] }, false);
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
  assert.equal(state.levels[1], null, "code never changes levels; only the tutor's judgement does");

  r = await engine.quizTurn(dir, chat, "another one please");
  assert.equal(calls.length, 3, "with the bank used up, the model-run quizzer takes over");
  assert.equal(r.reply, "Here is a fresh question?");
  const saved = await store.loadChat(chat);
  assert.deepEqual(saved.fm.asked, ["Q1", "Q2", "Q3"]);
  assert.equal(saved.messages.filter((m) => m.role === "you").length, 6);
});

test("web research is passed to the compile call only when asked for", async () => {
  const fs = new MemFS();
  const store = new Store(fs, "Tutor", () => "2026-11-12");
  const settings = { claudePath: "", chatModel: "sonnet", compileModel: "sonnet", utilityModel: "haiku", effort: "low", targetLevel: 4, maxChatWords: 1200, maxTopicWords: 2000, singlePassWords: 6000, smartRouting: false, hardEffort: "high" };
  const engine = new Engine(store, () => settings, () => "2026-11-12");
  const calls: any[] = [];
  (engine as any).call = async (o: any) => {
    calls.push(o);
    return { text: COMPILED.replace("=====QUESTIONS=====", "## Sources\n- [MIT 18.06](https://ocw.mit.edu)\n\n=====QUESTIONS====="), usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, costUsd: 0, calls: 1 } };
  };
  const a = await engine.compile({ title: "Linear maps", mode: "spec", goal: "first-year university", material: [{ name: "Spec", text: "Cover linear maps and kernels." }], fm: {}, research: true });
  assert.deepEqual(calls[0].tools, ["WebSearch", "WebFetch"]);
  assert.match(calls[0].input, /RESEARCH: on/);
  assert.match(calls[0].system, /at most 6 searches/);
  const topic = await store.loadTopic(a.dir);
  assert.equal(topic.fm.research, "yes");
  assert.equal(topic.subskills.length, 2, "the Sources section is not read as a subskill");
  assert.match(topic.body, /## Sources/);
  assert.ok(!topic.subskills[1].section.includes("Sources"));
  await engine.compile({ title: "Other", mode: "subject", goal: "", material: [], fm: {} });
  assert.equal(calls[1].tools, undefined);
  assert.match(calls[1].input, /RESEARCH: off/);

  const sheet = await ((engine as any).call = async () => ({ text: "# Linear maps summary\n\n## Map\n```mermaid\ngraph TD\n```", usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, costUsd: 0, calls: 1 } }), engine.summarySheet(a.dir));
  assert.match(await fs.read(sheet.path), /tutor: summary[\s\S]*```mermaid/);
});

test("the Claude CLI is found on this machine", () => {
  const p = findClaude();
  assert.ok(p, "claude should be on PATH or in a known install location");
  assert.ok(!/\.cmd$/i.test(p!), "a .cmd shim must be resolved to the real binary");
});


test("session boundaries retain unfinished work and Learn stays in scope", async () => {
  const { chooseAction, sessionFor, readSessionReply } = await import("../src/session");
  const topic = F.parseTopic(F.parseCompileOutput(COMPILED).topicBody);
  const state = F.newState(topic, 4);
  const chat: F.Chat = { fm: {}, summary: "", messages: [{ role: "you", text: "x^2 + 2x" }] };
  const session = sessionFor(chat, state);
  assert.equal(chooseAction("teach", state, topic, session).action, "explain");
  const pending = readSessionReply('Try this <session>{"pendingQuestion":"Find $x$","helpGiven":[],"nextAction":"check","completedStep":true}</session>', session);
  assert.equal(pending.record.completedStep, false, "a pending question prevents rotation");
  assert.equal(pending.text, "Try this");
  pending.record.action = "guided-practice";
  assert.equal(chooseAction("auto", state, topic, pending.record).action, "guided-practice");
  assert.equal(readSessionReply("ok <session>{bad}</session>", session).record.completedStep, false);
  assert.equal(session.attempt, "x^2 + 2x");
});

test("evidence deduplicates retries and requires delayed transfer for mastery", async () => {
  const { recordAttempt, skillEvidence } = await import("../src/evidence");
  const a = { id: "1", skill: 1, question: "q1", answer: "answer", timestamp: "2026-11-13T12:00:00Z", mode: "auto", result: "correct" as const, confidence: 0.8, assisted: false, transfer: false, source: "model" as const, error: "" };
  let attempts = recordAttempt([], a);
  attempts = recordAttempt(attempts, a);
  assert.equal(attempts.length, 1);
  attempts = recordAttempt(attempts, { ...a, id: "2", question: "q2", transfer: true });
  assert.equal(skillEvidence(attempts, 1).delayedTransfer, false);
  attempts = recordAttempt(attempts, { ...a, id: "3", question: "q3", transfer: true, timestamp: "2026-11-14T12:00:00Z" });
  assert.equal(skillEvidence(attempts, 1).delayedTransfer, true);
  const state = F.newState(F.parseTopic(F.parseCompileOutput(COMPILED).topicBody), 4);
  state.levels[1] = 3;
  F.applyStateUpdate(state, { levels: { "1": 4 } });
  assert.equal(state.levels[1], 3);
  state.attempts = attempts;
  F.applyStateUpdate(state, { levels: { "1": 4 } });
  assert.equal(state.levels[1], 4);
  assert.equal(F.parseState(F.serializeState(state, "2026-11-14")).attempts?.length, 3);
});


test("cross-topic prerequisite links reject cycles and supply context", async () => {
  const fs = new MemFS();
  const store = new Store(fs, "Tutor");
  const compiled = F.parseCompileOutput(COMPILED);
  const make = (title: string) => store.saveCompiled({ title, fm: {}, topicBody: compiled.topicBody, questionsBody: compiled.questionsBody, target: 4 });
  const first = await make("First");
  const second = await make("Second");
  const state = await store.loadState(first, 4);
  state.focus = 1;
  await store.addPrerequisite(first, state, { skill: 1, topic: second, prerequisite: 1 });
  assert.match(await store.linkedContext(state), /External prerequisite/);
  const other = await store.loadState(second, 4);
  await assert.rejects(store.addPrerequisite(second, other, { skill: 1, topic: first, prerequisite: 1 }), /circular/);
  state.priorities = { 1: 3 };
  const migrated = F.newState(F.parseTopic(compiled.topicBody), 4, state);
  assert.equal(migrated.priorities?.[1], 3);
  assert.equal(migrated.links?.length, 1);
});
