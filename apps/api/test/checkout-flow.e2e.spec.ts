import { randomUUID } from 'node:crypto';
import { bootApp, buyer, call, login, raceCounters, runner, seedEvent, sendFakeWebhook, TestContext } from './helpers';

describe('runner flow: event → checkout → order → PromptPay → webhook → ticket', () => {
  let ctx: TestContext;
  let ev: Awaited<ReturnType<typeof seedEvent>>;

  beforeAll(async () => {
    ctx = await bootApp();
    ev = await seedEvent(ctx.pool);
  });
  afterAll(() => ctx.close());

  it('completes a two-runner registration end to end', async () => {
    const { app, pool } = ctx;
    const { token, userId } = await login(app);

    const detail = await call(app, 'GET', `/v1/events/${ev.slug}`);
    expect(detail.status).toBe(200);
    expect(detail.body.races.map((r: any) => r.code)).toEqual(['21K', '10K']);
    expect(detail.body.races[0]).toMatchObject({ priceSatang: 120_000, tierName: 'Early bird', available: 100 });

    const session = await call(app, 'POST', '/v1/checkout/sessions', {
      token,
      body: {
        eventId: ev.eventId,
        races: [{ raceId: ev.raceIds['21K'], quantity: 1 }, { raceId: ev.raceIds['10K'], quantity: 1 }],
        variants: [{ variantId: ev.variantIds.M, quantity: 1 }, { variantId: ev.variantIds.S, quantity: 1 }],
      },
    });
    expect(session.status).toBe(201);
    expect(await raceCounters(pool, ev.raceIds['21K'])).toMatchObject({ reserved: 1, sold: 0 });

    const key = randomUUID();
    const order = await call(app, 'POST', '/v1/orders', {
      token,
      headers: { 'idempotency-key': key },
      body: {
        checkoutSessionId: session.body.id,
        couponCode: 'RUN10',
        buyer,
        participants: [
          { raceId: ev.raceIds['21K'], shirtVariantId: ev.variantIds.M, isSelf: true, runner: runner() },
          {
            raceId: ev.raceIds['10K'],
            shirtVariantId: ev.variantIds.S,
            runner: runner({ firstNameTh: 'สมหญิง', firstNameEn: 'Somying', gender: 'female', birthDate: '1968-08-04' }),
          },
        ],
      },
    });
    expect(order.status).toBe(201);
    // 1,200 + 900 = 2,100 baht; RUN10 takes 210; 2% fee on 1,890 = 37.80
    expect(order.body).toMatchObject({ status: 'pending_payment', subtotalSatang: 210_000, discountSatang: 21_000, feeSatang: 3_780, totalSatang: 192_780 });
    expect(order.body.registrations.every((r: any) => r.status === 'pending' && r.bibNumber === null)).toBe(true);

    const payment = await call(app, 'POST', `/v1/orders/${order.body.id}/payments`, {
      token,
      headers: { 'idempotency-key': randomUUID() },
      body: { method: 'promptpay' },
    });
    expect(payment.status).toBe(201);
    expect(payment.body).toMatchObject({ method: 'promptpay', status: 'pending', amountSatang: 192_780 });
    expect(payment.body.qrPayload).toEqual(expect.any(String));

    const { rows } = await pool.query('SELECT gateway_charge_id FROM payments WHERE id = $1', [payment.body.id]);
    const hook = await sendFakeWebhook(app, rows[0].gateway_charge_id, 'successful', 'evt-flow-1');
    expect(hook.status).toBe(200);
    expect(hook.body.result).toBe('confirmed');

    // Gateways redeliver; the second copy must not change anything.
    const again = await sendFakeWebhook(app, rows[0].gateway_charge_id, 'successful', 'evt-flow-1');
    expect(again.body.result).toBe('duplicate');

    const paid = await call(app, 'GET', `/v1/orders/${order.body.id}`, { token });
    expect(paid.body.status).toBe('paid');
    const bibs = paid.body.registrations.map((r: any) => [r.raceCode, r.status, r.bibNumber]).sort();
    expect(bibs).toEqual([['10K', 'confirmed', '2001'], ['21K', 'confirmed', '0001']]);

    expect(await raceCounters(pool, ev.raceIds['21K'])).toMatchObject({ reserved: 0, sold: 1 });
    const tiers = await pool.query(`SELECT name, reserved, sold FROM price_tiers WHERE race_id = $1 ORDER BY name`, [ev.raceIds['21K']]);
    expect(tiers.rows.find((t) => t.name === 'Early bird')).toMatchObject({ reserved: 0, sold: 1 });
    const shirts = await pool.query('SELECT reserved, sold FROM product_variants WHERE id = $1', [ev.variantIds.M]);
    expect(shirts.rows[0]).toMatchObject({ reserved: 0, sold: 1 });
    const coupon = await pool.query(`SELECT used_count FROM coupons WHERE event_id = $1`, [ev.eventId]);
    expect(coupon.rows[0].used_count).toBe(1);

    const mine = await call(app, 'GET', '/v1/me/registrations', { token });
    expect(mine.body.items).toHaveLength(2);
    const self = mine.body.items.find((r: any) => r.race.code === '21K');
    expect(self).toMatchObject({ status: 'confirmed', bibNumber: '0001', shirtSize: 'M', ageGroup: 'M30-39' });
    expect(self.qrToken).toMatch(/^[0-9a-f]{32}$/);

    const stored = await pool.query('SELECT runner_user_id, runner_snapshot FROM registrations WHERE order_id = $1 AND race_id = $2', [order.body.id, ev.raceIds['21K']]);
    expect(stored.rows[0].runner_user_id).toBe(userId);
    // The raw ID number is never stored in clear text.
    expect(JSON.stringify(stored.rows[0].runner_snapshot)).not.toMatch(/"idDocNumber"/);
  });

  it('replays the stored response for a retried POST /orders with the same key and body', async () => {
    const { app } = ctx;
    const { token } = await login(app);
    const session = await call(app, 'POST', '/v1/checkout/sessions', {
      token,
      body: { eventId: ev.eventId, races: [{ raceId: ev.raceIds['10K'], quantity: 1 }], variants: [{ variantId: ev.variantIds.S, quantity: 1 }] },
    });
    const body = { checkoutSessionId: session.body.id, buyer, participants: [{ raceId: ev.raceIds['10K'], shirtVariantId: ev.variantIds.S, runner: runner() }] };
    const key = randomUUID();
    const first = await call(app, 'POST', '/v1/orders', { token, headers: { 'idempotency-key': key }, body });
    const second = await call(app, 'POST', '/v1/orders', { token, headers: { 'idempotency-key': key }, body });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);

    const reused = await call(app, 'POST', '/v1/orders', { token, headers: { 'idempotency-key': key }, body: { ...body, couponCode: 'RUN10' } });
    expect(reused.status).toBe(422);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('refuses a second place in the same race for the same ID card', async () => {
    const { app } = ctx;
    const { token } = await login(app);
    const person = runner();
    const book = async () => {
      const session = await call(app, 'POST', '/v1/checkout/sessions', {
        token,
        body: { eventId: ev.eventId, races: [{ raceId: ev.raceIds['10K'], quantity: 1 }], variants: [{ variantId: ev.variantIds.M, quantity: 1 }] },
      });
      return call(app, 'POST', '/v1/orders', {
        token,
        headers: { 'idempotency-key': randomUUID() },
        body: { checkoutSessionId: session.body.id, buyer, participants: [{ raceId: ev.raceIds['10K'], shirtVariantId: ev.variantIds.M, runner: person }] },
      });
    };
    expect((await book()).status).toBe(201);
    const dup = await book();
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('ALREADY_REGISTERED');
  });

  it('rejects runners younger than the race minimum age', async () => {
    const { app } = ctx;
    const { token } = await login(app);
    const session = await call(app, 'POST', '/v1/checkout/sessions', {
      token,
      body: { eventId: ev.eventId, races: [{ raceId: ev.raceIds['21K'], quantity: 1 }], variants: [{ variantId: ev.variantIds.S, quantity: 1 }] },
    });
    const res = await call(app, 'POST', '/v1/orders', {
      token,
      headers: { 'idempotency-key': randomUUID() },
      body: { checkoutSessionId: session.body.id, buyer, participants: [{ raceId: ev.raceIds['21K'], shirtVariantId: ev.variantIds.S, runner: runner({ birthDate: '2012-01-01' }) }] },
    });
    expect(res.status).toBe(422);
    expect(res.body.detail).toMatch(/at least 16/);
  });

  it('rejects a webhook with a bad signature', async () => {
    const res = await call(ctx.app, 'POST', '/v1/webhooks/payments/fake', {
      raw: JSON.stringify({ id: 'evt-forged', type: 'charge.complete', data: { id: 'fake_chrg_x', status: 'successful' } }),
      headers: { 'x-fake-signature': 'deadbeef' },
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_WEBHOOK');
  });

  it('requires sign-in and an Idempotency-Key on money endpoints', async () => {
    const anon = await call(ctx.app, 'POST', '/v1/checkout/sessions', { body: {} });
    expect(anon.status).toBe(401);
    const { token } = await login(ctx.app);
    const noKey = await call(ctx.app, 'POST', '/v1/orders', {
      token,
      body: { checkoutSessionId: randomUUID(), buyer, participants: [{ raceId: ev.raceIds['10K'], runner: runner() }] },
    });
    expect(noKey.status).toBe(400);
    expect(noKey.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});
