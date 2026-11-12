// Parsing and serialising of the plugin's markdown files. Pure functions, no Obsidian imports.

export type Mode = "tutor" | "teach" | "quiz" | "expert";
export const MODES: Mode[] = ["tutor", "teach", "quiz", "expert"];
export type SourceMode = "notes" | "spec" | "subject";
export type FmValue = string | number | string[];
export type Frontmatter = Record<string, FmValue>;

export const words = (s: string): number => (s.trim() ? s.trim().split(/\s+/).length : 0);

/** A short fingerprint of a text (FNV-1a), used to tell an unedited skill file from an edited one. */
export function textHash(s: string): string {
  s = s.split("\r\n").join("\n");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export function ymd(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return ymd(new Date(y, m - 1, d + n));
}

// ---------- frontmatter (a small YAML subset: scalars and string lists) ----------

function scalar(v: string): string | number {
  v = v.trim();
  if (v.startsWith('"')) {
    try {
      return String(JSON.parse(v));
    } catch {
      return v.replace(/^"|"$/g, "");
    }
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length > 1) return v.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

export function splitFrontmatter(md: string): { fm: Frontmatter; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(md);
  if (!m) return { fm: {}, body: md };
  const fm: Frontmatter = {};
  let listKey: string | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    // Obsidian's property editor may rewrite lists with or without indentation.
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (fm[listKey] as string[]).push(String(scalar(item[1])));
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, raw] = kv;
    if (raw === "" || raw === "[]") {
      fm[key] = [];
      listKey = key;
    } else {
      fm[key] = scalar(raw);
      listKey = null;
    }
  }
  return { fm, body: md.slice(m[0].length) };
}

export function withFrontmatter(fm: Frontmatter, body: string): string {
  const out: string[] = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) {
      if (!v.length) out.push(`${k}: []`);
      else out.push(`${k}:`, ...v.map((x) => `  - ${JSON.stringify(x)}`));
    } else if (typeof v === "number") out.push(`${k}: ${v}`);
    else if (/^[A-Za-z][\w-]*$/.test(v) || /^\d{4}-\d{2}-\d{2}$/.test(v)) out.push(`${k}: ${v}`);
    else out.push(`${k}: ${JSON.stringify(v)}`);
  }
  out.push("---", "");
  return out.join("\n") + body.replace(/^\s+/, "");
}

export const fmStr = (fm: Frontmatter, k: string, d = ""): string => {
  const v = fm[k];
  return v === undefined || Array.isArray(v) ? d : String(v);
};
export const fmNum = (fm: Frontmatter, k: string, d: number): number => {
  const n = Number(fm[k]);
  return fm[k] === undefined || Array.isArray(fm[k]) || Number.isNaN(n) ? d : n;
};
export const fmList = (fm: Frontmatter, k: string): string[] => (Array.isArray(fm[k]) ? (fm[k] as string[]) : []);

function section(body: string, heading: string): string {
  const re = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "mi");
  const m = re.exec(body);
  if (!m) return "";
  const rest = body.slice(m.index + m[0].length);
  const next = /^##\s+\S/m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

function tableRows(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith("|") || /^\|\s*:?-{2,}/.test(line.trim())) continue;
    rows.push(line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
  }
  return rows.slice(1); // drop the header row
}

// ---------- topic card ----------

export interface Subskill {
  n: number;
  name: string;
  prerequisites: number[];
  section: string;
}
export interface Topic {
  title: string;
  fm: Frontmatter;
  overview: string;
  subskills: Subskill[];
  body: string;
}

export function parseTopic(md: string): Topic {
  const { fm, body } = splitFrontmatter(md);
  const h1 = /^#\s+(.+)$/m.exec(body);
  const subskills: Subskill[] = [];
  const re = /^###\s+(\d+)\s*[.):-]?\s+(.+)$/gm;
  const heads: { n: number; name: string; start: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) heads.push({ n: Number(m[1]), name: m[2].trim(), start: m.index });
  heads.forEach((h, i) => {
    let end = i + 1 < heads.length ? heads[i + 1].start : body.length;
    const cut = /^##\s+\S/m.exec(body.slice(h.start + 4, end));
    if (cut) end = h.start + 4 + cut.index;
    const sec = body.slice(h.start, end).trim();
    const pre = /^prerequisites:\s*(.*)$/im.exec(sec);
    subskills.push({
      n: h.n,
      name: h.name,
      prerequisites: pre ? (pre[1].match(/\d+/g) ?? []).map(Number) : [],
      section: sec,
    });
  });
  return { title: fmStr(fm, "title") || (h1 ? h1[1].trim() : "Untitled"), fm, overview: section(body, "Overview"), subskills, body: body.trim() };
}

