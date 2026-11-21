import { addDays } from "./dates";
import { Attempt, LevelChange, normaliseAttempt, skillEvidence, supportedLevel } from "./evidence";
import type { Relation } from "./course";
import type { Misconception } from "./misconceptions";
import { reservedQuestions } from "./coursepkg";
import { FamilySpec, isMistakeCard, parseFamilySpec } from "./families";
import type { CodeTask } from "./codetask";
import { decodeSolution, parseCodeTask, renderCodeTask } from "./codequestions";
import { examDay, readObjectiveLine, type ObjectiveExam } from "./objective-meta";
export type { ObjectiveExam } from "./objective-meta";
import { FsrsMemory, ReviewEntry, SchedulerRecord, Sm2State, formatLog, formatMemory, parseLog, parseMemory, parseSchedulerRecord, reviewCard } from "./scheduler";
// Parsing and serialising of the plugin's markdown files. Pure functions, no Obsidian imports.

export type Mode = "auto" | "tutor" | "teach" | "quiz" | "expert";
export const MODES: Mode[] = ["auto", "tutor", "teach", "quiz", "expert"];
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

const K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** SHA-256 of a string's UTF-8 bytes, as 64 hex digits. Plain code, so it runs anywhere without Node or Web Crypto. */
export function sha256(text: string): string {
  const bytes = Array.from(new TextEncoder().encode(text));
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push(i >= 4 ? 0 : (bitLen >>> (i * 8)) & 0xff);
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Array<number>(64);
  const rot = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < bytes.length; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = (bytes[o + 4 * i] << 24) | (bytes[o + 4 * i + 1] << 16) | (bytes[o + 4 * i + 2] << 8) | bytes[o + 4 * i + 3];
    for (let i = 16; i < 64; i++) {
      const s0 = rot(w[i - 15], 7) ^ rot(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rot(w[i - 2], 17) ^ rot(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0;
      const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      [k, g, f, e, d, c, b, a] = [g, f, e, (d + t1) | 0, c, b, a, (t1 + t2) | 0];
    }
    [a, b, c, d, e, f, g, k].forEach((v, i) => (h[i] = (h[i] + v) | 0));
  }
  return h.map((v) => (v >>> 0).toString(16).padStart(8, "0")).join("");
}

/**
 * The fingerprint used for source provenance and cache keys: SHA-256 of the text with line
 * endings normalised, as 64 hex digits (the visual contract checks SourceRef hashes are SHA-256).
 */
export function contentHash(s: string): string {
  return sha256(s.split("\r\n").join("\n"));
}

export function ymd(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export { addDays };

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
  /** Other typed relations the card states for this subskill ("relations: supports 4; contrasts_with 2"). */
  relations: { type: Relation; n: number }[];
  /** Notes cited in this subskill's section, as [[links]]. */
  sources: string[];
  section: string;
  /** Specification objectives this subskill covers, by id ("objectives: O1, O3"). */
  objectives?: string[];
  /** Optional visual eligibility recorded at compile time ("visual: simulation | why"). Never a trigger by itself. */
  visual?: { kind: string; reason: string } | null;
  /** The compiled concise worked example, when the card has one. */
  worked?: string;
}

/** One specification objective from the card's "## Objectives" section. */
export interface Objective {
  id: string;
  text: string;
  /** Where the objective comes from: a spec label, a [[note]] or a link. */
  source: string;
  /** Exam metadata from the line, when it had any that read cleanly. */
  exam?: ObjectiveExam;
}
export interface Topic {
  title: string;
  fm: Frontmatter;
  overview: string;
  subskills: Subskill[];
  body: string;
  /** Objectives listed under "## Objectives". Empty on cards compiled before 0.6. */
  objectives?: Objective[];
  /** The topic's exam date (yyyy-mm-dd), from `exam:` in the properties or an "Exam:" line under Objectives. */
  examDate?: string;
}

const VISUAL_KINDS = ["text", "worked-example", "diagram", "simulation", "game", "external", "none"];

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
    const rel = /^relations:\s*(.*)$/im.exec(sec);
    const relations: { type: Relation; n: number }[] = [];
    for (const part of rel ? rel[1].split(";") : []) {
      const m = /(requires|supports|applies[_ ]to|contrasts[_ ]with|derived[_ ]from)\s*:?\s*([\d,\s]+)/i.exec(part);
      if (m) for (const n of m[2].match(/\d+/g) ?? []) relations.push({ type: m[1].toLowerCase().replace(" ", "_") as Relation, n: Number(n) });
    }
    const obj = /^objectives:\s*(.*)$/im.exec(sec);
    const vis = /^visual:\s*([a-z-]+)\s*(?:[|—–:-]\s*(.*))?$/im.exec(sec);
    const visualKind = vis ? vis[1].toLowerCase() : "";
    // "worked example:" starts a block of lines that runs to the next "key:" line or the end.
    const worked = /^worked example:\s*\n?([\s\S]*?)(?=^\s*(?:misconceptions|objectives|visual|prerequisites|relations):|(?![\s\S]))/im.exec(sec);
    subskills.push({
      n: h.n,
      name: h.name,
      prerequisites: pre ? (pre[1].match(/\d+/g) ?? []).map(Number) : [],
      relations,
      sources: [...new Set([...sec.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map((x) => `[[${x[1].trim()}]]`))],
      section: sec,
      objectives: obj ? obj[1].split(/[;,]/).map((x) => x.trim()).filter((x) => x && !/^none$/i.test(x)) : [],
      visual: VISUAL_KINDS.includes(visualKind) && visualKind !== "none" ? { kind: visualKind, reason: (vis![2] ?? "").trim().slice(0, 200) } : null,
      worked: worked ? worked[1].trim() : "",
    });
  });
  const objectives: Objective[] = [];
  let examDate = ["exam", "exam-date", "exam_date", "examDate"].map((k) => examDay(fmStr(fm, k))).find((d) => d) ?? "";
  for (const line of section(body, "Objectives").split(/\r?\n/)) {
    const day = /^\s*(?:[-*]\s+)?\**exam(?:\s+date)?\**\s*[:=]\**\s*(.+?)\s*$/i.exec(line);
    if (day) {
      examDate = examDate || (examDay(day[1]) ?? "");
      continue;
    }
    const m = /^\s*[-*]\s+\**([A-Za-z]?[\w.]*\d[\w.]*)\**\s*[:.)-]\s*(.+)$/.exec(line);
    if (!m) continue;
    const o = readObjectiveLine(m[2]);
    objectives.push({ id: m[1], text: o.text, source: o.source, ...(o.exam ? { exam: o.exam } : {}) });
  }
  return { title: fmStr(fm, "title") || (h1 ? h1[1].trim() : "Untitled"), fm, overview: section(body, "Overview"), subskills, body: body.trim(), objectives, ...(examDate ? { examDate } : {}) };
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
  /** Question family (0.6 on): questions testing the same thing the same way share one. */
  family?: string;
  /** Task type: recall, application, transfer, prediction, explanation, error-finding, teach-back, edge-case. */
  task?: string;
  /** Expected difficulty, 1 to 5. */
  difficulty?: number;
  /** For open questions: what a full answer must contain, used when the answer is graded. */
  rubric?: string;
  /** A bounded family spec (families.ts): code makes fresh numbers for this question and marks them. */
  generator?: FamilySpec;
  /**
   * A coding exercise (codequestions.ts): the learner answers with source code, which is run
   * against these tests when a runner is available. The question's type stays "open", so every
   * path that does not know about code treats it as an answer for the grader; `answer` holds a
   * reference solution.
   */
  code?: CodeTask;
  /** Stable concept id; set only on sealed questions. */
  concept?: string;
}

