export interface PricedLine {
  key: string;
  raceId?: string;
  unitPriceSatang: number;
  quantity: number;
}

export interface CouponRule {
  discountType: 'percent' | 'fixed';
  /** percent: basis points (1000 = 10%); fixed: satang off the order. */
  discountValue: number;
  maxDiscountSatang: number | null;
  minOrderSatang: number;
  appliesToRaceIds: string[] | null;
}

export interface Totals {
  subtotalSatang: number;
  discountSatang: number;
  feeSatang: number;
  totalSatang: number;
  /** Discount allocated to each line, by key. Sums to discountSatang. */
  lineDiscounts: Map<string, number>;
}

/**
 * All amounts are integer satang. Coupons only discount race entries (never add-ons),
 * and the runner fee is charged on what is left after the discount.
 */
export function computeTotals(lines: PricedLine[], coupon: CouponRule | null, feeBps: number): Totals {
  const lineTotal = (l: PricedLine) => l.unitPriceSatang * l.quantity;
  const subtotal = lines.reduce((s, l) => s + lineTotal(l), 0);
  const lineDiscounts = new Map(lines.map((l) => [l.key, 0]));

  let discount = 0;
  if (coupon && subtotal >= coupon.minOrderSatang) {
    const eligible = lines.filter(
      (l) => l.raceId && (!coupon.appliesToRaceIds?.length || coupon.appliesToRaceIds.includes(l.raceId)),
    );
    const eligibleTotal = eligible.reduce((s, l) => s + lineTotal(l), 0);
    discount = coupon.discountType === 'percent' ? Math.floor((eligibleTotal * coupon.discountValue) / 10_000) : coupon.discountValue;
    if (coupon.maxDiscountSatang !== null) discount = Math.min(discount, coupon.maxDiscountSatang);
    discount = Math.min(discount, eligibleTotal);

    // Spread the discount across eligible lines in proportion to their value; the last line takes the remainder.
    let allocated = 0;
    eligible.forEach((l, i) => {
      const share = i === eligible.length - 1 ? discount - allocated : Math.floor((discount * lineTotal(l)) / eligibleTotal);
      lineDiscounts.set(l.key, share);
      allocated += share;
    });
  }

  const fee = Math.round(((subtotal - discount) * feeBps) / 10_000);
  return { subtotalSatang: subtotal, discountSatang: discount, feeSatang: fee, totalSatang: subtotal - discount + fee, lineDiscounts };
}

/** Age in whole years on the given day (race day), using calendar dates only. */
export function ageOn(birthDate: string, onDate: string): number {
  const [by, bm, bd] = birthDate.split('-').map(Number);
  const [y, m, d] = onDate.split('-').map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}
