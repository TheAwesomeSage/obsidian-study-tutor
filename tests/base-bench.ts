// The base-model process check (basebench.ts) on the real configured provider: the Claude Code CLI by
// default, or Codex with TUTOR_TEST_PROVIDER=codex. BENCH_REPEATS sets the repeats (default 3). It
// spends usage (one base-model call per case and repeat; the plugin arm marks these by code), so it is
// not part of `npm test`. Run with `npm run bench:base`. Writes tests/out/base-bench.md.

import * as nodeFs from "node:fs";
import { Engine, type EngineSettings } from "../src/engine";
import { Store } from "../src/store";
import { modelIdentity, providerFor } from "../src/model-provider";
import { MemFS } from "./memfs";
import { benchReport, runBench } from "./basebench";

const settings: EngineSettings = {
  modelProvider: process.env.TUTOR_TEST_PROVIDER === "codex" ? "codex" : "claude",
  claudePath: "", chatModel: process.env.TUTOR_TEST_CHAT_MODEL || "sonnet", compileModel: "sonnet", utilityModel: "haiku",
  codexPath: process.env.TUTOR_TEST_CODEX_PATH, codexChatModel: process.env.TUTOR_TEST_CODEX_MODEL, codexCompileModel: process.env.TUTOR_TEST_CODEX_MODEL, codexUtilityModel: process.env.TUTOR_TEST_CODEX_MODEL,
  effort: "low", targetLevel: 4, maxChatWords: 6000, maxTopicWords: 2000, singlePassWords: 6000, smartRouting: false, hardEffort: "high", bankQuiz: true, codePlacement: true, mathCheck: false,
} as EngineSettings;

async function main() {
  const store = new Store(new MemFS(), "Tutor");
  const engine = new Engine(store, () => settings);
  const repeats = Math.max(1, Number(process.env.BENCH_REPEATS) || 3);
  const rows = await runBench(engine, store, repeats);
  const report = benchReport(rows, `Run ${new Date().toISOString()} on ${providerFor(settings)}, base model ${modelIdentity(settings, "chatModel")}, ${repeats} repeats.`);
  nodeFs.mkdirSync("tests/out", { recursive: true });
  nodeFs.writeFileSync("tests/out/base-bench.md", report);
  console.log(report);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
