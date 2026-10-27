// Calendar dates are stored as Postgres DATE, which Prisma returns as a Date at UTC midnight.
// "Today" depends on the user's timezone, so it is resolved here rather than on the server clock.

/** YYYY-MM-DD for the calendar day `at` falls on in the given IANA timezone. */
export function localDate(timezone: string, at = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

export const todayIn = (timezone: string) => localDate(timezone);

/** A YYYY-MM-DD string as a UTC-midnight Date, matching how DATE columns come back. */
export function toDate(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

/** The UTC instant at which ymd begins in the given timezone. */
export function startOfDay(ymd: string, timezone: string): Date {
  const utcMidnight = toDate(ymd);
  const wall = (tz: string) =>
    new Date(utcMidnight.toLocaleString('en-US', { timeZone: tz })).getTime();
  return new Date(utcMidnight.getTime() - (wall(timezone) - wall('UTC')));
}

export function addDays(ymd: string, days: number): string {
  const d = toDate(ymd);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Monday of the week containing ymd. */
export function weekStart(ymd: string): string {
  const d = toDate(ymd);
  const offset = (d.getUTCDay() + 6) % 7;
  return addDays(ymd, -offset);
}