export interface CompileOutput {
  topicBody: string;
  subject: string;
  questionsBody: string;
}

export function parseCompileOutput(raw: string): CompileOutput {
  let text = raw.trim();
  const fenced = /^```[a-z]*\r?\n([\s\S]*?)\r?\n```$/.exec(text);
  if (fenced) text = fenced[1];
  const split = /^=+\s*QUESTIONS\s*=+\s*$/m.exec(text);
  let topicBody = (split ? text.slice(0, split.index) : text).trim();
  const questionsBody = split ? text.slice(split.index + split[0].length).trim() : "";
  let subject = "none";
  const sub = /^subject:\s*(.*)$/im.exec(topicBody.slice(0, 400));
  if (sub) {
    subject = sub[1].trim().toLowerCase() || "none";
    topicBody = topicBody.replace(sub[0], "").replace(/\n{3,}/g, "\n\n");
  }
  const h1 = topicBody.search(/^#\s+/m);
  if (h1 > 0) topicBody = topicBody.slice(h1);
  return { topicBody, subject, questionsBody };
}

// ---------- question bank ----------

export type QType = "mcq" | "short" | "open";
export interface Question {
  id: string;
  subskill: number;
  type: QType;
  question: string;
  options: string[];
  answer: string;
  explanation: string;
}

const Q_KEYS = ["subskill", "type", "question", "options", "answer", "explanation"] as const;

const OPTION_LABEL = /^\(?[A-Za-z][.):]\s+/;

/**
 * Makes multiple-choice questions uniform: options become "A. text", "B. text", and the answer
 * becomes a single letter. Handles options written without letters and answers given as the
 * option's text. Returns null when the answer cannot be matched to an option.
 */
function normaliseMcq(options: string[], answer: string): { options: string[]; answer: string } | null {
  const lettered = options.every((o) => OPTION_LABEL.test(o));
  const texts = options.map((o) => (lettered ? o.replace(OPTION_LABEL, "") : o).trim());
  const letter = (i: number) => String.fromCharCode(65 + i);
  const a = answer.trim();
  let idx = -1;
  const m = /^\(?([A-Za-z])\)?(?:[.):]\s|[.):]?$)/.exec(a);
  if (m) {
    const want = m[1].toUpperCase();
    idx = lettered ? options.findIndex((o) => o.replace(/^\(/, "")[0].toUpperCase() === want) : want.charCodeAt(0) - 65;
  }
  if (idx < 0 || idx >= options.length) {
    const norm = (s: string) => s.toLowerCase().replace(/[\s$]+/g, "").replace(/[.;,]+$/, "");
    idx = texts.findIndex((t) => norm(t) !== "" && norm(t) === norm(a));
  }
  if (idx < 0 || idx >= options.length) return null;
  return { options: texts.map((t, i) => `${letter(i)}. ${t}`), answer: letter(idx) };
}

export function parseQuestions(md: string): Question[] {
  const { body } = splitFrontmatter(md);
  const parts = body.split(/^#{2,4}\s+\**(Q\d+)\**[.:]?[ \t]*$/m);
  const out: Question[] = [];
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const f: Record<string, string[]> = {};
    let key: string | null = null;
    for (const line of parts[i + 1].split(/\r?\n/)) {
      // Tolerates "**answer:** B" and "- answer: B" as well as the plain "answer: B".
      const kv = /^\s*(?:[-*]\s+)?\**([A-Za-z]+)\**\s*:\**\s?(.*)$/.exec(line);
      const name = kv ? kv[1].toLowerCase() : "";
      if (kv && (Q_KEYS as readonly string[]).includes(name)) {
        key = name;
        f[key] = kv[2] ? [kv[2]] : [];
      } else if (key) f[key].push(line);
    }
    const get = (k: string) => (f[k] ?? []).join("\n").trim();
    let question = get("question");
    let answer = get("answer");
    if (!question || !answer) continue;
    let options = (f["options"] ?? []).map((l) => l.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean);
    let type = get("type").toLowerCase() as QType;
    if (!["mcq", "short", "open"].includes(type)) type = options.length ? "mcq" : "open";
    if (type === "mcq") {
      const n = options.length >= 2 ? normaliseMcq(options, answer) : null;
      if (n) ({ options, answer } = n);
      else {
        // Unusable as multiple choice: keep it as a self-graded question with the choices in view.
        type = "open";
        if (options.length) question += "\n\n" + options.map((o) => `- ${o}`).join("\n");
        options = [];
      }
    } else options = [];
    out.push({ id: parts[i], subskill: Number(get("subskill")) || 0, type, question, options, answer, explanation: get("explanation") });
  }
  return out;
}

