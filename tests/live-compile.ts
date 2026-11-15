// One small, synthetic compile using the real CLI, optionally with local passage selection.
// Run with npm run test:compile-live; optionally set COMPILE_OLLAMA_URL.
import assert from "node:assert/strict";
import { Engine, type EngineSettings } from "../src/engine";
import { OllamaClient } from "../src/ollama";
import { usageLine } from "../src/claude";
import { Store } from "../src/store";
import { MemFS } from "./memfs";

async function main() {
  const settings: EngineSettings = {
    claudePath: "", chatModel: "haiku", compileModel: process.env.COMPILE_TEST_MODEL || "haiku", utilityModel: "haiku",
    effort: "low", targetLevel: 4, maxChatWords: 600, maxTopicWords: 2000, singlePassWords: process.env.COMPILE_OLLAMA_URL ? 10 : 600,
    smartRouting: false, hardEffort: "high",
  };
  const store = new Store(new MemFS(), "Tutor");
  const engine = new Engine(store, () => settings);
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
  console.log(`${r.status} · ${r.coverage} · ${r.questions} questions · Claude: ${usageLine(r.usage)} in ${r.usage.calls} calls`);
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
}
main().catch(e => { console.error(e); process.exitCode = 1; });
