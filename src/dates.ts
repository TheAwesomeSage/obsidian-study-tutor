// Calendar-day arithmetic on "YYYY-MM-DD" strings (a longer ISO stamp is cut to its date), done in
// UTC so a daylight-saving change never moves a day. Pure; the one place these are written.

/** Whole days since 1970-01-01 for the date a "YYYY-MM-DD" string names. NaN for text that is no date. */
export const dayNumber = (day: string): number => {
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
};

/** The date `n` days after (or before, when negative) `day`. */
export const addDays = (day: string, n: number): string => new Date((dayNumber(day) + n) * 86400000).toISOString().slice(0, 10);

/** Days from `from` to `to`: positive when `to` is later. */
export const daysBetween = (from: string, to: string): number => dayNumber(to) - dayNumber(from);
