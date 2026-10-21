import { randomUUID } from 'node:crypto';
import { addOrgMember, createEvent } from '../db/fixtures';
import { EMAIL_SENDER, FakeEmailSender } from '../src/modules/notifications/email-sender';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { bootApp, buyer, call, login, runner, sendFakeWebhook, TestContext, uniqueSlug } from './helpers';

describe('broadcasts', () => {
  let ctx: TestContext;
  let outbox: FakeEmailSender['outbox'];

  beforeAll(async () => {
    ctx = await bootApp();
    outbox = ctx.app.get<FakeEmailSender>(EMAIL_SENDER).outbox;
  });
  afterAll(() => ctx.close());

  /** 21K (starts 19:00 Bangkok) and 10K; Ann runs 21K, Ben runs 10K and has his kit, Cat has not paid for 10K. */
  async function orgEvent() {
    const created = await createEvent(
      ctx.pool,
      {
        slug: uniqueSlug(),
        nameTh: 'งานส่งข่าว',
        eventDate: '2027-03-01',
        races: [
          { code: '21K', nameTh: 'ฮาล์ฟ', distanceKm: 21.1, capacity: 50, bibStart: 1, bibEnd: 50, tiers: [{ name: 'ปกติ', priceSatang: 90_000 }] },
          { code: '10K', nameTh: 'มินิ', distanceKm: 10, capacity: 50, bibStart: 2001, bibEnd: 2050, tiers: [{ name: 'ปกติ', priceSatang: 50_000 }] },
        ],
      },
      uniqueSlug('org'),
    );
    await ctx.pool.query(`UPDATE races SET start_at = '2027-03-01T19:00:00+07:00' WHERE id = $1`, [created.raceIds['21K']]);
    const email = `owner-${randomUUID()}@org.example`;
    await addOrgMember(ctx.pool, created.organizationId, email, 'owner');
    const { token } = await login(ctx.app, email);
    const tag = randomUUID().slice(0, 6);
    const ann = await register(created, '21K', runner({ firstNameTh: 'แอน', email: `ann-${tag}@example.com` }), true);
    const ben = await register(created, '10K', runner({ firstNameTh: 'เบน', email: `ben-${tag}@example.com` }), true);
    const cat = await register(created, '10K', runner({ firstNameTh: 'แคท', email: `cat-${tag}@example.com` }), false);
    await ctx.pool.query('UPDATE registrations SET kit_picked_up_at = now() WHERE id = $1', [ben.id]);
    return { ...created, email, token, base: `/v1/org/${created.organizationId}/events/${created.eventId}`, ann, ben, cat, tag };
  }

  async function register(ev: { eventId: string; raceIds: Record<string, string> }, raceCode: string, person: ReturnType<typeof runner>, pay: boolean) {
    const { token } = await login(ctx.app);
    const raceId = ev.raceIds[raceCode];
    const session = await call(ctx.app, 'POST', '/v1/checkout/sessions', { token, body: { eventId: ev.eventId, races: [{ raceId, quantity: 1 }] } });
    const order = await call(ctx.app, 'POST', '/v1/orders', {
      token,
      headers: { 'idempotency-key': randomUUID() },
      body: { checkoutSessionId: session.body.id, buyer, participants: [{ raceId, runner: person }] },
    });
    if (pay) {
      const payment = await call(ctx.app, 'POST', `/v1/orders/${order.body.id}/payments`, { token, headers: { 'idempotency-key': randomUUID() }, body: { method: 'promptpay' } });
      const charge = await ctx.pool.query('SELECT gateway_charge_id FROM payments WHERE id = $1', [payment.body.id]);
      await sendFakeWebhook(ctx.app, charge.rows[0].gateway_charge_id);
    }
    const reg = await ctx.pool.query('SELECT id, bib_number FROM registrations WHERE order_id = $1', [order.body.id]);
    return reg.rows[0] as { id: string; bib_number: string | null };
  }

  const draft = { subject: 'สวัสดี {ชื่อ}', body: '{ชื่อ} บิบ {บิบ} ระยะ {ระยะ} ปล่อยตัว {เวลาปล่อยตัว}' };

  it('counts the audience with the runner-list filters and fills in the placeholders', async () => {
    const ev = await orgEvent();
    const preview = (audience: Record<string, unknown>) => call(ctx.app, 'POST', `${ev.base}/broadcasts/preview`, { token: ev.token, body: { audience, ...draft } });

    const all = await preview({});
    expect(all.body).toMatchObject({ count: 2, withoutEmail: 0 });
    expect(all.body.sample).toEqual({ to: `ann-${ev.tag}@example.com`, subject: 'สวัสดี แอน', body: `แอน บิบ ${ev.ann.bib_number} ระยะ 21K ปล่อยตัว 19:00` });
    expect((await preview({ raceId: ev.raceIds['10K'] })).body.count).toBe(1);
    expect((await preview({ pickup: 'not_picked' })).body.sample.to).toBe(`ann-${ev.tag}@example.com`);
    const unpaid = await preview({ status: 'pending' });
    expect(unpaid.body).toMatchObject({ count: 1, sample: { to: `cat-${ev.tag}@example.com`, body: 'แคท บิบ - ระยะ 10K ปล่อยตัว -' } });
  });

  it('keeps drafts, sends a test to the organiser, then sends each runner their own message once', async () => {
    const ev = await orgEvent();
    const created = await call(ctx.app, 'POST', `${ev.base}/broadcasts`, { token: ev.token, body: { ...draft, audience: { pickup: 'not_picked' } } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'draft', channels: ['email'], audience: { raceId: null, status: 'confirmed', pickup: 'not_picked' } });
    const path = `${ev.base}/broadcasts/${created.body.id}`;
    const updated = await call(ctx.app, 'PATCH', path, { token: ev.token, body: { audience: { status: 'confirmed', raceId: null, pickup: null }, subject: 'แจ้ง {ชื่อ}' } });
    expect(updated.body).toMatchObject({ subject: 'แจ้ง {ชื่อ}', audience: { pickup: null } });

    const before = outbox.length;
    expect((await call(ctx.app, 'POST', `${path}/test`, { token: ev.token })).body).toEqual({ to: ev.email });
    expect(outbox.slice(before)).toEqual([{ to: ev.email, subject: '[ทดสอบ] แจ้ง แอน', text: expect.stringContaining('แอน บิบ') }]);

    const sent = await call(ctx.app, 'POST', `${path}/send`, { token: ev.token, body: {} });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ status: 'sent', recipientCount: 2, sentCount: 2, failedCount: 0 });
    const mine = outbox.slice(before + 1);
    expect(mine.map((m) => [m.to, m.subject]).sort()).toEqual([[`ann-${ev.tag}@example.com`, 'แจ้ง แอน'], [`ben-${ev.tag}@example.com`, 'แจ้ง เบน']]);
    expect(mine.find((m) => m.to.startsWith('ben'))!.text).toBe(`เบน บิบ ${ev.ben.bib_number} ระยะ 10K ปล่อยตัว -`);

    const rows = await ctx.pool.query(`SELECT status, registration_id FROM notifications WHERE broadcast_id = $1`, [created.body.id]);
    expect(rows.rows.map((r) => r.status)).toEqual(['sent', 'sent']);
    expect((await call(ctx.app, 'POST', `${path}/send`, { token: ev.token, body: {} })).body.code).toBe('BROADCAST_NOT_DRAFT');
    expect((await call(ctx.app, 'PATCH', path, { token: ev.token, body: { body: 'x' } })).body.code).toBe('BROADCAST_NOT_DRAFT');

    const list = await call(ctx.app, 'GET', `${ev.base}/broadcasts`, { token: ev.token });
    expect(list.body.items).toEqual([expect.objectContaining({ id: created.body.id, status: 'sent', sentAt: expect.any(String) })]);
    const audit = await ctx.pool.query(`SELECT action FROM audit_logs WHERE entity_id = $1 ORDER BY id`, [created.body.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['broadcast.create', 'broadcast.update', 'broadcast.send']);
  });

  it('schedules for later, can be taken back, and goes out when its time comes', async () => {
    const ev = await orgEvent();
    const { body: b } = await call(ctx.app, 'POST', `${ev.base}/broadcasts`, { token: ev.token, body: draft });
    const path = `${ev.base}/broadcasts/${b.id}`;
    expect((await call(ctx.app, 'POST', `${path}/send`, { token: ev.token, body: { scheduledAt: new Date(Date.now() - 60_000).toISOString() } })).status).toBe(422);

    const later = new Date(Date.now() + 3_600_000).toISOString();
    expect((await call(ctx.app, 'POST', `${path}/send`, { token: ev.token, body: { scheduledAt: later } })).body).toMatchObject({ status: 'scheduled' });
    expect((await call(ctx.app, 'POST', `${path}/unschedule`, { token: ev.token })).body).toMatchObject({ status: 'draft', scheduledAt: null });
    expect((await call(ctx.app, 'POST', `${path}/send`, { token: ev.token, body: { scheduledAt: later } })).body.status).toBe('scheduled');

    const notifications = ctx.app.get(NotificationsService);
    await notifications.sendDue();
    expect((await call(ctx.app, 'GET', `${ev.base}/broadcasts`, { token: ev.token })).body.items[0].status).toBe('scheduled');
    await ctx.pool.query(`UPDATE broadcasts SET scheduled_at = now() - interval '1 second' WHERE id = $1`, [b.id]);
    expect(await notifications.sendDue()).toBeGreaterThanOrEqual(1);
    expect((await call(ctx.app, 'GET', `${ev.base}/broadcasts`, { token: ev.token })).body.items[0]).toMatchObject({ status: 'sent', sentCount: 2 });

    // A delivery that stopped half way is finished by the next run.
    await ctx.pool.query(`UPDATE broadcasts SET status = 'sending', sent_count = 1 WHERE id = $1`, [b.id]);
    await ctx.pool.query(
      `UPDATE notifications SET status = 'queued', sent_at = NULL, created_at = now() - interval '10 minutes'
        WHERE id = (SELECT id FROM notifications WHERE broadcast_id = $1 LIMIT 1)`,
      [b.id],
    );
    const before = outbox.length;
    await notifications.sendDue();
    expect(outbox.length).toBe(before + 1);
    expect((await call(ctx.app, 'GET', `${ev.base}/broadcasts`, { token: ev.token })).body.items[0]).toMatchObject({ status: 'sent', sentCount: 2 });
  });

  it('refuses audiences nobody is in, removes drafts, and is for owners and admins', async () => {
    const ev = await orgEvent();
    const empty = await call(ctx.app, 'POST', `${ev.base}/broadcasts`, { token: ev.token, body: { ...draft, audience: { status: 'pending', pickup: 'picked' } } });
    expect((await call(ctx.app, 'POST', `${ev.base}/broadcasts/${empty.body.id}/send`, { token: ev.token, body: {} })).body.code).toBe('NO_RECIPIENTS');
    expect((await call(ctx.app, 'DELETE', `${ev.base}/broadcasts/${empty.body.id}`, { token: ev.token })).status).toBe(200);
    expect((await call(ctx.app, 'GET', `${ev.base}/broadcasts`, { token: ev.token })).body.items).toEqual([]);

    const email = `staff-${randomUUID()}@org.example`;
    await addOrgMember(ctx.pool, ev.organizationId, email, 'staff');
    const staff = await login(ctx.app, email);
    expect((await call(ctx.app, 'GET', `${ev.base}/broadcasts`, { token: staff.token })).status).toBe(403);
    expect((await call(ctx.app, 'POST', `${ev.base}/broadcasts`, { token: staff.token, body: draft })).status).toBe(403);
  });
});
