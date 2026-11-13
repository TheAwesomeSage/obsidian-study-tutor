// All vault reads and writes go through this class. It depends only on a small file-system
// interface (Obsidian's DataAdapter satisfies it), so it can be tested outside Obsidian.

import { BUNDLED } from "./prompts";
import { SrStats, buildSrNote, srStats } from "./formats";
import { Chat, Frontmatter, LearnerState, Mode, Question, Topic, fmNum, fmStr, newState, parseChat, parseQuestions, parseState, parseTopic, serializeChat, serializeState, textHash, withFrontmatter, ymd } from "./formats";

export interface FS {
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
}

export interface TopicRef {
  dir: string;
  title: string;
}

/** Fingerprints of the skill files shipped in 0.1.0 that later changed, from before fingerprints were recorded. */
const FIRST_RELEASE: Record<string, string> = { "core.md": "c8e78aa5", "mode-tutor.md": "bd93508", "mode-quiz.md": "29a50213", "compile.md": "4c586797" };

const base = (p: string): string => p.split("/").pop() ?? p;
const safeName = (s: string): string => s.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Topic";

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

  async addPrerequisite(dir: string, state: LearnerState, link: { skill: number; topic: string; prerequisite: number }): Promise<void> {
    const topics = await this.listTopics();
    const edges = new Map<string, string[]>();
    const key = (topic: string, skill: number) => `${topic}#${skill}`;
    for (const ref of topics) {
      const topic = await this.loadTopic(ref.dir);
      const saved = ref.dir === dir ? state : await this.loadState(ref.dir, state.target);
      for (const sub of topic.subskills) edges.set(key(ref.dir, sub.n), sub.prerequisites.map(n => key(ref.dir, n)));
      for (const edge of saved.links ?? []) {
        const source = key(ref.dir, edge.skill);
        edges.set(source, [...(edges.get(source) ?? []), key(edge.topic, edge.prerequisite)]);
      }
    }
    const source = key(dir, link.skill);
    const destination = key(link.topic, link.prerequisite);
    if (!edges.has(source) || !edges.has(destination)) throw new Error("Choose an existing topic and skill.");
    const visited = new Set<string>();
    const reaches = (node: string): boolean => {
      if (node === source) return true;
      if (visited.has(node)) return false;
      visited.add(node);
      return (edges.get(node) ?? []).some(reaches);
    };
    if (reaches(destination)) throw new Error("This prerequisite would create a circular dependency.");
    state.links = [...(state.links ?? []), link];
    await this.saveState(dir, state);
  }

  async linkedContext(state: LearnerState): Promise<string> {
    const topics = await this.listTopics();
    const sections: string[] = [];
    for (const link of state.links ?? []) {
      if (link.skill !== state.focus) continue;
      const ref = topics.find(t => t.dir === link.topic);
      if (!ref) continue;
      const topic = await this.loadTopic(ref.dir);
      const prerequisite = topic.subskills.find(s => s.n === link.prerequisite);
      if (!prerequisite) continue;
      const other = await this.loadState(ref.dir, state.target);
      sections.push(`External prerequisite [[${ref.dir}/topic]]: ${prerequisite.name}, level ${other.levels[prerequisite.n] ?? "unknown"}.\n${prerequisite.section}`);
    }
    return sections.join("\n\n");
  }

  async loadQuestions(dir: string): Promise<Question[]> {
    const p = `${dir}/questions.md`;
    return (await this.fs.exists(p)) ? parseQuestions(await this.fs.read(p)) : [];
  }

  async loadState(dir: string, target: number): Promise<LearnerState> {
    const p = `${dir}/state.md`;
    const topic = await this.loadTopic(dir);
    if (await this.fs.exists(p)) {
      const s = parseState(await this.fs.read(p));
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
      return s;
    }
    const s = newState(topic, target);
    await this.saveState(dir, s);
    return s;
  }

  async saveState(dir: string, s: LearnerState): Promise<void> {
    await this.writeFile(`${dir}/state.md`, serializeState(s, this.today()));
  }

  /** Writes a compiled topic. With `existingDir` it recompiles in place and keeps levels where subskill names match. */
  async saveCompiled(p: { title: string; fm: Frontmatter; topicBody: string; questionsBody: string; target: number; existingDir?: string }): Promise<string> {
    let dir = p.existingDir;
    if (!dir) {
      const name = safeName(p.title);
      dir = `${this.topicsDir}/${name}`;
      for (let i = 2; await this.fs.exists(dir); i++) dir = `${this.topicsDir}/${name} ${i}`;
    }
    let previous: LearnerState | undefined;
    if (await this.fs.exists(`${dir}/state.md`)) previous = parseState(await this.fs.read(`${dir}/state.md`));
    const topicMd = withFrontmatter({ tutor: "topic", title: p.title, ...p.fm, compiled: this.today() }, p.topicBody + "\n");
    await this.writeFile(`${dir}/topic.md`, topicMd);
    await this.writeFile(`${dir}/questions.md`, withFrontmatter({ tutor: "questions", topic: p.title }, p.questionsBody + "\n"));
    await this.saveState(dir, newState(parseTopic(topicMd), p.target, previous));
    return dir;
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
    if (chat.fm.session) {
      const memoryPath = path.replace("/chats/", "/sessions/");
      await this.writeFile(memoryPath, `# Study session\n\nChat: [[${path.replace(/\.md$/, "")}]]\n\n` + String(chat.fm.session) + "\n");
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

  async saveSummary(dir: string, title: string, body: string): Promise<string> {
    const p = `${dir}/summary.md`;
    await this.writeFile(p, withFrontmatter({ tutor: "summary", topic: title, written: this.today() }, body + "\n"));
    return p;
  }

  // ----- extras that other plugins can read -----

  /** A Bases view over every topic's state file (Bases is a core plugin; the file is harmless without it). */
  async writeDashboard(): Promise<void> {
    const p = `${this.root}/Dashboard.base`;
    if (await this.fs.exists(p)) return;
    const yaml = ["filters:", "  and:", `    - 'tutor == "state"'`, "properties:", "  note.topic:", "    displayName: Topic", "  note.progress:", "    displayName: Progress %", "  note.due:", "    displayName: Cards due at last study","  note.updated:", "    displayName: Last studied", "views:", "  - type: table", "    name: Topics", "    order:", "      - topic", "      - progress", "      - due", "      - updated", ""];
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
