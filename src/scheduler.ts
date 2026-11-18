// Flashcard scheduling behind one versioned boundary. SM-2 (what Study Tutor has always used) and
// FSRS-6 both implement `Scheduler`. Every card keeps a short review log and its SM-2 fields up to
// date whichever scheduler is active, so switching to FSRS replays the log and switching back is a
// rollback that loses nothing. Pure functions, no Obsidian imports.

import type { Attempt } from "./evidence";
import type { CardSched, Grade } from "./formats";

export type SchedulerId = "sm2" | "fsrs";

/** One review in a card's log. */
export interface ReviewEntry {
  day: string;
  grade: Grade;
}

/** The SM-2 part of a card: everything SM-2 needs to schedule it. */
export type Sm2State = Pick<CardSched, "due" | "interval" | "ease" | "reps" | "lapses">;

/** FSRS memory state: stability in days, difficulty from 1 to 10, and the day of the last review. */
export interface FsrsMemory {
  s: number;
  d: number;
  last: string;
}

export interface Scheduler {
  /** Stored in the learner state with the version, as "fsrs@6". */
  readonly id: SchedulerId;
  /** Bumped whenever the same history would be scheduled differently. */
  readonly version: number;
  /** For settings, as "FSRS-6". */
  readonly label: string;
  /** The card after one review graded `grade` on `today`: `due` and this scheduler's own fields. The rest of the card, the log included, is kept as it was. */
  next(card: CardSched | undefined, grade: Grade, today: string): CardSched;
  /** The card with `due` and this scheduler's own fields rebuilt from its review log, or from its SM-2 fields when it has no log. */
  rebuild(card: CardSched): CardSched;
}

/** What the settings ask for. */
export interface SchedulerChoice {
  id: SchedulerId;
  /** FSRS desired retention: the chance of recall a card is scheduled for. Ignored by SM-2. */
  retention: number;
}

/** The scheduler a learner state's card dates come from, with every switch. Absent in states from before 0.10, which are SM-2 version 1. */
export interface SchedulerRecord {
  id: SchedulerId;
  version: number;
  /** FSRS only. */
  retention?: number;
  /** Oldest first, at most MAX_SWITCHES. `from` and `to` are refs such as "sm2@1" and "fsrs@6:0.9". */
  switches: { at: string; from: string; to: string; cards: number }[];
}

/** Reviews kept per card. Older ones are folded into `logFrom`, the SM-2 state before the log. */
export const REVIEW_LOG_MAX = 32;
const MAX_SWITCHES = 20;
export const DEFAULT_RETENTION = 0.9;
export const RETENTION_RANGE: [number, number] = [0.7, 0.97];

// ---------- dates ----------

const dayNumber = (day: string): number => {
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
};
const addDays = (day: string, n: number): string => new Date((dayNumber(day) + n) * 86400000).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string): number => dayNumber(to) - dayNumber(from);
const round = (x: number, places: number): number => Math.round(x * 10 ** places) / 10 ** places;

// ---------- SM-2, exactly as Study Tutor scheduled cards up to 0.9 ----------

export const SM2: Scheduler = {
  id: "sm2",
  version: 1,
  label: "SM-2",
  next(card, grade, today) {
    const c: CardSched = card ? { ...card } : { due: today, interval: 0, ease: 2.5, reps: 0, lapses: 0 };
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
  },
  rebuild(card) {
    let st: Sm2State | undefined = card.log?.length ? card.logFrom : sm2State(card);
    for (const e of card.log ?? []) st = sm2Part(SM2.next(st, e.grade, e.day));
    const out: CardSched = { ...card, ...st! };
    delete out.fsrs;
    return out;
  },
};

const sm2Part = (c: CardSched | Sm2State): Sm2State => ({ due: c.due, interval: c.interval, ease: c.ease, reps: c.reps, lapses: c.lapses });

