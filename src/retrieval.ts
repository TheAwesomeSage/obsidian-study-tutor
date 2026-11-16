// Focused evidence retrieval for a study turn: which saved source passages bear on what the
// learner just asked, taken from the focus concept's own sources first. Pure ranking code plus a
// small consumer-side adapter for the source store, so the tutor can run on saved material alone
// (no model, no web) and the compiler's store can be swapped in at the boundary.

import { contentHash, words } from "./formats";
import type { CourseEdge, Relation } from "./course";

/**
 * One saved passage of a source. The id is stable within one saved revision of that source: the
 * same text at the same place in the same revision always has the same id, and a new revision of
 * the source gives new ids. Compact packets may carry an excerpt with the same id; the store
 * returns the original text and what surrounds it.
 */
export interface SourcePassage {
  id: string;
  /** What the passage was saved from: a note name or path, or a URL. */
  sourceId: string;
  title: string;
  /** Fingerprint of the saved source revision the passage belongs to. */
  revision: string;
  /** Heading path inside a note ("Kernel > Examples"), or a web page's section. Empty when none. */
  heading: string;
  /** Set for web sources. */
  url?: string;
  /** The original text, exactly as saved. */
  text: string;
  /** Position within its source, from 0. */
  order: number;
}

export interface PassageContext {
  passage: SourcePassage;
  before: SourcePassage[];
  after: SourcePassage[];
}

/**
 * The source store as the tutor uses it. The compiler's store is adapted to this shape; until it
 * is, `NoteSourceStore` reads the learner's notes directly.
 */
export interface SourceStore {
  /** Every saved passage of one source, by the name a topic card cites ([[Note]] without brackets, or a URL). Empty when unknown. */
  passagesOf(source: string, topic?: string): Promise<SourcePassage[]>;
  /** One passage by id, with up to `around` neighbours on each side. Null when the id or its revision is no longer saved. */
  passage(id: string, around: number, topic?: string): Promise<PassageContext | null>;
  /** Extra saved citations for a concept, including web sources absent from older graph files. */
  citations?(topic: string, conceptId: string): Promise<string[]>;
}

const linkName = (l: string): string => l.replace(/^\[\[|\]\]$/g, "").split(/[|#]/)[0].trim();

/** Splits a markdown note into passages under their headings. Paragraphs shorter than six words are left out, as before. */
export function notePassages(name: string, text: string): SourcePassage[] {
  const clean = text.replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n?/, "");
  const revision = contentHash(clean).slice(0, 8);
  const out: SourcePassage[] = [];
  const path: string[] = [];
  for (const block of clean.split(/\n\s*\n/)) {
    const lines = block.trim().split("\n");
    // A heading line opens a section; any text after it in the same block belongs to it.
    while (lines.length && /^#{1,6}\s+/.test(lines[0])) {
      const m = /^(#{1,6})\s+(.*)$/.exec(lines.shift()!)!;
      path.length = Math.min(path.length, m[1].length - 1);
      path[m[1].length - 1] = m[2].trim();
    }
    const body = lines.join("\n").trim();
    if (words(body) < 6) continue;
    out.push({ id: `${name}@${revision}#${out.length}`, sourceId: name, title: name, revision, heading: path.filter(Boolean).join(" > "), text: body, order: out.length });
  }
  return out;
}

/** The fallback store: reads notes through the host, one revision per read. Web sources are not available here. */
export class NoteSourceStore implements SourceStore {
  constructor(private read: (name: string) => Promise<string | null>) {}

  async passagesOf(source: string): Promise<SourcePassage[]> {
    const name = linkName(source);
    if (!name || /^https?:/i.test(name)) return [];
    const text = await this.read(name).catch(() => null);
    return text ? notePassages(name, text) : [];
  }

  async passage(id: string, around: number): Promise<PassageContext | null> {
    const at = id.lastIndexOf("@");
    if (at <= 0) return null;
    const all = await this.passagesOf(id.slice(0, at));
    const i = all.findIndex((p) => p.id === id);
    if (i < 0) return null;
    const n = Math.max(0, Math.min(2, around));
    return { passage: all[i], before: all.slice(Math.max(0, i - n), i), after: all.slice(i + 1, i + 1 + n) };
  }
}

/** Words that name a kind of thing rather than the thing: a question saying "rule" has not named the chain rule. */
const GENERIC = new Set("rule rules theorem theorems law laws method methods definition definitions property properties formula formulas principle equation equations test form type types basic basics introduction".split(" "));

const STOP = new Set("the a an and or of to in is it that this what was were you your for on with as at be do did how why when can could me my we i are not have has had about from does into than then them they there their which would should will just so if but also use used using get".split(" "));

/** Query terms: lower-case words of three or more letters, without stop words. */
export function terms(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOP.has(w)));
}

