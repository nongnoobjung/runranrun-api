import { randomUUID } from 'node:crypto';
import { addOrgMember, createEvent } from '../db/fixtures';
import { EMAIL_SENDER, FakeEmailSender, OutgoingEmail } from '../src/modules/notifications/email-sender';
import { queueOrderPaid } from '../src/modules/notifications/emails';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { bootApp, buyer, call, login, runner, sendFakeWebhook, TestContext, uniqueSlug } from './helpers';

describe('transactional emails', () => {
  let ctx: TestContext;
  let sender: FakeEmailSender;

  beforeAll(async () => {
    ctx = await bootApp();
    sender = ctx.app.get<FakeEmailSender>(EMAIL_SENDER);
  });
  afterAll(() => ctx.close());

  /** A 21K (฿1,200) and a 10K (฿900) with transfers, race changes and the waitlist on, and its owner. */
  async function orgEvent(capacity = 50) {
    const created = await createEvent(
      ctx.pool,
      {
        slug: uniqueSlug(),
        nameTh: 'งานอีเมล',
        nameEn: 'Email Run',
        eventDate: '2027-03-01',
        races: [
          { code: '21K', nameTh: 'ฮาล์ฟ', distanceKm: 21.1, capacity, bibStart: 1, bibEnd: 500, tiers: [{ name: 'ปกติ', priceSatang: 120_000 }] },
          { code: '10K', nameTh: 'มินิ', distanceKm: 10, capacity, bibStart: 2001, bibEnd: 2500, tiers: [{ name: 'ปกติ', priceSatang: 90_000 }] },
        ],
      },
      uniqueSlug('org'),
    );
    await ctx.pool.query('UPDATE events SET allow_transfer = true, transfer_fee_satang = 0, allow_race_change = true, race_change_fee_satang = 0 WHERE id = $1', [created.eventId]);
    const email = `owner-${randomUUID()}@org.example`;
    await addOrgMember(ctx.pool, created.organizationId, email, 'owner');
    const { token } = await login(ctx.app, email);
    return { ...created, token, base: `/v1/org/${created.organizationId}/events/${created.eventId}` };
  }

  /** A runner (whose account email is also the buyer email) pays for one place for themselves. */
  async function paidPlace(ev: Awaited<ReturnType<typeof orgEvent>>, code: '21K' | '10K' = '10K', locale?: 'th' | 'en') {
    const email = `runner-${randomUUID()}@example.com`;
    const me = await login(ctx.app, email);
    if (locale) expect((await call(ctx.app, 'PUT', '/v1/me/locale', { token: me.token, body: { locale } })).status).toBe(200);
    const raceId = ev.raceIds[code];
    const session = await call(ctx.app, 'POST', '/v1/checkout/sessions', { token: me.token, body: { eventId: ev.eventId, races: [{ raceId, quantity: 1 }] } });
    const order = await call(ctx.app, 'POST', '/v1/orders', {
      token: me.token,
      headers: { 'idempotency-key': randomUUID() },
      body: { checkoutSessionId: session.body.id, buyer: { ...buyer, email }, participants: [{ raceId, isSelf: true, runner: runner({ email }) }] },
    });
    if (order.status !== 201) throw new Error(JSON.stringify(order.body));
    const payment = await call(ctx.app, 'POST', `/v1/orders/${order.body.id}/payments`, { token: me.token, headers: { 'idempotency-key': randomUUID() }, body: { method: 'promptpay' } });
    const charge = await ctx.pool.query('SELECT gateway_charge_id FROM payments WHERE id = $1', [payment.body.id]);
    const eventId = `evt-${randomUUID()}`;
    const webhook = () => sendFakeWebhook(ctx.app, charge.rows[0].gateway_charge_id, 'successful', eventId);
    await webhook();
    const reg = await ctx.pool.query('SELECT id, bib_number FROM registrations WHERE order_id = $1', [order.body.id]);
    return { ...me, email, orderId: order.body.id as string, registrationId: reg.rows[0].id as string, bib: reg.rows[0].bib_number as string, webhook };
  }

  /** What is queued for an address: template keys in order, with their language. */
  const queued = async (to: string) =>
    (await ctx.pool.query<{ template_key: string; payload: { locale: string; vars: Record<string, unknown> }; status: string }>(
      `SELECT template_key, payload, status FROM notifications WHERE recipient = $1 AND broadcast_id IS NULL ORDER BY created_at`,
      [to],
    )).rows;
  const keys = async (to: string) => (await queued(to)).map((n) => n.template_key);

  /** Sends everything due and returns what went to `to`. */
  async function sent(to: string): Promise<OutgoingEmail[]> {
    await ctx.app.get(NotificationsService).flush();
    return sender.outbox.filter((e) => e.to === to);
  }

  it('queues one "payment received" email per paid order, in Thai by default, with the receipt and ticket links', async () => {
    const ev = await orgEvent();
    const p = await paidPlace(ev);
    // The gateway redelivers, and the code that queues it runs again: still one email.
    expect((await p.webhook()).body.result).toBe('duplicate');
    await queueOrderPaid(ctx.pool, p.orderId);
    expect(await keys(p.email)).toEqual(['order_paid']);
    expect((await queued(p.email))[0].payload.locale).toBe('th');

    const mails = await sent(p.email);
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toMatch(/^ชำระเงินสำเร็จ: งานอีเมล/);
    expect(mails[0].text).toContain(`http://localhost:3000/orders/${p.orderId}/receipt`);
    expect(mails[0].text).toContain(`http://localhost:3000/me/registrations/${p.registrationId}`);
    expect(mails[0].text).toContain(`บิบ ${p.bib}`);
    expect((await queued(p.email))[0].status).toBe('sent');
    // Sending again finds nothing left to send.
    expect(await sent(p.email)).toHaveLength(1);
  });

  it("writes in the recipient's language: English links and text for an English account", async () => {
    const ev = await orgEvent();
    const p = await paidPlace(ev, '10K', 'en');
    expect((await queued(p.email))[0].payload.locale).toBe('en');
    const [mail] = await sent(p.email);
    expect(mail.subject).toMatch(/^Payment received: Email Run/);
    expect(mail.text).toContain(`http://localhost:3000/en/orders/${p.orderId}/receipt`);
    expect((await call(ctx.app, 'PUT', '/v1/me/locale', { token: p.token, body: { locale: 'fr' } })).status).toBe(422);
  });

  it('tells the runner about a bib the organiser gives or changes, once per change', async () => {
    const ev = await orgEvent();
    const p = await paidPlace(ev);
    const url = `${ev.base}/registrations/${p.registrationId}/bib`;
    expect((await call(ctx.app, 'PUT', url, { token: ev.token, body: { bibNumber: p.bib } })).status).toBe(200);
    expect(await keys(p.email)).toEqual(['order_paid']);
    await call(ctx.app, 'PUT', url, { token: ev.token, body: { bibNumber: '777' } });
    await call(ctx.app, 'PUT', url, { token: ev.token, body: { bibNumber: '777' } });
    expect(await keys(p.email)).toEqual(['order_paid', 'bib_assigned']);
    expect((await queued(p.email))[1].payload.vars).toMatchObject({ bib: '777', previousBib: p.bib });
    const mails = await sent(p.email);
    expect(mails.at(-1)!.subject).toBe(`เปลี่ยนเลขบิบ งานอีเมล: 777`);

    // Numbering the runners still waiting for a bib emails each of them.
    await ctx.pool.query(`UPDATE races SET bib_auto_assign = false WHERE id = $1`, [ev.raceIds['21K']]);
    const waiting = await paidPlace(ev, '21K');
    expect(waiting.bib).toBeNull();
    expect((await call(ctx.app, 'POST', `${ev.base}/bibs/assign`, { token: ev.token, body: {} })).body.assigned).toBe(1);
    expect(await keys(waiting.email)).toEqual(['order_paid', 'bib_assigned']);
  });

  it('emails each step of a refund exactly once', async () => {
    const ev = await orgEvent();
    await ctx.pool.query('UPDATE events SET allow_refund = true, refund_percent_bps = 10000 WHERE id = $1', [ev.eventId]);
    const bank = { bankCode: 'KBANK', accountName: 'สมชาย ใจดี', accountNumber: '1234567890' };

    const a = await paidPlace(ev);
    await call(ctx.app, 'POST', `/v1/me/registrations/${a.registrationId}/refund-requests`, { token: a.token, body: { reason: 'เจ็บขา', bank } });
    const [ra] = (await call(ctx.app, 'GET', `${ev.base}/refunds`, { token: ev.token })).body.items;
    expect((await call(ctx.app, 'POST', `${ev.base}/refunds/${ra.id}/approve`, { token: ev.token })).status).toBe(201);
    expect((await call(ctx.app, 'POST', `${ev.base}/refunds/${ra.id}/approve`, { token: ev.token })).status).toBe(409);
    await call(ctx.app, 'POST', `${ev.base}/refunds/${ra.id}/transferred`, { token: ev.token, body: { reference: 'KBANK 0099' } });
    expect(await keys(a.email)).toEqual(['order_paid', 'refund_approved', 'refund_transferred']);
    const mails = await sent(a.email);
    expect(mails.at(-1)!.text).toContain('KBANK 0099');

    const b = await paidPlace(ev);
    await call(ctx.app, 'POST', `/v1/me/registrations/${b.registrationId}/refund-requests`, { token: b.token, body: { reason: 'ไม่ว่าง', bank } });
    const rb = (await call(ctx.app, 'GET', `${ev.base}/refunds`, { token: ev.token })).body.items.find((i: any) => i.registration.id === b.registrationId);
    await call(ctx.app, 'POST', `${ev.base}/refunds/${rb.id}/reject`, { token: ev.token, body: { note: 'เลยกำหนด' } });
    expect(await keys(b.email)).toEqual(['order_paid', 'refund_rejected']);
    expect((await sent(b.email)).at(-1)!.text).toContain('เลยกำหนด');
  });

  it('emails both sides of a transfer and the runner who changed race', async () => {
    const ev = await orgEvent();
    const from = await paidPlace(ev, '21K');
    const toEmail = `friend-${randomUUID()}@example.com`;
    const to = await login(ctx.app, toEmail);
    await call(ctx.app, 'PUT', '/v1/me/locale', { token: to.token, body: { locale: 'en' } });
    const created = await call(ctx.app, 'POST', `/v1/me/registrations/${from.registrationId}/transfers`, { token: from.token, body: { toEmail } });
    const accepted = await call(ctx.app, 'POST', `/v1/me/transfers/${created.body.transfer.open.id}/accept`, { token: to.token, body: { runner: runner({ firstNameEn: 'Jane', lastNameEn: 'Doe' }) } });
    expect(accepted.body.status).toBe('completed');
    expect(await keys(from.email)).toEqual(['order_paid', 'transfer_sent']);
    // The invitation was sent when the transfer was offered (ChangesService); the confirmation comes now.
    expect(await keys(toEmail)).toEqual(['transfer_offer', 'transfer_received']);
    expect((await sent(toEmail)).at(-1)).toMatchObject({ subject: 'Place received: Email Run 21K', text: expect.stringContaining('/en/me/registrations/') });

    const mover = await paidPlace(ev, '21K');
    const change = await call(ctx.app, 'POST', `/v1/me/registrations/${mover.registrationId}/race-changes`, { token: mover.token, body: { toRaceId: ev.raceIds['10K'] } });
    expect(change.body.status).toBe('completed');
    expect(await keys(mover.email)).toEqual(['order_paid', 'race_change_completed']);
    expect((await queued(mover.email))[1].payload.vars).toMatchObject({ fromRace: '21K', toRace: '10K', bib: expect.any(String) });
  });

  it('emails the runner a waitlist offer once', async () => {
    const ev = await orgEvent(1);
    const holder = await paidPlace(ev, '10K');
    const email = `waiting-${randomUUID()}@example.com`;
    const waiting = await login(ctx.app, email);
    expect((await call(ctx.app, 'POST', '/v1/me/waitlist', { token: waiting.token, body: { raceId: ev.raceIds['10K'] } })).status).toBe(201);
    await call(ctx.app, 'POST', `${ev.base}/registrations/${holder.registrationId}/cancel`, { token: ev.token, body: { refundSatang: 0, reason: 'ยกเลิก' } });
    await call(ctx.app, 'POST', `${ev.base}/waitlist/offer`, { token: ev.token });
    expect(await keys(email)).toEqual(['waitlist_offer']);
    expect((await sent(email))[0].text).toContain('/me/waitlist');
  });

  it('emails finishers once when results are published, even if they are published again', async () => {
    const ev = await orgEvent();
    const fin = await paidPlace(ev, '10K');
    const dnf = await paidPlace(ev, '10K');
    const csv = ['bib,chip_time,gun_time,status', `${fin.bib},0:52:10,0:52:30,`, `${dnf.bib},,,DNF`].join('\n');
    expect((await call(ctx.app, 'POST', `${ev.base}/results/import`, { token: ev.token, body: { csv, dryRun: false } })).body.applied).toBe(true);
    const publish = (published: boolean) => call(ctx.app, 'POST', `${ev.base}/results/publish`, { token: ev.token, body: { published } });
    await publish(true);
    await publish(false);
    await publish(true);
    expect(await keys(fin.email)).toEqual(['order_paid', 'results_published']);
    expect(await keys(dnf.email)).toEqual(['order_paid']);
    expect((await sent(fin.email)).at(-1)!.text).toContain('0:52:10');
  });

  it('never sends one email twice when several senders flush at once, and retries a failed send later', async () => {
    const ev = await orgEvent();
    const people = [];
    for (let i = 0; i < 5; i += 1) people.push(await paidPlace(ev));
    const service = ctx.app.get(NotificationsService);
    await Promise.all([service.flush(), service.flush(), service.flush()]);
    for (const p of people) expect(sender.outbox.filter((e) => e.to === p.email)).toHaveLength(1);

    const flaky = await paidPlace(ev);
    const real = sender.send.bind(sender);
    const send = jest.spyOn(sender, 'send').mockImplementation(async (e) => {
      if (e.to === flaky.email) throw new Error('provider down');
      return real(e);
    });
    await service.flush();
    send.mockRestore();
    const row = (await ctx.pool.query(`SELECT status, attempts, last_error, next_attempt_at > now() AS later FROM notifications WHERE recipient = $1`, [flaky.email])).rows[0];
    expect(row).toEqual({ status: 'queued', attempts: 1, last_error: 'provider down', later: true });
    expect(await sent(flaky.email)).toHaveLength(0);
    await ctx.pool.query(`UPDATE notifications SET next_attempt_at = now() WHERE recipient = $1`, [flaky.email]);
    expect(await sent(flaky.email)).toHaveLength(1);
  });
});