const Q_KEYS = ["subskill", "type", "question", "options", "answer", "explanation", "family", "task", "difficulty", "rubric", "generator", "code", "concept"] as const;
const Q_TASKS = ["recall", "application", "transfer", "prediction", "explanation", "error-finding", "teach-back", "edge-case", "probe"];

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
  const parts = body.split(/^#{2,4}\s+\**(Q\d+|P[0-9a-f]+)\**[.:]?[ \t]*$/m);
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
    const q: Question = { id: parts[i], subskill: Number(get("subskill")) || 0, type, question, options, answer, explanation: get("explanation") };
    const family = get("family").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
    const task = get("task").toLowerCase().trim();
    const difficulty = Number(get("difficulty"));
    if (family) q.family = family;
    if (Q_TASKS.includes(task)) q.task = task;
    if (Number.isInteger(difficulty) && difficulty >= 1 && difficulty <= 5) q.difficulty = difficulty;
    if (get("concept")) q.concept = get("concept").slice(0, 80);
    if (get("rubric")) q.rubric = get("rubric").slice(0, 800);
    // A spec that fails its checks is dropped: the question stays, with its own numbers only.
    const generator = type === "short" && get("generator") ? parseFamilySpec(get("generator")) : null;
    if (generator && "spec" in generator) q.generator = generator.spec;
    // "code:" is a one-line JSON task. One that fails its checks is dropped, and the question
    // stays an open one for the grader, with no tests to run.
    const code = type !== "mcq" && get("code") ? parseCodeTask(get("code")) : null;
    if (code && "task" in code) {
      q.type = "open";
      q.code = code.task;
      q.answer = decodeSolution(q.answer);
    }
    out.push(q);
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

/** The value of an answer that is nothing but a number ("5", "$-0.25$"), otherwise null. */
export function plainNumber(s: string): number | null {
  const t = s.replace(/\$/g, "").replace(/\s+/g, "").replace(/[.;,]+$/, "").replace(/−/g, "-");
  return /^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(t) ? Number(t) : null;
}

/** Two plain numbers that differ. Code can mark that wrong without any model or algebra system. */
export function differentNumbers(given: string, expected: string): boolean {
  const a = plainNumber(given);
  const b = plainNumber(expected);
  return a !== null && b !== null && a !== b;
}

export const mcqLetter = (s: string): string => (/[A-Za-z]/.exec(s)?.[0] ?? "").toUpperCase();

// ---------- learner state ----------

export interface CardSched {
  /** The day the card is next due, set by the scheduler the state records (scheduler.ts). */
  due: string;
  // SM-2's own state, kept up to date whichever scheduler is active, so going back to SM-2 loses nothing.
  interval: number;
  ease: number;
  reps: number;
  lapses: number;
  /** FSRS memory state, while FSRS schedules the card. */
  fsrs?: FsrsMemory;
  /** The latest reviews, oldest first. Absent on cards not reviewed since 0.10. */
  log?: ReviewEntry[];
  /** The SM-2 state just before `log[0]`, when the log does not begin at the card's first review. */
  logFrom?: Sm2State;
}
export interface LearnerState {
  /** Every marked answer, with how it was marked. Kept in evidence.md beside the state file. */
  attempts: Attempt[];
  /** Every change of level, with its cause. */
  changes: LevelChange[];
  /** Study priority per subskill, from 0.1 to 5. Weighs what is suggested next; it never touches levels. */
  priorities: Record<number, number>;
  /** The day a lesson on the subskill was first delivered. */
  taught: Record<number, string>;
  /** Stable concept id of each subskill, filled in by the store from the course graph. */
  concepts: Record<number, string>;
  /** Per subskill, the objective versions it teaches now ("id@v"), from the course graph. Attempts are stamped with them. */
  objectiveRefs?: Record<number, string[]>;
  /** Per subskill, the latest material change to an objective it teaches. Earlier evidence then needs a focused recheck. */
  revisions?: Record<number, { at: string; why: string }>;
  /** Cross-topic links as 0.5.0 stored them. The store moves them into the course graph on load. */
  links?: { skill: number; topic: string; prerequisite: number }[];
  topic: string;
  target: number;
  focus: number | null;
  names: Record<number, string>;
  levels: Record<number, number | null>;
  bank: Record<number, { right: number; total: number }>;
  /**
   * Active misconception descriptions, derived from `misconceptionRecords` when the store loaded
   * them (misconceptions.ts). Kept as a plain list for older code and older files.
   */
  misconceptions: string[];
  /** Misconceptions as evidence-backed records, kept in evidence.md. Absent in states built before 0.9. */
  misconceptionRecords?: Misconception[];
  cards: Record<string, CardSched>;
  /** The scheduler the card dates come from, and every switch. Absent: SM-2, as before 0.10. */
  scheduler?: SchedulerRecord;
  newDate: string;
  newCount: number;
}

export const blankState = (topic = "", target = 4): LearnerState => ({ topic, target, focus: null, names: {}, levels: {}, bank: {}, misconceptions: [], cards: {}, newDate: "", newCount: 0, attempts: [], changes: [], priorities: {}, taught: {}, concepts: {} });

/**
 * A fresh state for a topic card. With `previous`, the learner's history is carried over:
 * `remap` gives the new number of each old subskill (from the course graph's stable concept
 * ids), and without it subskills are matched by name. Evidence for a subskill that no longer
 * exists is kept under skill 0, so nothing the learner did is thrown away.
 */
export function newState(topic: Topic, target: number, previous?: LearnerState, remap?: Record<number, number>): LearnerState {
  const s = blankState(topic.title, target);
  for (const sk of topic.subskills) {
    s.names[sk.n] = sk.name;
    s.levels[sk.n] = null;
    s.bank[sk.n] = { right: 0, total: 0 };
  }
  if (!previous) return s;
  const byName = (old: number) => topic.subskills.find((sk) => sk.name.toLowerCase() === previous.names[old]?.toLowerCase())?.n;
  const now = (old: number): number | undefined => {
    const n = remap ? remap[old] : byName(old);
    return n !== undefined && n in s.names ? n : undefined;
  };
  s.target = previous.target;
  s.misconceptions = [...previous.misconceptions];
  if (previous.misconceptionRecords) s.misconceptionRecords = previous.misconceptionRecords.map((m) => ({ ...m }));
  s.changes = [...(previous.changes ?? [])];
  for (const old of Object.keys(previous.names).map(Number)) {
    const n = now(old);
    if (n === undefined) continue;
    s.levels[n] = previous.levels[old] ?? null;
    if (previous.bank[old]) s.bank[n] = { ...previous.bank[old] };
    if (previous.priorities?.[old] !== undefined) s.priorities[n] = previous.priorities[old];
    if (previous.taught?.[old]) s.taught[n] = previous.taught[old];
  }
  s.attempts = (previous.attempts ?? []).map((a) => ({ ...a, skill: a.skill ? now(a.skill) ?? 0 : 0 }));
  if (previous.focus !== null) s.focus = now(previous.focus) ?? null;
  if (previous.links?.length) s.links = previous.links.flatMap((l) => (now(l.skill) === undefined ? [] : [{ ...l, skill: now(l.skill)! }]));
  return s;
}

/** Sets a level and logs why. Every level change in the plugin goes through here. */
export function setLevel(s: LearnerState, n: number, to: number | null, cause: string, note: string, at: string = new Date().toISOString()): string | null {
  const from = s.levels[n] ?? null;
  if (from === to || !(n in s.names)) return null;
  s.levels[n] = to;
  s.changes.push({ t: at, skill: n, concept: s.concepts[n] ?? "", from, to, cause, note });
  if (s.changes.length > 400) s.changes = s.changes.slice(-400);
  return `${s.names[n]}: ${from ?? "unset"} → ${to ?? "unset"}`;
}

/** The evidence for one subskill and the level it can hold. */
/** What a subskill's evidence is measured against: its latest material objective change, if any. */
export const revisionOf = (s: LearnerState, n: number): { at: string; why: string; refs?: string[] } | undefined => (s.revisions?.[n] ? { ...s.revisions[n], refs: s.objectiveRefs?.[n] } : undefined);

/** The objective versions an attempt on this subskill assesses now, as a field to spread into it. Empty when the course has none recorded. */
export const objectiveStamp = (s: LearnerState, n: number): { objectives?: string[] } => (s.objectiveRefs?.[n]?.length ? { objectives: [...s.objectiveRefs[n]] } : {});

/** A subskill's evidence, measured against its latest material objective change. */
export const evidenceOf = (s: LearnerState, n: number) => skillEvidence(s.attempts, n, revisionOf(s, n));

export function mastery(s: LearnerState, n: number) {
  const evidence = evidenceOf(s, n);
  const supported = supportedLevel(evidence, n in s.taught);
  const level = s.levels[n] ?? null;
  return { level, evidence, supported, backed: level !== null && level <= supported };
}

export function progress(s: LearnerState): number {
  const ns = Object.keys(s.names);
  if (!ns.length || s.target <= 0) return 0;
  const sum = ns.reduce((a, n) => a + Math.min(s.levels[Number(n)] ?? 0, s.target), 0);
  return Math.round((100 * sum) / (ns.length * s.target));
}

/** The flashcards of a state: the bank's questions. A known mistake's card is checked inside quizzes and adaptive sessions, not in review, so it is left out of every count of cards to review. */
export const reviewCards = (s: LearnerState): CardSched[] => Object.entries(s.cards).filter(([id]) => !isMistakeCard(id)).map(([, c]) => c);
export const dueCount = (s: LearnerState, today: string): number => reviewCards(s).filter((c) => c.due <= today).length;

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
    priorities: JSON.stringify(s.priorities ?? {}),
    taught: JSON.stringify(s.taught ?? {}),
  };
  // Links not yet moved into the course graph are written back, so a failed migration loses nothing.
  if (s.links?.length) fm.links = JSON.stringify(s.links);
  if (s.scheduler) {
    fm.scheduler = `${s.scheduler.id}@${s.scheduler.version}`;
    if (s.scheduler.retention !== undefined) fm.retention = s.scheduler.retention;
    if (s.scheduler.switches.length) fm.scheduler_switches = JSON.stringify(s.scheduler.switches);
  }
  const cell = (t: string) => t.replace(/\|/g, "/");
  const lines = ["## Skill map", "", "| # | Subskill | Level | Bank |", "| --- | --- | --- | --- |"];
  for (const n of Object.keys(s.names).map(Number).sort((a, b) => a - b)) {
    const b = s.bank[n] ?? { right: 0, total: 0 };
    lines.push(`| ${n} | ${cell(s.names[n])} | ${s.levels[n] ?? "-"} | ${b.right}/${b.total} |`);
  }
  lines.push("", "## Misconceptions", "", ...(s.misconceptions.length ? s.misconceptions.map((m) => `- ${m}`) : ["None recorded."]));
  lines.push("", "## Review schedule", "", "| Card | Due | Interval | Ease | Reps | Lapses | FSRS | Log |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const [id, c] of Object.entries(s.cards)) lines.push(`| ${id} | ${c.due} | ${c.interval} | ${c.ease} | ${c.reps} | ${c.lapses} | ${formatMemory(c.fsrs)} | ${formatLog(c)} |`);
  return withFrontmatter(fm, lines.join("\n") + "\n");
}

