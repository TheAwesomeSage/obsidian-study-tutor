// The knowledge graph's layout and the home screen's recommendation. No DOM, no model.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as F from "../src/formats";
import { joinCourse, neighbourhood, syncTopicGraph } from "../src/course";
import { LayoutEdge, LayoutNode, bounds, depths, layoutGraph } from "../src/graphlayout";
import { ago, recommend, topicInfo } from "../src/overview";

/** A synthetic course: `topics` clusters of `size` concepts, each a small prerequisite tree, with a few links between clusters. */
function course(topics: number, size: number): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
  const nodes: LayoutNode[] = [];
  const edges: LayoutEdge[] = [];
  for (let t = 0; t < topics; t++) {
    for (let i = 0; i < size; i++) {
      nodes.push({ id: `t${t}/c${i}`, group: `t${t}` });
      if (i > 0) edges.push({ from: `t${t}/c${i}`, to: `t${t}/c${Math.floor((i - 1) / 2)}`, orders: true });
      if (i > 3 && i % 5 === 0) edges.push({ from: `t${t}/c${i}`, to: `t${t}/c${i - 3}`, orders: false });
    }
    if (t > 0) edges.push({ from: `t${t}/c0`, to: `t${t - 1}/c${size - 1}`, orders: true });
  }
  return { nodes, edges };
}

test("depth follows the longest prerequisite chain, and a loop does not hang", () => {
  const nodes = ["a", "b", "c", "d"].map((id) => ({ id, group: "g" }));
  const e = (from: string, to: string, orders = true) => ({ from, to, orders });
  assert.deepEqual(depths(nodes, [e("b", "a"), e("c", "a"), e("d", "b"), e("d", "c")]), { a: 0, b: 1, c: 1, d: 2 });
  assert.deepEqual(depths(nodes, [e("b", "a"), e("c", "b"), e("c", "a")]), { a: 0, b: 1, c: 2, d: 0 });
  assert.deepEqual(depths(nodes, [e("b", "a"), e("c", "b", false)]).c, 0, "only `requires` gives depth");
  assert.deepEqual(Object.keys(depths(nodes, [e("a", "b"), e("b", "a")])).sort(), ["a", "b", "c", "d"]);
});

test("the layout is deterministic, keeps clusters apart and puts foundations below what builds on them", () => {
  const { nodes, edges } = course(6, 20);
  const a = layoutGraph(nodes, edges);
  const b = layoutGraph(nodes, edges);
  assert.deepEqual(a, b, "the same graph always gives the same picture");
  assert.equal(Object.keys(a).length, 120);
  assert.ok(Object.values(a).every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));

  // No two concepts sit on top of each other.
  const ids = Object.keys(a);
  let closest = Infinity;
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) closest = Math.min(closest, Math.hypot(a[ids[i]][0] - a[ids[j]][0], a[ids[i]][1] - a[ids[j]][1]));
  assert.ok(closest > 6, `the closest pair is ${closest.toFixed(1)} apart`);

  // Each concept is nearer its own topic's centre than any other topic's, for nearly all of them.
  const centre = (t: number) => {
    const mine = ids.filter((id) => id.startsWith(`t${t}/`)).map((id) => a[id]);
    return [mine.reduce((s, p) => s + p[0], 0) / mine.length, mine.reduce((s, p) => s + p[1], 0) / mine.length];
  };
  const centres = [0, 1, 2, 3, 4, 5].map(centre);
  const home = ids.filter((id) => {
    const t = Number(id.slice(1, id.indexOf("/")));
    const d = centres.map((c) => Math.hypot(a[id][0] - c[0], a[id][1] - c[1]));
    return d[t] === Math.min(...d);
  }).length;
  assert.ok(home >= 108, `${home} of 120 concepts sit in their own cluster`);

  // Within a topic, a concept is drawn above its prerequisite (smaller y) far more often than not.
  const inside = edges.filter((e) => e.orders && e.from.split("/")[0] === e.to.split("/")[0]);
  const upward = inside.filter((e) => a[e.from][1] < a[e.to][1]).length;
  assert.ok(upward / inside.length > 0.9, `${upward} of ${inside.length} prerequisite edges point downward to the foundation`);
  const box = bounds(a);
  assert.ok(box.x1 - box.x0 > 200 && box.y1 - box.y0 > 200);
});

test("saved positions are kept when concepts are added, so the map stays familiar", () => {
  const before = course(3, 12);
  const first = layoutGraph(before.nodes, before.edges);
  // A fourth topic and one extra concept in the first topic arrive.
  const after = course(4, 12);
  after.nodes.push({ id: "t0/new", group: "t0" });
  after.edges.push({ from: "t0/new", to: "t0/c0", orders: true });
  const second = layoutGraph(after.nodes, after.edges, first);
  for (const id of Object.keys(first)) assert.deepEqual(second[id], first[id], `${id} did not move`);
  assert.ok(second["t0/new"], "the new concept was placed");
  const near = Math.hypot(second["t0/new"][0] - first["t0/c0"][0], second["t0/new"][1] - first["t0/c0"][1]);
  assert.ok(near < 220, `the new concept sits near its prerequisite (${near.toFixed(0)} away)`);
  const firstBox = bounds(first);
  const newTopic = bounds(second, after.nodes.filter((n) => n.group === "t3").map((n) => n.id));
  const overlap = newTopic.x0 < firstBox.x1 - 40 && newTopic.x1 > firstBox.x0 + 40 && newTopic.y0 < firstBox.y1 - 40 && newTopic.y1 > firstBox.y0 + 40;
  assert.ok(!overlap || Math.hypot((newTopic.x0 + newTopic.x1) / 2, (newTopic.y0 + newTopic.y1) / 2) > 80, "the new topic is placed beside the old ones");
  assert.deepEqual(layoutGraph(before.nodes, before.edges, first), first, "with every position saved nothing is recomputed");
});

