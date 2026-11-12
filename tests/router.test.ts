import { test } from "node:test";
import assert from "node:assert/strict";
import * as F from "../src/formats";
import { Route, routeTurn } from "../src/router";
import { Engine } from "../src/engine";
import { Store } from "../src/store";
import { MemFS } from "./memfs";

const long = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 7}`).join(" ");

// A labelled set. The router must match every line; a wrong "simple" is the failure that matters.
const CASES: [F.Mode, string, Route][] = [
  // Expert: short look-ups may go to the cheap model.
  ["expert", "What is a loop invariant?", "simple"],
  ["expert", "Define eigenvalue", "simple"],
  ["expert", "What does NP stand for?", "simple"],
  ["expert", "what is the kernel of a linear map?", "simple"],
  ["expert", "What are prerequisites?", "simple"],
  ["expert", "Who invented binary search?", "simple"],
  ["expert", "What is meant by a basis?", "simple"],
  ["expert", "what's a stack frame", "simple"],
  // Expert: anything needing reasoning, comparison, context or working stays on the chat model.
  ["expert", "Why do we use lo + (hi - lo) / 2?", "standard"],
  ["expert", "What is the difference between a kernel and an image?", "standard"],
  ["expert", "How does pipelining speed up a CPU?", "standard"],
  ["expert", "Explain rank-nullity intuitively", "standard"],
  ["expert", "What is it?", "standard"],
  ["expert", "What is an example of a non-diagonalisable matrix?", "standard"],
  ["expert", "what is the kernel? and what is the image?", "standard"],
  ["expert", "What is 7 mod 3?", "standard"],
  ["expert", "Can you give me an analogy for a stack frame?", "standard"],
  ["expert", "what is wrong with my answer", "standard"],
  ["expert", "What is the kernel of this matrix?", "standard"],
  ["expert", "What is the best way to learn induction proofs quickly", "complex"],
  ["expert", "what is a group; what is a ring", "standard"],
  ["expert", "What is a vector space and when should I use one instead of a module?", "standard"],
  // Expert: proofs, derivations, code and long questions get extra thinking.
  ["expert", "Prove that the kernel is a subspace", "complex"],
  ["expert", "Derive the backpropagation update for a sigmoid layer", "complex"],
  ["expert", "Show that sqrt(2) is irrational", "complex"],
  ["expert", "Write a function that reverses a linked list", "complex"],
  ["expert", "Why does this fail?\n```c\nint x = 1;\n```", "complex"],
  ["expert", "What is the time complexity of merge sort and why?", "complex"],
  ["expert", "Walk me through register allocation step by step", "complex"],
  ["expert", "Give a counterexample to: every matrix is diagonalisable", "complex"],
  ["expert", long(90), "complex"],
  // Teaching modes: the message is an answer to judge. Never the cheap model.
  ["tutor", "It needs a sorted array", "standard"],
  ["tutor", "idk", "standard"],
  ["tutor", "next", "standard"],
  ["tutor", "What is a loop invariant?", "standard"],
  ["tutor", "", "standard"],
  ["tutor", "x = 3 so the rank is 2", "complex"],
  ["tutor", "$\\ker T = \\{0\\}$", "complex"],
  ["tutor", "the answer is 12", "complex"],
  ["tutor", "By induction on n", "complex"],
  ["tutor", long(45), "complex"],
  ["teach", "I don't get it", "standard"],
  ["teach", "again", "standard"],
  ["teach", "det(A - tI) = 0 gives t = 2", "complex"],
  // Quiz: a look-up put to the quizzer can go cheap; answers cannot.
  ["quiz", "What is a pivot?", "simple"],
  ["quiz", "why is that?", "standard"],
  ["quiz", "it halves the search space each time", "standard"],
];

test("the router matches every labelled message", () => {
  const wrong = CASES.map(([mode, message, want]) => ({ mode, message: message.slice(0, 60), want, got: routeTurn({ mode, message }).route })).filter((c) => c.want !== c.got);
  assert.deepEqual(wrong, []);
});

test("the router never sends an attached note or a teaching-mode answer to the cheap model", () => {
  assert.equal(routeTurn({ mode: "expert", message: "What is a loop invariant?", attached: true }).route, "standard");
  for (const mode of ["tutor", "teach"] as F.Mode[]) for (const [, message] of CASES) assert.notEqual(routeTurn({ mode, message }).route, "simple", `${mode}: ${message}`);
});

const COMPILED = `# Linear maps
subject: none

