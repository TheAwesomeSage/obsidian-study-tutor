// A process check against the base model (docs/BASE-MODEL-COMPARISON.md, part B): the same answers to
// the same questions, marked by the plugin and by the same model in a plain chat with the course notes,
// each scored by code against a fixed key. It measures how answers are marked and recorded, not
// learning: no simulated learner stands in for a person here. Used by base-bench.ts (real provider)
// and by journey.test.ts (fixtures, to check the scoring).

import { Engine } from "../src/engine";
import { Store } from "../src/store";
import { installExample } from "../src/examples";

export type Key = "correct" | "incorrect";

/** Answers with a fixed key, on questions of the signals course that code can mark. */
export const CASES: { q: string; answer: string; key: Key; why: string }[] = [
  { q: "Q5", answer: "B", key: "correct", why: "the right option" },
  { q: "Q5", answer: "A", key: "incorrect", why: "the misconception: final value after one τ" },
  { q: "Q6", answer: "1000", key: "correct", why: "exact" },
  { q: "Q6", answer: "1000 rad/s", key: "correct", why: "with its unit" },
  { q: "Q6", answer: "159", key: "incorrect", why: "the frequency in Hz, not rad/s" },
  { q: "Q7", answer: "0, 1, 0.63", key: "correct", why: "exact" },
  { q: "Q7", answer: "0 V, 1 V, 0.632 V", key: "correct", why: "units and an extra digit" },
  { q: "Q7", answer: "0, 1, 0.37", key: "incorrect", why: "e^(−1) in place of 1 − e^(−1)" },
];

/** The base model's instruction: a capable tutor with the notes, asked only to mark. */
export const BASE_INSTRUCTION = "You are a careful tutor. You have the course notes below. Mark the learner's answer to the question. Reply with exactly one word: correct or incorrect.";

export interface BenchRow {
  arm: "plugin" | "base";
  q: string;
  answer: string;
  key: Key;
  /** What the arm said, "ungraded" when it would not decide, "unreadable" when the reply was neither word. */
  verdict: string;
  agrees: boolean;
  /** The plugin's marking method (deterministic, model…); for the base model, always "model". */
  by: string;
  recorded: boolean;
}

/** Marks every case `repeats` times in each arm. The engine's `call` is the provider (real or a stub). */
export async function runBench(engine: Engine, store: Store, repeats = 3): Promise<BenchRow[]> {
  await store.installSkills();
  const target = engine.settings().targetLevel;
  const { dir } = await installExample(store, "signals-systems", target);
  const topic = await store.loadTopic(dir);
  const questions = await store.loadQuestions(dir);
  const notes = topic.body;
  const rows: BenchRow[] = [];
  for (let r = 0; r < repeats; r++) {
    for (const c of CASES) {
      const q = questions.find((x) => x.id === c.q)!;
      // The plugin: a Practise chat with that question open, answered as the learner would.
      const chat = await store.newChat(dir, topic.title, "quiz");
      const ch = await store.loadChat(chat);
      ch.fm.card = q.id;
      await store.saveChat(chat, ch);
      const res = await engine.study(dir, chat, c.answer);
      const v = res.attempt?.result ?? "ungraded";
      rows.push({ arm: "plugin", q: c.q, answer: c.answer, key: c.key, verdict: v, agrees: v === c.key, by: res.attempt?.grading ?? "none", recorded: !!res.attempt });
      // The base model: the same question and answer, with the notes, and no answer key.
      const options = q.options?.length ? `\nOptions:\n${q.options.join("\n")}` : "";
      const out = await engine.call({ model: engine.settings().chatModel, system: `${BASE_INSTRUCTION}\n\n# Course notes\n${notes}`, input: `Question: ${q.question}${options}\n\nLearner's answer: ${c.answer}` });
      const word = /\bincorrect\b/i.test(out.text) ? "incorrect" : /\bcorrect\b/i.test(out.text) ? "correct" : "unreadable";
      rows.push({ arm: "base", q: c.q, answer: c.answer, key: c.key, verdict: word, agrees: word === c.key, by: "model", recorded: false });
    }
  }
  return rows;
}

/** Agreement with the key, and how often the same answer got the same verdict across repeats, per arm. */
export function benchSummary(rows: BenchRow[]): Record<"plugin" | "base", { n: number; agree: number; undecided: number; consistent: number; cases: number; recorded: number }> {
  const of = (arm: "plugin" | "base") => {
    const mine = rows.filter((r) => r.arm === arm);
    const byCase = new Map<string, Set<string>>();
    for (const r of mine) byCase.set(`${r.q}|${r.answer}`, (byCase.get(`${r.q}|${r.answer}`) ?? new Set()).add(r.verdict));
    return { n: mine.length, agree: mine.filter((r) => r.agrees).length, undecided: mine.filter((r) => r.verdict === "ungraded" || r.verdict === "unreadable").length, consistent: [...byCase.values()].filter((s) => s.size === 1).length, cases: byCase.size, recorded: mine.filter((r) => r.recorded).length };
  };
  return { plugin: of("plugin"), base: of("base") };
}

export function benchReport(rows: BenchRow[], about: string): string {
  const s = benchSummary(rows);
  const line = (arm: "plugin" | "base", name: string) => `| ${name} | ${s[arm].agree} of ${s[arm].n} | ${s[arm].undecided} | ${s[arm].consistent} of ${s[arm].cases} | ${s[arm].recorded} |`;
  return [
    "# Base-model process check: marking",
    "",
    about,
    "",
    "> A process measure, not a learning one. It shows how the same answers are marked and recorded by each arm. It cannot show that either arm teaches better: only unseen tests taken by people can (docs/BASE-MODEL-COMPARISON.md, part A).",
    "",
    "| Arm | Agrees with the key | Undecided | Same verdict every repeat | Recorded as evidence |",
    "|---|---|---|---|---|",
    line("plugin", "Study Tutor"),
    line("base", "Base model with the notes"),
    "",
    "| Arm | Question | Answer | Key | Verdict | Marked by |",
    "|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.arm} | ${r.q} | ${r.answer.replace(/\|/g, "\\|")} | ${r.key} | ${r.verdict} | ${r.by} |`),
    "",
  ].join("\n");
}
