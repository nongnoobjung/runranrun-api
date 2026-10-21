import { randomUUID } from 'node:crypto';
import { bootApp, buyer, call, login, runner, seedEvent, TestContext } from './helpers';

describe('choosing shirt sizes after the places are held', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await bootApp();
  });
  afterAll(() => ctx.close());

  const variantCounters = async (id: string) =>
    (await ctx.pool.query('SELECT reserved, sold FROM product_variants WHERE id = $1', [id])).rows[0];

  it('swaps size holds, keeps the old sizes when the new one is sold out, and then orders', async () => {
    const ev = await seedEvent(ctx.pool, {
      shirtSizes: [
        { label: 'S', chestIn: 36, stock: 10 },
        { label: 'M', chestIn: 38, stock: 10 },
        { label: 'XL', chestIn: 42, stock: 0 },
      ],
    });
    const { token } = await login(ctx.app);
    const session = await call(ctx.app, 'POST', '/v1/checkout/sessions', {
      token,
      body: { eventId: ev.eventId, races: [{ raceId: ev.raceIds['10K'], quantity: 2 }] },
    });
    expect(session.status).toBe(201);
    const url = `/v1/checkout/sessions/${session.body.id}/variants`;

    const first = await call(ctx.app, 'PUT', url, { token, body: { variants: [{ variantId: ev.variantIds.M, quantity: 2 }] } });
    expect(first.status).toBe(200);
    expect(await variantCounters(ev.variantIds.M)).toMatchObject({ reserved: 2 });

    const changed = await call(ctx.app, 'PUT', url, {
      token,
      body: { variants: [{ variantId: ev.variantIds.M, quantity: 1 }, { variantId: ev.variantIds.S, quantity: 1 }] },
    });
    expect(changed.status).toBe(200);
    expect(await variantCounters(ev.variantIds.M)).toMatchObject({ reserved: 1 });
    expect(await variantCounters(ev.variantIds.S)).toMatchObject({ reserved: 1 });

    const soldOut = await call(ctx.app, 'PUT', url, { token, body: { variants: [{ variantId: ev.variantIds.XL, quantity: 2 }] } });
    expect(soldOut.status).toBe(409);
    expect(soldOut.body.code).toBe('SIZE_SOLD_OUT');
    expect(await variantCounters(ev.variantIds.M)).toMatchObject({ reserved: 1 });
    expect(await variantCounters(ev.variantIds.S)).toMatchObject({ reserved: 1 });

    const order = await call(ctx.app, 'POST', '/v1/orders', {
      token,
      headers: { 'idempotency-key': randomUUID() },
      body: {
        checkoutSessionId: session.body.id,
        buyer,
        participants: [
          { raceId: ev.raceIds['10K'], shirtVariantId: ev.variantIds.M, runner: runner() },
          { raceId: ev.raceIds['10K'], shirtVariantId: ev.variantIds.S, runner: runner({ firstNameEn: 'Somying', gender: 'female' }) },
        ],
      },
    });
    expect(order.status).toBe(201);

    const locked = await call(ctx.app, 'PUT', url, { token, body: { variants: [{ variantId: ev.variantIds.S, quantity: 2 }] } });
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe('ORDER_EXISTS');
  });
});
