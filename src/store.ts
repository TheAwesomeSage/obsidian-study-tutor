// All vault reads and writes go through this class. It depends only on a small file-system
// interface (Obsidian's DataAdapter satisfies it), so it can be tested outside Obsidian.

import { BUNDLED } from "./prompts";
import { Chat, Frontmatter, LearnerState, Mode, Question, Topic, answerText, fmNum, fmStr, newState, parseChat, parseQuestions, parseState, parseTopic, serializeChat, serializeState, withFrontmatter, ymd } from "./formats";

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

  async installSkills(): Promise<number> {
    let written = 0;
    for (const [rel, text] of Object.entries(BUNDLED)) {
      const p = `${this.skillsDir}/${rel}`;
      if (await this.fs.exists(p)) continue;
      await this.writeFile(p, text);
      written++;
    }
    return written;
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

  // ----- extras that other plugins can read -----

  /** A Bases view over every topic's state file (Bases is a core plugin; the file is harmless without it). */
  async writeDashboard(): Promise<void> {
    const p = `${this.root}/Dashboard.base`;
    if (await this.fs.exists(p)) return;
    const yaml = ["filters:", "  and:", `    - 'tutor == "state"'`, "properties:", "  note.topic:", "    displayName: Topic", "  note.progress:", "    displayName: Progress %", "  note.due:", "    displayName: Cards due at last study","  note.updated:", "    displayName: Last studied", "views:", "  - type: table", "    name: Topics", "    order:", "      - topic", "      - progress", "      - due", "      - updated", ""];
    await this.writeFile(p, yaml.join("\n"));
  }

  /** Writes the question bank as flashcards in the format the Spaced Repetition community plugin reads. */
  async exportFlashcards(dir: string): Promise<string> {
    const topic = await this.loadTopic(dir);
    const qs = await this.loadQuestions(dir);
    const tag = topic.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "topic";
    const flat = (s: string) => s.replace(/\n\s*\n/g, "\n").trim();
    const cards = qs.map((q) => {
      const front = flat(q.question) + (q.options.length ? "\n" + q.options.map((o) => `- ${o}`).join("\n") : "");
      const back = flat(answerText(q)) + (q.explanation ? "\n" + flat(q.explanation) : "");
      return `${front}\n?\n${back}`;
    });
    const p = `${dir}/flashcards.md`;
    await this.writeFile(p, `#flashcards/${tag}\n\n${cards.join("\n\n")}\n`);
    return p;
  }
}