const hits = (have: Set<string>, want: Set<string>): number => {
  let n = 0;
  for (const w of want) if (have.has(w)) n++;
  return n;
};

/** A concept as retrieval sees it. */
export interface RetrievalConcept {
  id: string;
  name: string;
  /** Sources the course cites for it, as [[links]] or URLs. */
  sources: string[];
  /** The compact card section, used only as the fallback. */
  section?: string;
  /** Topic folder, to tell cross-topic links apart. */
  topic?: string;
}

export interface RetrievalInput {
  query: string;
  focus: RetrievalConcept;
  /** Typed edges touching the focus, each with the concept at its other end. Rejected edges may be passed; they are never followed. */
  neighbours: { edge: CourseEdge; concept: RetrievalConcept }[];
  maxWords?: number;
  maxPassages?: number;
}

export interface RetrievedPassage {
  id: string;
  sourceId: string;
  title: string;
  heading: string;
  url?: string;
  /** focus: the focus concept's sources. neighbour: the one related concept followed. card: the topic card, used when sources fall short. */
  tier: "focus" | "neighbour" | "card";
  concept: string;
  topic?: string;
  score: number;
  /** The text sent, exactly as saved, cut at a word boundary when it did not fit (then `truncated`). */
  excerpt: string;
  truncated: boolean;
}

export interface Retrieval {
  passages: RetrievedPassage[];
  /** The one typed edge followed because the question spans two concepts, or null. */
  via: { type: Relation; other: string; otherName: string; status: CourseEdge["status"]; crossTopic: boolean } | null;
  /** Set when the focus concept's own sources gave little or nothing for this question. */
  gap: { concept: string; name: string; reason: string } | null;
  /** True when the topic card section was used because the sources fell short. */
  fallback: boolean;
  words: number;
}

/** Below this many words of matching focus passages, the focus is reported as thin on evidence. */
export const MIN_FOCUS_WORDS = 40;
const TYPE_ORDER: Relation[] = ["requires", "derived_from", "supports", "applies_to", "contrasts_with", "synoptic"];

/**
 * The one related concept a question reaches, if it names one: a neighbour along a typed edge
 * that is not rejected, whose name the question uses beyond the focus's own name. Confirmed
 * links come before inferred ones, and links into other topics before links inside this one.
 */
export function relevantEdge(query: string, focus: RetrievalConcept, neighbours: RetrievalInput["neighbours"]): RetrievalInput["neighbours"][number] | null {
  const q = terms(query);
  const own = terms(focus.name);
  const ranked = neighbours
    .filter((x) => x.edge.status !== "rejected" && x.concept.id !== focus.id)
    .map((x) => {
      // The words that tell this concept apart: its name, less the focus's name and generic words.
      const theirs = [...terms(x.concept.name)].filter((w) => !own.has(w));
      const distinct = theirs.filter((w) => !GENERIC.has(w));
      return { x, named: hits(q, new Set(distinct.length ? distinct : theirs)), cross: !!x.concept.topic && !!focus.topic && x.concept.topic !== focus.topic };
    })
    .filter((r) => r.named > 0)
    .sort((a, b) => Number(b.x.edge.status === "reviewed") - Number(a.x.edge.status === "reviewed") || Number(b.cross) - Number(a.cross) || b.named - a.named || TYPE_ORDER.indexOf(a.x.edge.type) - TYPE_ORDER.indexOf(b.x.edge.type) || (a.x.concept.id < b.x.concept.id ? -1 : a.x.concept.id > b.x.concept.id ? 1 : 0));
  return ranked[0]?.x ?? null;
}

const normText = (t: string): string => t.toLowerCase().replace(/\s+/g, " ").trim();

/** Cut a quote without collapsing its original indentation or line breaks. */
function clipPassage(text: string, maxWords: number): { text: string; truncated: boolean } {
  let end = Math.min(text.length, maxWords * 20 + 120);
  let count = 0;
  for (const word of text.slice(0, end).matchAll(/\S+/g)) {
    if (++count <= maxWords) continue;
    end = word.index!;
    break;
  }
  return end < text.length ? { text: text.slice(0, end).trimEnd() + " …", truncated: true } : { text, truncated: false };
}

