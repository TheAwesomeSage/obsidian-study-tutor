// End-to-end check against the real Claude CLI. It spends a small amount of usage, so it is
// not part of `npm test`. Run with `npm run test:live`.

import { Engine, EngineSettings } from "../src/engine";
import { Store } from "../src/store";
import { usageLine, Usage } from "../src/claude";
import { MemFS } from "./memfs";

const settings: EngineSettings = { claudePath: "", chatModel: "sonnet", compileModel: "sonnet", utilityModel: "haiku", effort: "low", targetLevel: 4, maxChatWords: 60, maxTopicWords: 2000, singlePassWords: 400 };

const show = (label: string, u: Usage) => console.log(`  ${label}: ${usageLine(u)} · ${u.calls} call(s) · $${u.costUsd.toFixed(4)}`);

async function main() {
  const fs = new MemFS();
  const store = new Store(fs, "Tutor");
  const engine = new Engine(store, () => settings);
  await store.installSkills();

  console.log("1. Compile from notes (large enough to fan out to parallel helpers)");
  const filler = (topic: string) => Array.from({ length: 60 }, (_, i) => `Remark ${i + 1} on ${topic}: this line restates the idea in other words for practice.`).join("\n");
  const material = [
    { name: "Binary search", text: "Binary search finds a target in a sorted array by halving the search interval.\nInvariant: if the target is present it lies in [lo, hi].\nmid = lo + (hi - lo) // 2 avoids overflow.\nRuns in O(log n) comparisons.\n" + filler("binary search") },
    { name: "Loop invariants", text: "A loop invariant is a property true before and after every iteration.\nProve it by initialisation, maintenance and termination.\nOff-by-one errors come from mixing closed [lo, hi] and half-open [lo, hi) intervals.\n" + filler("loop invariants") },
  ];
  const c = await engine.compile({ title: "Binary search", mode: "notes", goal: "intro algorithms course", material, fm: { sources: ["[[Binary search]]", "[[Loop invariants]]"] } }, (m) => console.log("  ·", m));
  console.log(`  ${c.subskills} subskills, ${c.questions} questions, ${c.agents} model calls, saved to ${c.dir}`);
  show("compile", c.usage);
  const topic = await store.loadTopic(c.dir);
  console.log(`  subject card chosen: ${topic.fm.subject}; cites notes: ${/\[\[(Binary search|Loop invariants)\]\]/.test(topic.body)}`);

  console.log("2. Tutor chat: three turns");
  let chatPath = await store.newChat(c.dir, topic.title, "tutor");
  const say = async (msg: string) => {
    const r = await engine.turn(c.dir, chatPath, msg);
    console.log(`  YOU: ${msg || "(open chat)"}\n  TUTOR: ${r.reply.replace(/\n+/g, " ").slice(0, 220)}`);
    if (r.changes.length) console.log(`  state: ${r.changes.join("; ")}`);
    show("turn", r.usage);
    if (r.rotatedTo) {
      console.log(`  chat rotated to ${r.rotatedTo}`);
      show("rotation", r.rotationUsage!);
      chatPath = r.rotatedTo;
    }
    return r;
  };
  await say("");
  const second = await say("I think it works on any array, sorted or not, and takes O(n) time.");
  await say("Oh wait, it needs a sorted array, because we discard half each time based on a comparison. So O(log n).");
  await say("mid = (lo + hi) // 2, and I move lo = mid + 1 if the middle value is too small.");
  if (second.usage.cacheRead === 0) console.log("  WARNING: the second turn did not read from the prompt cache");
  const parts = await store.listChats(c.dir);
  console.log(`  chat files: ${parts.map((p) => p.split("/").pop()).join(", ")}`);

  console.log("3. Expert mode turn in a new chat");
  chatPath = await store.newChat(c.dir, topic.title, "expert", new Date(Date.now() + 60000));
  await say("Why do people write lo + (hi - lo) // 2 instead of (lo + hi) // 2?");

  console.log("4. Grade a flashcard answer on the cheap model");
  const q = (await store.loadQuestions(c.dir)).find((x) => x.type !== "mcq")!;
  const g = await engine.grade(q, "no idea");
  console.log(`  Q: ${q.question.slice(0, 100)}\n  grade for "no idea": ${g.grade} — ${g.feedback}`);
  show("grade", g.usage);
  if (g.grade !== "again") throw new Error("a blank answer should grade as 'again'");
  console.log("\nLIVE TEST PASSED");
}

main().catch((e) => {
  console.error("LIVE TEST FAILED:", e);
  process.exit(1);
});