/** The answer as shown to the learner: for multiple choice, the whole option and not just its letter. */
export function answerText(q: Question): string {
  if (q.type !== "mcq") return q.answer;
  return q.options.find((o) => mcqLetter(o) === mcqLetter(q.answer)) ?? q.answer;
}

/** Normalised comparison for typed short answers: case, spacing and surrounding $ are ignored. */
export function sameShortAnswer(given: string, expected: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\$/g, "").replace(/\s+/g, "").replace(/[.;,]+$/, "");
  return norm(given) !== "" && norm(given) === norm(expected);
}

export const mcqLetter = (s: string): string => (/[A-Za-z]/.exec(s)?.[0] ?? "").toUpperCase();

// ---------- learner state ----------

export interface CardSched {
  due: string;
  interval: number;
  ease: number;
  reps: number;
  lapses: number;
}
export interface LearnerState {
  topic: string;
  target: number;
  focus: number | null;
  names: Record<number, string>;
  levels: Record<number, number | null>;
  bank: Record<number, { right: number; total: number }>;
  misconceptions: string[];
  cards: Record<string, CardSched>;
  newDate: string;
  newCount: number;
}

export function newState(topic: Topic, target: number, previous?: LearnerState): LearnerState {
  const s: LearnerState = { topic: topic.title, target, focus: null, names: {}, levels: {}, bank: {}, misconceptions: [], cards: {}, newDate: "", newCount: 0 };
  const oldByName = new Map<string, number | null>();
  if (previous) for (const [n, name] of Object.entries(previous.names)) oldByName.set(name.toLowerCase(), previous.levels[Number(n)] ?? null);
  for (const sk of topic.subskills) {
    s.names[sk.n] = sk.name;
    s.levels[sk.n] = oldByName.get(sk.name.toLowerCase()) ?? null;
    s.bank[sk.n] = { right: 0, total: 0 };
  }
  if (previous) {
    s.target = previous.target;
    s.misconceptions = [...previous.misconceptions];
  }
  return s;
}

export function progress(s: LearnerState): number {
  const ns = Object.keys(s.names);
  if (!ns.length || s.target <= 0) return 0;
  const sum = ns.reduce((a, n) => a + Math.min(s.levels[Number(n)] ?? 0, s.target), 0);
  return Math.round((100 * sum) / (ns.length * s.target));
}

export const dueCount = (s: LearnerState, today: string): number => Object.values(s.cards).filter((c) => c.due <= today).length;

export function serializeState(s: LearnerState, today: string): string {
  const fm: Frontmatter = {
    tutor: "state",
    topic: s.topic,
    progress: progress(s),
    due: dueCount(s, today),
    target: s.target,
    focus: s.focus ?? 0,
    new_date: s.newDate || today,
    new_count: s.newCount,
    updated: today,
  };
  const cell = (t: string) => t.replace(/\|/g, "/");
  const lines = ["## Skill map", "", "| # | Subskill | Level | Bank |", "| --- | --- | --- | --- |"];
  for (const n of Object.keys(s.names).map(Number).sort((a, b) => a - b)) {
    const b = s.bank[n] ?? { right: 0, total: 0 };
    lines.push(`| ${n} | ${cell(s.names[n])} | ${s.levels[n] ?? "-"} | ${b.right}/${b.total} |`);
  }
  lines.push("", "## Misconceptions", "", ...(s.misconceptions.length ? s.misconceptions.map((m) => `- ${m}`) : ["None recorded."]));
  lines.push("", "## Review schedule", "", "| Card | Due | Interval | Ease | Reps | Lapses |", "| --- | --- | --- | --- | --- | --- |");
  for (const [id, c] of Object.entries(s.cards)) lines.push(`| ${id} | ${c.due} | ${c.interval} | ${c.ease} | ${c.reps} | ${c.lapses} |`);
  return withFrontmatter(fm, lines.join("\n") + "\n");
}