test("two thousand concepts are laid out in well under a few seconds", () => {
  const { nodes, edges } = course(40, 50);
  assert.equal(nodes.length, 2000);
  const t0 = Date.now();
  const pos = layoutGraph(nodes, edges);
  const ms = Date.now() - t0;
  assert.ok(ms < 4000, `took ${ms} ms`);
  assert.equal(Object.keys(pos).length, 2000);
  assert.ok(Object.values(pos).every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));
});

test("a concept's neighbourhood separates what it rests on, what rests on it, and other relations", () => {
  const card = (names: [string, string, string?][]) => ["# T", "", "## Subskills", "", ...names.flatMap(([name, pre, rel], i) => [`### ${i + 1}. ${name}`, `prerequisites: ${pre}`, ...(rel ? [`relations: ${rel}`] : []), "- claim", ""])].join("\n");
  const a = syncTopicGraph("Signals", F.parseTopic(card([["Complex numbers", "none"], ["Phasors", "1"], ["Fourier series", "2", "contrasts_with 4"], ["Laplace transform", "1", "applies_to 5"], ["Transfer functions", "4"]])), null).graph;
  const b = syncTopicGraph("Circuits", F.parseTopic(card([["Impedance", "none"], ["Filters", "1"]])), null).graph;
  b.edges.push({ from: "circuits/impedance", to: "signals/phasors", type: "requires", status: "reviewed", source: "learner" });
  b.edges.push({ from: "circuits/filters", to: "signals/transfer-functions", type: "requires", status: "rejected", source: "learner" });
  b.edges.push({ from: "circuits/filters", to: "nowhere/gone", type: "requires", status: "reviewed", source: "learner" });
  const c = joinCourse([{ dir: "T/Signals", title: "Signals", graph: a }, { dir: "T/Circuits", title: "Circuits", graph: b }]);
  assert.equal(c.concepts.size, 7);
  assert.equal(c.edges.length, 9, "the edge to a concept that does not exist is left out");
  const hood = neighbourhood(c, "signals/phasors");
  assert.deepEqual(hood.prerequisites.map((e) => e.to), ["signals/complex-numbers"]);
  assert.deepEqual(hood.dependents.map((e) => e.from).sort(), ["circuits/impedance", "signals/fourier-series"]);
  assert.deepEqual([...hood.descendants].sort(), ["circuits/filters", "circuits/impedance", "signals/fourier-series"], "dependents are followed across topics");
  const laplace = neighbourhood(c, "signals/laplace-transform");
  assert.deepEqual(laplace.related.map((e) => [e.type, e.to]), [["contrasts_with", "signals/laplace-transform"], ["applies_to", "signals/transfer-functions"]]);
  assert.deepEqual([...neighbourhood(c, "circuits/filters").ancestors].sort(), ["circuits/impedance", "signals/complex-numbers", "signals/phasors"], "a rejected prerequisite is not followed");
});

test("the home screen suggests one next step across topics, and little time favours quick work", () => {
  const topic = (title: string) => F.parseTopic(`# ${title}\n\n### 1. One\nprerequisites: none\n\n### 2. Two\nprerequisites: 1\n`);
  const day = "2026-11-13";
  const fresh = F.newState(topic("New"), 4);
  const practised = F.newState(topic("Old"), 4);
  practised.levels = { 1: 2, 2: 2 };
  const due = F.newState(topic("Due"), 4);
  due.levels = { 1: 3, 2: 2 };
  due.cards["Q1"] = { due: "2026-11-10", interval: 1, ease: 2.5, reps: 1, lapses: 0 };
  const infos = [topicInfo("d/new", "New", fresh, { 1: [], 2: [1] }, day), topicInfo("d/old", "Old", practised, { 1: [], 2: [1] }, day), topicInfo("d/due", "Due", due, { 1: [], 2: [1] }, day)];
  assert.deepEqual(infos.map((i) => [i.step.title, i.due, i.progress, i.secured]), [["Learn", 0, 0, 0], ["Practise", 0, 50, 0], ["Review", 1, 63, 0]]);
  assert.equal(infos[1].unbacked, 2, "levels with no answers behind them are counted as not yet backed");
  let rec = recommend(infos, "d/new", 25)!;
  assert.deepEqual([rec.info.title, rec.step.title], ["Due", "Review"], "due reviews come before new lessons");
  rec = recommend(infos.slice(0, 2), "d/new", 25)!;
  assert.deepEqual([rec.info.title, rec.step.title], ["New", "Learn"]);
  rec = recommend(infos.slice(0, 2), "d/new", 10)!;
  assert.deepEqual([rec.info.title, rec.step.title], ["Old", "Practise"], "with ten minutes, practice is suggested over a lesson");
  assert.match(rec.why, /fits the time you have/);
  assert.equal(recommend([], null, 25), null);
  assert.deepEqual([ago(null, day), ago("2026-11-13T09:00:00Z", day), ago("2026-11-12", day), ago("2026-11-08", day), ago("2026-10-20", day)], ["not yet", "today", "yesterday", "5 days ago", "3 weeks ago"]);
});