export function parseState(md: string): LearnerState {
  const { fm, body } = splitFrontmatter(md);
  const s = blankState(fmStr(fm, "topic"), fmNum(fm, "target", 4));
  s.focus = fmNum(fm, "focus", 0) || null;
  s.newDate = fmStr(fm, "new_date");
  s.newCount = fmNum(fm, "new_count", 0);
  // Each optional field is read on its own, so one damaged value cannot take the others with it.
  const json = (key: string): unknown => {
    try {
      return JSON.parse(fmStr(fm, key, "null"));
    } catch {
      return null;
    }
  };
  const numMap = <T>(raw: unknown, ok: (v: unknown) => boolean): Record<number, T> => {
    const out: Record<number, T> = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) for (const [k, v] of Object.entries(raw)) if (Number.isInteger(Number(k)) && ok(v)) out[Number(k)] = v as T;
    return out;
  };
  const links = json("links");
  if (Array.isArray(links) && links.length) s.links = links.filter((l) => l && Number.isInteger(l.skill) && typeof l.topic === "string" && Number.isInteger(l.prerequisite));
  s.priorities = numMap<number>(json("priorities"), (v) => typeof v === "number" && v >= 0.1 && v <= 5);
  s.taught = numMap<string>(json("taught"), (v) => typeof v === "string");
  // 0.5.0 kept attempts in this file's frontmatter. They are read here and saved to evidence.md.
  const legacy = json("evidence");
  if (Array.isArray(legacy)) s.attempts = legacy.map(normaliseAttempt).filter((x): x is Attempt => !!x);
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
    // Files from before 0.10 have the first six columns only.
    const c: CardSched = { due: r[1], interval: Number(r[2]) || 0, ease: Number(r[3]) || 2.5, reps: Number(r[4]) || 0, lapses: Number(r[5]) || 0 };
    const mem = parseMemory(r[6] ?? "");
    if (mem) c.fsrs = mem;
    s.cards[r[0]] = { ...c, ...parseLog(r[7] ?? "") };
  }
  const scheduler = parseSchedulerRecord(fmStr(fm, "scheduler"), fmNum(fm, "retention", NaN), fmStr(fm, "scheduler_switches"));
  if (scheduler) s.scheduler = scheduler;
  return s;
}

