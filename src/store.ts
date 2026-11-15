// All vault reads and writes go through this class. It depends only on a small file-system
// interface (Obsidian's DataAdapter satisfies it), so it can be tested outside Obsidian.

import { BUNDLED } from "./prompts";
import { Course, CourseEdge, EdgeStatus, Relation, TopicGraph, effectivePrereqs, joinCourse, parseTopicGraph, serializeTopicGraph, syncTopicGraph, wouldCycle } from "./course";
import { Attempt, LevelChange, normaliseAttempt } from "./evidence";
import { SrStats, buildSrNote, srStats } from "./formats";
import { Chat, Frontmatter, LearnerState, Mode, Prereqs, Question, Topic, fmNum, fmStr, newState, parseChat, parseQuestions, parseState, parseTopic, serializeChat, serializeState, textHash, withFrontmatter, ymd } from "./formats";
import type { PolicyCase } from "./policy";
import { SessionRecord, sessionMarkdown } from "./session";
import type { ActivityRecord } from "./configure";
import type { CoursePackage } from "./coursepkg";
import { Misconception, parseMisconception, reconcile } from "./misconceptions";
import { ExpansionRecord, parseExpansion } from "./expansion";

/** One learner interaction with an activity. Kept apart from evidence.md; only an assessed answer also becomes an attempt there. */
export interface ActivityEvent {
  t: string;
  activityId: string;
  conceptId: string;
  /** offered, opened, generated, reused, failed, unsupported, assessed. Slider moves, playback and resets are never logged. */
  event: string;
  trigger: string;
  reason: string;
  /** For assessed events: the module's verdict, and whether a hint was opened first. */
  correct?: boolean | null;
  hintUsed?: boolean;
  attemptId?: string;
  chatPath?: string;
}

/** A capability that no module has, with what motivated it, for a separate development pass. */
export interface CapabilityRequest {
  t: string;
  topic: string;
  conceptId: string;
  kind: string;
  operation: string;
  objective: string;
  motivatingTask: string;
  sources: { path: string; contentHash: string }[];
  count: number;
}

const jsonl = (md: string): Record<string, unknown>[] => {
  const out: Record<string, unknown>[] = [];
  for (const line of md.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* one damaged line does not cost the rest */
    }
  }
  return out;
};

export interface FS {
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  /** Obsidian's adapter: move to the system trash (false when unavailable), or to the vault's .trash. */
  trashSystem?(path: string): Promise<boolean>;
  trashLocal?(path: string): Promise<void>;
  /** Permanent removal, used only when no trash is available. */
  remove?(path: string): Promise<void>;
}

export interface TopicRef {
  dir: string;
  title: string;
}

/** One saved chat, as the home screen lists it. */
export interface ChatRef {
  path: string;
  dir: string;
  topic: string;
  mode: Mode;
  /** yyyy-mm-dd hhmm, from the file name. */
  stamp: string;
  part: number;
  messages: number;
  /** A question is still open, or the last word was the learner's. */
  unfinished: boolean;
  /** Where it was left: the open question, or the start of the last message. */
  snippet: string;
  action: string;
}

export interface ExternalPrereq {
  /** The subskill of this topic that has the prerequisite. */
  skill: number;
  /** The prerequisite: its stable concept id, name, topic title, topic folder and number there. */
  id: string;
  name: string;
  topic: string;
  dir: string;
  n: number;
  level: number | null;
  section: string;
}

/** Fingerprints of the skill files shipped in 0.1.0 that later changed, from before fingerprints were recorded. */
const FIRST_RELEASE: Record<string, string> = { "core.md": "c8e78aa5", "mode-tutor.md": "bd93508", "mode-quiz.md": "29a50213", "compile.md": "4c586797" };

const base = (p: string): string => p.split("/").pop() ?? p;
const safeName = (s: string): string => s.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Topic";

const EVIDENCE_HEAD = "Every answer Study Tutor has marked on this topic and every change of level, one record per line.\nThis is the evidence behind the levels in state.md. Edit it only if you know what you are changing.";
const FENCE = "```";

function parseEvidence(md: string): { attempts: Attempt[]; changes: LevelChange[]; misconceptions: Misconception[] } {
  const attempts: Attempt[] = [];
  const changes: LevelChange[] = [];
  const misconceptions: Misconception[] = [];
  for (const line of md.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    try {
      const r = JSON.parse(line);
      if (r.kind === "change" && typeof r.t === "string" && Number.isInteger(r.skill)) changes.push({ t: r.t, skill: r.skill, concept: String(r.concept ?? ""), from: r.from ?? null, to: r.to ?? null, cause: String(r.cause ?? ""), note: String(r.note ?? "") });
      else if (r.kind === "misconception") {
        const m = parseMisconception(r);
        if (m && !misconceptions.some((x) => x.id === m.id)) misconceptions.push(m);
      } else {
        const a = normaliseAttempt(r);
        if (a) attempts.push(a);
      }
    } catch {
      /* one damaged line does not cost the rest */
    }
  }
  return { attempts, changes, misconceptions };
}