/** The day SM-2 has the card due. Under FSRS `due` is FSRS's, and SM-2's is its interval after the last review. */
export const sm2Due = (c: CardSched): string => (c.fsrs ? addDays(c.fsrs.last, c.interval) : c.due);

/** The card's SM-2 state as SM-2 alone would have it. */
export const sm2State = (c: CardSched): Sm2State => ({ ...sm2Part(c), due: sm2Due(c) });

// ---------- FSRS-6 ----------

/**
 * FSRS-6 default parameters w0..w20, as published by open-spaced-repetition: DEFAULT_PARAMETERS
 * in py-fsrs (fsrs/scheduler.py, the FSRS-6 scheduler) and FSRS6_DEFAULT_PARAMETERS in fsrs-rs.
 * w20 is the decay of the forgetting curve.
 */
export const FSRS6_DEFAULT_W: readonly number[] = [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542];

const W = FSRS6_DEFAULT_W;
const RATING: Record<Grade, number> = { again: 1, hard: 2, good: 3, easy: 4 };
const S_MIN = 0.001;
const MAX_INTERVAL = 36500;
const DECAY = -W[20];
/** Chosen so that recall is exactly 90% when the days elapsed equal the stability. */
const FACTOR = 0.9 ** (1 / DECAY) - 1;
const clampD = (d: number): number => Math.min(10, Math.max(1, d));
const initialD = (g: number): number => W[4] - Math.exp(W[5] * (g - 1)) + 1;

/** Probability of recall after `days`, at stability `s`. */
export const retrievability = (days: number, s: number): number => (1 + (FACTOR * Math.max(0, days)) / s) ** DECAY;

/** Whole days until recall falls to `retention`, at stability `s`, from 1 day to 100 years. */
export const fsrsInterval = (s: number, retention: number): number => Math.min(MAX_INTERVAL, Math.max(1, Math.round((s / FACTOR) * (retention ** (1 / DECAY) - 1))));

/**
 * One FSRS-6 review, at day granularity and without learning steps. A first review starts the
 * memory from w0..w3 and the initial difficulty. A review on the same day as the last one (a
 * card failed and then retried, or met in a quiz and in review the same day) uses FSRS-6's
 * short-term stability, which cannot fall for a pass; otherwise the usual recall or forgetting
 * stability applies. Stability and difficulty are rounded to 4 places, so a stored card steps
 * exactly as a replayed one.
 */
export function fsrsStep(mem: FsrsMemory | undefined, grade: Grade, today: string): FsrsMemory {
  const g = RATING[grade];
  if (!mem) return { s: round(Math.max(S_MIN, W[g - 1]), 4), d: round(clampD(initialD(g)), 4), last: today };
  const t = Math.max(0, daysBetween(mem.last, today));
  const { s, d } = mem;
  let next: number;
  if (t < 1) {
    let inc = Math.exp(W[17] * (g - 3 + W[18])) * s ** -W[19];
    if (g >= 2) inc = Math.max(inc, 1);
    next = s * inc;
  } else {
    const r = retrievability(t, s);
    if (g === 1) next = Math.min(W[11] * d ** -W[12] * ((s + 1) ** W[13] - 1) * Math.exp((1 - r) * W[14]), s / Math.exp(W[17] * W[18]));
    else next = s * (1 + Math.exp(W[8]) * (11 - d) * s ** -W[9] * (Math.exp((1 - r) * W[10]) - 1) * (g === 2 ? W[15] : 1) * (g === 4 ? W[16] : 1));
  }
  // Difficulty: linear damping towards 10, then mean reversion to the initial difficulty of an easy first review.
  const damped = d + ((10 - d) * -W[6] * (g - 3)) / 9;
  const nd = clampD(W[7] * initialD(4) + (1 - W[7]) * damped);
  return { s: round(Math.max(S_MIN, next), 4), d: round(nd, 4), last: today };
}

