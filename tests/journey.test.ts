// The learner journey (journey.ts) on scripted fixtures: every model call gets a canned reply chosen
// by what is being asked, so the code paths run end to end with no provider. Writes the report to
// tests/out/journey-fixture.md. `npm run test:journey-live` runs the same journey on a real provider.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { Engine } from "../src/engine";
import { Store } from "../src/store";
import { MemFS } from "./memfs";
import { journeyReport, runJourney } from "./journey";

const usage = { input: 100, cacheRead: 0, cacheWrite: 0, output: 50, costUsd: 0, calls: 1 };

/** A canned reply for each kind of call the journey makes. Anything else fails the step that made it. */
function fixtures() {
  let tutorTurns = 0;
  return async (o: any) => {
    const props = o.jsonSchema?.properties ?? {};
    if (String(o.system).startsWith("# Ask anything")) {
      return { text: '<ask>{"kind":"broad","goal":"Explain an RC filter\'s step response from a scope trace","first_step":"What a time constant is"}</ask>\nStart with the time constant: the time for the output to cover 63% of the step.', usage };
    }
    if (String(o.system).startsWith("# Outcome assessor")) {
      const input = JSON.parse(o.input);
      return { text: "", structured: { criteria: input.criteria.map((c: string) => ({ criterion: c, verdict: "met", evidence: "stated in the answer" })), summary: "Complete." }, usage };
    }
    if (props.grade) {
      return { text: "", structured: { grade: "good", feedback: "Sound.", reasoning: { result: "correct", method: "sound", certainty: "complete" } }, usage };
    }
    if (!o.jsonSchema) {
      tutorTurns++;
      const session = (q: string) => `<session>${JSON.stringify({ helpGiven: [], answerExposed: false, nextAction: "check", completedStep: false, sources: [], pendingQuestion: q })}</session>`;
      if (tutorTurns === 1) return { text: `Where is the output at t = τ?\n${session("Where is the output at t = τ?")}`, usage };
      return { text: `Not yet: at t = τ it has covered about 63% of the step, not all of it.\n<attempt>${JSON.stringify({ skill: 3, assisted: false, transfer: false, difficulty: 2, result: "incorrect", error_type: "conceptual" })}</attempt>\n${session("")}`, usage };
    }
    throw new Error(`no fixture for this call: ${String(o.system).slice(0, 60)}`);
  };
}

test("journey: every feature of the question-to-course work runs through the app's entry points, and the report says what did the work", async () => {
  const fs = new MemFS();
  const today = () => "2026-11-22";
  const store = new Store(fs, "Tutor", today);
  const settings: any = { claudePath: "", chatModel: "sonnet", compileModel: "opus", utilityModel: "haiku", effort: "low", targetLevel: 4, maxChatWords: 6000, maxTopicWords: 2000, singlePassWords: 6000, smartRouting: false, hardEffort: "high", bankQuiz: true, codePlacement: true, mathCheck: false };
  const engine = new Engine(store, () => settings, today);
  (engine as any).call = fixtures();
  const { adaptRegistry } = await import("../src/visualcontract");
  const registry = await import("../src/visuals/registry");
  engine.visuals = adaptRegistry(registry as any);

  const rows = await runJourney(engine, store, "fixture");
  const report = journeyReport(rows, "fixture", "Run by `npm test` on scripted replies. No provider was called.");
  nodeFs.mkdirSync("tests/out", { recursive: true });
  nodeFs.writeFileSync("tests/out/journey-fixture.md", report);
  for (const r of rows) assert.ok(r.ok, `${r.step}: ${r.detail}`);
  // Who did the work in each step: code where the app marks by code, a (scripted) model elsewhere.
  assert.deepEqual(rows.map((r) => [r.step, r.by]), [
    ["Ask anything", "fixture"],
    ["Grow the question into a course", "code"],
    ["Plan backwards from the outcome", "code"],
    ["Part 1: predict, marked by code", "code"],
    ["Part 2: the plotter, marked by its own code", "code"],
    ["Part 3: derive, marked by the grader", "fixture"],
    ["Part 4: explain, marked by the separate assessor", "fixture"],
    ["Diagnose a wrong answer, then teach to its cause", "fixture"],
    ["Bridge from another topic with the same structure", "fixture"],
    ["Outcome check", "fixture"],
    ["Time to independence, from the records", "code"],
  ]);
  assert.match(report, /\| 8 \| Bridge from another topic/);
  const models = Object.fromEntries(rows.map((r) => [r.step, r.models.join(", ")]));
  assert.deepEqual([models["Part 4: explain, marked by the separate assessor"], models["Bridge from another topic with the same structure"], models["Outcome check"], models["Ask anything"]], ["opus", "opus", "opus", "sonnet"], "the assessor runs on the compile model, the tutor on the chat model");
  assert.ok(!report.includes("| real |"), "a fixture run never claims a real provider");
});