/**
 * Ranks saved passages for one question. Deterministic: the same passages and query give the same
 * result in the same order. The focus concept's sources come first; one related concept is added
 * only when the question names it, with a slot kept for it. Duplicates (by id, or the same text
 * cited twice) are dropped, and the total is capped in words and passages. Headings and source
 * names travel with every excerpt.
 */
export async function retrieve(store: SourceStore | null, p: RetrievalInput): Promise<Retrieval> {
  const maxWords = Math.max(30, p.maxWords ?? 220);
  const maxPassages = Math.max(1, p.maxPassages ?? 4);
  const q = terms(p.query);
  const edge = relevantEdge(p.query, p.focus, p.neighbours);

  const gather = async (c: RetrievalConcept, tier: "focus" | "neighbour") => {
    const out: (RetrievedPassage & { rank: number[] })[] = [];
    const named = terms(c.name);
    const additional = c.topic && store?.citations ? await store.citations(c.topic, c.id).catch(() => []) : [];
    const sources = [...new Set([...c.sources, ...additional])];
    let readable = 0;
    for (let si = 0; si < sources.length; si++) {
      const list = store ? await store.passagesOf(sources[si], c.topic).catch(() => []) : [];
      if (list.length) readable++;
      for (const s of list) {
        const have = terms(`${s.heading} ${s.text}`);
        // Words of the question count fully; the concept's own name only breaks ties between them.
        const score = hits(have, q) + 0.25 * hits(have, named);
        if (hits(have, q) === 0) continue;
        out.push({ id: s.id, sourceId: s.sourceId, title: s.title, heading: s.heading, ...(s.url ? { url: s.url } : {}), tier, concept: c.id, topic: c.topic, score, excerpt: s.text, truncated: false, rank: [-score, si, s.order] });
      }
    }
    out.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { out, readable, cited: sources.length };
  };

  const focus = await gather(p.focus, "focus");
  const other = edge ? await gather(edge.concept, "neighbour") : { out: [], readable: 0, cited: 0 };

  const picked: RetrievedPassage[] = [];
  const seenText = new Set<string>();
  let budget = maxWords;
  const take = (x: RetrievedPassage & { rank?: number[] }, limitWords: number): boolean => {
    if (picked.some((y) => y.id === x.id)) return false;
    const key = normText(x.excerpt);
    if (seenText.has(key)) return false;
    const room = Math.min(budget, limitWords);
    if (room < 12) return false;
    const w = words(x.excerpt);
    const quote = clipPassage(x.excerpt, room);
    seenText.add(key);
    const { rank: _rank, ...plain } = x as RetrievedPassage & { rank?: number[] };
    picked.push({ ...plain, excerpt: quote.text, truncated: quote.truncated });
    budget -= Math.min(w, room);
    return true;
  };

  // A question that spans two concepts keeps one slot, and a third of the words, for the other one.
  const reserve = other.out.length ? 1 : 0;
  const focusWords = reserve ? Math.ceil((maxWords * 2) / 3) : maxWords;
  let focusUsed = 0;
  for (const x of focus.out) {
    if (picked.length >= maxPassages - reserve) break;
    const before = budget;
    if (take(x, focusWords - focusUsed)) focusUsed += before - budget;
  }
  for (const x of other.out) {
    if (picked.length >= maxPassages) break;
    take(x, budget);
  }
  // Leftover room goes back to the focus.
  for (const x of focus.out) {
    if (picked.length >= maxPassages) break;
    take(x, budget);
  }

  const focusWordsGot = picked.filter((x) => x.tier === "focus").reduce((a, x) => a + words(x.excerpt), 0);
  // Thin means the sources hold little that matches, not that the word cap cut it short.
  const focusAvailable = [...new Map(focus.out.map((x) => [normText(x.excerpt), words(x.excerpt)])).values()].reduce((a, n) => a + n, 0);
  let gap: Retrieval["gap"] = null;
  if (!focus.cited) gap = { concept: p.focus.id, name: p.focus.name, reason: "the course cites no source for it" };
  else if (!focus.readable) gap = { concept: p.focus.id, name: p.focus.name, reason: "its sources could not be read" };
  else if (!focusWordsGot) gap = { concept: p.focus.id, name: p.focus.name, reason: "no passage in its sources matches this question" };
  else if (focusAvailable < MIN_FOCUS_WORDS) gap = { concept: p.focus.id, name: p.focus.name, reason: `only ${focusAvailable} words of its sources match this question` };

  // The existing fallback: with nothing from the focus's sources, its card section stands in, labelled as such.
  let fallback = false;
  if (!focusWordsGot && p.focus.section?.trim() && budget >= 12) {
    fallback = take({ id: `card:${p.focus.id}`, sourceId: "topic card", title: "topic card", heading: p.focus.name, tier: "card", concept: p.focus.id, score: 0, excerpt: p.focus.section.trim(), truncated: false }, budget);
  }

  const via = edge && picked.some((x) => x.tier === "neighbour")
    ? { type: edge.edge.type, other: edge.concept.id, otherName: edge.concept.name, status: edge.edge.status, crossTopic: !!edge.concept.topic && !!p.focus.topic && edge.concept.topic !== p.focus.topic }
    : null;
  return { passages: picked, via, gap, fallback, words: maxWords - budget };
}