export function parseState(md: string): LearnerState {
  const { fm, body } = splitFrontmatter(md);
  const s: LearnerState = {
    topic: fmStr(fm, "topic"),
    target: fmNum(fm, "target", 4),
    focus: fmNum(fm, "focus", 0) || null,
    names: {},
    levels: {},
    bank: {},
    misconceptions: [],
    cards: {},
    newDate: fmStr(fm, "new_date"),
    newCount: fmNum(fm, "new_count", 0),
  };
  for (const r of tableRows(section(body, "Skill map"))) {
    const n = Number(r[0]);
    if (!n) continue;
    s.names[n] = r[1] ?? "";
    s.levels[n] = /^\d$/.test(r[2] ?? "") ? Number(r[2]) : null;
    const b = /^(\d+)\/(\d+)$/.exec(r[3] ?? "");
    s.bank[n] = b ? { right: Number(b[1]), total: Number(b[2]) } : { right: 0, total: 0 };
  }
  for (const line of section(body, "Misconceptions").split(/\r?\n/)) {
    const m = /^\s*-\s+(.+)$/.exec(line);
    if (m) s.misconceptions.push(m[1].trim());
  }
  for (const r of tableRows(section(body, "Review schedule"))) {
    if (!r[0] || !/^\d{4}-\d{2}-\d{2}$/.test(r[1] ?? "")) continue;
    s.cards[r[0]] = { due: r[1], interval: Number(r[2]) || 0, ease: Number(r[3]) || 2.5, reps: Number(r[4]) || 0, lapses: Number(r[5]) || 0 };
  }
  return s;
}

/** The part of the state the model sees each turn. The review schedule is left out. */
export function stateForPrompt(s: LearnerState, today: string): string {
  const lines = [`target level: ${s.target}`, `current focus: ${s.focus ?? "not set"}`, "", "| # | subskill | level | bank reviews right/total |", "| --- | --- | --- | --- |"];
  for (const n of Object.keys(s.names).map(Number).sort((a, b) => a - b)) {
    const b = s.bank[n] ?? { right: 0, total: 0 };
    lines.push(`| ${n} | ${s.names[n]} | ${s.levels[n] ?? "unset"} | ${b.right}/${b.total} |`);
  }
  lines.push("", "misconceptions: " + (s.misconceptions.length ? s.misconceptions.map((m) => `"${m}"`).join("; ") : "none recorded"));
  lines.push(`flashcards due today: ${dueCount(s, today)}`);
  return lines.join("\n");
}

export interface StateUpdate {
  levels?: Record<string, unknown>;
  focus?: unknown;
  add_misconceptions?: unknown;
  clear_misconceptions?: unknown;
}

/** Pulls the hidden <state>{...}</state> line out of a reply. Malformed JSON is dropped, not shown. */
export function extractStateTrailer(reply: string): { text: string; update: StateUpdate | null } {
  let update: StateUpdate | null = null;
  const text = reply
    .replace(/`{0,3}\s*<state>([\s\S]*?)<\/state>\s*`{0,3}/g, (_all, json: string) => {
      try {
        const parsed = JSON.parse(json.trim());
        if (parsed && typeof parsed === "object") update = { ...(update ?? {}), ...parsed };
      } catch {
        /* ignore a malformed update */
      }
      return "";
    })
    .trim();
  return { text, update };
}

/** Applies a validated update and returns a readable list of what changed. */
export function applyStateUpdate(s: LearnerState, u: StateUpdate, allowLevels = true): string[] {
  const changes: string[] = [];
  if (allowLevels && u.levels && typeof u.levels === "object") {
    for (const [k, v] of Object.entries(u.levels)) {
      const n = Number(k);
      const lvl = Number(v);
      if (!(n in s.names) || !Number.isInteger(lvl) || lvl < 0 || lvl > 5) continue;
      if (s.levels[n] !== lvl) {
        changes.push(`${s.names[n]}: ${s.levels[n] ?? "unset"} → ${lvl}`);
        s.levels[n] = lvl;
      }
    }
  }
  const focus = Number(u.focus);
  if (u.focus !== undefined && focus in s.names && s.focus !== focus) {
    s.focus = focus;
    changes.push(`focus → ${s.names[focus]}`);
  }
  const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((i) => typeof i === "string").map((i) => (i as string).trim().slice(0, 200)).filter(Boolean) : []);
  for (const m of strings(u.clear_misconceptions)) {
    const i = s.misconceptions.findIndex((x) => x.toLowerCase() === m.toLowerCase());
    if (i >= 0) {
      s.misconceptions.splice(i, 1);
      changes.push(`cleared misconception: ${m}`);
    }
  }
  for (const m of strings(u.add_misconceptions)) {
    if (s.misconceptions.some((x) => x.toLowerCase() === m.toLowerCase())) continue;
    s.misconceptions.push(m);
    changes.push(`noted misconception: ${m}`);
  }
  if (s.misconceptions.length > 12) s.misconceptions = s.misconceptions.slice(-12);
  return changes;
}

