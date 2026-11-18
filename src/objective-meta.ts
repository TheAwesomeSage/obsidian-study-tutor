// Exam metadata on a specification objective: the tolerant syntax an objective line in a topic
// card (or the specification text it came from) may carry after its text. docs/OBJECTIVE-METADATA.md
// documents it. Pure functions with no imports, so formats.ts and coursepkg.ts can both use it.

/**
 * Exam metadata an objective line may carry, in a trailing group such as
 * "(weight 8%, paper 2, command: derive, 6 marks, 8 min)". Every field is optional, and a value
 * that does not read cleanly is left out. docs/OBJECTIVE-METADATA.md gives the syntax.
 */
export interface ObjectiveExam {
  /** Share of the exam's marks, from 0 to 1 ("weight 8%"). */
  weight?: number;
  /** Paper or component ("Paper 2", "Component B"). */
  paper?: string;
  /** Command words, lower case ("derive", "explain"). */
  commands?: string[];
  /** Typical marks for a question on it. */
  marks?: number;
  /** Typical minutes for such a question. */
  minutes?: number;
  /** This objective's exam date (yyyy-mm-dd), when it differs from the topic's. */
  date?: string;
}

/** A calendar date written yyyy-mm-dd (or with / or . between), as yyyy-mm-dd. Null when it is not a real date. */
export function examDay(text: string): string | null {
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null;
}

/** Command words read without a "command:" key, but only next to another exam field. */
const COMMAND_WORDS = new Set(["analyse", "analyze", "apply", "assess", "calculate", "compare", "compute", "construct", "contrast", "deduce", "define", "derive", "describe", "determine", "differentiate", "discuss", "draw", "estimate", "evaluate", "explain", "expand", "factorise", "factorize", "find", "identify", "integrate", "interpret", "justify", "label", "list", "name", "outline", "plot", "predict", "prove", "show", "simplify", "sketch", "solve", "state", "suggest", "verify"]);
const EXAM_KEY = /^(?:weight(?:ing)?|share|paper|component|unit|marks?|minutes?|mins?|time|exam|date|commands?|command\s+words?)\b/i;

/** Reads the parts of one bracketed group. Parts that read cleanly set a field; the rest are returned. */
function examParts(inner: string): { exam: ObjectiveExam; read: number; ignored: string[]; rest: string[] } {
  const exam: ObjectiveExam = {};
  const ignored: string[] = [];
  const rest: string[] = [];
  const bare: string[] = [];
  let read = 0;
  const num = (s: string) => Number(s);
  for (const raw of inner.split(/[;,]/)) {
    const p = raw.trim();
    if (!p) continue;
    let m: RegExpExecArray | null;
    let ok = false;
    if ((m = /^(?:weight(?:ing)?|share)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*%?(?:\s+of\s+(?:the\s+)?(?:marks|exam))?$/i.exec(p) ?? /^(\d+(?:\.\d+)?)\s*%(?:\s+of\s+(?:the\s+)?(?:marks|exam))?$/i.exec(p))) {
      const v = num(m[1]);
      if (v > 0 && v <= 100) [exam.weight, ok] = [Math.round(v * 100) / 10000, true];
    } else if ((m = /^(paper|component|unit)\s*[:=]?\s*(?:paper\s+)?(\d{1,2}[A-Za-z]?|[A-Za-z]\d{0,2}|[IVX]{1,4}|one|two|three|four)$/i.exec(p))) {
      [exam.paper, ok] = [`${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}`, true];
    } else if ((m = /^(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?\s*marks?$/i.exec(p) ?? /^marks?\s*[:=]?\s*(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?$/i.exec(p))) {
      const lo = num(m[1]), hi = m[2] ? num(m[2]) : lo;
      if (lo >= 1 && hi >= lo && hi <= 200) [exam.marks, ok] = [Math.round((lo + hi) / 2), true];
    } else if ((m = /^(\d{1,3}(?:\.\d+)?)\s*(?:min|mins|minutes?)$/i.exec(p) ?? /^(?:minutes?|mins?|time)\s*[:=]?\s*(\d{1,3}(?:\.\d+)?)(?:\s*(?:min|mins|minutes?))?$/i.exec(p))) {
      const v = num(m[1]);
      if (v > 0 && v <= 300) [exam.minutes, ok] = [v, true];
    } else if ((m = /^(?:(?:exam(?:\s+date)?|date)\s*[:=]?\s*)?(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})$/i.exec(p))) {
      const d = examDay(m[1]);
      if (d) [exam.date, ok] = [d, true];
    } else if ((m = /^(?:commands?|command\s+words?)\s*[:=]?\s*(.+)$/i.exec(p))) {
      const words = m[1].toLowerCase().split(/\s*(?:[/&+]|\band\b|\bor\b)\s*|\s+/).filter((w) => /^[a-z][a-z-]{1,19}$/.test(w));
      if (words.length) [exam.commands, ok] = [[...new Set([...(exam.commands ?? []), ...words])], true];
    } else if (COMMAND_WORDS.has(p.toLowerCase())) {
      bare.push(p.toLowerCase());
      continue;
    }
    if (ok) read++;
    else if (EXAM_KEY.test(p)) ignored.push(p);
    else rest.push(p);
  }
  // A bare command word counts only beside another exam field: "(derive)" alone stays a source.
  if (read) {
    if (bare.length) exam.commands = [...new Set([...(exam.commands ?? []), ...bare])];
  } else rest.push(...bare);
  return { exam, read, ignored, rest };
}

/**
 * Splits an objective's text from its trailing groups: exam metadata in "(...)" or "{...}", and
 * the source in the last other "(...)". Metadata that does not read cleanly is ignored, never an
 * error, and a group with nothing that reads as metadata is treated as before: as the source.
 */
export function readObjectiveLine(line: string): { text: string; source: string; exam: ObjectiveExam | null; ignored: string[] } {
  let rest = line.trim();
  let source = "";
  let exam: ObjectiveExam | null = null;
  const ignored: string[] = [];
  for (let guard = 0; guard < 6; guard++) {
    const g = /\s*(?:\(([^()]*)\)|\{([^{}]*)\})\s*$/.exec(rest);
    if (!g) break;
    const paren = g[1] !== undefined;
    const inner = (paren ? g[1] : g[2]).trim();
    const r = examParts(inner);
    if (r.read) {
      // Peeled from the right, so a field given twice keeps its leftmost value.
      const commands: string[] = [...new Set([...(r.exam.commands ?? []), ...(exam?.commands ?? [])])];
      exam = { ...(exam ?? {}), ...r.exam, ...(commands.length ? { commands } : {}) };
      ignored.unshift(...r.ignored);
      if (!source && r.rest.length) source = r.rest.join(", ");
      rest = rest.slice(0, g.index);
      continue;
    }
    if (source || !paren) break;
    source = inner;
    rest = rest.slice(0, g.index);
  }
  return { text: rest.trim(), source, exam, ignored };
}
