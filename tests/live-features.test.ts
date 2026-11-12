// Live check of the features that need a real model: web research at compile time, the
// teacher mode, the code-marked quiz and the summary note. Spends usage (the research step
// most of all). Run with `npm run test:features`.

import { Engine, EngineSettings } from "../src/engine";
import { Store } from "../src/store";
import { usageLine, Usage } from "../src/claude";
import { mcqLetter } from "../src/formats";
import { MemFS } from "./memfs";

const settings: EngineSettings = { claudePath: "", chatModel: "sonnet", compileModel: "sonnet", utilityModel: "haiku", effort: "low", targetLevel: 4, maxChatWords: 1200, maxTopicWords: 2000, singlePassWords: 6000, smartRouting: true, hardEffort: "high" };
const show = (label: string, u: Usage) => console.log(`  ${label}: ${usageLine(u)} · ${u.calls} call(s) · $${u.costUsd.toFixed(4)}`);

async function main() {
  const fs = new MemFS();
  const store = new Store(fs, "Tutor");
  const engine = new Engine(store, () => settings);

  console.log("1. Compile from a spec note with web research on");
  const spec = "I want to learn eigenvalues and eigenvectors: definition, characteristic polynomial, computing them for 2x2 and 3x3 matrices, diagonalisation, and one application.";
  const c = await engine.compile({ title: "Eigenvalues and eigenvectors", mode: "spec", goal: "first-year university linear algebra", material: [{ name: "Eigen spec", text: spec }], fm: {}, research: true }, (m) => console.log("  ·", m));
  const topic = await store.loadTopic(c.dir);
  const links = topic.body.match(/\]\(https?:\/\/[^)\s]+\)/g) ?? [];
  console.log(`  ${c.subskills} subskills, ${c.questions} questions; subject card: ${topic.fm.subject}; web links cited: ${links.length}; has Sources section: ${/^## Sources/m.test(topic.body)}`);
  console.log(`  first sources: ${links.slice(0, 3).join(" ")}`);
  show("compile with research", c.usage);

  console.log("2. Teacher mode: first lesson, then an answer");
  let chat = await store.newChat(c.dir, topic.title, "teach");
  const t1 = await engine.turn(c.dir, chat, "");
  console.log(`  words: ${t1.reply.split(/\s+/).length}; has a session plan up front: ${/plan|session|today|we('| wi)ll cover/i.test(t1.reply.slice(0, 300))}; has a worked example: ${/example/i.test(t1.reply)}; has a Mermaid diagram: ${/```mermaid/.test(t1.reply)}; ends with a question: ${/\?\s*$/.test(t1.reply.trim())}`);
  console.log("  ---\n" + t1.reply.split("\n").map((l) => "  | " + l).join("\n") + "\n  ---");
  show("lesson turn", t1.usage);
  const t2 = await engine.turn(c.dir, chat, "I'm not sure, I don't really get what the vector has to do with it.");
  console.log(`  follow-up re-explains (${t2.reply.split(/\s+/).length} words): ${t2.reply.replace(/\n+/g, " ").slice(0, 200)}`);
  show("follow-up turn", t2.usage);

  console.log("3. Quiz from the bank: five answers");
  chat = await store.newChat(c.dir, topic.title, "quiz", new Date(Date.now() + 60000));
  const qs = await store.loadQuestions(c.dir);
  let total: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0, calls: 0 };
  let localTurns = 0;
  let r = await engine.quizTurn(c.dir, chat, "");
  for (let i = 0; i < 5; i++) {
    const pending = qs.find((q) => q.id === (fs.files.get(chat) ?? "").match(/^card: (\S+)$/m)?.[1]);
    if (!pending) break;
    const answer = pending.type === "mcq" ? mcqLetter(pending.answer) : pending.type === "short" ? pending.answer : "I think it is because the matrix only stretches that vector, but I am not sure about the details.";
    r = await engine.quizTurn(c.dir, chat, answer);
    if (r.local) localTurns++;
    total = { input: total.input + r.usage.input, cacheRead: total.cacheRead + r.usage.cacheRead, cacheWrite: total.cacheWrite + r.usage.cacheWrite, output: total.output + r.usage.output, costUsd: total.costUsd + r.usage.costUsd, calls: total.calls + r.usage.calls };
    console.log(`  ${pending.id} (${pending.type}) → ${r.reply.split("\n")[0].slice(0, 90)}  [${r.local ? "no tokens" : usageLine(r.usage)}]`);
  }
  console.log(`  ${localTurns} of 5 answers marked without the model`);
  show("whole quiz", total);

  console.log("4. Summary note");
  const s = await engine.summarySheet(c.dir);
  const note = await fs.read(s.path);
  console.log(`  ${note.split(/\s+/).length} words; has a Mermaid map: ${/```mermaid\s+graph/.test(note)}; has Key ideas: ${/## Key ideas/.test(note)}`);
  show("summary", s.usage);
  console.log("\nFEATURE TEST DONE");
}

main().catch((e) => {
  console.error("FEATURE TEST FAILED:", e);
  process.exit(1);
});
