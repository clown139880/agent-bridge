/**
 * Five-field cron (minute hour day-of-month month day-of-week) in an IANA time zone: lists,
 * ranges, steps and `*`; day-of-week 0–7 with 0 and 7 as Sunday. When both day fields are
 * restricted, either may match, as in Vixie cron.
 */
export interface Cron { minute: Set<number>; hour: Set<number>; day: Set<number>; month: Set<number>; weekday: Set<number>;
  anyDay: boolean; anyWeekday: boolean }

const FIELDS: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

export function parseCron(expression: string): Cron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron needs five fields: ${expression}`);
  const sets = parts.map((part, index) => field(part, ...FIELDS[index]!));
  const weekday = new Set([...sets[4]!].map((value) => value % 7));
  return { minute: sets[0]!, hour: sets[1]!, day: sets[2]!, month: sets[3]!, weekday, anyDay: parts[2] === "*", anyWeekday: parts[4] === "*" };
}

function field(text: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const item of text.split(",")) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
    if (!match) throw new Error(`invalid cron field: ${text}`);
    const step = match[4] ? Number(match[4]) : 1;
    const from = match[1] === "*" ? min : Number(match[2]);
    const to = match[1] === "*" ? max : match[3] ? Number(match[3]) : match[4] ? max : from;
    if (step < 1 || from < min || to > max || from > to) throw new Error(`cron field out of range: ${text}`);
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The wall-clock fields of an instant in `timeZone`. */
function local(ms: number, timeZone: string): { minute: number; hour: number; day: number; month: number; weekday: number } {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", minute: "numeric", hour: "numeric",
      day: "numeric", month: "numeric", weekday: "short" });
    formatters.set(timeZone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(ms).map((part) => [part.type, part.value]));
  return { minute: Number(parts.minute), hour: Number(parts.hour), day: Number(parts.day), month: Number(parts.month),
    weekday: WEEKDAYS[parts.weekday!]! };
}

/** The first matching minute strictly after `after`, within a year; undefined if none. */
export function nextCron(cron: Cron, after: number, timeZone: string): number | undefined {
  const MINUTE = 60_000;
  let at = Math.floor(after / MINUTE) * MINUTE + MINUTE;
  for (const limit = at + 366 * 86_400_000; at < limit;) {
    const t = local(at, timeZone);
    const dayMatches = cron.anyDay && cron.anyWeekday ? true
      : cron.anyDay ? cron.weekday.has(t.weekday)
        : cron.anyWeekday ? cron.day.has(t.day)
          : cron.day.has(t.day) || cron.weekday.has(t.weekday);
    if (!cron.month.has(t.month) || !dayMatches) { at += (24 * 60 - t.hour * 60 - t.minute) * MINUTE; continue; }
    if (!cron.hour.has(t.hour)) { at += (60 - t.minute) * MINUTE; continue; }
    if (cron.minute.has(t.minute)) return at;
    at += MINUTE;
  }
  return undefined;
}
