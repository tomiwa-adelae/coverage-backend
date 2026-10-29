import { balanceDrops, crossSellIdeas, looksLikeBusiness } from './care';

describe('balanceDrops', () => {
  const row = (prospectId: string, month: string, amount: number) => ({
    prospectId,
    month,
    amount,
  });

  it('flags a large fall in the latest month', () => {
    const drops = balanceDrops(
      [row('a', '2026-09', 20_000_000), row('a', '2026-10', 8_000_000)],
      '2026-09',
    );
    expect(drops).toEqual([
      {
        prospectId: 'a',
        month: '2026-10',
        from: 20_000_000,
        to: 8_000_000,
        drop: 12_000_000,
      },
    ]);
  });

  it('ignores small or proportionally minor falls', () => {
    expect(
      balanceDrops(
        [
          row('a', '2026-09', 1_000_000),
          row('a', '2026-10', 700_000), // 30% but only ₦300k
          row('b', '2026-09', 100_000_000),
          row('b', '2026-10', 90_000_000), // ₦10m but only 10%
        ],
        '2026-09',
      ),
    ).toEqual([]);
  });

  it('ignores old drops and single months', () => {
    expect(
      balanceDrops(
        [
          row('a', '2026-05', 20_000_000),
          row('a', '2026-06', 1_000_000),
          row('b', '2026-10', 5_000_000),
        ],
        '2026-09',
      ),
    ).toEqual([]);
  });

  it('puts the biggest drop first', () => {
    const drops = balanceDrops(
      [
        row('a', '2026-09', 5_000_000),
        row('a', '2026-10', 1_000_000),
        row('b', '2026-09', 50_000_000),
        row('b', '2026-10', 10_000_000),
      ],
      '2026-09',
    );
    expect(drops.map((d) => d.prospectId)).toEqual(['b', 'a']);
  });
});

describe('crossSellIdeas', () => {
  it('starts with what they asked about and skips what they hold', () => {
    const ideas = crossSellIdeas({
      name: 'Funke Adebayo',
      funded: 2_000_000,
      wantsProducts: ['SAVINGS', 'CURRENT'],
      holdsProducts: ['CURRENT'],
    });
    expect(ideas.map((i) => i.product)).toEqual(['SAVINGS', 'DIGITAL']);
  });

  it('suggests business products and a fixed deposit where they fit', () => {
    const ideas = crossSellIdeas({
      name: 'Bello Stores Ltd',
      funded: 25_000_000,
      wantsProducts: [],
      holdsProducts: ['CURRENT', 'DIGITAL'],
    });
    expect(ideas.map((i) => i.product)).toEqual([
      'POS',
      'PAYROLL',
      'FIXED_DEPOSIT',
    ]);
  });
});

describe('looksLikeBusiness', () => {
  it('reads names and products', () => {
    const none = { wantsProducts: [], holdsProducts: [] };
    expect(looksLikeBusiness({ name: 'Kola Ventures', ...none })).toBe(true);
    expect(looksLikeBusiness({ name: 'Grace Nwosu', ...none })).toBe(false);
    expect(
      looksLikeBusiness({
        name: 'Grace Nwosu',
        wantsProducts: ['POS'],
        holdsProducts: [],
      }),
    ).toBe(true);
  });
});