## Overview
Linear maps preserve addition and scaling.

## Subskills

### 1. Definition of a linear map
prerequisites: none
- $T(u+v)=T(u)+T(v)$

### 2. Kernel and image
prerequisites: 1
- The kernel is everything sent to zero.

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

async function setup(smartRouting: boolean) {
  const fs = new MemFS();
  const store = new Store(fs, "Tutor", () => "2026-11-12");
  const settings = { claudePath: "", chatModel: "sonnet", compileModel: "sonnet", utilityModel: "haiku", effort: "low", targetLevel: 4, maxChatWords: 600, maxTopicWords: 2000, singlePassWords: 6000, smartRouting, hardEffort: "high" };
  const engine = new Engine(store, () => settings, () => "2026-11-12");
  const out = F.parseCompileOutput(COMPILED);
  const dir = await store.saveCompiled({ title: "Linear maps", fm: { subject: "none" }, topicBody: out.topicBody, questionsBody: out.questionsBody, target: 4 });
  const calls: any[] = [];
  let reply = "ok";
  (engine as any).call = async (o: any) => {
    calls.push(o);
    return { text: o.jsonSchema ? "" : reply, structured: o.jsonSchema ? { grade: "good", feedback: "Fine." } : undefined, usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, costUsd: 0, calls: 1 } };
  };
  return { fs, store, engine, dir, calls, setReply: (r: string) => (reply = r) };
}

test("a turn uses the model and effort the router chose", async () => {
  const { store, engine, dir, calls, setReply } = await setup(true);
  const expert = await store.newChat(dir, "Linear maps", "expert", new Date(2026, 10, 12, 9, 0));
  let r = await engine.turn(dir, expert, "What is a kernel?");
  assert.deepEqual([calls[0].model, calls[0].effort], ["haiku", undefined]);
  assert.equal(r.route?.route, "simple");
  r = await engine.turn(dir, expert, "Prove that the kernel is a subspace");
  assert.deepEqual([calls[1].model, calls[1].effort], ["sonnet", "high"]);
  r = await engine.turn(dir, expert, "How does that relate to the image?");
  assert.deepEqual([calls[2].model, calls[2].effort], ["sonnet", "low"]);

  const tutor = await store.newChat(dir, "Linear maps", "tutor", new Date(2026, 10, 12, 9, 1));
  await engine.turn(dir, tutor, "What is a kernel?");
  assert.equal(calls[3].model, "sonnet", "the tutor never answers on the cheap model");

  // The cheap model cannot move a level, whatever it says.
  const quiz = await store.newChat(dir, "Linear maps", "quiz", new Date(2026, 10, 12, 9, 2));
  setReply('A pivot is a leading entry.\n<state>{"levels":{"1":5}}</state>');
  r = await engine.turn(dir, quiz, "What is a pivot?");
  assert.equal(calls[4].model, "haiku");
  assert.equal(r.state.levels[1], null);
  assert.deepEqual(r.changes, []);

  // A retry routes on the message being retried, not on the empty retry itself.
  const again = await store.newChat(dir, "Linear maps", "expert", new Date(2026, 10, 12, 9, 3));
  const c = await store.loadChat(again);
  c.messages.push({ role: "you", text: "Derive the rank-nullity theorem" });
  await store.saveChat(again, c);
  await engine.turn(dir, again, "");
  assert.deepEqual([calls[5].model, calls[5].effort], ["sonnet", "high"]);
});

test("with routing off every turn uses the chat model at the normal effort", async () => {
  const { store, engine, dir, calls } = await setup(false);
  const expert = await store.newChat(dir, "Linear maps", "expert", new Date(2026, 10, 12, 9, 0));
  await engine.turn(dir, expert, "What is a kernel?");
  await engine.turn(dir, expert, "Prove that the kernel is a subspace");
  assert.deepEqual(calls.map((c) => [c.model, c.effort]), [["sonnet", "low"], ["sonnet", "low"]]);
});

