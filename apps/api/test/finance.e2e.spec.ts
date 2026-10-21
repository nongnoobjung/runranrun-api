import { randomUUID } from 'node:crypto';
import { addOrgMember, createEvent } from '../db/fixtures';
import { bootApp, buyer, call, login, runner, sendFakeWebhook, TestContext, uniqueSlug } from './helpers';

describe('organiser finance', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await bootApp();
  });
  afterAll(() => ctx.close());

  /** A ฿500 10K with a ฿100 coupon in its own organisation, whose platform fee is 3% + ฿5 per runner. */
  async function orgEvent() {
    const created = await createEvent(
      ctx.pool,
      {
        slug: uniqueSlug(),
        nameTh: 'งานการเงิน',
        eventDate: '2027-03-01',
        races: [{ code: '10K', nameTh: 'มินิ', distanceKm: 10, capacity: 50, bibStart: 1, bibEnd: 50, tiers: [{ name: 'ปกติ', priceSatang: 50_000 }] }],
        coupons: [{ code: 'HELLO', type: 'fixed', value: 10_000 }],
      },
      uniqueSlug('org'),
    );
    await ctx.pool.query('INSERT INTO platform_fees (organization_id, percent_bps, fixed_per_reg_satang) VALUES ($1, 300, 500)', [created.organizationId]);
    const email = `owner-${randomUUID()}@org.example`;
    await addOrgMember(ctx.pool, created.organizationId, email, 'owner');
    const { token } = await login(ctx.app, email);
    return { ...created, token, org: `/v1/org/${created.organizationId}`, base: `/v1/org/${created.organizationId}/events/${created.eventId}` };
  }

  async function order(ev: Awaited<ReturnType<typeof orgEvent>>, opts: { coupon?: string; pay?: boolean } = {}) {
    const me = await login(ctx.app);
    const raceId = ev.raceIds['10K'];
    const session = await call(ctx.app, 'POST', '/v1/checkout/sessions', { token: me.token, body: { eventId: ev.eventId, races: [{ raceId, quantity: 1 }] } });
    const created = await call(ctx.app, 'POST', '/v1/orders', {
      token: me.token,
      headers: { 'idempotency-key': randomUUID() },
      body: { checkoutSessionId: session.body.id, couponCode: opts.coupon, buyer, participants: [{ raceId, runner: runner() }] },
    });
    if (opts.pay !== false) {
      const payment = await call(ctx.app, 'POST', `/v1/orders/${created.body.id}/payments`, { token: me.token, headers: { 'idempotency-key': randomUUID() }, body: { method: 'promptpay' } });
      const charge = await ctx.pool.query('SELECT gateway_charge_id FROM payments WHERE id = $1', [payment.body.id]);
      await sendFakeWebhook(ctx.app, charge.rows[0].gateway_charge_id);
    }
    const row = await ctx.pool.query('SELECT id, order_no FROM orders WHERE id = $1', [created.body.id]);
    return row.rows[0] as { id: string; order_no: string };
  }

  it('records the platform fee on each order when it is placed', async () => {
    const ev = await orgEvent();
    const plain = await order(ev);
    const discounted = await order(ev, { coupon: 'HELLO' });
    const fees = await ctx.pool.query('SELECT id, platform_fee_satang, fee_satang, total_satang FROM orders WHERE id = ANY($1)', [[plain.id, discounted.id]]);
    const byId = Object.fromEntries(fees.rows.map((r) => [r.id, r]));
    // 3% of what the organiser sells after the discount, plus ฿5 per runner. The runner fee is separate.
    expect(byId[plain.id]).toMatchObject({ platform_fee_satang: '2000', fee_satang: '1000', total_satang: '51000' });
    expect(byId[discounted.id]).toMatchObject({ platform_fee_satang: '1700', fee_satang: '800', total_satang: '40800' });
  });

  it('sums an event: sales, discounts, fees, refunds, net and what has been paid out', async () => {
    const ev = await orgEvent();
    const a = await order(ev);
    await order(ev, { coupon: 'HELLO' });
    await order(ev, { pay: false });
    const reg = await ctx.pool.query('SELECT id FROM registrations WHERE order_id = $1', [a.id]);
    await ctx.pool.query(`INSERT INTO refunds (order_id, registration_id, status, amount_satang, reason) VALUES ($1, $2, 'approved', 40000, 'ป่วย')`, [a.id, reg.rows[0].id]);
    await ctx.pool.query('UPDATE orders SET refunded_satang = 40000 WHERE id = $1', [a.id]);

    const bank = await ctx.pool.query(
      `INSERT INTO bank_accounts (organization_id, bank_code, account_name, account_number_enc, account_number_last4, is_default, verified_at)
       VALUES ($1, 'KBANK', 'บจก. ทดสอบ', '\\x00', '5521', true, now()) RETURNING id`,
      [ev.organizationId],
    );
    const settlement = await ctx.pool.query(
      `INSERT INTO settlements (organization_id, event_id, period_start, period_end, status, order_count, gross_satang, platform_fee_satang, net_satang)
       VALUES ($1, $2, now() - interval '15 days', now() - interval '1 day', 'paid', 2, 90000, 3700, 86300) RETURNING id`,
      [ev.organizationId, ev.eventId],
    );
    await ctx.pool.query(
      `INSERT INTO payouts (settlement_id, organization_id, bank_account_id, amount_satang, status, transfer_ref, paid_at) VALUES ($1, $2, $3, 20000, 'paid', 'TRF-1', now())`,
      [settlement.rows[0].id, ev.organizationId, bank.rows[0].id],
    );

    const res = await call(ctx.app, 'GET', `${ev.base}/finance`, { token: ev.token });
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({
      orders: 2, runners: 2, salesSatang: 100_000, discountsSatang: 10_000, runnerFeesSatang: 1_800, platformFeesSatang: 3_700, collectedSatang: 91_800,
      refundCount: 1, refundsSatang: 40_000, refundsPaidSatang: 0, pendingOrders: 1, pendingSatang: 51_000,
      netSatang: 46_300, paidOutSatang: 20_000, toPayOutSatang: 26_300,
    });
    expect(res.body.payouts).toEqual([
      expect.objectContaining({ status: 'paid', grossSatang: 90_000, feesSatang: 3_700, netSatang: 86_300, payout: expect.objectContaining({ status: 'paid', amountSatang: 20_000, transferRef: 'TRF-1', bankCode: 'KBANK', accountLast4: '5521' }) }),
    ]);
    expect(res.body.bankAccount).toEqual({ bankCode: 'KBANK', accountName: 'บจก. ทดสอบ', accountLast4: '5521', branch: null, verified: true });

    const all = await call(ctx.app, 'GET', `${ev.base}/finance/transactions`, { token: ev.token });
    expect(all.body.total).toBe(3);
    const refunded = all.body.items.find((t: { orderNo: string }) => t.orderNo === a.order_no);
    expect(refunded).toMatchObject({ status: 'paid', method: 'promptpay', runners: 1, salesSatang: 50_000, platformFeeSatang: 2_000, refundedSatang: 40_000, netSatang: 8_000 });
    const pending = await call(ctx.app, 'GET', `${ev.base}/finance/transactions?status=pending`, { token: ev.token });
    expect(pending.body).toMatchObject({ total: 1, items: [expect.objectContaining({ status: 'pending_payment', netSatang: null })] });
    expect((await call(ctx.app, 'GET', `${ev.base}/finance/transactions?status=paid&limit=1`, { token: ev.token })).body).toMatchObject({ total: 2, items: [expect.anything()] });

    const csv = await ctx.app.inject({ method: 'GET', url: `${ev.base}/finance/transactions.csv`, headers: { authorization: `Bearer ${ev.token}` } });
    const lines = csv.body.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('order_no,status,created_at,paid_at,method,buyer_name,runners,sales,discount,runner_fee,paid_by_buyer,platform_fee,refunded,net');
    expect(lines).toHaveLength(4);
    expect(lines.find((l) => l.startsWith(a.order_no))).toMatch(/,500\.00,0\.00,10\.00,510\.00,20\.00,400\.00,80\.00$/);
    const audit = await ctx.pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE event_id = $1 AND action = 'finance.export'`, [ev.eventId]);
    expect(audit.rows[0].n).toBe(1);

    const org = await call(ctx.app, 'GET', `${ev.org}/finance`, { token: ev.token });
    expect(org.body.events).toEqual([expect.objectContaining({ eventId: ev.eventId, nameTh: 'งานการเงิน', netSatang: 46_300 })]);
    expect(org.body.totals).toMatchObject({ salesSatang: 100_000, netSatang: 46_300, paidOutSatang: 20_000 });
  });

  it('is for owners, admins and finance only', async () => {
    const ev = await orgEvent();
    for (const [role, status] of [['finance', 200], ['admin', 200], ['staff', 403], ['viewer', 403]] as const) {
      const email = `${role}-${randomUUID()}@org.example`;
      await addOrgMember(ctx.pool, ev.organizationId, email, role);
      const { token } = await login(ctx.app, email);
      expect((await call(ctx.app, 'GET', `${ev.base}/finance`, { token })).status).toBe(status);
      expect((await call(ctx.app, 'GET', `${ev.org}/finance`, { token })).status).toBe(status);
    }
    const outsider = await login(ctx.app);
    expect((await call(ctx.app, 'GET', `${ev.base}/finance/transactions`, { token: outsider.token })).status).toBe(404);
  });
});