/**
 * An FSRS memory state for a card known only by its SM-2 numbers (a card from before review logs,
 * or the summary of reviews trimmed from a long log). This follows the approach of fsrs-rs
 * `memory_state_from_sm2` with SM-2 taken to aim at 90% recall: the stability is the SM-2
 * interval (at 90% the stability is the interval), and the difficulty is solved from the ease, so
 * that a successful review at 90% recall grows stability by the ease, as SM-2 grows the interval:
 * D = 11 - (ease - 1) / (e^w8 * S^-w9 * (e^(0.1 * w10) - 1)), clamped to 1..10. A card whose last
 * review was a lapse (reps 0, interval 0) takes the stability of a failed first review, w0. The
 * last review is SM-2's due day less its interval. A card never reviewed has no memory.
 */
export function memoryFromSm2(st: Sm2State): FsrsMemory | undefined {
  if (st.reps === 0 && st.lapses === 0) return undefined;
  const s = st.reps === 0 || st.interval <= 0 ? W[0] : st.interval;
  const growth = Math.exp(W[8]) * s ** -W[9] * (Math.exp(0.1 * W[10]) - 1);
  return { s: round(Math.max(S_MIN, s), 4), d: round(clampD(11 - (st.ease - 1) / growth), 4), last: addDays(st.due, -st.interval) };
}

/** The card's FSRS memory from its history: the log replayed from `logFrom` (or from nothing), else its SM-2 fields. */
export function memoryOf(card: CardSched): FsrsMemory | undefined {
  if (!card.log?.length) return memoryFromSm2(sm2State(card));
  let mem = card.logFrom ? memoryFromSm2(card.logFrom) : undefined;
  for (const e of card.log) mem = fsrsStep(mem, e.grade, e.day);
  return mem;
}

const lastWasLapse = (c: CardSched): boolean => (c.log?.length ? c.log[c.log.length - 1].grade === "again" : c.reps === 0);

/** FSRS's due day: today after a lapse, so the card is relearned the same day, otherwise the interval for the desired retention. */
const fsrsDue = (mem: FsrsMemory, lapse: boolean, retention: number): string => (lapse ? mem.last : addDays(mem.last, fsrsInterval(mem.s, retention)));

/** A desired retention within RETENTION_RANGE, to two places. Anything unreadable is the default. */
export const clampRetention = (r: number): number => (Number.isFinite(r) ? round(Math.min(RETENTION_RANGE[1], Math.max(RETENTION_RANGE[0], r)), 2) : DEFAULT_RETENTION);

export function fsrsScheduler(retention = DEFAULT_RETENTION): Scheduler {
  const r = clampRetention(retention);
  return {
    id: "fsrs",
    version: 6,
    label: "FSRS-6",
    next(card, grade, today) {
      const mem = fsrsStep(card ? card.fsrs ?? memoryOf(card) : undefined, grade, today);
      return { ...(card ?? { interval: 0, ease: 2.5, reps: 0, lapses: 0 }), fsrs: mem, due: fsrsDue(mem, grade === "again", r) };
    },
    rebuild(card) {
      const mem = memoryOf(card);
      const out: CardSched = { ...card };
      if (!mem) return out;
      out.fsrs = mem;
      out.due = fsrsDue(mem, lastWasLapse(card), r);
      return out;
    },
  };
}

/** The scheduler a record or a choice names. No record means SM-2, as every state before 0.10. */
export function schedulerFor(x?: SchedulerRecord | SchedulerChoice): Scheduler {
  return x?.id === "fsrs" ? fsrsScheduler(x.retention ?? DEFAULT_RETENTION) : SM2;
}

/** "sm2@1" or "fsrs@6:0.9": what a record (at the version it was written with) or a choice schedules with. */
export function schedulerRef(x?: SchedulerRecord | SchedulerChoice): string {
  const s = schedulerFor(x);
  const version = x && "version" in x ? x.version : s.version;
  return s.id === "fsrs" ? `fsrs@${version}:${clampRetention(x?.retention ?? DEFAULT_RETENTION)}` : `sm2@${version}`;
}