/** A legacy note nothing has happened to is rebuilt from state.md on every load, so it is not written to the evidence log. */
const pristineLegacy = (m: Misconception): boolean => !!m.legacy && m.status === "suspected" && m.history.length <= 1;

function serializeEvidence(title: string, s: LearnerState): string {
  const lines = [...s.attempts.map((a) => JSON.stringify({ kind: "attempt", ...a })), ...s.changes.map((c) => JSON.stringify({ kind: "change", ...c })), ...(s.misconceptionRecords ?? []).filter((m) => !pristineLegacy(m)).map((m) => JSON.stringify({ kind: "misconception", ...m }))];
  return withFrontmatter({ tutor: "evidence", topic: title, attempts: s.attempts.length }, `${EVIDENCE_HEAD}\n\n${FENCE}jsonl\n${lines.join("\n")}\n${FENCE}\n`);
}

export class Store {
  constructor(
    private fs: FS,
    public root: string,
    private today: () => string = () => ymd(),
  ) {}

  get skillsDir(): string {
    return `${this.root}/_skills`;
  }
  get topicsDir(): string {
    return `${this.root}/Topics`;
  }

  async ensureDir(path: string): Promise<void> {
    let cur = "";
    for (const part of path.split("/").filter(Boolean)) {
      cur = cur ? `${cur}/${part}` : part;
      if (!(await this.fs.exists(cur))) await this.fs.mkdir(cur);
    }
  }

  private async writeFile(path: string, data: string): Promise<void> {
    await this.ensureDir(path.split("/").slice(0, -1).join("/"));
    await this.fs.write(path, data);
  }

  // ----- skills: bundled defaults are copied into the vault once, then the vault copy wins -----

  /**
   * Copies missing skill files into the vault and refreshes ones the user has not edited.
   * `installed` maps each file to the fingerprint of the version this plugin last wrote; a vault
   * file that still matches it is untouched by the user and safe to replace with a newer bundle.
   * A file the user has edited is never overwritten.
   */
  async installSkills(installed: Record<string, string> = {}): Promise<{ written: number; updated: number; record: Record<string, string> }> {
    let written = 0;
    let updated = 0;
    const record: Record<string, string> = {};
    for (const [rel, text] of Object.entries(BUNDLED)) {
      const p = `${this.skillsDir}/${rel}`;
      const bundled = textHash(text);
      if (!(await this.fs.exists(p))) {
        await this.writeFile(p, text);
        written++;
        record[rel] = bundled;
        continue;
      }
      const current = textHash(await this.fs.read(p));
      const lastWritten = installed[rel] ?? FIRST_RELEASE[rel];
      if (current === bundled) record[rel] = bundled;
      else if (lastWritten && current === lastWritten) {
        await this.writeFile(p, text);
        updated++;
        record[rel] = bundled;
      } else if (lastWritten) record[rel] = lastWritten;
    }
    return { written, updated, record };
  }

  async skill(rel: string): Promise<string> {
    const p = `${this.skillsDir}/${rel}`;
    try {
      if (await this.fs.exists(p)) return await this.fs.read(p);
    } catch {
      /* fall back to the bundled copy */
    }
    return BUNDLED[rel] ?? "";
  }

  async subjectNames(): Promise<string[]> {
    const names = new Set(Object.keys(BUNDLED).filter((k) => k.startsWith("subjects/")).map((k) => base(k).replace(/\.md$/, "")));
    try {
      const dir = `${this.skillsDir}/subjects`;
      if (await this.fs.exists(dir)) for (const f of (await this.fs.list(dir)).files) if (f.endsWith(".md")) names.add(base(f).replace(/\.md$/, ""));
    } catch {
      /* bundled names are enough */
    }
    return [...names].sort();
  }

  // ----- topics -----