// ---------- spaced repetition (SM-2 style) ----------

export type Grade = "again" | "hard" | "good" | "easy";

export function schedule(prev: CardSched | undefined, grade: Grade, today: string): CardSched {
  const c: CardSched = prev ? { ...prev } : { due: today, interval: 0, ease: 2.5, reps: 0, lapses: 0 };
  if (grade === "again") {
    c.reps = 0;
    c.lapses += 1;
    c.interval = 0;
    c.ease = Math.max(1.3, c.ease - 0.2);
  } else {
    if (grade === "hard") {
      c.interval = Math.max(1, Math.round(c.interval * 1.2));
      c.ease = Math.max(1.3, c.ease - 0.15);
    } else if (grade === "good") {
      c.interval = c.reps === 0 ? 1 : c.reps === 1 ? 3 : Math.max(c.interval + 1, Math.round(c.interval * c.ease));
    } else {
      c.interval = c.reps === 0 ? 3 : Math.max(c.interval + 2, Math.round(c.interval * c.ease * 1.3));
      c.ease = c.ease + 0.15;
    }
    c.reps += 1;
  }
  c.ease = Math.round(c.ease * 100) / 100;
  c.due = addDays(today, c.interval);
  return c;
}

/** Due cards first, then unseen cards up to today's remaining allowance. */
export function reviewQueue(questions: Question[], s: LearnerState, today: string, newPerDay: number): Question[] {
  const due = questions.filter((q) => s.cards[q.id] && s.cards[q.id].due <= today);
  const used = s.newDate === today ? s.newCount : 0;
  const fresh = questions.filter((q) => !s.cards[q.id]).slice(0, Math.max(0, newPerDay - used));
  return [...due, ...fresh];
}

// ---------- quiz from the question bank, marked by plain code ----------

/** The next bank question for a quiz: weakest subskill first, skipping ones already asked in this chat. */
export function pickQuizQuestion(questions: Question[], s: LearnerState, asked: string[]): Question | null {
  const left = questions.filter((q) => !asked.includes(q.id));
  if (!left.length) return null;
  const level = (q: Question) => s.levels[q.subskill] ?? 0;
  const seen = (q: Question) => (s.cards[q.id] ? 1 : 0);
  return [...left].sort((a, b) => level(a) - level(b) || seen(a) - seen(b))[0];
}

export function formatQuizQuestion(q: Question, s: LearnerState): string {
  const head = `**${s.names[q.subskill] ?? "Question"}**\n\n${q.question}`;
  if (q.type === "mcq") return `${head}\n\n${q.options.map((o) => `- ${o}`).join("\n")}\n\n*Reply with a letter.*`;
  return head;
}

/** A reply such as "b", "(B)" or "B. because..." read as a multiple-choice letter; null if it is not one. */
export function parseMcqReply(reply: string, optionCount: number): string | null {
  const m = /^\s*\(?([A-Za-z])\)?(?:[.):,]|\s|$)/.exec(reply);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const idx = letter.charCodeAt(0) - 65;
  // "A matrix is..." starts with a letter too; only accept a bare letter or a letter with punctuation.
  if (idx < 0 || idx >= optionCount) return null;
  if (!/^\s*\(?[A-Za-z]\)?[.):,]?\s*$/.test(reply) && !/^\s*\(?[A-Za-z]\)?[.):,]/.test(reply)) return null;
  return letter;
}

