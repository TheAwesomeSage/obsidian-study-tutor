// Example courses that ship with the plugin: written by hand, saved into the vault as an ordinary
// topic without a model call, so a learner can try a complete course (and its multi-part tasks)
// before compiling one of their own. No Obsidian imports.

import cppTopic from "../assets/examples/cpp-concurrency/topic.md";
import cppQuestions from "../assets/examples/cpp-concurrency/questions.md";
import signalsTopic from "../assets/examples/signals-systems/topic.md";
import signalsQuestions from "../assets/examples/signals-systems/questions.md";
import type { Store } from "./store";

export interface ExampleCourse {
  id: string;
  title: string;
  /** One line for the button's tooltip. */
  blurb: string;
  topicBody: string;
  questionsBody: string;
  /** The subject card the tutor uses. */
  subject: string;
}

export const EXAMPLES: ExampleCourse[] = [
  {
    id: "cpp-concurrency",
    title: "C++ concurrency",
    blurb: "Data races, mutexes and condition variables, atomics and memory ordering, with a three-part lock-free queue task.",
    topicBody: cppTopic,
    questionsBody: cppQuestions,
    subject: "code-software-systems",
  },
  {
    id: "signals-systems",
    title: "Signals and systems",
    blurb: "LTI systems, Laplace transforms and the RC low-pass filter, with a four-part task: predict, plot, derive, then explain a measured discrepancy.",
    topicBody: signalsTopic,
    questionsBody: signalsQuestions,
    subject: "none",
  },
];

/** The topic folder an example was saved to, if it is in the vault. */
export async function exampleDir(store: Store, id: string): Promise<string | null> {
  for (const t of await store.listTopics()) {
    if ((await store.loadTopic(t.dir).catch(() => null))?.fm.example === id) return t.dir;
  }
  return null;
}

/** Saves the example as a topic and returns its folder; one already in the vault is returned as it is. */
export async function installExample(store: Store, id: string, target: number): Promise<{ dir: string; added: boolean }> {
  const ex = EXAMPLES.find((e) => e.id === id);
  if (!ex) throw new Error(`No example course "${id}".`);
  const have = await exampleDir(store, id);
  if (have) return { dir: have, added: false };
  const dir = await store.saveCompiled({ title: ex.title, fm: { example: ex.id, subject: ex.subject }, topicBody: ex.topicBody.trim(), questionsBody: ex.questionsBody.trim(), target });
  return { dir, added: true };
}
