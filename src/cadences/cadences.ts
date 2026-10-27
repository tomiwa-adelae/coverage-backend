import { ActivityType } from '@prisma/client';
import { addDays } from '../common/dates';

export interface CadenceStep {
  /** Days after the plan starts. */
  day: number;
  type: ActivityType;
  action: string;
}

/** Starter plans, created once per user. */
export const DEFAULT_CADENCES: { name: string; steps: CadenceStep[] }[] = [
  {
    name: 'New prospect',
    steps: [
      { day: 0, type: 'CALL', action: 'Introductory call' },
      { day: 2, type: 'WHATSAPP', action: 'Send intro message and brochure' },
      { day: 7, type: 'VISIT', action: 'Visit to understand their needs' },
      { day: 14, type: 'CALL', action: 'Follow up on account opening' },
    ],
  },
  {
    name: 'Forms follow-up',
    steps: [
      { day: 0, type: 'WHATSAPP', action: 'Send account opening forms' },
      {
        day: 3,
        type: 'CALL',
        action: 'Check if they need help with the forms',
      },
      { day: 7, type: 'VISIT', action: 'Pick up completed forms' },
    ],
  },
  {
    name: 'New customer care',
    steps: [
      { day: 0, type: 'CALL', action: 'Thank-you call' },
      { day: 30, type: 'VISIT', action: 'Check-in visit and cross-sell' },
      { day: 90, type: 'CALL', action: 'Quarterly review' },
    ],
  },
];

export function parseSteps(raw: unknown): CadenceStep[] {
  return Array.isArray(raw) ? (raw as CadenceStep[]) : [];
}

/**
 * The follow-up a step schedules. A step that falls in the past (the plan started
 * a while ago, or contact ran late) is due tomorrow instead, never backdated.
 */
export function stepDue(
  steps: CadenceStep[],
  index: number,
  start: string,
  today: string,
) {
  const step = steps[index];
  if (!step) return null;
  const planned = addDays(start, step.day);
  const earliest = index === 0 ? today : addDays(today, 1);
  return {
    nextDate: planned < earliest ? earliest : planned,
    nextAction: step.action,
  };
}
