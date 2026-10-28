// Minimal iCalendar (RFC 5545) writer for follow-up events: all-day, or timed
// (in UTC) when the follow-up has a time.

export interface IcsEvent {
  uid: string;
  /** YYYY-MM-DD; the event is all-day unless `start` is given. */
  date: string;
  /** Start of a timed, 30-minute event. */
  start?: Date;
  /** Alert this many minutes before a timed event. */
  alarmMinutes?: number;
  summary: string;
  description?: string;
  url?: string;
}

const escapeText = (s: string) =>
  s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');

/** Lines longer than 75 octets continue on the next line after a space. */
function fold(line: string) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + (start ? 74 : 75), bytes.length);
    // Don't split a multi-byte character.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    parts.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
  }
  return parts.join('\r\n ');
}

const compact = (ymd: string) => ymd.replace(/-/g, '');
/** 2026-11-05T13:00:00.000Z -> 20261105T130000Z */
const utc = (d: Date) =>
  d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');

function nextDay(ymd: string) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function buildCalendar(
  name: string,
  events: IcsEvent[],
  now = new Date(),
) {
  const stamp = utc(now);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Coverage//Follow-ups//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
    'X-PUBLISHED-TTL:PT1H',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
  ];
  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTAMP:${stamp}`,
      ...(e.start
        ? [
            `DTSTART:${utc(e.start)}`,
            `DTEND:${utc(new Date(e.start.getTime() + 30 * 60_000))}`,
          ]
        : [
            `DTSTART;VALUE=DATE:${compact(e.date)}`,
            `DTEND;VALUE=DATE:${compact(nextDay(e.date))}`,
          ]),
      `SUMMARY:${escapeText(e.summary)}`,
      ...(e.description ? [`DESCRIPTION:${escapeText(e.description)}`] : []),
      ...(e.url ? [`URL:${e.url}`] : []),
      // All-day reminders don't block the day; a timed meeting does.
      e.start ? 'TRANSP:OPAQUE' : 'TRANSP:TRANSPARENT',
      ...(e.start && e.alarmMinutes !== undefined
        ? [
            'BEGIN:VALARM',
            'ACTION:DISPLAY',
            `DESCRIPTION:${escapeText(e.summary)}`,
            `TRIGGER:-PT${e.alarmMinutes}M`,
            'END:VALARM',
          ]
        : []),
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
