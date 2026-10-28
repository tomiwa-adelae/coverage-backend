import { buildCalendar } from '../calendar/ics';
import { clock, instantOf } from './dates';

describe('instantOf', () => {
  it('turns Lagos local time into the right UTC instant', () => {
    expect(instantOf('2026-11-05', '14:00', 'Africa/Lagos').toISOString()).toBe(
      '2026-11-05T13:00:00.000Z',
    );
  });

  it('handles times just after midnight', () => {
    expect(instantOf('2026-11-05', '00:30', 'Africa/Lagos').toISOString()).toBe(
      '2026-11-04T23:30:00.000Z',
    );
  });

  it('follows the user’s own timezone', () => {
    expect(
      instantOf('2026-07-01', '09:15', 'Europe/London').toISOString(),
    ).toBe('2026-07-01T08:15:00.000Z');
  });
});

describe('clock', () => {
  it.each([
    ['00:05', '12:05 am'],
    ['09:30', '9:30 am'],
    ['12:00', '12:00 pm'],
    ['14:05', '2:05 pm'],
  ])('%s -> %s', (hhmm, label) => expect(clock(hhmm)).toBe(label));
});

describe('buildCalendar', () => {
  it('writes timed follow-ups as 30-minute events with an alert', () => {
    const ics = buildCalendar('Test', [
      {
        uid: 'a@coverage',
        date: '2026-11-05',
        start: instantOf('2026-11-05', '14:00', 'Africa/Lagos'),
        alarmMinutes: 30,
        summary: 'Pick up forms: Adaeze',
      },
      { uid: 'b@coverage', date: '2026-11-06', summary: 'Call: Chinedu' },
    ]);
    expect(ics).toContain('DTSTART:20261105T130000Z');
    expect(ics).toContain('DTEND:20261105T133000Z');
    expect(ics).toContain('TRIGGER:-PT30M');
    // The untimed one stays all-day.
    expect(ics).toContain('DTSTART;VALUE=DATE:20261106');
  });
});
