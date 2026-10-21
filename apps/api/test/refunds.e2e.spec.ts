import { randomUUID } from 'node:crypto';
import { addOrgMember, createEvent } from '../db/fixtures';
import { bootApp, buyer, call, login, runner, sendFakeWebhook, TestContext, uniqueSlug } from './helpers';

const bank = { bankCode: 'KBANK', accountName: 'สมชาย ใจดี', accountNumber: '123-4-56789-0' };

describe('refunds and cancellations', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await bootApp();
  });
  afterAll(() => ctx.close());

  /** A 10K at ฿500 with an M shirt and a ฿100 coupon; the fixture refunds 80% until race day. */
  async function orgEvent(role: 'owner' | 'finance' | 'staff' = 'owner') {
    const created = await createEvent(
      ctx.pool,
      {
        slug: uniqueSlug(),
        nameTh: 'งานคืนเงิน',
        eventDate: '2027-03-01',
        races: [{ code: '10K', nameTh: 'มินิ', distanceKm: 10, capacity: 50, bibStart: 1, bibEnd: 50, tiers: [{ name: 'ปกติ', priceSatang: 50_000 }] }],
        shirtSizes: [{ label: 'M', chestIn: 38, stock: 20 }],
        coupons: [{ code: 'HELLO', type: 'fixed', value: 10_000 }],
      },
      uniqueSlug('org'),
    );
    const email = `${role}-${randomUUID()}@org.example`;
    await addOrgMember(ctx.pool, created.organizationId, email, role);
    const { token } = await login(ctx.app, email);
    return { ...created, token, base: `/v1/org/${created.organizationId}/events/${created.eventId}` };
  }

  /** A runner pays for one 10K place with an M shirt. */
  async function paid(ev: Awaited<ReturnType<typeof orgEvent>>, opts: { coupon?: string; person?: ReturnType<typeof runner> } = {}) {
    const me = await login(ctx.app);
    const raceId = ev.raceIds['10K'];
    const session = await call(ctx.app, 'POST', '/v1/checkout/sessions', {
      token: me.token,
      body: { eventId: ev.eventId, races: [{ raceId, quantity: 1 }], variants: [{ variantId: ev.variantIds.M, quantity: 1 }] },
    });
    const order = await call(ctx.app, 'POST', '/v1/orders', {
      token: me.token,
      headers: { 'idempotency-key': randomUUID() },
      body: {
        checkoutSessionId: session.body.id, couponCode: opts.coupon, buyer,
        participants: [{ raceId, shirtVariantId: ev.variantIds.M, isSelf: true, runner: opts.person ?? runner() }],
      },
    });
    if (order.status !== 201) throw new Error(JSON.stringify(order.body));
    const payment = await call(ctx.app, 'POST', `/v1/orders/${order.body.id}/payments`, { token: me.token, headers: { 'idempotency-key': randomUUID() }, body: { method: 'promptpay' } });
    const charge = await ctx.pool.query('SELECT gateway_charge_id FROM payments WHERE id = $1', [payment.body.id]);
    await sendFakeWebhook(ctx.app, charge.rows[0].gateway_charge_id);
    const reg = await ctx.pool.query('SELECT id, registration_no, bib_number, qr_token FROM registrations WHERE order_id = $1', [order.body.id]);
    return { ...me, orderId: order.body.id as string, reg: reg.rows[0] as { id: string; registration_no: string; bib_number: string; qr_token: string } };
  }

  const counters = async (ev: Awaited<ReturnType<typeof orgEvent>>) => {
    const race = await ctx.pool.query('SELECT sold FROM races WHERE id = $1', [ev.raceIds['10K']]);
    const shirt = await ctx.pool.query('SELECT sold FROM product_variants WHERE id = $1', [ev.variantIds.M]);
    const tier = await ctx.pool.query('SELECT sold FROM price_tiers WHERE race_id = $1', [ev.raceIds['10K']]);
    return { race: race.rows[0].sold, shirt: shirt.rows[0].sold, tier: tier.rows[0].sold };
  };

  it('lets a runner ask for the policy amount and blocks kit pickup while it is open', async () => {
    const ev = await orgEvent();
    const r = await paid(ev);
    const path = `/v1/me/registrations/${r.reg.id}`;

    const quote = await call(ctx.app, 'GET', `${path}/refund`, { token: r.token });
    expect(quote.body).toMatchObject({ eligible: true, reason: null, pricePaidSatang: 50_000, percentBps: 8000, amountSatang: 40_000, needsBankAccount: true, lastRequest: null });
    expect(quote.body).not.toHaveProperty('_row');

    const noBank = await call(ctx.app, 'POST', `${path}/refund-requests`, { token: r.token, body: { reason: 'บาดเจ็บ' } });
    expect(noBank.status).toBe(422);
    const stranger = await login(ctx.app);
    expect((await call(ctx.app, 'POST', `${path}/refund-requests`, { token: stranger.token, body: { reason: 'x', bank } })).status).toBe(404);

    const asked = await call(ctx.app, 'POST', `${path}/refund-requests`, { token: r.token, body: { reason: 'บาดเจ็บ', bank } });
    expect(asked.status).toBe(201);
    expect(asked.body).toMatchObject({ eligible: false, reason: 'REFUND_IN_PROGRESS', lastRequest: expect.objectContaining({ status: 'requested', amountSatang: 40_000 }) });
    expect((await call(ctx.app, 'POST', `${path}/refund-requests`, { token: r.token, body: { reason: 'อีกครั้ง', bank } })).body.code).toBe('REFUND_IN_PROGRESS');

    // The place is still theirs until the organiser decides, but the kit cannot be collected meanwhile.
    const pickup = await call(ctx.app, 'POST', `${ev.base}/checkins`, { token: ev.token, body: { code: r.reg.qr_token, clientUuid: randomUUID() } });
    expect(pickup.body.code).toBe('REFUND_PENDING');
    const stored = await ctx.pool.query('SELECT manual_bank_info_enc FROM refunds WHERE registration_id = $1', [r.reg.id]);
    expect(stored.rows[0].manual_bank_info_enc.toString('utf8')).not.toContain('1234567890');
  });

  it('approves a request: the place goes back on sale, the coupon is freed and the money is owed until transferred', async () => {
    const ev = await orgEvent();
    const person = runner();
    const r = await paid(ev, { coupon: 'HELLO', person });
    const before = await counters(ev);
    await call(ctx.app, 'POST', `/v1/me/registrations/${r.reg.id}/refund-requests`, { token: r.token, body: { reason: 'ติดงาน', bank } });

    const financeEmail = `finance-${randomUUID()}@org.example`;
    await addOrgMember(ctx.pool, ev.organizationId, financeEmail, 'finance');
    const finance = await login(ctx.app, financeEmail);
    const staffEmail = `staff-${randomUUID()}@org.example`;
    await addOrgMember(ctx.pool, ev.organizationId, staffEmail, 'staff');
    const staff = await login(ctx.app, staffEmail);
    expect((await call(ctx.app, 'GET', `${ev.base}/refunds`, { token: staff.token })).status).toBe(403);

    const open = await call(ctx.app, 'GET', `${ev.base}/refunds`, { token: finance.token });
    expect(open.body.counts).toEqual({ requested: 1, approved: 0, closed: 0 });
    const item = open.body.items[0];
    // ฿500 − ฿100 coupon = ฿400 paid, 80% back.
    expect(item).toMatchObject({
      status: 'requested', amountSatang: 32_000, reason: 'ติดงาน', requestedByRunner: true, paymentMethod: 'promptpay',
      bank: { bankCode: 'KBANK', accountName: 'สมชาย ใจดี', accountNumber: '1234567890' },
      registration: expect.objectContaining({ id: r.reg.id, registrationNo: r.reg.registration_no, raceCode: '10K', pricePaidSatang: 40_000 }),
    });

    expect((await call(ctx.app, 'POST', `${ev.base}/refunds/${item.id}/transferred`, { token: finance.token, body: { reference: 'x' } })).body.code).toBe('REFUND_STATE');
    expect((await call(ctx.app, 'POST', `${ev.base}/refunds/${item.id}/approve`, { token: finance.token })).status).toBe(201);

    const reg = await ctx.pool.query('SELECT status, bib_number, cancelled_at FROM registrations WHERE id = $1', [r.reg.id]);
    expect(reg.rows[0]).toMatchObject({ status: 'refunded', bib_number: null });
    expect(await counters(ev)).toEqual({ race: before.race - 1, shirt: before.shirt - 1, tier: before.tier - 1 });
    const order = await ctx.pool.query('SELECT status, refunded_satang FROM orders WHERE id = $1', [r.orderId]);
    expect(order.rows[0]).toEqual({ status: 'refunded', refunded_satang: '32000' });
    const coupon = await ctx.pool.query('SELECT voided_at FROM coupon_redemptions WHERE order_id = $1', [r.orderId]);
    expect(coupon.rows[0].voided_at).not.toBeNull();
    expect((await call(ctx.app, 'GET', `/v1/me/registrations/${r.reg.id}/refund`, { token: r.token })).body.lastRequest.status).toBe('approved');

    const done = await call(ctx.app, 'POST', `${ev.base}/refunds/${item.id}/transferred`, { token: finance.token, body: { reference: 'KBANK 0099' } });
    expect(done.body.status).toBe('succeeded');
    const closed = await call(ctx.app, 'GET', `${ev.base}/refunds?status=closed`, { token: finance.token });
    expect(closed.body.items).toEqual([expect.objectContaining({ id: item.id, status: 'succeeded', transferReference: 'KBANK 0099' })]);

    // The same ID card can register for the race again now that the place is refunded.
    const again = await paid(ev, { person });
    expect(again.reg.bib_number).not.toBeNull();
    const audit = await ctx.pool.query(`SELECT action FROM audit_logs WHERE entity_id = $1 ORDER BY id`, [item.id]);
    expect(audit.rows.map((a) => a.action)).toEqual(['refund.request', 'refund.approve', 'refund.transferred']);
  });

  it('rejects a request with a note and keeps the place', async () => {
    const ev = await orgEvent();
    const r = await paid(ev);
    await call(ctx.app, 'POST', `/v1/me/registrations/${r.reg.id}/refund-requests`, { token: r.token, body: { reason: 'เปลี่ยนใจ', bank } });
    const { body } = await call(ctx.app, 'GET', `${ev.base}/refunds`, { token: ev.token });
    expect((await call(ctx.app, 'POST', `${ev.base}/refunds/${body.items[0].id}/reject`, { token: ev.token, body: {} })).status).toBe(422);
    const rejected = await call(ctx.app, 'POST', `${ev.base}/refunds/${body.items[0].id}/reject`, { token: ev.token, body: { note: 'เกินกำหนด' } });
    expect(rejected.body.status).toBe('rejected');

    const reg = await ctx.pool.query('SELECT status, bib_number FROM registrations WHERE id = $1', [r.reg.id]);
    expect(reg.rows[0]).toEqual({ status: 'confirmed', bib_number: r.reg.bib_number });
    const quote = await call(ctx.app, 'GET', `/v1/me/registrations/${r.reg.id}/refund`, { token: r.token });
    expect(quote.body).toMatchObject({ eligible: true, lastRequest: { status: 'rejected', note: 'เกินกำหนด' } });
  });

  it('lets the organiser cancel a place with any refund up to what was paid', async () => {
    const ev = await orgEvent();
    const keep = await paid(ev);
    const refund = await paid(ev);
    const before = await counters(ev);
    const cancel = (id: string, body: unknown) => call(ctx.app, 'POST', `${ev.base}/registrations/${id}/cancel`, { token: ev.token, body });

    expect((await cancel(keep.reg.id, { refundSatang: 50_001, reason: 'x' })).status).toBe(422);
    const noMoney = await cancel(keep.reg.id, { refundSatang: 0, reason: 'ซ้ำ' });
    expect(noMoney.body).toEqual({ registrationId: keep.reg.id, status: 'cancelled', refundId: null });
    expect((await cancel(keep.reg.id, { refundSatang: 0, reason: 'ซ้ำ' })).body.code).toBe('NOT_CONFIRMED');

    const half = await cancel(refund.reg.id, { refundSatang: 25_000, reason: 'งานเลื่อน' });
    expect(half.body).toMatchObject({ status: 'refunded', refundId: expect.any(String) });
    expect(await counters(ev)).toEqual({ race: before.race - 2, shirt: before.shirt - 2, tier: before.tier - 2 });
    const orders = await ctx.pool.query('SELECT id, status FROM orders WHERE id = ANY($1)', [[keep.orderId, refund.orderId]]);
    expect(Object.fromEntries(orders.rows.map((o) => [o.id, o.status]))).toEqual({ [keep.orderId]: 'cancelled', [refund.orderId]: 'refunded' });
    const list = await call(ctx.app, 'GET', `${ev.base}/refunds`, { token: ev.token });
    expect(list.body.items).toEqual([expect.objectContaining({ id: half.body.refundId, status: 'approved', amountSatang: 25_000, requestedByRunner: false, bank: null })]);
  });

  it('follows the event policy', async () => {
    const ev = await orgEvent();
    const r = await paid(ev);
    const quote = () => call(ctx.app, 'GET', `/v1/me/registrations/${r.reg.id}/refund`, { token: r.token });

    expect((await call(ctx.app, 'PATCH', ev.base, { token: ev.token, body: { refundPercentBps: 5000 } })).body).toMatchObject({ allowRefund: true, refundPercentBps: 5000 });
    expect((await quote()).body.amountSatang).toBe(25_000);
    await call(ctx.app, 'PATCH', ev.base, { token: ev.token, body: { refundDeadline: new Date(Date.now() - 60_000).toISOString() } });
    expect((await quote()).body.reason).toBe('REFUND_CLOSED');
    await call(ctx.app, 'PATCH', ev.base, { token: ev.token, body: { refundDeadline: null, allowRefund: false } });
    expect((await quote()).body.reason).toBe('REFUND_NOT_ALLOWED');
    expect((await call(ctx.app, 'POST', `/v1/me/registrations/${r.reg.id}/refund-requests`, { token: r.token, body: { reason: 'x', bank } })).body.code).toBe('REFUND_NOT_ALLOWED');

    await call(ctx.app, 'PATCH', ev.base, { token: ev.token, body: { allowRefund: true } });
    await call(ctx.app, 'POST', `${ev.base}/checkins`, { token: ev.token, body: { code: r.reg.qr_token, clientUuid: randomUUID() } });
    expect((await quote()).body.reason).toBe('ALREADY_PICKED_UP');
  });
});
