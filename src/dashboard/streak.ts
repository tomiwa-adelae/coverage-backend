import { addDays, toDate } from '../common/dates';

const isWeekend = (ymd: string) => [0, 6].includes(toDate(ymd).getUTCDay());

/**
 * Consecutive days on which the daily goal was met, counting back from today.
 * Today only counts once it is met (an unfinished today doesn't break the streak),
 * and weekends never break it — they add to it only if the goal was met.
 */
export function goalStreak(
  counts: Record<string, number>,
  today: string,
  goal: number,
  maxDays = 365,
): number {
  const met = (d: string) => (counts[d] ?? 0) >= goal;
  let day = met(today) ? today : addDays(today, -1);
  let streak = 0;
  for (let i = 0; i < maxDays; i++, day = addDays(day, -1)) {
    if (met(day)) streak++;
    else if (!isWeekend(day)) break;
  }
  return streak;
}