/** How one excerpt is cited: the note and heading as an Obsidian link, or the page and section as a web link. */
export function citation(x: Pick<RetrievedPassage, "sourceId" | "title" | "heading" | "url" | "tier">): string {
  if (x.tier === "card") return `[topic card: ${x.heading}]`;
  if (x.url) return `[${x.title || x.url}${x.heading ? ` § ${x.heading}` : ""}](${x.url})`;
  const last = x.heading.split(" > ").pop() ?? "";
  return `[[${linkName(x.sourceId)}${last ? `#${last}` : ""}]]`;
}

/** The excerpts as they go into the turn: exact quotes with their citation and reference id. */
export function renderRetrieval(r: Retrieval): string {
  const lines = r.passages.map((x) => `${citation(x)}: ${x.excerpt}${x.tier === "card" ? "" : ` {ref: ${x.id}}`}`);
  if (r.via) lines.unshift(`(This question also reaches ${r.via.otherName}, through a ${r.via.status === "reviewed" ? "confirmed" : "proposed"} "${r.via.type}" link${r.via.crossTopic ? " in another topic" : ""}.)`);
  return lines.join("\n\n");
}

/** What the tutor is told when the focus concept is thin on evidence. */
export function gapNote(r: Retrieval): string {
  if (!r.gap) return "";
  return `# Source gap\n${r.gap.name}: ${r.gap.reason}.${r.fallback ? " The topic card's own section is quoted instead." : ""} If the learner's question needs more than the material here, say so plainly; do not invent a source.`;
}

// ---------- asking for an original or surrounding passage ----------

/** At most this many passages per request, and one request per turn. */
export const MAX_PASSAGE_IDS = 2;
export const PASSAGE_RULE = `Each quoted excerpt ends with {ref: id}. If you need its original wording in full or the text around it before you can answer, reply with only <passage>{"ids":["the ref id"],"around":1}</passage>. At most ${MAX_PASSAGE_IDS} ids and one request per turn; around is 0 to 2 neighbouring passages on each side.`;

/** Takes a <passage> request out of a reply. */
export function extractPassageAsk(reply: string): { text: string; ids: string[]; around: number } {
  let ids: string[] = [];
  let around = 1;
  const text = reply
    .replace(/`{0,3}\s*<passage>([\s\S]*?)<\/passage>\s*`{0,3}/g, (_all, raw: string) => {
      try {
        const v = JSON.parse(raw.trim());
        const list = Array.isArray(v?.ids) ? v.ids : typeof v?.id === "string" ? [v.id] : [];
        ids = [...new Set([...ids, ...list.filter((x: unknown): x is string => typeof x === "string" && !!x.trim() && x.length <= 300)])].slice(0, MAX_PASSAGE_IDS);
        if (Number.isInteger(v?.around)) around = Math.max(0, Math.min(2, v.around));
      } catch {
        /* a malformed request is dropped */
      }
      return "";
    })
    .trim();
  return { text, ids, around };
}

/** One looked-up passage as the tutor sees it, capped: the passage itself, then its neighbours. */
export function renderContext(c: PassageContext | null, id: string, maxWords = 400): string {
  if (!c) return `{ref: ${id}}: not available (the source may have changed since it was quoted).`;
  const cap = (t: string, n: number) => clipPassage(t, n).text;
  const side = Math.floor(maxWords / 4);
  const cite = (p: SourcePassage) => citation({ sourceId: p.sourceId, title: p.title, heading: p.heading, url: p.url, tier: "focus" });
  return [
    ...c.before.map((p) => `(before) ${cite(p)}: ${cap(p.text, side)}`),
    `${cite(c.passage)} {ref: ${c.passage.id}}: ${cap(c.passage.text, maxWords)}`,
    ...c.after.map((p) => `(after) ${cite(p)}: ${cap(p.text, side)}`),
  ].join("\n\n");
}
