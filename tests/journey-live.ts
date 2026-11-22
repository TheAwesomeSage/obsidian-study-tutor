// The learner journey (journey.ts) on the real configured provider: the Claude Code CLI by default, or
// the Codex CLI with TUTOR_TEST_PROVIDER=codex (TUTOR_TEST_CODEX_PATH, TUTOR_TEST_CODEX_MODEL). Every
// row of the report says whether code or the real provider did the work, with the model, tokens and
// cost the CLI reported. It spends usage, so it is not part of `npm test` or CI.
// Run with `npm run test:journey-live`. Writes tests/out/journey-live.md; exits 1 if a step failed.

import * as nodeFs from "node:fs";
import { Engine, type EngineSettings } from "../src/engine";
import { Store } from "../src/store";
import { modelIdentity, providerFor } from "../src/model-provider";
import { MemFS } from "./memfs";
import { journeyReport, runJourney } from "./journey";

const settings: EngineSettings = {
  modelProvider: process.env.TUTOR_TEST_PROVIDER === "codex" ? "codex" : "claude",
  claudePath: "", chatModel: process.env.TUTOR_TEST_CHAT_MODEL || "sonnet", compileModel: process.env.TUTOR_TEST_COMPILE_MODEL || "sonnet", utilityModel: "haiku",
  codexPath: process.env.TUTOR_TEST_CODEX_PATH, codexChatModel: process.env.TUTOR_TEST_CODEX_MODEL, codexCompileModel: process.env.TUTOR_TEST_CODEX_MODEL, codexUtilityModel: process.env.TUTOR_TEST_CODEX_MODEL,
  effort: "low", targetLevel: 4, maxChatWords: 6000, maxTopicWords: 2000, singlePassWords: 6000, smartRouting: false, hardEffort: "high", bankQuiz: true, codePlacement: true, mathCheck: false,
} as EngineSettings;

async function main() {
  const store = new Store(new MemFS(), "Tutor");
  const engine = new Engine(store, () => settings);
  const { adaptRegistry } = await import("../src/visualcontract");
  const registry = await import("../src/visuals/registry");
  engine.visuals = adaptRegistry(registry as any);
  const started = new Date().toISOString();
  const rows = await runJourney(engine, store, "real");
  const about = `Run ${started} on ${providerFor(settings)}: chat ${modelIdentity(settings, "chatModel")}, assessor ${modelIdentity(settings, "compileModel")}. SymPy was not loaded. The vault was in memory and empty at the start.`;
  const report = journeyReport(rows, "real", about);
  nodeFs.mkdirSync("tests/out", { recursive: true });
  nodeFs.writeFileSync("tests/out/journey-live.md", report);
  console.log(report);
  if (rows.some((r) => !r.ok)) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