  async listTopics(): Promise<TopicRef[]> {
    if (!(await this.fs.exists(this.topicsDir))) return [];
    const out: TopicRef[] = [];
    for (const dir of (await this.fs.list(this.topicsDir)).folders) {
      if (!(await this.fs.exists(`${dir}/topic.md`))) continue;
      try {
        out.push({ dir, title: parseTopic(await this.fs.read(`${dir}/topic.md`)).title });
      } catch {
        out.push({ dir, title: base(dir) });
      }
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
  }

  async loadTopic(dir: string): Promise<Topic> {
    return parseTopic(await this.fs.read(`${dir}/topic.md`));
  }

  // ----- the course graph: concepts and relations, separate from anything about the learner -----

  private graphPath(dir: string): string {
    return `${dir}/graph.md`;
  }

  /**
   * The topic's course graph, brought into line with its topic card. The file is rewritten only
   * when something changed, so reading the graph is safe to do often.
   */
  async loadGraph(dir: string, topic?: Topic): Promise<TopicGraph> {
    const t = topic ?? (await this.loadTopic(dir));
    const p = this.graphPath(dir);
    let prev: TopicGraph | null = null;
    let text = "";
    try {
      if (await this.fs.exists(p)) {
        text = await this.fs.read(p);
        prev = parseTopicGraph(text);
      }
    } catch {
      prev = null;
    }
    const { graph } = syncTopicGraph(base(dir), t, prev);
    const next = serializeTopicGraph(t.title, graph);
    if (next !== text.replace(/\r\n/g, "\n")) await this.writeFile(p, next);
    return graph;
  }

  async saveGraph(dir: string, graph: TopicGraph): Promise<void> {
    const topic = await this.loadTopic(dir);
    await this.writeFile(this.graphPath(dir), serializeTopicGraph(topic.title, graph));
  }

  /** Prerequisites inside one topic, by subskill number, as the course graph has them now. */
  async prereqs(dir: string, topic?: Topic): Promise<Prereqs> {
    return effectivePrereqs(await this.loadGraph(dir, topic));
  }

  /** Every topic's graph joined into one. */
  async loadCourse(): Promise<Course> {
    const parts: { dir: string; title: string; graph: TopicGraph }[] = [];
    for (const ref of await this.listTopics()) {
      try {
        parts.push({ dir: ref.dir, title: ref.title, graph: await this.loadGraph(ref.dir) });
      } catch {
        /* a topic that cannot be read is left out of the graph, not out of the vault */
      }
    }
    return joinCourse(parts);
  }

  /**
   * Adds a relation between two concepts, stored with the topic the first one belongs to.
   * A `requires` relation that would close a loop of prerequisites is refused.
   */
  async addRelation(edge: { from: string; to: string; type: Relation; status?: EdgeStatus; source?: string; rationale?: string; challenge?: string }): Promise<void> {
    const course = await this.loadCourse();
    if (edge.type === "synoptic") {
      if (!edge.rationale?.trim() || !edge.challenge?.trim()) throw new Error("A synoptic connection needs an explanation and a joint question.");
      if (edge.rationale.length > 2000 || edge.challenge.length > 4000) throw new Error("Keep the explanation under 2000 characters and the question under 4000.");
      const duplicate = course.edges.find(e => e.type === "synoptic" && ((e.from === edge.from && e.to === edge.to) || (e.from === edge.to && e.to === edge.from)));
      if (duplicate) throw new Error("This synoptic connection already exists, including reviewed or rejected suggestions.");
    }
    const from = course.concepts.get(edge.from);
    if (!from || !course.concepts.has(edge.to)) throw new Error("Choose two existing concepts.");
    if (edge.from === edge.to) throw new Error("A concept cannot be related to itself.");
    if (edge.type === "requires" && wouldCycle(course.edges, edge.from, edge.to)) throw new Error("This prerequisite would create a circular dependency.");
    const graph = await this.loadGraph(from.topic);
    const existing = graph.edges.find((e) => e.from === edge.from && e.to === edge.to && e.type === edge.type);
    if (existing) existing.status = edge.status ?? "reviewed";
    else graph.edges.push({ from: edge.from, to: edge.to, type: edge.type, status: edge.status ?? "reviewed", source: edge.source ?? "learner", ...(edge.rationale ? { rationale: edge.rationale.trim() } : {}), ...(edge.challenge ? { challenge: edge.challenge.trim() } : {}) });
    await this.saveGraph(from.topic, graph);
  }

  /**
   * Marks a relation reviewed or rejected. A relation the learner added is removed outright when
   * rejected; synoptic suggestions and those from the topic card stay in the file as rejected, so they are not
   * proposed again the next time the card is read.
   */
  async setRelationStatus(edge: { from: string; to: string; type: Relation }, status: EdgeStatus): Promise<void> {
    const same = (e: CourseEdge) => e.from === edge.from && e.to === edge.to && e.type === edge.type;
    const course = await this.loadCourse();
    const from = course.concepts.get(edge.from);
    if (!from) throw new Error("That concept no longer exists.");
    const graph = await this.loadGraph(from.topic);
    const i = graph.edges.findIndex(same);
    if (i < 0) return;
    // Bringing a rejected prerequisite back must not close a loop either.
    if (status !== "rejected" && edge.type === "requires" && graph.edges[i].status === "rejected" && wouldCycle(course.edges.filter((e) => !same(e)), edge.from, edge.to)) throw new Error("This prerequisite would create a circular dependency.");
    if (status === "rejected" && graph.edges[i].source !== "topic card" && graph.edges[i].type !== "synoptic") graph.edges.splice(i, 1);
    else graph.edges[i].status = status;
    await this.saveGraph(from.topic, graph);
  }

  /** Prerequisites that live in other topics, for each subskill of this one, with the level held there. */
  async externalPrereqs(dir: string, target: number): Promise<ExternalPrereq[]> {
    const graph = await this.loadGraph(dir);
    const mine = new Map(graph.concepts.filter((c) => !c.retired).map((c) => [c.id, c.n]));
    const outside = graph.edges.filter((e) => e.type === "requires" && e.status !== "rejected" && mine.has(e.from) && !mine.has(e.to));
    if (!outside.length) return [];
    const course = await this.loadCourse();
    const out: ExternalPrereq[] = [];
    const states = new Map<string, LearnerState>();
    const topics = new Map<string, Topic>();
    for (const e of outside) {
      const c = course.concepts.get(e.to);
      if (!c) continue;
      if (!states.has(c.topic)) {
        states.set(c.topic, await this.loadState(c.topic, target));
        topics.set(c.topic, await this.loadTopic(c.topic));
      }
      out.push({ skill: mine.get(e.from)!, id: e.to, name: c.name, topic: c.topicTitle, dir: c.topic, n: c.n, level: states.get(c.topic)!.levels[c.n] ?? null, section: topics.get(c.topic)!.subskills.find((k) => k.n === c.n)?.section ?? "" });
    }
    return out;
  }

  /** What the tutor is told about the focus subskill's prerequisites in other topics. */
  async linkedContext(dir: string, state: LearnerState, known?: ExternalPrereq[]): Promise<string> {
    const links = (known ?? (await this.externalPrereqs(dir, state.target))).filter((l) => l.skill === state.focus);
    return links.map((l) => `External prerequisite [[${l.dir}/topic]]: ${l.name}, level ${l.level ?? "unknown"}.\n${l.section}`).join("\n\n");
  }

  /** Moves cross-topic links from the 0.5.0 learner state into the course graph, once. */
  private async migrateLinks(dir: string, s: LearnerState, graph: TopicGraph): Promise<boolean> {
    const links = s.links ?? [];
    if (!links.length) return false;
    const left: typeof links = [];
    let changed = false;
    for (const link of links) {
      const from = graph.concepts.find((c) => c.n === link.skill && !c.retired);
      let to: string | undefined;
      try {
        if (await this.fs.exists(`${link.topic}/topic.md`)) to = (await this.loadGraph(link.topic)).concepts.find((c) => c.n === link.prerequisite && !c.retired)?.id;
      } catch {
        to = undefined;
      }
      // A link whose other end cannot be found yet is kept for a later attempt, not dropped.
      if (!from || !to) {
        left.push(link);
        continue;
      }
      if (!graph.edges.some((e) => e.from === from.id && e.to === to && e.type === "requires")) {
        graph.edges.push({ from: from.id, to, type: "requires", status: "reviewed", source: "learner" });
        changed = true;
      }
    }
    if (changed) await this.saveGraph(dir, graph);
    const moved = left.length !== links.length;
    s.links = left.length ? left : undefined;
    return moved;
  }

  async loadQuestions(dir: string): Promise<Question[]> {
    const p = `${dir}/questions.md`;
    return (await this.fs.exists(p)) ? parseQuestions(await this.fs.read(p)) : [];
  }

  // ----- learner state: levels in state.md, the evidence behind them in evidence.md -----

  private evidencePath(dir: string): string {
    return `${dir}/evidence.md`;
  }
  /** What was last written to each evidence file, so an unchanged log is not written again. */
  private evidenceWritten = new Map<string, string>();

  async loadState(dir: string, target: number): Promise<LearnerState> {
    const p = `${dir}/state.md`;
    const topic = await this.loadTopic(dir);
    const graph = await this.loadGraph(dir, topic);
    const concepts: Record<number, string> = {};
    for (const c of graph.concepts) if (!c.retired) concepts[c.n] = c.id;
    if (!(await this.fs.exists(p))) {
      const s = newState(topic, target);
      s.concepts = concepts;
      await this.saveState(dir, s);
      return s;
    }
    const s = parseState(await this.fs.read(p));
    const legacy = s.attempts.length > 0;
    let records: Misconception[] = [];
    if (await this.fs.exists(this.evidencePath(dir))) {
      const stored = parseEvidence(await this.fs.read(this.evidencePath(dir)));
      // The evidence file is the record. Attempts still in the old place are added, never doubled.
      const ids = new Set(stored.attempts.map((a) => a.id));
      s.attempts = [...stored.attempts, ...s.attempts.filter((a) => !ids.has(a.id))];
      s.changes = stored.changes;
      records = stored.misconceptions;
    }
    // Misconceptions are records with evidence; the plain list in state.md is derived from them.
    // A description listed there with no record (an older file, or one added by hand) is kept as a legacy suspicion.
    const mis = reconcile(records, s.misconceptions, s.attempts, `${this.today()}T00:00:00.000Z`);
    s.misconceptionRecords = mis.records;
    s.misconceptions = mis.list;
    // Keep the state in step with the topic card if it was edited by hand.
    for (const sk of topic.subskills) {
      if (!(sk.n in s.names)) {
        s.levels[sk.n] = null;
        s.bank[sk.n] = { right: 0, total: 0 };
      }
      s.names[sk.n] = sk.name;
    }
    for (const n of Object.keys(s.names).map(Number)) {
      if (!topic.subskills.some((sk) => sk.n === n)) {
        delete s.names[n];
        delete s.levels[n];
        delete s.bank[n];
      }
    }
    s.topic = topic.title;
    s.concepts = concepts;
    // Attempts made before concepts had ids take the id of the subskill they were recorded on.
    for (const a of s.attempts) if (!a.concept && a.skill in concepts) a.concept = concepts[a.skill];
    const moved = await this.migrateLinks(dir, s, graph);
    if (legacy || moved) await this.saveState(dir, s);
    return s;
  }

  /**
   * Writes the evidence log first and the state second. If the second write is interrupted, the
   * log already holds the attempt, and because attempts are keyed by id, doing the turn again
   * replaces the record instead of adding one.
   */
  async saveState(dir: string, s: LearnerState): Promise<void> {
    const p = this.evidencePath(dir);
    if (s.misconceptionRecords) {
      const mis = reconcile(s.misconceptionRecords, s.misconceptions, s.attempts, `${this.today()}T00:00:00.000Z`);
      s.misconceptionRecords = mis.records;
      s.misconceptions = mis.list;
    }
    if (s.attempts.length || s.changes.length || s.misconceptionRecords?.some((m) => !m.legacy) || this.evidenceWritten.has(p) || (await this.fs.exists(p))) {
      const evidence = serializeEvidence(s.topic, s);
      if (this.evidenceWritten.get(p) !== evidence) {
        await this.writeFile(p, evidence);
        this.evidenceWritten.set(p, evidence);
      }
    }
    await this.writeFile(`${dir}/state.md`, serializeState(s, this.today()));
  }

  /**
   * Writes a compiled topic. With `existingDir` it recompiles in place. The learner's history is
   * read before anything is overwritten and carried over through the course graph's stable
   * concept ids, so levels, attempts, priorities and relations follow a subskill that was
   * renumbered or renamed. Relations from other topics point at ids, so they follow too.
   */
  async saveCompiled(p: { title: string; fm: Frontmatter; topicBody: string; questionsBody: string; target: number; existingDir?: string; keepCards?: string[] }): Promise<string> {
    let dir = p.existingDir;
    if (!dir) {
      const name = safeName(p.title);
      dir = `${this.topicsDir}/${name}`;
      for (let i = 2; await this.fs.exists(dir); i++) dir = `${this.topicsDir}/${name} ${i}`;
    }
    let previous: LearnerState | undefined;
    let oldGraph: TopicGraph | null = null;
    if (await this.fs.exists(`${dir}/state.md`)) previous = await this.loadState(dir, p.target);
    if (await this.fs.exists(this.graphPath(dir))) oldGraph = parseTopicGraph(await this.fs.read(this.graphPath(dir)));
    const topicMd = withFrontmatter({ tutor: "topic", title: p.title, ...p.fm, compiled: this.today() }, p.topicBody + "\n");
    const topic = parseTopic(topicMd);
    const { graph, remap } = syncTopicGraph(base(dir), topic, oldGraph);
    await this.writeFile(`${dir}/topic.md`, topicMd);
    await this.writeFile(`${dir}/questions.md`, withFrontmatter({ tutor: "questions", topic: p.title }, p.questionsBody + "\n"));
    await this.writeFile(this.graphPath(dir), serializeTopicGraph(topic.title, graph));
    const next = newState(topic, p.target, previous, previous && oldGraph ? remap : undefined);
    for (const c of graph.concepts) if (!c.retired) next.concepts[c.n] = c.id;
    // A new question bank starts its card schedule again. A partial refresh keeps the schedule
    // of every question it left untouched. Everything else is kept either way.
    if (previous && p.keepCards) for (const id of p.keepCards) if (previous.cards[id]) next.cards[id] = previous.cards[id];
    await this.saveState(dir, next);
    return dir;
  }

  async readQuestionsRaw(dir: string): Promise<string> {
    const p = `${dir}/questions.md`;
    return (await this.fs.exists(p)) ? await this.fs.read(p) : "";
  }

  // ----- chats: one markdown file per part; only the active part is ever loaded -----

  async listChats(dir: string): Promise<string[]> {
    const d = `${dir}/chats`;
    if (!(await this.fs.exists(d))) return [];
    // Oldest first, and part 2 after part 1. A plain sort would put "x p2.md" before "x.md".
    const key = (f: string): [string, number] => {
      const m = /^(.*?)(?: p(\d+))?\.md$/.exec(f);
      return m ? [m[1], Number(m[2] ?? 1)] : [f, 1];
    };
    return (await this.fs.list(d)).files
      .filter((f) => f.endsWith(".md"))
      .sort((a, b) => {
        const [sa, pa] = key(a);
        const [sb, pb] = key(b);
        return sa === sb ? pa - pb : sa < sb ? -1 : 1;
      });
  }

  async loadChat(path: string): Promise<Chat> {
    return parseChat(await this.fs.read(path));
  }

  async saveChat(path: string, chat: Chat): Promise<void> {
    await this.writeFile(path, serializeChat(chat));
    if (!chat.fm.session) return;
    // The session record is mirrored as a readable note. The chat file stays the source of truth.
    try {
      const record = JSON.parse(String(chat.fm.session)) as SessionRecord;
      await this.writeFile(path.replace("/chats/", "/sessions/"), sessionMarkdown(record, path));
    } catch {
      /* a record that cannot be read is simply not mirrored */
    }
  }

  async newChat(dir: string, topicTitle: string, mode: Mode, now: Date = new Date()): Promise<string> {
    const p = (n: number) => String(n).padStart(2, "0");
    const stamp = `${ymd(now)} ${p(now.getHours())}${p(now.getMinutes())}`;
    let path = `${dir}/chats/${stamp} ${mode}.md`;
    for (let i = 2; await this.fs.exists(path); i++) path = `${dir}/chats/${stamp} ${mode} (${i}).md`;
    await this.saveChat(path, { fm: { tutor: "chat", topic: topicTitle, mode, part: 1, previous: "", next: "", created: ymd(now) }, summary: "", messages: [] });
    return path;
  }

  /** Starts the next part of a chat: the summary replaces the old transcript and the last exchange is carried over. */
  async rotateChat(path: string, chat: Chat, summary: string): Promise<string> {
    const part = fmNum(chat.fm, "part", 1) + 1;
    const stem = path.replace(/\.md$/, "").replace(/ p\d+$/, "");
    const next = `${stem} p${part}.md`;
    const link = (p: string) => `[[${p.replace(/\.md$/, "")}|${base(p).replace(/\.md$/, "")}]]`;
    const carried = chat.messages.slice(-2);
    await this.saveChat(next, { fm: { ...chat.fm, part, previous: link(path), next: "", created: fmStr(chat.fm, "created") || this.today() }, summary, messages: carried });
    await this.saveChat(path, { ...chat, fm: { ...chat.fm, next: link(next) } });
    return next;
  }

  /** Moves a file to the trash: the system trash where possible, otherwise the vault's .trash folder. */
  private async trash(path: string): Promise<void> {
    if (this.fs.trashSystem && (await this.fs.trashSystem(path).catch(() => false))) return;
    if (this.fs.trashLocal) return this.fs.trashLocal(path);
    if (this.fs.remove) return this.fs.remove(path);
    throw new Error("This vault cannot delete files from the plugin.");
  }

  /**
   * Deletes a chat session: every part of it (followed through the previous and next links) and
   * the readable session note of each part, to the trash. Learner evidence, levels and saved
   * activities live elsewhere and are kept. Returns the chat files removed.
   */
  async deleteChat(path: string): Promise<string[]> {
    const linked = (chat: Chat, key: "previous" | "next"): string => {
      const m = /^\[\[([^\]|]+)/.exec(fmStr(chat.fm, key));
      return m ? `${m[1]}.md` : "";
    };
    const parts: string[] = [];
    const queue = [path];
    while (queue.length && parts.length < 50) {
      const p = queue.shift()!;
      if (parts.includes(p) || !(await this.fs.exists(p))) continue;
      parts.push(p);
      try {
        const chat = await this.loadChat(p);
        for (const next of [linked(chat, "previous"), linked(chat, "next")]) if (next && !parts.includes(next)) queue.push(next);
      } catch {
        /* an unreadable part is still deleted; its links are simply not followed */
      }
    }
    for (const p of parts) {
      await this.trash(p);
      const note = p.replace("/chats/", "/sessions/");
      if (note !== p && (await this.fs.exists(note))) await this.trash(note);
    }
    return parts;
  }

  /** The earlier parts of a chat, oldest first, followed back through each part's `previous` link. */
  async earlierParts(path: string): Promise<Chat[]> {
    const out: Chat[] = [];
    const seen = new Set<string>([path]);
    let chat: Chat;
    try {
      chat = await this.loadChat(path);
    } catch {
      return out;
    }
    for (let i = 0; i < 12; i++) {
      const m = /^\[\[([^\]|]+)/.exec(fmStr(chat.fm, "previous"));
      const prev = m ? `${m[1]}.md` : "";
      if (!prev || seen.has(prev) || !(await this.fs.exists(prev))) break;
      seen.add(prev);
      try {
        chat = await this.loadChat(prev);
      } catch {
        break;
      }
      out.unshift(chat);
    }
    return out;
  }

  /** The most recent chats across every topic, newest first. Only the last few files of each topic are read. */
  async recentChats(limit = 8): Promise<ChatRef[]> {
    const out: ChatRef[] = [];
    const flat = (t: string) => t.replace(/```[\s\S]*?(```|$)/g, " [code] ").replace(/[#*_>]+/g, "").replace(/\s+/g, " ").trim();
    for (const ref of await this.listTopics()) {
      let files: string[] = [];
      try {
        files = (await this.listChats(ref.dir)).slice(-(limit + 4));
      } catch {
        continue;
      }
      for (const path of files) {
        try {
          const chat = await this.loadChat(path);
          // A part that has been continued elsewhere is history; its last part is the session.
          if (fmStr(chat.fm, "next") || (!chat.messages.length && !chat.summary)) continue;
          const last = chat.messages[chat.messages.length - 1];
          let record: Partial<SessionRecord> = {};
          try {
            record = JSON.parse(fmStr(chat.fm, "session", "{}")) ?? {};
          } catch {
            record = {};
          }
          const pending = typeof record.pendingQuestion === "string" ? record.pendingQuestion : "";
          const m = /(\d{4}-\d{2}-\d{2} \d{4})/.exec(base(path));
          out.push({
            path,
            dir: ref.dir,
            topic: ref.title,
            mode: (fmStr(chat.fm, "mode", "tutor") as Mode) || "tutor",
            stamp: m ? m[1] : fmStr(chat.fm, "created"),
            part: fmNum(chat.fm, "part", 1),
            messages: chat.messages.length,
            unfinished: !!pending || !!fmStr(chat.fm, "card") || fmStr(chat.fm, "placement") === "on" || last?.role === "you" || (record.completedStep !== true && last?.role === "tutor" && /\?\s*$/.test(last.text.trim())),
            snippet: flat(pending || last?.text || chat.summary).slice(0, 180),
            action: typeof record.action === "string" ? record.action : "",
          });
        } catch {
          /* an unreadable chat is skipped */
        }
      }
    }
    return out.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : b.part - a.part)).slice(0, limit);
  }

  async saveSummary(dir: string, title: string, body: string): Promise<string> {
    const p = `${dir}/summary.md`;
    await this.writeFile(p, withFrontmatter({ tutor: "summary", topic: title, written: this.today() }, body + "\n"));
    return p;
  }

  // ----- the decision log: what the policy saw and chose, for comparing policy versions -----

  private get decisionsPath(): string {
    return `${this.root}/_logs/decisions.md`;
  }

  async logDecision(c: PolicyCase): Promise<void> {
    try {
      const p = this.decisionsPath;
      const old = (await this.fs.exists(p)) ? (await this.fs.read(p)).split(/\r?\n/).filter((l) => l.startsWith("{")) : [];
      const lines = [...old, JSON.stringify(c)].slice(-300);
      await this.writeFile(p, `Decisions the study policy made, one per line, newest last. Used to compare policy versions.\n\n${FENCE}jsonl\n${lines.join("\n")}\n${FENCE}\n`);
    } catch {
      /* logging must never break a turn */
    }
  }

  async loadDecisions(): Promise<PolicyCase[]> {
    const p = this.decisionsPath;
    if (!(await this.fs.exists(p))) return [];
    const out: PolicyCase[] = [];
    for (const line of (await this.fs.read(p)).split(/\r?\n/)) {
      if (!line.startsWith("{")) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip a damaged line */
      }
    }
    return out;
  }

  // ----- activities: saved configurations, and the learner's interactions with them -----

  activitiesPath(dir: string): string {
    return `${dir}/activities.md`;
  }

  /** Saved activity configurations and failures for a topic. Learner work is not in here. */
  async loadActivities(dir: string): Promise<ActivityRecord[]> {
    const p = this.activitiesPath(dir);
    if (!(await this.fs.exists(p))) return [];
    return jsonl(await this.fs.read(p)).filter((r) => typeof r.id === "string" && r.v === 1) as unknown as ActivityRecord[];
  }

  /** Adds or replaces one record by id. Transient failures are never saved. */
  async saveActivity(dir: string, rec: ActivityRecord): Promise<void> {
    if (rec.transient) return;
    const all = (await this.loadActivities(dir)).filter((r) => r.id !== rec.id);
    all.push(rec);
    const head = "Interactive activities configured for this topic, one per line. Each is bounded settings for an existing module, with its sources, versions and how it was made. Your answers in them are in activity-log.md and, when assessed, evidence.md.";
    await this.writeFile(this.activitiesPath(dir), withFrontmatter({ tutor: "activities", count: all.length }, `${head}\n\n${FENCE}jsonl\n${all.map((r) => JSON.stringify(r)).join("\n")}\n${FENCE}\n`));
  }

  // ----- requests to the compiler for linked material, and what came back -----

  expansionsPath(dir: string): string {
    return `${dir}/expansions.md`;
  }

  /** Requests for prerequisite or extension material made while studying this topic. They are never evidence. */
  async loadExpansions(dir: string): Promise<ExpansionRecord[]> {
    const p = this.expansionsPath(dir);
    if (!(await this.fs.exists(p))) return [];
    return jsonl(await this.fs.read(p)).flatMap((r) => {
      const x = parseExpansion(r);
      return x ? [x] : [];
    });
  }

  /** Adds or replaces one record by request id. */
  async saveExpansion(dir: string, rec: ExpansionRecord): Promise<void> {
    const all = (await this.loadExpansions(dir)).filter((r) => r.request.id !== rec.request.id);
    all.push(rec);
    const head = "Requests for linked material (a missing prerequisite, or going further than the course), one per line, with what the compiler returned. These are study material only: they change no level.";
    await this.writeFile(this.expansionsPath(dir), withFrontmatter({ tutor: "expansions", count: all.length }, `${head}\n\n${FENCE}jsonl\n${all.slice(-100).map((r) => JSON.stringify(r)).join("\n")}\n${FENCE}\n`));
  }

  async logActivity(dir: string, ev: ActivityEvent): Promise<void> {
    try {
      const p = `${dir}/activity-log.md`;
      const old = (await this.fs.exists(p)) ? (await this.fs.read(p)).split(/\r?\n/).filter((l) => l.startsWith("{")) : [];
      const lines = [...old, JSON.stringify(ev)].slice(-1000);
      await this.writeFile(p, withFrontmatter({ tutor: "activity-log" }, `What happened with interactive activities on this topic, newest last: why each was chosen, whether it was opened, and any assessed answer.\n\n${FENCE}jsonl\n${lines.join("\n")}\n${FENCE}\n`));
    } catch {
      /* logging must never break a turn */
    }
  }

  async loadActivityLog(dir: string): Promise<ActivityEvent[]> {
    const p = `${dir}/activity-log.md`;
    if (!(await this.fs.exists(p))) return [];
    return jsonl(await this.fs.read(p)) as unknown as ActivityEvent[];
  }

  private get capabilitiesPath(): string {
    return `${this.root}/_logs/capability-requests.md`;
  }

  /** Records a missing capability once per concept and operation, counting repeats. */
  async logCapability(req: Omit<CapabilityRequest, "count">): Promise<void> {
    try {
      const p = this.capabilitiesPath;
      const all = (await this.fs.exists(p)) ? (jsonl(await this.fs.read(p)) as unknown as CapabilityRequest[]) : [];
      const same = all.find((r) => r.conceptId === req.conceptId && r.kind === req.kind && r.operation.toLowerCase() === req.operation.toLowerCase());
      if (same) {
        same.count += 1;
        same.t = req.t;
      } else all.push({ ...req, count: 1 });
      await this.writeFile(p, `Capabilities learners asked for that no visual module has yet, for a development pass. Ordinary study never builds them.\n\n${FENCE}jsonl\n${all.slice(-500).map((r) => JSON.stringify(r)).join("\n")}\n${FENCE}\n`);
    } catch {
      /* logging must never break a turn */
    }
  }

  async loadCapabilities(): Promise<CapabilityRequest[]> {
    const p = this.capabilitiesPath;
    return (await this.fs.exists(p)) ? (jsonl(await this.fs.read(p)) as unknown as CapabilityRequest[]) : [];
  }

  // ----- the course package: the versioned, reusable form of a compiled topic -----

  packagePath(dir: string): string {
    return `${dir}/package.md`;
  }

  async loadPackage(dir: string): Promise<CoursePackage | null> {
    const p = this.packagePath(dir);
    if (!(await this.fs.exists(p))) return null;
    const m = /```json\s*\n([\s\S]*?)\n```/.exec(await this.fs.read(p));
    if (!m) return null;
    try {
      const v = JSON.parse(m[1]);
      return v && v.format === "study-tutor-course" ? (v as CoursePackage) : null;
    } catch {
      return null;
    }
  }

  async savePackage(dir: string, pkg: CoursePackage): Promise<void> {
    const missing = pkg.coverage.missing.length ? `\n\nNot yet covered: ${pkg.coverage.missing.join(", ")}.` : "";
    const head = `The course package for this topic, revision ${pkg.revision}: objectives and what covers them, worked lessons, question families, rubrics, sources and optional visual eligibility. Study Tutor writes it when the topic is compiled or refreshed.${missing}`;
    await this.writeFile(this.packagePath(dir), withFrontmatter({ tutor: "package", topic: pkg.topic, revision: pkg.revision, complete: pkg.coverage.complete ? "yes" : "no" }, `${head}\n\n${FENCE}json\n${JSON.stringify(pkg, null, 1)}\n${FENCE}\n`));
  }

  /** Writes a note under the tutor folder and returns its path. */
  async writeNote(rel: string, text: string): Promise<string> {
    const p = `${this.root}/${rel}`;
    await this.writeFile(p, text);
    return p;
  }

  // ----- extras that other plugins can read -----

  /** A Bases view over every topic's state file (Bases is a core plugin; the file is harmless without it). */
  async writeDashboard(): Promise<void> {
    const p = `${this.root}/Dashboard.base`;
    if (await this.fs.exists(p)) return;
    const yaml = ["filters:", "  and:", `    - 'tutor == "state"'`, "properties:", "  note.topic:", "    displayName: Topic", "  note.progress:", "    displayName: Progress %", "  note.due:", "    displayName: Cards due at last study", "  note.updated:", "    displayName: Last studied", "views:", "  - type: table", "    name: Topics", "    order:", "      - topic", "      - progress", "      - due", "      - updated", ""];
    await this.writeFile(p, yaml.join("\n"));
  }

  flashcardPath(dir: string): string {
    return `${dir}/flashcards.md`;
  }

  /**
   * Writes the question bank as a flashcard note for the Spaced Repetition community plugin.
   * Safe to call again at any time: schedules that plugin has written into the note are kept,
   * and the file is only rewritten when its content would change.
   */
  async exportFlashcards(dir: string): Promise<string> {
    const topic = await this.loadTopic(dir);
    const qs = await this.loadQuestions(dir);
    const tag = topic.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "topic";
    const p = this.flashcardPath(dir);
    const existing = (await this.fs.exists(p)) ? await this.fs.read(p) : "";
    const next = buildSrNote(qs, tag, existing);
    if (next !== existing.replace(/\r\n/g, "\n")) await this.writeFile(p, next);
    return p;
  }

  /** Due and new counts read from the schedule the Spaced Repetition plugin keeps in the flashcard note. */
  async flashcardStats(dir: string): Promise<SrStats | null> {
    const p = this.flashcardPath(dir);
    if (!(await this.fs.exists(p))) return null;
    return srStats(await this.fs.read(p), this.today());
  }
}