test("base-model process check: each arm is scored by code against a fixed key, and the report says it is not a learning measure", async () => {
  const { runBench, benchSummary, benchReport, CASES } = await import("./basebench");
  const store = new Store(new MemFS(), "Tutor", () => "2026-11-22");
  const settings: any = { claudePath: "", chatModel: "sonnet", compileModel: "opus", utilityModel: "haiku", effort: "low", targetLevel: 4, maxChatWords: 6000, maxTopicWords: 2000, singlePassWords: 6000, smartRouting: false, hardEffort: "high", bankQuiz: true, codePlacement: true, mathCheck: false };
  const engine = new Engine(store, () => settings, () => "2026-11-22");
  // A stub base model that calls everything correct: it agrees on the correct cases only.
  const seen: any[] = [];
  // The plugin's own grader, where code cannot decide, is stubbed to say "good".
  const graded: any[] = [];
  (engine as any).call = async (o: any) => {
    if (o.jsonSchema?.properties?.grade) { graded.push(o); return { text: "", structured: { grade: "good", feedback: "" }, usage }; }
    seen.push(o);
    return { text: "Correct.", usage };
  };
  const rows = await runBench(engine, store, 2);
  const s = benchSummary(rows);
  const right = CASES.filter((c) => c.key === "correct").length;
  assert.deepEqual([s.plugin.n, s.plugin.agree, s.plugin.recorded, s.plugin.consistent], [CASES.length * 2, CASES.length * 2, CASES.length * 2, CASES.length], "the plugin marks every case the same way each time");
  assert.deepEqual([s.base.agree, s.base.recorded], [right * 2, 0]);
  assert.equal(seen.length, CASES.length * 2, "one base-model call per case and repeat");
  assert.ok(seen.every((o) => !/answer: /i.test(o.system) && o.system.includes("# Course notes")), "the base model has the notes, not the key");
  // A number with a unit is beyond the short-answer matcher, so the plugin's grader marks it; everything else is code.
  assert.deepEqual([...new Set(rows.filter((r) => r.arm === "plugin" && r.by !== "deterministic").map((r) => `${r.answer}: ${r.by}`))], ["1000 rad/s: model"]);
  assert.equal(graded.length, 2);
  assert.match(benchReport(rows, "fixture"), /A process measure, not a learning one/);
});

test("metrics: time to independence is split by bridges, and outcome checks and kinds of task are counted", async () => {
  const M = await import("../src/metrics");
  const base = { v: 2 as const, concept: "c", question: "q", answer: "a", activity: "x", mode: "auto" as const, difficulty: null, errorType: "", note: "", confidence: null, assisted: false, assistance: [], answerExposed: false, transfer: false, seconds: null, grading: "deterministic" as const, verification: "verified" as const, assumptions: "", taskType: "application" as const, family: "" };
  const at = (id: string, skill: number, day: string, result: "correct" | "incorrect", over: object = {}) => ({ ...base, id, skill, questionId: `q${id}`, result, timestamp: `${day}T10:00:00.000Z`, ...over });
  const attempts = { T: [at("1", 1, "2026-11-01", "incorrect", { transferFrom: "other/x", taskType: "transfer", grading: "model", verification: "unverified" }), at("2", 1, "2026-11-02", "correct"), at("3", 2, "2026-11-01", "incorrect"), at("4", 2, "2026-11-04", "correct")] } as any;
  const s = M.summariseMetrics({ packages: [], attempts, assessments: [{ criteria: [{ verdict: "met" }, { verdict: "partly" }] }] });
  assert.deepEqual(s.independence, { concepts: 2, reached: 2, bridged: { n: 1, attempts: 2, days: 1 }, unbridged: { n: 1, attempts: 2, days: 3 } });
  assert.deepEqual([s.kinds.bridges, s.kinds.bridgesCorrect, s.kinds.outcomeChecks, s.kinds.criteria, s.kinds.byTaskType], [1, 0, 1, { met: 1, partly: 1 }, { transfer: 1, application: 3 }]);
  assert.match(M.metricsReport(s), /## Time to independent performance[\s\S]*They are not a comparison/);
});
