import { Repeat } from '@prisma/client';
import { addDays } from '../common/dates';

/** The next date a repeating task is due after `ymd`. */
export function nextOccurrence(ymd: string, repeat: Repeat) {
  if (repeat === Repeat.WEEKLY) return addDays(ymd, 7);
  if (repeat === Repeat.MONTHLY) {
    const [y, m, d] = ymd.split('-').map(Number);
    // Clamp to the month's last day (31 Jan -> 28/29 Feb).
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m, Math.min(d, last)))
      .toISOString()
      .slice(0, 10);
  }
  // DAILY means every working day.
  let next = addDays(ymd, 1);
  while ([0, 6].includes(new Date(`${next}T12:00:00Z`).getUTCDay()))
    next = addDays(next, 1);
  return next;
}
