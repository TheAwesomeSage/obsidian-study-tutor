// One small, synthetic compile using the real CLI, optionally with local passage selection.
// Run with npm run test:compile-live. Set TUTOR_TEST_PROVIDER=codex to test the other CLI.
// COMPILE_OLLAMA_URL optionally enables local passage selection.
import assert from "node:assert/strict";
import { Engine, type EngineSettings } from "../src/engine";
import { OllamaClient } from "../src/ollama";
import { usageLine } from "../src/claude";
import { MODEL_PROVIDERS, providerFor } from "../src/model-provider";
import { Store } from "../src/store";
import { courseLessons, courseSources } from "../src/tutoring-adapters";
import { MemFS } from "./memfs";

async function main() {
  const settings: EngineSettings = {
    modelProvider: process.env.TUTOR_TEST_PROVIDER === "codex" ? "codex" : "claude",
    claudePath: "", chatModel: "haiku", compileModel: process.env.COMPILE_TEST_MODEL || "haiku", utilityModel: "haiku",
    codexPath: process.env.TUTOR_TEST_CODEX_PATH, codexCompileModel: process.env.TUTOR_TEST_CODEX_MODEL,
    codexChatModel: process.env.TUTOR_TEST_CODEX_MODEL, codexUtilityModel: process.env.TUTOR_TEST_CODEX_MODEL,
    effort: "low", targetLevel: 4, maxChatWords: 600, maxTopicWords: 2000, singlePassWords: process.env.COMPILE_OLLAMA_URL ? 10 : 600,
    smartRouting: false, hardEffort: "high",
  };
  const store = new Store(new MemFS(), "Tutor");
  const engine = new Engine(store, () => settings);
  engine.sources = courseSources(store, async () => null);
  engine.material = courseLessons(store);
  if (process.env.COMPILE_TRACE === "1") {
    // Only use this script with the synthetic note below.
    const handler = engine as unknown as { call: (o: { jsonSchema?: unknown }) => Promise<{ structured?: unknown; text: string }> };
    const actual = handler.call.bind(engine);
    handler.call = async o => {
      const result = await actual(o);
      console.log(JSON.stringify(result.structured ?? result.text));
      return result;
    };
  }
  if (process.env.COMPILE_OLLAMA_URL) engine.compilationLocal = new OllamaClient({ baseUrl: process.env.COMPILE_OLLAMA_URL });
  const input = {
    title: "Kernel of a coordinate projection", mode: "notes" as const, goal: "One objective: compute the kernel of T(x,y)=x.",
    material: [{ name: "Projection demo", text: "# Compute the kernel\n\nFor a map T(x,y)=x over real numbers, a vector belongs to its kernel if T sends it to zero. Solve x=0 and allow y to be arbitrary; therefore the kernel is {(0,y): y is real}, the y-axis. For example T(0,3)=0 but T(2,3)=2." }], fm: {},
  };
  const r = await engine.compile(input, line => console.log(line));
  const pkg = (await store.loadPackage(r.dir))!;
  console.log(`${r.status} · ${r.coverage} · ${r.questions} questions · ${MODEL_PROVIDERS[providerFor(settings)]} · ${usageLine(r.usage)} in ${r.usage.calls} calls`);
  console.log(JSON.stringify({ metrics: r.metrics, issues: pkg.staged?.issues, availability: pkg.staged?.availability }));
  assert.ok(pkg.staged?.availability.some(a => a.sources.length && a.lessons.length && a.questions.length), "expected a source-backed lesson and assessment");
  assert.ok(r.questions > 0);
  if (engine.compilationLocal) {
    assert.ok(r.metrics?.localCalls);
    assert.ok(!pkg.staged?.issues.some(issue => issue.startsWith("Local selection")), "the real local selector should succeed");
  }
  if (r.complete) {
    const repeat = await engine.refresh({ ...input, existingDir: r.dir });
    assert.equal(repeat.usage.calls, 0);
    console.log("Unchanged refresh called no model.");
  }
  const chat = await store.newChat(r.dir, "Kernel of a coordinate projection", "tutor");
  const turn = await engine.turn(r.dir, chat, "Why does y remain free when computing the kernel?");
  assert.ok(turn.reply.trim());
  assert.ok(turn.tools?.some(tool => tool.tool === "vault.source" && tool.ok));
  assert.ok(turn.tools?.some(tool => tool.tool === "course.lesson" && tool.ok));
  assert.ok(turn.move, "expected a Master move");
  console.log(`Live Master turn read saved sources and lesson. Move: ${turn.move.move}.`);
  const grade = await engine.grade({
    id: "Q1", subskill: 1, type: "open", options: [],
    question: "Simplify 16/64 and justify the method.", answer: "1/4",
    explanation: "Divide both numerator and denominator by their common factor 16.",
    rubric: "Correct simplified result is 1/4. Justifies that division by the same nonzero common factor preserves the fraction.",
  }, "I cancel the digit 6 from the top and bottom, leaving 1/4.");
  assert.equal(grade.reasoning?.result.verdict, "correct");
  assert.equal(grade.reasoning?.method.verdict, "flawed");
  console.log("Live grading identified a correct result with a flawed method.");
}
main().catch(e => { console.error(e); process.exitCode = 1; });
