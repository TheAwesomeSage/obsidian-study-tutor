// Parsing and serialising of the plugin's markdown files. Pure functions, no Obsidian imports.

export type Mode = "tutor" | "quiz" | "expert";
export type SourceMode = "notes" | "spec" | "subject";
export type FmValue = string | number | string[];
export type Frontmatter = Record<string, FmValue>;

export const words = (s: string): number => (s.trim() ? s.trim().split(/\s+/).length : 0);

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