/** For settings: "FSRS-6, retention 0.9" or "SM-2". */
export function schedulerLabel(x?: SchedulerRecord | SchedulerChoice): string {
  const s = schedulerFor(x);
  return s.id === "fsrs" ? `${s.label}, retention ${x?.retention ?? DEFAULT_RETENTION}` : s.label;
}

// ---------- one review, and switching ----------

/** The log after one more review, with anything older than REVIEW_LOG_MAX folded into `logFrom`. */
function withLog(c: CardSched, prev: CardSched | undefined, grade: Grade, today: string): CardSched {
  const log = [...(prev?.log ?? []), { day: today, grade }];
  // A card reviewed before logs began starts its log from its SM-2 state; a new card from nothing.
  let from: Sm2State | undefined = prev?.log?.length ? prev.logFrom : prev ? sm2State(prev) : undefined;
  while (log.length > REVIEW_LOG_MAX) {
    const e = log.shift()!;
    from = sm2Part(SM2.next(from, e.grade, e.day));
  }
  c.log = log;
  if (from) c.logFrom = from;
  else delete c.logFrom;
  return c;
}

/**
 * One review of a card under the scheduler a learner state records. SM-2's fields are updated
 * whatever is active, the review is logged, and the active scheduler sets `due`.
 */
export function reviewCard(prev: CardSched | undefined, grade: Grade, today: string, using?: SchedulerRecord): CardSched {
  const active = schedulerFor(using);
  let c = SM2.next(prev, grade, today);
  if (active.id === "sm2") delete c.fsrs;
  else {
    const f = active.next(prev, grade, today);
    c = { ...c, fsrs: f.fsrs, due: f.due };
  }
  return withLog(c, prev, grade, today);
}

/**
 * Brings a learner state onto the scheduler the settings choose, and records the switch. To FSRS,
 * each card's memory is rebuilt from its log; back to SM-2, each card's date is SM-2's own, which
 * was kept up to date all along. A change of retention alone re-dates FSRS cards from their stored
 * memory. A state with no record that stays on SM-2 is left exactly as it was. Returns whether
 * anything changed, so the caller knows to save.
 */
export function syncScheduler(state: { cards: Record<string, CardSched>; scheduler?: SchedulerRecord }, wanted: SchedulerChoice, today: string): boolean {
  const choice: SchedulerChoice = { id: wanted.id === "fsrs" ? "fsrs" : "sm2", retention: clampRetention(wanted.retention) };
  const cur = state.scheduler;
  const from = schedulerRef(cur);
  const to = schedulerRef(choice);
  if (from === to) return false;
  const want = schedulerFor(choice);
  const ids = Object.keys(state.cards);
  const record: SchedulerRecord = { id: want.id, version: want.version, ...(want.id === "fsrs" ? { retention: choice.retention } : {}), switches: [...(cur?.switches ?? [])] };
  // A state with no cards and no record has nothing to switch: it simply starts on the choice.
  if (cur || ids.length) record.switches = [...record.switches, { at: today, from, to, cards: ids.length }].slice(-MAX_SWITCHES);
  const sameFsrs = cur?.id === "fsrs" && want.id === "fsrs" && cur.version === want.version;
  for (const id of ids) {
    const c = state.cards[id];
    if (want.id === "sm2") {
      const back: CardSched = { ...c, due: sm2Due(c) };
      delete back.fsrs;
      state.cards[id] = back;
    } else if (sameFsrs && c.fsrs) {
      state.cards[id] = { ...c, due: fsrsDue(c.fsrs, lastWasLapse(c), choice.retention) };
    } else state.cards[id] = want.rebuild(c);
  }
  state.scheduler = record;
  return true;
}

// ---------- who owns the schedule ----------

export type ScheduleOwner = "study-tutor" | "spaced-repetition";

