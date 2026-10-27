import { Prospect } from '@prisma/client';

const num = (v: bigint | null) => (v === null ? null : Number(v));
const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export function serializeProspect(p: Prospect) {
  return {
    ...p,
    potential: num(p.potential),
    funded: num(p.funded),
    nextDate: ymd(p.nextDate),
  };
}

export type ProspectView = ReturnType<typeof serializeProspect>;
