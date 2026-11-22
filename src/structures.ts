// Deep structures shared across topics. A concept says which one it has with a "structure:" line on
// its topic card, written by the author or proposed by the compiler from this list. Two concepts in
// different topics match only when they name the same structure here: words in common never make a
// match, and no model decides one. No Obsidian imports.

import type { Attempt } from "./evidence";

export interface Structure {
  slug: string;
  name: string;
  /** What every case of it does, in a sentence that holds for both sides of a bridge. */
  shape: string;
  /** Where carrying one case over to another goes wrong. Named after a bridge answer, right or wrong. */
  breaks: string;
}

export const STRUCTURES: Structure[] = [
  { slug: "first-order-decay", name: "First-order decay", shape: "A quantity changes at a rate proportional to how far it is from its final value, so it approaches that value exponentially with one time constant (or half-life).", breaks: "Only one store and one rate: a second store, a rate that depends on the level non-linearly, or a driving input that changes over time gives a different shape." },
  { slug: "bounded-buffer", name: "Bounded buffer", shape: "A producer adds items and a consumer removes them through a store of fixed capacity, so the producer must wait (or drop) when it is full and the consumer when it is empty.", breaks: "What happens at full or empty is a choice (block, drop, overwrite), and with more than one producer or consumer the ordering guarantees change." },
  { slug: "negative-feedback", name: "Negative feedback", shape: "The output is measured and the difference from a target drives a correction that reduces that difference.", breaks: "Delay or too much gain in the loop turns correction into overshoot and oscillation." },
  { slug: "positive-feedback", name: "Positive feedback", shape: "A change produces more of the same change, so small differences grow until something limits them.", breaks: "Growth stops at a limit the simple loop does not contain: a resource, saturation or a competing effect." },
  { slug: "superposition", name: "Superposition", shape: "The response to a sum of inputs is the sum of the responses to each, so a problem splits into parts solved separately and added.", breaks: "Only for linear systems: a squared term, a threshold or saturation breaks it." },
  { slug: "conservation", name: "Conservation", shape: "A total is neither created nor destroyed, so what leaves one place arrives in another and the books balance.", breaks: "Only for a closed system with every store counted: a missed flow or store makes it look violated." },
  { slug: "equilibrium", name: "Dynamic equilibrium", shape: "Two opposing rates become equal, so the amounts stop changing while both processes go on.", breaks: "Equal rates do not mean equal amounts, and a disturbance shifts the balance rather than stopping it." },
  { slug: "divide-and-conquer", name: "Divide and conquer", shape: "A problem is split into smaller problems of the same kind, each solved the same way, and the answers combined.", breaks: "It pays only when the split and the combining are cheap and the parts do not overlap much." },
  { slug: "rate-and-accumulation", name: "Rate and accumulation", shape: "A store's amount is the running total of its net rate of flow, and the rate is the slope of the amount.", breaks: "The starting amount is not in the rate: two stores with the same flow can hold different amounts." },
  { slug: "resonance", name: "Resonance", shape: "A system with a natural frequency, driven near it, responds far more strongly than at other frequencies.", breaks: "Damping sets how large and how sharp the peak is: with heavy damping there is hardly a peak." },
  { slug: "mutual-exclusion", name: "Mutual exclusion", shape: "Several agents share one resource that only one may use at a time, so access is taken and released in turn.", breaks: "Taking two resources in different orders can deadlock, and a waiting agent can starve." },
  { slug: "trade-off-optimum", name: "Optimum of a trade-off", shape: "Two costs move in opposite directions as one quantity changes, so the total is least where their rates of change balance.", breaks: "The optimum moves when either cost changes, and a constraint can put the best choice at a limit instead." },
];

const BY_SLUG = new Map(STRUCTURES.map((s) => [s.slug, s]));

/** The structure a slug names, or undefined for a slug not on the list. */
export function structureOf(slug: string | undefined): Structure | undefined {
  return slug ? BY_SLUG.get(slug.trim().toLowerCase()) : undefined;
}

/** A concept in another topic with the same structure as one of this topic's, with the learner's level there. */
export interface StructureTwin {
  /** The subskill in this topic. */
  skill: number;
  structure: string;
  /** The twin's stable concept id, its name and its topic. */
  id: string;
  name: string;
  topic: string;
  dir: string;
  level: number | null;
  /** The twin's card section, for the marker. */
  section: string;
}

/** A twin is a bridge to build from once the learner can do it on their own. */
export const BRIDGE_FROM_LEVEL = 3;

/** The question a bridge asks, written by code so it is the same however it is reached. */
export function bridgeQuestion(newName: string, twin: StructureTwin): string {
  const s = structureOf(twin.structure)!;
  return [
    `**Bridge from ${twin.topic}** · You can already do *${twin.name}*. *${newName}* has the same deep structure: ${s.name.toLowerCase()}. ${s.shape}`,
    `Before it is taught, use what you know. Say which part of ${twin.name} corresponds to which part of ${newName}, and predict how ${newName} behaves. Then say one place the comparison might not hold.`,
    "Answer without help. Say **skip** to go straight to the lesson.",
  ].join("\n\n");
}

/** The model answer and rubric the separate assessor marks a bridge against. */
export function bridgeMarking(newName: string, newSection: string, twin: StructureTwin): { answer: string; rubric: string } {
  const s = structureOf(twin.structure)!;
  return {
    answer: `Both are cases of ${s.name.toLowerCase()}: ${s.shape}\n\nThe known case, ${twin.name}:\n${twin.section}\n\nThe new case, ${newName}:\n${newSection}\n\nWhere the comparison breaks: ${s.breaks}`,
    rubric: `maps the corresponding parts of ${twin.name} and ${newName} correctly; predicts behaviour of ${newName} that follows from the shared structure; names a real limit of the comparison`,
  };
}

/**
 * Attempts and days from the first attempt on a subskill to its first independent success, and
 * whether a bridge was answered on it. Null until there is an independent success. Probes are left out.
 */
export function timeToIndependence(attempts: Attempt[], skill: number, firstIndependentDay: string | null): { attempts: number; days: number; bridgedFrom: string } | null {
  const mine = attempts.filter((a) => a.skill === skill && !a.probe).sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  if (!firstIndependentDay || !mine.length) return null;
  const upTo = mine.filter((a) => a.timestamp.slice(0, 10) <= firstIndependentDay);
  const firstDay = mine[0].timestamp.slice(0, 10);
  const days = Math.round((Date.parse(firstIndependentDay) - Date.parse(firstDay)) / 86400000);
  return { attempts: upTo.length, days, bridgedFrom: mine.find((a) => a.transferFrom)?.transferFrom ?? "" };
}

/**
 * Time to independence over a set of subskills, split by whether a bridge was answered on them, so
 * a bridge's effect can be compared with concepts taught without one. Means, rounded to tenths.
 */
export function bridgeComparison(rows: ({ attempts: number; days: number; bridgedFrom: string } | null)[]): { bridged: { n: number; attempts: number; days: number }; unbridged: { n: number; attempts: number; days: number } } {
  const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0);
  const of = (rs: { attempts: number; days: number }[]) => ({ n: rs.length, attempts: mean(rs.map((r) => r.attempts)), days: mean(rs.map((r) => r.days)) });
  const done = rows.filter((r): r is NonNullable<typeof r> => !!r);
  return { bridged: of(done.filter((r) => r.bridgedFrom)), unbridged: of(done.filter((r) => !r.bridgedFrom)) };
}