export const givesUp = (reply: string): boolean => /^\s*(idk|i don'?t know|no idea|skip|pass|\?+)\s*[.!]?\s*$/i.test(reply);

/** True when the learner is asking the tutor something instead of answering the pending question. */
export const looksLikeQuestion = (reply: string): boolean => /\?\s*$/.test(reply.trim()) || /^\s*(why|how|what|when|where|which|can you|could you|explain|hint|help)\b/i.test(reply);

/** One code-markable question per subskill, for placing a new learner without a model. */
export function placementQuestions(questions: Question[], s: LearnerState): Question[] {
  const out: Question[] = [];
  for (const n of Object.keys(s.names).map(Number).sort((a, b) => a - b)) {
    const mine = questions.filter((q) => q.subskill === n);
    const q = mine.find((x) => x.type === "mcq") ?? mine.find((x) => x.type === "short");
    if (q) out.push(q);
  }
  return out;
}

/** Marks an answer without a model where that is possible. "letter" means: ask for a letter again. */
export function codeMark(q: Question, answer: string): Grade | "letter" | "model" {
  if (givesUp(answer)) return "again";
  if (q.type === "mcq") {
    const letter = parseMcqReply(answer, q.options.length);
    if (!letter) return "letter";
    return letter === mcqLetter(q.answer) ? "good" : "again";
  }
  if (q.type === "short" && sameShortAnswer(answer, q.answer)) return "good";
  return "model";
}

// ---------- flashcards for the Spaced Repetition community plugin ----------
//
// That plugin reads cards from tagged notes: question lines, a line holding only "?", answer
// lines, then a blank line. It writes its schedule back into the note on the line after the
// card, as <!--SR:!2026-11-15,3,250--> (due date, interval, ease), optionally inside a
// "> [!sr|card-metadata]" callout. Checked against version 1.15.4 of the plugin.

export interface SrStats {
  total: number;
  due: number;
  fresh: number;
}

const SR_TAIL = /^(<!--SR:|> \[!sr\|card-metadata\])/;
const ZWSP = "​";

/** Makes text safe inside a card: no blank lines, and nothing the plugin would read as a card separator. */
export function srSafe(text: string): string {
  let fenced = false;
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((line) => {
      if (/^(```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      // A line that is only "?" or "??" would split the card in two.
      if (/^\s*\?{1,2}\s*$/.test(line)) return ZWSP + line;
      // "::" outside inline code would turn the line into a card of its own (think std::vector).
      return line.split(/(`[^`]*`)/).map((part, i) => (i % 2 ? part : part.replace(/:(?=:)/g, `:${ZWSP}`))).join("");
    })
    .join("\n");
}

const srKey = (front: string): string => front.replace(/​/g, "").replace(/\s+/g, " ").trim().toLowerCase();

/** Splits a flashcard note into cards, each with the front text and whatever schedule lines follow it. */
function srBlocks(md: string): { front: string; tail: string }[] {
  const out: { front: string; tail: string }[] = [];
  for (const block of md.replace(/\r\n/g, "\n").split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const sep = lines.findIndex((l) => l.trim() === "?");
    if (sep < 1) continue;
    const tailAt = lines.findIndex((l, i) => i > sep && SR_TAIL.test(l));
    out.push({ front: lines.slice(0, sep).join("\n"), tail: tailAt < 0 ? "" : lines.slice(tailAt).join("\n") });
  }
  return out;
}

/**
 * Writes the question bank as a flashcard note. Cards already in `existing` keep the schedule
 * the plugin wrote for them, so the note can be regenerated without losing review history.
 */
export function buildSrNote(questions: Question[], tag: string, existing = ""): string {
  const kept = new Map(srBlocks(existing).map((b) => [srKey(b.front), b.tail]));
  const cards = questions.map((q) => {
    const front = srSafe(q.question) + (q.options.length ? "\n" + q.options.map((o) => `- ${srSafe(o)}`).join("\n") : "");
    const back = srSafe(answerText(q)) + (q.explanation ? "\n" + srSafe(q.explanation) : "");
    const tail = kept.get(srKey(front));
    return `${front}\n?\n${back}${tail ? "\n" + tail : ""}`;
  });
  return `#flashcards/${tag}\n\n${cards.join("\n\n")}\n`;
}

/** Counts cards in a flashcard note: how many are due today and how many have never been reviewed. */
export function srStats(md: string, today: string): SrStats {
  const stats: SrStats = { total: 0, due: 0, fresh: 0 };
  for (const b of srBlocks(md)) {
    stats.total += 1;
    const dates = [...b.tail.matchAll(/!(\d{4}-\d{2}-\d{2}),/g)].map((m) => m[1]);
    if (!dates.length) stats.fresh += 1;
    else if (dates.some((d) => d <= today)) stats.due += 1;
  }
  return stats;
}

// ---------- the guided path: learn, practise, master ----------

export interface NextStep {
  action: Mode | "review" | "done";
  title: string;
  detail: string;
}

/**
 * The cheapest sensible next thing to do on a topic. Lessons and code-marked practice come
 * before Socratic tutoring, which is the most thorough mode and also the most expensive.
 */
export function nextStep(s: LearnerState, today: string, dueOverride?: number): NextStep {
  const ns = Object.keys(s.names).map(Number).sort((a, b) => a - b);
  if (!ns.length) return { action: "done", title: "Nothing to study yet", detail: "This topic has no subskills." };
  const lvl = (n: number) => s.levels[n];
  // When another plugin keeps the flashcard schedule, its count of due cards is passed in.
  const due = dueOverride ?? dueCount(s, today);
  const untaught = ns.filter((n) => lvl(n) === null || (lvl(n) as number) <= 1);
  if (ns.every((n) => lvl(n) === null)) return { action: "teach", title: "Learn", detail: `Start with a lesson on ${s.names[ns[0]]}.` };
  if (due > 0) return { action: "review", title: "Review", detail: `${due} flashcard${due === 1 ? " is" : "s are"} due. Reviewing uses no tokens.` };
  if (untaught.length) return { action: "teach", title: "Learn", detail: `Take a lesson on ${s.names[untaught[0]]}.` };
  const unpractised = ns.filter((n) => (s.bank[n]?.total ?? 0) < 2);
  if (unpractised.length) return { action: "quiz", title: "Practise", detail: `Quiz yourself on ${s.names[unpractised[0]]}. Most answers are marked without tokens.` };
  const below = ns.filter((n) => (lvl(n) ?? 0) < s.target).sort((a, b) => (lvl(a) ?? 0) - (lvl(b) ?? 0));
  if (below.length) return { action: "tutor", title: "Master", detail: `Work with the tutor on ${s.names[below[0]]} (level ${lvl(below[0])} of ${s.target}).` };
  return { action: "done", title: "At target", detail: "Every subskill is at your target level. Come back when flashcards are due." };
}

// ---------- chat files ----------

export interface ChatMsg {
  role: "you" | "tutor";
  text: string;
}
export interface Chat {
  fm: Frontmatter;
  summary: string;
  messages: ChatMsg[];
}

const SUMMARY_H = "Summary of earlier parts";

export function parseChat(md: string): Chat {
  const { fm, body } = splitFrontmatter(md);
  const tIdx = body.search(/^##\s+Transcript\s*$/m);
  const head = tIdx >= 0 ? body.slice(0, tIdx) : body;
  const transcript = tIdx >= 0 ? body.slice(tIdx).replace(/^##\s+Transcript\s*$/m, "") : "";
  let summary = section(head, SUMMARY_H);
  if (/^none\.?$/i.test(summary)) summary = "";
  const parts = transcript.split(/^%%msg:(you|tutor)%%[ \t]*$/m);
  const messages: ChatMsg[] = [];
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const text = parts[i + 1].replace(/^\s*######\s+(You|Tutor)\s*$/m, "").trim();
    messages.push({ role: parts[i] as "you" | "tutor", text });
  }
  return { fm, summary, messages };
}

export function serializeChat(c: Chat): string {
  const lines = [`## ${SUMMARY_H}`, "", c.summary.trim() || "None.", "", "## Transcript", ""];
  for (const m of c.messages) lines.push(`%%msg:${m.role}%%`, `###### ${m.role === "you" ? "You" : "Tutor"}`, m.text.trim(), "");
  return withFrontmatter(c.fm, lines.join("\n"));
}

export const chatWords = (c: Chat): number => c.messages.reduce((a, m) => a + words(m.text), 0);

export function chatForPrompt(c: Chat): string {
  const out: string[] = [];
  if (c.summary.trim()) out.push("## Summary of earlier parts", c.summary.trim(), "");
  if (c.messages.length) {
    out.push("## Messages");
    for (const m of c.messages) out.push(`${m.role === "you" ? "LEARNER" : "TUTOR"}: ${m.text.trim()}`, "");
  }
  return out.join("\n").trim();
}
