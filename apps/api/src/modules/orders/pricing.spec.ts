import { ageOn, computeTotals, platformFee } from './pricing';

describe('computeTotals', () => {
  const lines = [
    { key: 'race:0', raceId: 'r21', unitPriceSatang: 120_000, quantity: 1 },
    { key: 'race:1', raceId: 'r10', unitPriceSatang: 90_000, quantity: 1 },
    { key: 'variant:ship', unitPriceSatang: 8_000, quantity: 1 },
  ];

  it('adds the runner fee on top when there is no coupon', () => {
    const t = computeTotals(lines, null, 200);
    expect(t.subtotalSatang).toBe(218_000);
    expect(t.discountSatang).toBe(0);
    expect(t.feeSatang).toBe(4_360);
    expect(t.totalSatang).toBe(222_360);
  });

  it('applies a percent coupon to race entries only and allocates it per line', () => {
    const t = computeTotals(lines, { discountType: 'percent', discountValue: 1000, maxDiscountSatang: null, minOrderSatang: 0, appliesToRaceIds: null }, 0);
    expect(t.discountSatang).toBe(21_000); // 10% of 2,100 baht, not of the shipping add-on
    expect(t.lineDiscounts.get('race:0')).toBe(12_000);
    expect(t.lineDiscounts.get('race:1')).toBe(9_000);
    expect(t.lineDiscounts.get('variant:ship')).toBe(0);
    expect(t.totalSatang).toBe(197_000);
  });

  it('respects the max discount, race restriction and minimum order', () => {
    const capped = computeTotals(lines, { discountType: 'percent', discountValue: 5000, maxDiscountSatang: 30_000, minOrderSatang: 0, appliesToRaceIds: ['r21'] }, 0);
    expect(capped.discountSatang).toBe(30_000);
    expect(capped.lineDiscounts.get('race:0')).toBe(30_000);
    expect(capped.lineDiscounts.get('race:1')).toBe(0);

    const belowMin = computeTotals(lines, { discountType: 'fixed', discountValue: 10_000, maxDiscountSatang: null, minOrderSatang: 500_000, appliesToRaceIds: null }, 0);
    expect(belowMin.discountSatang).toBe(0);
  });

  it('never discounts more than the eligible amount, and allocations always sum to the discount', () => {
    const t = computeTotals(
      [
        { key: 'a', raceId: 'x', unitPriceSatang: 33_333, quantity: 1 },
        { key: 'b', raceId: 'x', unitPriceSatang: 33_333, quantity: 1 },
        { key: 'c', raceId: 'x', unitPriceSatang: 33_334, quantity: 1 },
      ],
      { discountType: 'fixed', discountValue: 10_001, maxDiscountSatang: null, minOrderSatang: 0, appliesToRaceIds: null },
      0,
    );
    expect([...t.lineDiscounts.values()].reduce((s, v) => s + v, 0)).toBe(10_001);
    const huge = computeTotals(lines, { discountType: 'fixed', discountValue: 9_999_999, maxDiscountSatang: null, minOrderSatang: 0, appliesToRaceIds: null }, 0);
    expect(huge.discountSatang).toBe(210_000);
  });
});

describe('ageOn', () => {
  it('counts whole years on race day', () => {
    expect(ageOn('1990-03-12', '2027-02-14')).toBe(36);
    expect(ageOn('1990-02-14', '2027-02-14')).toBe(37);
    expect(ageOn('2011-02-15', '2027-02-14')).toBe(15);
  });
});

describe('platformFee', () => {
  it('takes a share of the sales plus a fixed amount per registration', () => {
    expect(platformFee(200_000, 2, { percentBps: 300, fixedPerRegistrationSatang: 500 })).toBe(7_000);
    expect(platformFee(33_333, 1, { percentBps: 250, fixedPerRegistrationSatang: 0 })).toBe(833);
  });

  it('is nothing without a plan', () => {
    expect(platformFee(200_000, 2, null)).toBe(0);
  });
});
