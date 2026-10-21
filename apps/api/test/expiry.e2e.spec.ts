import { randomUUID } from 'node:crypto';
import { HoldReleaseService } from '../src/modules/inventory/hold-release.service';
import { bootApp, buyer, call, login, raceCounters, runner, seedEvent, sendFakeWebhook, TestContext } from './helpers';

describe('expired checkouts and late payments', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await bootApp();
  });
  afterAll(() => ctx.close());

  async function orderWithQr(ev: Awaited<ReturnType<typeof seedEvent>>, raceCode: string, person = runner()) {
    const { token } = await login(ctx.app);
    const session = await call(ctx.app, 'POST', '/v1/checkout/sessions', {
      token,
      body: { eventId: ev.eventId, races: [{ raceId: ev.raceIds[raceCode], quantity: 1 }] },
    });
    const order = await call(ctx.app, 'POST', '/v1/orders', {
      token,
      headers: { 'idempotency-key': randomUUID() },
      body: { checkoutSessionId: session.body.id, buyer, participants: [{ raceId: ev.raceIds[raceCode], runner: person }] },
    });
    const payment = await call(ctx.app, 'POST', `/v1/orders/${order.body.id}/payments`, {
      token,
      headers: { 'idempotency-key': randomUUID() },
      body: { method: 'promptpay' },
    });
    const charge = await ctx.pool.query('SELECT gateway_charge_id FROM payments WHERE id = $1', [payment.body.id]);
    return { token, sessionId: session.body.id as string, orderId: order.body.id as string, chargeId: charge.rows[0].gateway_charge_id as string };
  }

  async function expire(sessionId: string) {
    await ctx.pool.query(`UPDATE checkout_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`, [sessionId]);
    await ctx.pool.query(`UPDATE inventory_holds SET expires_at = now() - interval '1 minute' WHERE checkout_session_id = $1`, [sessionId]);
    await ctx.pool.query(`UPDATE orders SET expires_at = now() - interval '1 minute' WHERE checkout_session_id = $1`, [sessionId]);
    return ctx.app.get(HoldReleaseService).releaseExpired();
  }

  const noShirts = { shirtSizes: [], coupons: [] };

  it('returns the place, expires the order and frees the ID card when time runs out', async () => {
    const ev = await seedEvent(ctx.pool, {
      ...noShirts,
      races: [{ code: '10K', nameTh: 'มินิ', distanceKm: 10, capacity: 5, tiers: [{ name: 'ปกติ', priceSatang: 90_000, quota: 5 }] }],
    });
    const person = runner();
    const first = await orderWithQr(ev, '10K', person);
    expect(await raceCounters(ctx.pool, ev.raceIds['10K'])).toMatchObject({ reserved: 1 });

    expect(await expire(first.sessionId)).toBeGreaterThanOrEqual(1);
    expect(await raceCounters(ctx.pool, ev.raceIds['10K'])).toMatchObject({ reserved: 0, sold: 0 });
    const tier = await ctx.pool.query('SELECT reserved FROM price_tiers WHERE race_id = $1', [ev.raceIds['10K']]);
    expect(tier.rows[0].reserved).toBe(0);
    const order = await call(ctx.app, 'GET', `/v1/orders/${first.orderId}`, { token: first.token });
    expect(order.body.status).toBe('expired');
    expect(order.body.registrations[0].status).toBe('cancelled');

    const pay = await call(ctx.app, 'POST', `/v1/orders/${first.orderId}/payments`, {
      token: first.token, headers: { 'idempotency-key': randomUUID() }, body: { method: 'promptpay' },
    });
    expect(pay.status).toBe(409);
    expect(pay.body.code).toBe('ORDER_NOT_PAYABLE');

    // The same person can now book again.
    const second = await orderWithQr(ev, '10K', person);
    expect(second.orderId).not.toBe(first.orderId);
  });

  it('accepts a payment that arrives after expiry when a place is still free', async () => {
    const ev = await seedEvent(ctx.pool, {
      ...noShirts,
      races: [{ code: '10K', nameTh: 'มินิ', distanceKm: 10, capacity: 5, bibStart: 2001, tiers: [{ name: 'ปกติ', priceSatang: 90_000 }] }],
    });
    const o = await orderWithQr(ev, '10K');
    await expire(o.sessionId);

    const hook = await sendFakeWebhook(ctx.app, o.chargeId);
    expect(hook.body.result).toBe('late_confirmed');
    const order = await call(ctx.app, 'GET', `/v1/orders/${o.orderId}`, { token: o.token });
    expect(order.body.status).toBe('paid');
    expect(order.body.registrations[0]).toMatchObject({ status: 'confirmed', bibNumber: '2001' });
    expect(await raceCounters(ctx.pool, ev.raceIds['10K'])).toMatchObject({ reserved: 0, sold: 1 });
  });

  it('queues a refund when a late payment finds the race sold out', async () => {
    const ev = await seedEvent(ctx.pool, {
      ...noShirts,
      races: [{ code: '5K', nameTh: 'ฟันรัน', distanceKm: 5, capacity: 1, tiers: [{ name: 'ราคาเดียว', priceSatang: 65_000 }] }],
    });
    const late = await orderWithQr(ev, '5K');
    await expire(late.sessionId);
    const winner = await orderWithQr(ev, '5K'); // takes the only place
    expect((await sendFakeWebhook(ctx.app, winner.chargeId)).body.result).toBe('confirmed');

    const hook = await sendFakeWebhook(ctx.app, late.chargeId);
    expect(hook.body.result).toBe('late_sold_out_refund');
    const refund = await ctx.pool.query('SELECT status, amount_satang, reason FROM refunds WHERE order_id = $1', [late.orderId]);
    expect(refund.rows[0]).toMatchObject({ status: 'approved', reason: 'late_payment_sold_out' });
    expect(Number(refund.rows[0].amount_satang)).toBe(66_300); // 650 baht + 2% fee
    expect(await raceCounters(ctx.pool, ev.raceIds['5K'])).toMatchObject({ capacity: 1, reserved: 0, sold: 1 });
  });

  it('dev helper completes the pending payment of an order', async () => {
    const ev = await seedEvent(ctx.pool, {
      ...noShirts,
      races: [{ code: '5K', nameTh: 'ฟันรัน', distanceKm: 5, capacity: 3, tiers: [{ name: 'ราคาเดียว', priceSatang: 65_000 }] }],
    });
    const o = await orderWithQr(ev, '5K');
    const res = await call(ctx.app, 'POST', `/v1/dev/orders/${o.orderId}/complete-payment`, { body: {} });
    expect(res.status).toBe(201);
    expect(res.body.result).toBe('confirmed');
    const again = await call(ctx.app, 'POST', `/v1/dev/orders/${o.orderId}/complete-payment`, { body: {} });
    expect(again.status).toBe(404);
  });

  it('cancelling a checkout before paying gives the places back', async () => {
    const ev = await seedEvent(ctx.pool, {
      ...noShirts,
      races: [{ code: '5K', nameTh: 'ฟันรัน', distanceKm: 5, capacity: 3, tiers: [{ name: 'ราคาเดียว', priceSatang: 65_000 }] }],
    });
    const { token } = await login(ctx.app);
    const session = await call(ctx.app, 'POST', '/v1/checkout/sessions', {
      token, body: { eventId: ev.eventId, races: [{ raceId: ev.raceIds['5K'], quantity: 3 }] },
    });
    expect(await raceCounters(ctx.pool, ev.raceIds['5K'])).toMatchObject({ reserved: 3 });
    const del = await call(ctx.app, 'DELETE', `/v1/checkout/sessions/${session.body.id}`, { token });
    expect(del.status).toBe(204);
    expect(await raceCounters(ctx.pool, ev.raceIds['5K'])).toMatchObject({ reserved: 0 });
  });
});