/** The part of the state the model sees each turn. The review schedule is left out. */
export function stateForPrompt(s: LearnerState, today: string): string {
  const lines = [`target level: ${s.target}`, `current focus: ${s.focus ?? "not set"}`, "", "| # | subskill | level | bank reviews right/total | unaided correct/attempts |", "| --- | --- | --- | --- | --- |"];
  for (const n of Object.keys(s.names).map(Number).sort((a, b) => a - b)) {
    const b = s.bank[n] ?? { right: 0, total: 0 };
    const e = skillEvidence(s.attempts, n);
    lines.push(`| ${n} | ${s.names[n]} | ${s.levels[n] ?? "unset"} | ${b.right}/${b.total} | ${e.independentCorrect}/${e.independent} |`);
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

/**
 * Applies a model's proposed update, within what the evidence allows, and returns a readable
 * list of what changed.
 *
 * A level goes up only one step at a time and never past what the recorded attempts support.
 * It goes down only by one step, and only when this turn's attempt on that subskill was not
 * correct. With `levels: false` no level changes at all.
 */
export function applyStateUpdate(s: LearnerState, u: StateUpdate, opts: { levels?: boolean; attempt?: Attempt | null } = {}): string[] {
  const changes: string[] = [];
  if (opts.levels !== false && u.levels && typeof u.levels === "object") {
    for (const [k, v] of Object.entries(u.levels)) {
      const n = Number(k);
      const lvl = Number(v);
      if (!(n in s.names) || !Number.isInteger(lvl) || lvl < 0 || lvl > 5) continue;
      const current = s.levels[n] ?? 0;
      const mine = opts.attempt && opts.attempt.skill === n && opts.attempt.result !== "ungraded" && opts.attempt.verification !== "disputed" ? opts.attempt : null;
      if (lvl > current) {
        if (lvl > current + 1 || lvl > mastery(s, n).supported) continue;
      } else if (lvl < current) {
        if (!mine || mine.result === "correct" || lvl < current - 1) continue;
      } else if (s.levels[n] !== null) continue;
      const line = setLevel(s, n, lvl, mine?.id ?? "tutor", lvl > current ? "the recorded attempts support this level" : "this turn's answer was not correct");
      if (line) changes.push(line);
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

// ---------- spaced repetition (scheduler.ts) ----------

export type Grade = "again" | "hard" | "good" | "easy";

/**
 * One review of a card. `using` is the learner state's scheduler record; without it the card is
 * scheduled by SM-2, exactly as before 0.10. The review is logged on the card either way.
 */
export function schedule(prev: CardSched | undefined, grade: Grade, today: string, using?: SchedulerRecord): CardSched {
  return reviewCard(prev, grade, today, using);
}

/** Due cards first, then unseen cards up to today's remaining allowance. Families kept for assessment are never new cards. */
export function reviewQueue(questions: Question[], s: LearnerState, today: string, newPerDay: number): Question[] {
  const due = questions.filter((q) => s.cards[q.id] && s.cards[q.id].due <= today);
  const used = s.newDate === today ? s.newCount : 0;
  const kept = reservedQuestions(questions);
  const fresh = questions.filter((q) => !s.cards[q.id] && !kept.has(q.id)).slice(0, Math.max(0, newPerDay - used));
  return [...due, ...fresh];
}

// ---------- quiz from the question bank, marked by plain code ----------

export function formatQuizQuestion(q: Question, s: LearnerState): string {
  const head = `**${s.names[q.subskill] ?? "Question"}**\n\n${q.question}`;
  if (q.type === "mcq") return `${head}\n\n${q.options.map((o) => `- ${o}`).join("\n")}\n\n*Reply with a letter.*`;
  // A code question shows its visible tests and starting code; hidden tests only after marking.
  if (q.code) return `${head}\n\n${renderCodeTask(q.code)}`;
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
  // Placement leaves the families kept for assessment unseen when the subskill has another.
  const kept = reservedQuestions(questions);
  const pick = (qs: Question[]) => qs.find((x) => x.type === "mcq") ?? qs.find((x) => x.type === "short");
  for (const n of Object.keys(s.names).map(Number).sort((a, b) => a - b)) {
    const mine = questions.filter((q) => q.subskill === n);
    const q = pick(mine.filter((x) => !kept.has(x.id))) ?? pick(mine);
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
  if (q.type === "short" && differentNumbers(answer, q.answer)) return "again";
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
  const held = reservedQuestions(questions);
  const cards = questions.filter((q) => !held.has(q.id)).map((q) => {
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
  /** The subskill the step is about, when it is about one. Following the step makes it the focus. */
  subskill?: number;
}

/** For each subskill, the subskills it lists as prerequisites (only ones that exist, never itself). */
export type Prereqs = Record<number, number[]>;

export function prereqMap(topic: Topic): Prereqs {
  const known = new Set(topic.subskills.map((k) => k.n));
  const out: Prereqs = {};
  for (const k of topic.subskills) out[k.n] = [...new Set(k.prerequisites)].filter((p) => p !== k.n && known.has(p));
  return out;
}

/** The direct prerequisites of `n` that the learner holds below level `need`, weakest first. */
export function weakPrereqs(s: LearnerState, pre: Prereqs, n: number, need: number): number[] {
  const lvl = (k: number) => s.levels[k] ?? -1;
  return (pre[n] ?? []).filter((p) => p in s.names && lvl(p) < need).sort((a, b) => lvl(a) - lvl(b) || a - b);
}

/**
 * Where to start in order to work on `n`: follows weak prerequisites down until it reaches a
 * subskill whose own prerequisites are sound. Returns `n` itself when nothing is in the way.
 */
export function foundationFor(s: LearnerState, pre: Prereqs, n: number, need: number): number {
  const seen = new Set<number>();
  let cur = n;
  while (!seen.has(cur)) {
    seen.add(cur);
    const weak = weakPrereqs(s, pre, cur, need).filter((p) => !seen.has(p));
    if (!weak.length) break;
    cur = weak[0];
  }
  return cur;
}

/** Places where the learner is further along in a subskill than in something it builds on. */
export function prereqGaps(s: LearnerState, pre: Prereqs): string[] {
  const out: string[] = [];
  for (const n of Object.keys(s.names).map(Number).sort((a, b) => a - b)) {
    const level = s.levels[n] ?? 0;
    if (level <= 0) continue;
    for (const p of pre[n] ?? []) if (p in s.names && (s.levels[p] ?? 0) < level) out.push(`${p} (${s.names[p]}, level ${s.levels[p] ?? "unset"}) is behind ${n} (${s.names[n]}, level ${level}), which builds on it`);
  }
  return out;
}

/**
 * The cheapest sensible next thing to do on a topic. Lessons and code-marked practice come
 * before Socratic tutoring, which is the most thorough mode and also the most expensive.
 * With the prerequisites passed in, a subskill is never suggested while something it builds
 * on is still weak: the weak prerequisite is suggested instead.
 */
export function nextStep(s: LearnerState, today: string, dueOverride?: number, pre: Prereqs = {}): NextStep {
  const ns = Object.keys(s.names).map(Number).sort((a, b) => a - b);
  if (!ns.length) return { action: "done", title: "Nothing to study yet", detail: "This topic has no subskills." };
  const lvl = (n: number) => s.levels[n];
  const because = (first: number, wanted: number) => (first === wanted ? "" : ` first: ${s.names[wanted]} builds on it`);
  // When another plugin keeps the flashcard schedule, its count of due cards is passed in.
  const due = dueOverride ?? dueCount(s, today);
  const untaught = ns.filter((n) => lvl(n) === null || (lvl(n) as number) <= 1);
  if (ns.every((n) => lvl(n) === null)) {
    const first = foundationFor(s, pre, ns[0], 2);
    return { action: "teach", title: "Learn", detail: `Start with a lesson on ${s.names[first]}.`, subskill: first };
  }
  // A wrong unaided answer after earlier success is the clearest sign of what to look at next.
  const lapsed = ns.filter((n) => (lvl(n) ?? 0) >= 2 && skillEvidence(s.attempts, n).lapse);
  if (lapsed.length) return { action: "auto", title: "Revisit", detail: `Your last unaided answer on ${s.names[lapsed[0]]} was wrong after earlier success. Find out what slipped.`, subskill: lapsed[0] };
  if (due > 0) return { action: "review", title: "Review", detail: `${due} flashcard${due === 1 ? " is" : "s are"} due. Reviewing uses no tokens.` };
  if (untaught.length) {
    // A lesson needs its prerequisites at "can follow along" (2) or better.
    const first = foundationFor(s, pre, untaught[0], 2);
    return { action: "teach", title: "Learn", detail: `Take a lesson on ${s.names[first]}${because(first, untaught[0])}.`, subskill: first };
  }
  const unpractised = ns.filter((n) => (s.bank[n]?.right ?? 0) < 2);
  if (unpractised.length) return { action: "quiz", title: "Practise", detail: `Quiz yourself on ${s.names[unpractised[0]]}. Most answers are marked without tokens.`, subskill: unpractised[0] };
  const below = ns.filter((n) => (lvl(n) ?? 0) < s.target).sort((a, b) => (lvl(a) ?? 0) - (lvl(b) ?? 0));
  if (below.length) {
    // Mastery needs its prerequisites at "can do with help" (3) or better.
    const first = foundationFor(s, pre, below[0], Math.min(3, s.target));
    return { action: "tutor", title: "Master", detail: `Work with the tutor on ${s.names[first]} (level ${lvl(first)} of ${s.target})${because(first, below[0])}.`, subskill: first };
  }
  // A level at target counts as reached only when the recorded attempts can hold it. A level
  // carried over from an older version, or set by placement alone, is checked before it is trusted.
  const unbacked = ns.filter((n) => !mastery(s, n).backed);
  if (unbacked.length) {
    const n = unbacked[0];
    const m = mastery(s, n);
    return { action: "auto", title: "Confirm", detail: `${s.names[n]} is recorded at level ${m.level}, but the answers recorded so far support level ${m.supported}. A short unaided check will settle it.`, subskill: n };
  }
  // Staleness is measured from unaided work: a helped answer is not fresh evidence of retention.
  const stale = ns.filter((n) => {
    const last = skillEvidence(s.attempts, n).lastIndependent;
    return !!last && addDays(last.slice(0, 10), STALE_DAYS) < today;
  });
  if (stale.length) return { action: "quiz", title: "Retrieval check", detail: `${s.names[stale[0]]} has not been practised for over ${STALE_DAYS} days. A few questions will show whether it has held.`, subskill: stale[0] };
  return { action: "done", title: "At target", detail: "Every subskill is at your target level, and your unaided answers back that up. Come back when flashcards are due." };
}

/** Days without practice after which a subskill at target is worth a retrieval check. */
export const STALE_DAYS = 21;

/** What to do with one subskill the learner picked from the graph: a lesson if it is new, otherwise the tutor. */
export function stepFor(s: LearnerState, n: number): NextStep {
  const level = s.levels[n];
  if (level === null || level === undefined || level <= 1) return { action: "teach", title: "Learn", detail: `Take a lesson on ${s.names[n]}.`, subskill: n };
  return { action: "tutor", title: "Master", detail: `Work with the tutor on ${s.names[n]}.`, subskill: n };
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