/**
 * Who keeps the flashcard schedule. This is the one place it is decided, so the two plugins never
 * both schedule the same cards: the Spaced Repetition plugin owns it exactly when the setting
 * "Review flashcards in the Spaced Repetition plugin" is on and that plugin is enabled in the
 * vault. Otherwise Study Tutor does. The engine is handed the answer as `externalFlashcards`.
 */
export function scheduleOwner(handOff: boolean, pluginEnabled: boolean): ScheduleOwner {
  return handOff && pluginEnabled ? "spaced-repetition" : "study-tutor";
}

/** Asked by every place that would schedule a card: does Study Tutor schedule it? Takes the decided owner, or engine settings that carry it. */
export function tutorSchedules(x: ScheduleOwner | { externalFlashcards?: boolean }): boolean {
  return typeof x === "string" ? x === "study-tutor" : !x.externalFlashcards;
}

// ---------- time per item, and timed mixed sessions ----------

/** Seconds per review item until enough answers have been timed. A stated guess, not a measurement. */
export const DEFAULT_SECONDS_PER_ITEM = 60;
/** Below this many timed answers the default is used. */
export const MIN_TIMED_ANSWERS = 5;

/** Median seconds per answer over the latest 200 timed answers, or the default when there are too few. */
export function secondsPerItem(attempts: Pick<Attempt, "seconds" | "timestamp">[]): { seconds: number; timed: number; fallback: boolean } {
  const timed = attempts.filter((a) => typeof a.seconds === "number" && a.seconds > 0 && a.seconds <= 3600).sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0)).slice(-200);
  if (timed.length < MIN_TIMED_ANSWERS) return { seconds: DEFAULT_SECONDS_PER_ITEM, timed: timed.length, fallback: true };
  const xs = timed.map((a) => a.seconds!).sort((a, b) => a - b);
  const mid = xs.length >> 1;
  return { seconds: Math.round(xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2), timed: xs.length, fallback: false };
}

/** The day of a card's last review: FSRS's record of it, the log's, or SM-2's due day less its interval. */
export const lastReview = (c: CardSched): string => c.fsrs?.last ?? c.log?.[c.log.length - 1]?.day ?? addDays(c.due, -c.interval);

/** Days since the last review over the days it was scheduled for (at least 1). 1 is due today; 2 is twice as long as planned. */
export const overdueRatio = (c: { due: string; last: string }, today: string): number => Math.max(0, daysBetween(c.last, today)) / Math.max(1, daysBetween(c.last, c.due));

export interface MixItem {
  /** Unique across the session, e.g. topic folder and card id. */
  id: string;
  /** Items in one group (a subskill of a topic) are kept apart. */
  group: string;
  due: string;
  last: string;
  /** Estimated seconds to answer. */
  seconds: number;
}

/**
 * A timed mixed session: due items only, the most overdue (by overdue ratio) first, as many as fit
 * in `minutes` by their estimates, then ordered so that no two items in a row share a group
 * whenever some order allows it. Pure.
 */
