import type { Product, Tier } from '@prisma/client';

// Looking after funded customers: how often to check in, when a balance drop
// matters, and which products to offer next. Pure, so it's easy to test.

/** Days between check-ins with a funded customer, by tier. */
export const CARE_DAYS: Record<Tier, number> = { A: 14, B: 30, C: 90 };
export const careDays = (tier: Tier | null) => (tier ? CARE_DAYS[tier] : 30);

/** Ask for a referral this long after they funded. */
export const REFERRAL_AFTER_DAYS = 30;

/** A fall this big (share of the previous balance, and naira) is worth a call. */
export const DROP_SHARE = 0.2;
export const DROP_MIN = 500_000;

const BUSINESS_NAME =
  /\b(ltd|limited|plc|enterprises?|ventures|nig(eria)?|company|co\.|global|services|stores|industries|group|associates|int'?l)\b/i;
const BUSINESS_PRODUCTS: Product[] = ['POS', 'PAYROLL', 'TRADE'];

/** A business rather than a person: by name, or by the products involved. */
export function looksLikeBusiness(p: {
  name: string;
  wantsProducts: Product[];
  holdsProducts: Product[];
}) {
  return (
    BUSINESS_NAME.test(p.name) ||
    [...p.wantsProducts, ...p.holdsProducts].some((x) =>
      BUSINESS_PRODUCTS.includes(x),
    )
  );
}

export interface BalanceRow {
  prospectId: string;
  /** YYYY-MM */
  month: string;
  amount: number;
}

export interface BalanceDrop {
  prospectId: string;
  month: string;
  from: number;
  to: number;
  drop: number;
}

/**
 * Customers whose latest recorded balance fell sharply from the one before,
 * if the latest is from `sinceMonth` or later (old drops are history).
 */
export function balanceDrops(rows: BalanceRow[], sinceMonth: string) {
  const byProspect = new Map<string, BalanceRow[]>();
  for (const r of rows)
    byProspect.set(r.prospectId, [...(byProspect.get(r.prospectId) ?? []), r]);
  const drops: BalanceDrop[] = [];
  for (const [prospectId, list] of byProspect) {
    list.sort((a, b) => a.month.localeCompare(b.month));
    const latest = list.at(-1)!;
    const before = list.at(-2);
    if (!before || latest.month < sinceMonth) continue;
    const drop = before.amount - latest.amount;
    if (drop >= DROP_MIN && drop >= before.amount * DROP_SHARE)
      drops.push({
        prospectId,
        month: latest.month,
        from: before.amount,
        to: latest.amount,
        drop,
      });
  }
  return drops.sort((a, b) => b.drop - a.drop);
}

export interface CrossSellIdea {
  product: Product;
  reason: string;
}

/** Products worth offering a funded customer next, most likely first. */
export function crossSellIdeas(p: {
  name: string;
  funded: number | null;
  wantsProducts: Product[];
  holdsProducts: Product[];
}): CrossSellIdea[] {
  const holds = new Set(p.holdsProducts);
  const ideas: CrossSellIdea[] = [];
  const add = (product: Product, reason: string) => {
    if (!holds.has(product) && !ideas.some((i) => i.product === product))
      ideas.push({ product, reason });
  };
  for (const w of p.wantsProducts) add(w, 'They asked about it');
  const business = looksLikeBusiness(p);
  if (business) {
    add('POS', 'A business without a POS terminal');
    add('PAYROLL', 'Could pay staff salaries through the bank');
  }
  if ((p.funded ?? 0) >= 10_000_000)
    add('FIXED_DEPOSIT', 'Large balance: offer a fixed deposit on idle funds');
  add('DIGITAL', 'Not on mobile or internet banking yet');
  return ideas;
}
