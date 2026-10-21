import { bootApp, call, login, raceCounters, seedEvent, TestContext } from './helpers';

/**
 * The opening-minute rush: many buyers hit the last places at the same moment.
 * Requests run concurrently against real Postgres, so this exercises the row-level conditional UPDATEs.
 */
describe('capacity under concurrent checkouts', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await bootApp();
  });
  afterAll(() => ctx.close());

  it('never sells more places than the capacity, and fills the Early bird quota exactly', async () => {
    const ev = await seedEvent(ctx.pool, {
      races: [
        {
          code: '21K', nameTh: 'ฮาล์ฟ', distanceKm: 21.1, capacity: 25,
          tiers: [{ name: 'Early bird', priceSatang: 120_000, quota: 10 }, { name: 'ปกติ', priceSatang: 140_000 }],
        },
      ],
      shirtSizes: [],
    });
    const buyers = await Promise.all(Array.from({ length: 120 }, () => login(ctx.app)));

    const results = await Promise.all(
      buyers.map(({ token }) =>
        call(ctx.app, 'POST', '/v1/checkout/sessions', {
          token,
          body: { eventId: ev.eventId, races: [{ raceId: ev.raceIds['21K'], quantity: 1 }] },
        }),
      ),
    );

    const ok = results.filter((r) => r.status === 201);
    const soldOut = results.filter((r) => r.status === 409 && r.body.code === 'SOLD_OUT');
    expect(ok).toHaveLength(25);
    expect(soldOut).toHaveLength(95);
    expect(results.filter((r) => r.status >= 500)).toHaveLength(0);

    const prices = ok.map((r) => r.body.items.races[0].priceSatang);
    expect(prices.filter((p) => p === 120_000)).toHaveLength(10);
    expect(prices.filter((p) => p === 140_000)).toHaveLength(15);

    expect(await raceCounters(ctx.pool, ev.raceIds['21K'])).toEqual({ capacity: 25, reserved: 25, sold: 0 });
    const holds = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM inventory_holds WHERE race_id = $1 AND status = 'held'`,
      [ev.raceIds['21K']],
    );
    expect(holds.rows[0].n).toBe(25);
  });

  it('does not oversell a shirt size either', async () => {
    const ev = await seedEvent(ctx.pool, {
      races: [{ code: '5K', nameTh: 'ฟันรัน', distanceKm: 5, capacity: 100, tiers: [{ name: 'ราคาเดียว', priceSatang: 65_000 }] }],
      shirtSizes: [{ label: '2XL', chestIn: 44, stock: 7 }],
    });
    const buyers = await Promise.all(Array.from({ length: 40 }, () => login(ctx.app)));
    const results = await Promise.all(
      buyers.map(({ token }) =>
        call(ctx.app, 'POST', '/v1/checkout/sessions', {
          token,
          body: { eventId: ev.eventId, races: [{ raceId: ev.raceIds['5K'], quantity: 1 }], variants: [{ variantId: ev.variantIds['2XL'], quantity: 1 }] },
        }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(7);
    expect(results.filter((r) => r.body?.code === 'SIZE_SOLD_OUT')).toHaveLength(33);
    // A failed size hold rolls back the race place taken in the same request.
    expect(await raceCounters(ctx.pool, ev.raceIds['5K'])).toMatchObject({ reserved: 7 });
  });
});