export function timedMix<T extends MixItem>(items: T[], minutes: number, today: string): T[] {
  const ratio = new Map(items.map((i) => [i.id, overdueRatio(i, today)]));
  const ranked = items.filter((i) => i.due <= today).sort((a, b) => ratio.get(b.id)! - ratio.get(a.id)! || (a.due < b.due ? -1 : a.due > b.due ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let budget = Math.max(0, minutes) * 60;
  const chosen: T[] = [];
  for (const i of ranked) {
    if (i.seconds > budget) continue;
    chosen.push(i);
    budget -= i.seconds;
  }
  // Greedy in rank order, taking the best item from a different group that still leaves an order
  // with no repeats; when no such item exists a repeat cannot be avoided, and rank decides.
  const left = [...chosen];
  const out: T[] = [];
  const feasible = (rest: T[], prev: string): boolean => {
    const counts = new Map<string, number>();
    for (const i of rest) counts.set(i.group, (counts.get(i.group) ?? 0) + 1);
    for (const [g, n] of counts) if (n > (g === prev ? Math.floor(rest.length / 2) : Math.ceil(rest.length / 2))) return false;
    return true;
  };
  while (left.length) {
    const prev = out.length ? out[out.length - 1].group : "";
    let pick = left.findIndex((i, k) => i.group !== prev && feasible([...left.slice(0, k), ...left.slice(k + 1)], i.group));
    if (pick < 0) pick = left.findIndex((i) => i.group !== prev);
    if (pick < 0) pick = 0;
    out.push(left.splice(pick, 1)[0]);
  }
  return out;
}

// ---------- the review log and FSRS memory in the state file's table ----------

const LETTER: Record<Grade, string> = { again: "a", hard: "h", good: "g", easy: "e" };
const FROM_LETTER: Record<string, Grade> = { a: "again", h: "hard", g: "good", e: "easy" };
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** "10.9654/2.1181/2026-11-03", or "" when the card has no FSRS memory. */
export const formatMemory = (m?: FsrsMemory): string => (m ? `${m.s}/${m.d}/${m.last}` : "");

export function parseMemory(cell: string): FsrsMemory | undefined {
  const [s, d, last] = cell.split("/");
  const sn = Number(s);
  const dn = Number(d);
  return s && d && Number.isFinite(sn) && sn > 0 && Number.isFinite(dn) && DAY.test(last ?? "") ? { s: sn, d: clampD(dn), last } : undefined;
}

/** "from:2026-10-01/6/2.5/2/0 2026-11-01g 2026-11-04a": the SM-2 state before the log, if any, then each review. */
export function formatLog(c: Pick<CardSched, "log" | "logFrom">): string {
  const parts = c.logFrom ? [`from:${c.logFrom.due}/${c.logFrom.interval}/${c.logFrom.ease}/${c.logFrom.reps}/${c.logFrom.lapses}`] : [];
  for (const e of c.log ?? []) parts.push(e.day + LETTER[e.grade]);
  return parts.join(" ");
}

/** Reads a log cell. Anything unreadable is dropped, so a damaged cell costs only its own entries. */
export function parseLog(cell: string): Pick<CardSched, "log" | "logFrom"> {
  const out: Pick<CardSched, "log" | "logFrom"> = {};
  const log: ReviewEntry[] = [];
  for (const tok of cell.split(/\s+/).filter(Boolean)) {
    const f = /^from:(\d{4}-\d{2}-\d{2})\/(\d+)\/([\d.]+)\/(\d+)\/(\d+)$/.exec(tok);
    if (f) out.logFrom = { due: f[1], interval: Number(f[2]), ease: Number(f[3]) || 2.5, reps: Number(f[4]), lapses: Number(f[5]) };
    const m = /^(\d{4}-\d{2}-\d{2})([ahge])$/.exec(tok);
    if (m) log.push({ day: m[1], grade: FROM_LETTER[m[2]] });
  }
  if (log.length) out.log = log.slice(-REVIEW_LOG_MAX);
  return out;
}

/** Reads the scheduler fields of a state file's frontmatter. Unknown or damaged values mean no record (SM-2). */
export function parseSchedulerRecord(ref: string, retention: number, switchesJson: string): SchedulerRecord | undefined {
  const m = /^(sm2|fsrs)@(\d+)$/.exec(ref.trim());
  if (!m) return undefined;
  let switches: SchedulerRecord["switches"] = [];
  try {
    const raw: unknown = JSON.parse(switchesJson || "[]");
    if (Array.isArray(raw)) switches = raw.filter((x) => x && typeof x.at === "string" && typeof x.from === "string" && typeof x.to === "string").map((x) => ({ at: x.at, from: x.from, to: x.to, cards: Number(x.cards) || 0 }));
  } catch {
    /* a damaged switch log is dropped; the record itself still holds */
  }
  const id = m[1] as SchedulerId;
  return { id, version: Number(m[2]), ...(id === "fsrs" ? { retention: Number.isFinite(retention) && retention > 0 ? retention : DEFAULT_RETENTION } : {}), switches };
}