test("grading sends maths to the chat model and plain prose to the cheap one", async () => {
  const { store, engine, dir, calls } = await setup(true);
  const qs = await store.loadQuestions(dir);
  await engine.grade(qs[1], "1");
  assert.equal(calls[0].model, "sonnet", "the model answer is a number");
  await engine.grade(qs[2], "because sums and multiples stay inside it");
  assert.equal(calls[1].model, "haiku");
  await engine.grade(qs[2], "because T(u+v) = 0");
  assert.equal(calls[2].model, "sonnet", "the learner's answer contains maths");
});

test("placement sets starting levels in code and then hands over to the tutor", async () => {
  const { store, engine, dir, calls } = await setup(true);
  const chat = await store.newChat(dir, "Linear maps", "tutor", new Date(2026, 10, 12, 9, 0));
  let r = await engine.placementTurn(dir, chat, "");
  assert.match(r!.reply, /\*\*Placement\*\* · 2 quick questions[\s\S]*Which map is linear\?/);
  r = await engine.placementTurn(dir, chat, "the second one");
  assert.match(r!.reply, /Reply with one letter/);
  r = await engine.placementTurn(dir, chat, "B");
  assert.match(r!.reply, /^\*\*Correct\.\*\*[\s\S]*dim\\ker/);
  r = await engine.placementTurn(dir, chat, "5");
  assert.match(r!.reply, /^\*\*Placement done\.\*\*[\s\S]*\| Definition of a linear map \| 2 \|[\s\S]*\| Kernel and image \| 1 \|[\s\S]*begin with \*\*Kernel and image\*\*/);
  assert.equal(calls.length, 0, "placement never calls a model");
  const state = await store.loadState(dir, 4);
  assert.deepEqual([state.levels[1], state.levels[2], state.focus], [2, 1, 2]);
  assert.deepEqual(state.bank[1], { right: 1, total: 1 });
  assert.deepEqual(state.bank[2], { right: 0, total: 1 });
  assert.equal(await engine.placementTurn(dir, chat, "ok"), null, "after placement the normal tutor turn runs");
  assert.equal((await store.loadChat(chat)).fm.placement, "done");

  // Skipping a question places that subskill at 0. Placement does not start when levels exist.
  const other = await setup(true);
  const c2 = await other.store.newChat(other.dir, "Linear maps", "tutor", new Date(2026, 10, 12, 9, 0));
  await other.engine.placementTurn(other.dir, c2, "");
  await other.engine.placementTurn(other.dir, c2, "skip");
  await other.engine.placementTurn(other.dir, c2, "0");
  const s2 = await other.store.loadState(other.dir, 4);
  assert.deepEqual([s2.levels[1], s2.levels[2], s2.focus], [0, 2, 1]);
  const c3 = await other.store.newChat(other.dir, "Linear maps", "tutor", new Date(2026, 10, 12, 9, 5));
  assert.equal(await other.engine.placementTurn(other.dir, c3, ""), null);
});

test("the next step follows learn, practise, master", () => {
  const topic = F.parseTopic(F.parseCompileOutput(COMPILED).topicBody);
  const s = F.newState(topic, 4);
  const day = "2026-11-12";
  assert.equal(F.nextStep(s, day).action, "teach");
  s.levels = { 1: 2, 2: 1 };
  assert.match(F.nextStep(s, day).detail, /lesson on Kernel and image/);
  s.levels = { 1: 2, 2: 2 };
  assert.equal(F.nextStep(s, day).action, "quiz");
  s.bank = { 1: { right: 2, total: 2 }, 2: { right: 1, total: 2 } };
  const master = F.nextStep(s, day);
  assert.equal(master.action, "tutor");
  assert.match(master.detail, /level 2 of 4/);
  s.cards["Q1"] = { due: "2026-11-10", interval: 1, ease: 2.5, reps: 1, lapses: 0 };
  assert.equal(F.nextStep(s, day).action, "review");
  delete s.cards["Q1"];
  s.levels = { 1: 4, 2: 5 };
  assert.equal(F.nextStep(s, day).action, "done");
});
