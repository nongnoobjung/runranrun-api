import { randomUUID } from 'node:crypto';
import { addOrgMember, createEvent, setPlatformRole } from '../db/fixtures';
import { bootApp, buyer, call, login, runner, sendFakeWebhook, TestContext, uniqueSlug } from './helpers';

describe('admin backoffice', () => {
  let ctx: TestContext;
  let admin: string;

  beforeAll(async () => {
    ctx = await bootApp();
    const email = `admin-${randomUUID()}@kao.example`;
    await setPlatformRole(ctx.pool, email, 'admin');
    admin = (await login(ctx.app, email)).token;
  });
  afterAll(() => ctx.close());

  /** An organisation of its own with one 10K event (฿900), and its owner. */
  async function orgEvent() {
    const created = await createEvent(
      ctx.pool,
      {
        slug: uniqueSlug(),
        nameTh: 'งานแอดมิน',
        eventDate: '2027-05-01',
        races: [{ code: '10K', nameTh: 'มินิ', distanceKm: 10, capacity: 50, bibStart: 1, bibEnd: 50, tiers: [{ name: 'ปกติ', priceSatang: 90_000 }] }],
      },
      uniqueSlug('org'),
    );
    const email = `owner-${randomUUID()}@org.example`;
    await addOrgMember(ctx.pool, created.organizationId, email, 'owner');
    const { token } = await login(ctx.app, email);
    return { ...created, token, base: `/v1/org/${created.organizationId}/events/${created.eventId}` };
  }

  async function paidOrder(ev: Awaited<ReturnType<typeof orgEvent>>) {
    const { token } = await login(ctx.app);
    const raceId = ev.raceIds['10K'];
    const session = await call(ctx.app, 'POST', '/v1/checkout/sessions', { token, body: { eventId: ev.eventId, races: [{ raceId, quantity: 1 }] } });
    const order = await call(ctx.app, 'POST', '/v1/orders', {
      token,
      headers: { 'idempotency-key': randomUUID() },
      body: { checkoutSessionId: session.body.id, buyer, participants: [{ raceId, runner: runner() }] },
    });
    const payment = await call(ctx.app, 'POST', `/v1/orders/${order.body.id}/payments`, { token, headers: { 'idempotency-key': randomUUID() }, body: { method: 'promptpay' } });
    const charge = await ctx.pool.query('SELECT gateway_charge_id FROM payments WHERE id = $1', [payment.body.id]);
    await sendFakeWebhook(ctx.app, charge.rows[0].gateway_charge_id);
    return order.body.id as string;
  }

  it('lets only platform staff in, each role to its own part', async () => {
    const someone = await login(ctx.app);
    expect((await call(ctx.app, 'GET', '/v1/admin/me', { token: someone.token })).status).toBe(403);
    expect((await call(ctx.app, 'GET', '/v1/admin/overview', { token: someone.token })).status).toBe(403);

    const supportEmail = `support-${randomUUID()}@kao.example`;
    await setPlatformRole(ctx.pool, supportEmail, 'support');
    const support = await login(ctx.app, supportEmail);
    expect((await call(ctx.app, 'GET', '/v1/admin/me', { token: support.token })).body).toEqual({
      role: 'support',
      can: { view: true, review_events: false, manage_orgs: false, payouts: false, fees: false, manage_users: false, manage_roles: false },
    });
    expect((await call(ctx.app, 'GET', '/v1/admin/reviews', { token: support.token })).status).toBe(200);
    expect((await call(ctx.app, 'GET', '/v1/admin/payouts', { token: support.token })).status).toBe(403);
    const ev = await orgEvent();
    expect((await call(ctx.app, 'POST', `/v1/admin/organizations/${ev.organizationId}/approve`, { token: support.token })).status).toBe(403);
    expect((await call(ctx.app, 'GET', '/v1/admin/overview', { token: admin })).body).toMatchObject({ pendingReview: expect.any(Number), pendingKyc: expect.any(Number) });
  });

  it('holds a reviewed organisation’s first opening until an admin approves it', async () => {
    const ev = await orgEvent();
    await ctx.pool.query('UPDATE organizations SET review_events = true WHERE id = $1', [ev.organizationId]);
    await ctx.pool.query(`UPDATE events SET status = 'draft', published_at = NULL WHERE id = $1`, [ev.eventId]);

    const submitted = await call(ctx.app, 'POST', `${ev.base}/publish`, { token: ev.token });
    expect(submitted.body).toMatchObject({ status: 'pending_review', review: { submittedAt: expect.any(String), note: null } });
    const slug = (await ctx.pool.query('SELECT slug FROM events WHERE id = $1', [ev.eventId])).rows[0].slug;
    expect((await call(ctx.app, 'GET', `/v1/events/${slug}`)).status).toBe(404);
    expect((await call(ctx.app, 'POST', `${ev.base}/publish`, { token: ev.token })).body.code).toBe('INVALID_STATUS');

    const queue = (await call(ctx.app, 'GET', '/v1/admin/reviews', { token: admin })).body.items;
    expect(queue).toEqual(expect.arrayContaining([expect.objectContaining({ id: ev.eventId, races: 1, capacity: 50, organization: expect.objectContaining({ id: ev.organizationId }) })]));
    const detail = await call(ctx.app, 'GET', `/v1/admin/events/${ev.eventId}`, { token: admin });
    expect(detail.body).toMatchObject({ event: { id: ev.eventId, races: [expect.objectContaining({ code: '10K' })] }, organization: { reviewEvents: true } });

    const rejected = await call(ctx.app, 'POST', `/v1/admin/events/${ev.eventId}/reject`, { token: admin, body: { note: 'ใส่แผนที่เส้นทางด้วย' } });
    expect(rejected.body).toMatchObject({ status: 'draft' });
    expect((await call(ctx.app, 'GET', ev.base, { token: ev.token })).body).toMatchObject({ status: 'draft', review: { note: 'ใส่แผนที่เส้นทางด้วย' } });

    await call(ctx.app, 'POST', `${ev.base}/publish`, { token: ev.token });
    expect((await call(ctx.app, 'POST', `/v1/admin/events/${ev.eventId}/approve`, { token: admin })).body.status).toBe('published');
    expect((await call(ctx.app, 'GET', `/v1/events/${slug}`)).status).toBe(200);
    expect((await call(ctx.app, 'POST', `/v1/admin/events/${ev.eventId}/approve`, { token: admin })).body.code).toBe('INVALID_STATUS');

    // Approved once, the organiser closes and reopens on their own.
    await call(ctx.app, 'POST', `${ev.base}/close`, { token: ev.token });
    expect((await call(ctx.app, 'POST', `${ev.base}/publish`, { token: ev.token })).body.status).toBe('published');
    const audit = await ctx.pool.query(`SELECT action FROM audit_logs WHERE event_id = $1 AND action LIKE 'admin.%' ORDER BY created_at`, [ev.eventId]);
    expect(audit.rows.map((a) => a.action)).toEqual(['admin.event_reject', 'admin.event_approve']);
  });

  it('lets development tools create an organiser that waits for KYC and review', async () => {
    const ownerEmail = `dev-owner-${randomUUID()}@org.example`;
    const created = await call(ctx.app, 'POST', '/v1/dev/organizations', { body: { nameTh: 'ทีมใหม่', ownerEmail } });
    expect(created.status).toBe(201);
    const org = await call(ctx.app, 'GET', `/v1/admin/organizations/${created.body.id}`, { token: admin });
    expect(org.body).toMatchObject({ status: 'pending_kyc', reviewEvents: true, members: [{ email: ownerEmail, role: 'owner', accepted: true }] });
  });

  it('approves, suspends and reactivates organisers and records their bank account', async () => {
    const ev = await orgEvent();
    await ctx.pool.query(`UPDATE organizations SET status = 'pending_kyc', kyc_approved_at = NULL WHERE id = $1`, [ev.organizationId]);
    await ctx.pool.query(`UPDATE events SET status = 'draft' WHERE id = $1`, [ev.eventId]);
    expect((await call(ctx.app, 'POST', `${ev.base}/publish`, { token: ev.token })).body).toMatchObject({ code: 'EVENT_NOT_READY', missing: ['organization'] });

    const pending = await call(ctx.app, 'GET', '/v1/admin/organizations?status=pending_kyc', { token: admin });
    expect(pending.body.items.map((o: { id: string }) => o.id)).toContain(ev.organizationId);
    expect(pending.body.counts.pending_kyc).toBeGreaterThanOrEqual(1);

    const approved = await call(ctx.app, 'POST', `/v1/admin/organizations/${ev.organizationId}/approve`, { token: admin });
    expect(approved.body).toMatchObject({ status: 'active', kycApprovedAt: expect.any(String), members: [expect.objectContaining({ role: 'owner' })] });
    expect((await call(ctx.app, 'POST', `/v1/admin/organizations/${ev.organizationId}/approve`, { token: admin })).body.code).toBe('INVALID_STATUS');
    expect((await call(ctx.app, 'POST', `${ev.base}/publish`, { token: ev.token })).body.status).toBe('published');

    const suspended = await call(ctx.app, 'POST', `/v1/admin/organizations/${ev.organizationId}/suspend`, { token: admin, body: { reason: 'เอกสารปลอม' } });
    expect(suspended.body).toMatchObject({ status: 'suspended', statusNote: 'เอกสารปลอม' });
    await call(ctx.app, 'POST', `${ev.base}/close`, { token: ev.token });
    expect((await call(ctx.app, 'POST', `${ev.base}/publish`, { token: ev.token })).body.code).toBe('EVENT_NOT_READY');
    expect((await call(ctx.app, 'POST', `/v1/admin/organizations/${ev.organizationId}/reactivate`, { token: admin })).body).toMatchObject({ status: 'active', statusNote: null });

    const settings = await call(ctx.app, 'PATCH', `/v1/admin/organizations/${ev.organizationId}`, { token: admin, body: { reviewEvents: true } });
    expect(settings.body.reviewEvents).toBe(true);
    const bank = await call(ctx.app, 'PUT', `/v1/admin/organizations/${ev.organizationId}/bank-account`, {
      token: admin,
      body: { bankCode: 'KBANK', accountName: 'บจก. ทดสอบ', accountNumber: '123-4-56789-0' },
    });
    expect(bank.body.bankAccount).toEqual({ bankCode: 'KBANK', accountName: 'บจก. ทดสอบ', accountLast4: '7890', branch: null, verified: true });
    expect(JSON.stringify(bank.body)).not.toContain('1234567890');
  });

  it('settles what an event collected in rounds and records the transfer', async () => {
    const ev = await orgEvent();
    await paidOrder(ev);
    const settle = () => call(ctx.app, 'POST', `/v1/admin/events/${ev.eventId}/settlements`, { token: admin });

    const first = await settle();
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: 'calculated', grossSatang: 90_000, refundsSatang: 0, netSatang: 90_000 });
    expect((await settle()).body.code).toBe('SETTLEMENT_OPEN');
    expect((await call(ctx.app, 'POST', `/v1/admin/settlements/${first.body.id}/approve`, { token: admin })).body.code).toBe('NO_BANK_ACCOUNT');

    await call(ctx.app, 'PUT', `/v1/admin/organizations/${ev.organizationId}/bank-account`, {
      token: admin,
      body: { bankCode: 'SCB', accountName: 'บจก. ทดสอบ', accountNumber: '1112223334' },
    });
    const approved = await call(ctx.app, 'POST', `/v1/admin/settlements/${first.body.id}/approve`, { token: admin });
    expect(approved.body).toMatchObject({ status: 'approved', payout: { status: 'pending', bankCode: 'SCB', accountLast4: '3334' } });
    const paid = await call(ctx.app, 'POST', `/v1/admin/settlements/${first.body.id}/paid`, { token: admin, body: { transferRef: 'SCB-0001' } });
    expect(paid.body).toMatchObject({ status: 'paid', payout: { status: 'paid', transferRef: 'SCB-0001' } });

    // The organiser sees the money as paid out.
    const finance = await call(ctx.app, 'GET', `${ev.base}/finance`, { token: ev.token });
    expect(finance.body.summary).toMatchObject({ netSatang: 90_000, paidOutSatang: 90_000, toPayOutSatang: 0 });
    expect(finance.body.payouts).toEqual([expect.objectContaining({ status: 'paid', payout: expect.objectContaining({ transferRef: 'SCB-0001' }) })]);
    expect((await settle()).body.code).toBe('NOTHING_TO_SETTLE');

    // A later sale goes into the next round only; a round that is voided hands its amount on.
    await paidOrder(ev);
    const second = await settle();
    expect(second.body).toMatchObject({ grossSatang: 90_000, netSatang: 90_000 });
    expect((await call(ctx.app, 'POST', `/v1/admin/settlements/${second.body.id}/void`, { token: admin })).status).toBe(200);
    const third = await settle();
    expect(third.body.netSatang).toBe(90_000);
    const orders = await ctx.pool.query('SELECT settlement_id FROM orders WHERE event_id = $1 ORDER BY created_at', [ev.eventId]);
    expect(orders.rows.map((o) => o.settlement_id)).toEqual([first.body.id, third.body.id]);

    const list = await call(ctx.app, 'GET', '/v1/admin/payouts', { token: admin });
    expect(list.body.events).toEqual(expect.arrayContaining([expect.objectContaining({ eventId: ev.eventId, openSettlement: third.body.id, toSettleSatang: 0 })]));
  });
});
