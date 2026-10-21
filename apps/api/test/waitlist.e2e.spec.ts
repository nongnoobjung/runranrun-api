import { randomUUID } from 'node:crypto';
import { addOrgMember, createEvent } from '../db/fixtures';
import { WaitlistService } from '../src/modules/waitlist/waitlist.service';
import { bootApp, buyer, call, login, raceCounters, runner, sendFakeWebhook, TestContext, uniqueSlug } from './helpers';

describe('waitlist', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await bootApp();
  });
  afterAll(() => ctx.close());

  /** A 10K with two places (the fixture turns the waitlist on), and its owner. */
  async function orgEvent() {
    const created = await createEvent(
      ctx.pool,
      {
        slug: uniqueSlug(),
        nameTh: 'งานคิว',
        eventDate: '2027-03-01',
        races: [{ code: '10K', nameTh: 'มินิ', distanceKm: 10, capacity: 2, bibStart: 1, bibEnd: 50, tiers: [{ name: 'ปกติ', priceSatang: 50_000 }] }],
      },
      uniqueSlug('org'),
    );
    const email = `owner-${randomUUID()}@org.example`;
    await addOrgMember(ctx.pool, created.organizationId, email, 'owner');
    const { token } = await login(ctx.app, email);
    return { ...created, raceId: created.raceIds['10K'], token, base: `/v1/org/${created.organizationId}/events/${created.eventId}` };
  }

  /** Orders and pays for a held checkout as `token`; returns the registration id. */
  async function payFor(token: string, sessionId: string, raceId: string) {
    const order = await call(ctx.app, 'POST', '/v1/orders', {
      token,
      headers: { 'idempotency-key': randomUUID() },
      body: { checkoutSessionId: sessionId, buyer, participants: [{ raceId, runner: runner() }] },
    });
    if (order.status !== 201) throw new Error(JSON.stringify(order.body));
    const payment = await call(ctx.app, 'POST', `/v1/orders/${order.body.id}/payments`, { token, headers: { 'idempotency-key': randomUUID() }, body: { method: 'promptpay' } });
    const charge = await ctx.pool.query('SELECT gateway_charge_id FROM payments WHERE id = $1', [payment.body.id]);
    await sendFakeWebhook(ctx.app, charge.rows[0].gateway_charge_id);
    const reg = await ctx.pool.query('SELECT id FROM registrations WHERE order_id = $1', [order.body.id]);
    return reg.rows[0].id as string;
  }

  async function buy(ev: Awaited<ReturnType<typeof orgEvent>>) {
    const { token } = await login(ctx.app);
    const session = await call(ctx.app, 'POST', '/v1/checkout/sessions', { token, body: { eventId: ev.eventId, races: [{ raceId: ev.raceId, quantity: 1 }] } });
    if (session.status !== 201) return { status: session.status, code: session.body.code as string };
    return { status: 201, registrationId: await payFor(token, session.body.id, ev.raceId) };
  }

  const join = (token: string, raceId: string) => call(ctx.app, 'POST', '/v1/me/waitlist', { token, body: { raceId } });
  const mine = async (token: string) => (await call(ctx.app, 'GET', '/v1/me/waitlist', { token })).body.items;
  const cancel = (ev: Awaited<ReturnType<typeof orgEvent>>, registrationId: string) =>
    call(ctx.app, 'POST', `${ev.base}/registrations/${registrationId}/cancel`, { token: ev.token, body: { refundSatang: 0, reason: 'ยกเลิก' } });

  it('queues runners for a full race in order', async () => {
    const ev = await orgEvent();
    const a = await login(ctx.app);
    expect((await join(a.token, ev.raceId)).body.code).toBe('RACE_NOT_FULL');
    await buy(ev);
    await buy(ev);

    const b = await login(ctx.app);
    const c = await login(ctx.app);
    expect((await join(a.token, ev.raceId)).body).toMatchObject({ status: 'waiting', position: 1, ahead: 0, race: { code: '10K' }, priceSatang: 50_000 });
    await join(b.token, ev.raceId);
    await join(c.token, ev.raceId);
    expect((await join(b.token, ev.raceId)).body.code).toBe('ALREADY_IN_WAITLIST');
    expect((await mine(c.token))[0]).toMatchObject({ position: 3, ahead: 2 });

    await ctx.pool.query('UPDATE events SET waitlist_enabled = false WHERE id = $1', [ev.eventId]);
    expect((await join((await login(ctx.app)).token, ev.raceId)).body.code).toBe('WAITLIST_DISABLED');
  });

  it('offers a freed place to the next in line, who claims it and pays; turning it down passes it on', async () => {
    const ev = await orgEvent();
    const first = await buy(ev);
    const second = await buy(ev);
    const [a, b, c] = [await login(ctx.app), await login(ctx.app), await login(ctx.app)];
    for (const r of [a, b, c]) await join(r.token, ev.raceId);

    // Cancelling a place offers it to A and holds it, so the public cannot take it.
    await cancel(ev, first.registrationId!);
    const [offer] = await mine(a.token);
    expect(offer).toMatchObject({ status: 'offered', checkoutSessionId: null });
    expect(new Date(offer.offerExpiresAt).getTime() - Date.now()).toBeGreaterThan(23 * 3_600_000);
    expect(await raceCounters(ctx.pool, ev.raceId)).toMatchObject({ sold: 1, reserved: 1 });
    expect((await buy(ev)).code).toBe('SOLD_OUT');
    expect((await mine(b.token))[0]).toMatchObject({ status: 'waiting', ahead: 0 });
    expect((await call(ctx.app, 'POST', `/v1/me/waitlist/${(await mine(b.token))[0].id}/claim`, { token: b.token })).body.code).toBe('NO_OFFER');

    // Claiming moves the held place into A's checkout; claiming again returns the same checkout.
    const claimed = await call(ctx.app, 'POST', `/v1/me/waitlist/${offer.id}/claim`, { token: a.token });
    expect(claimed.status).toBe(201);
    expect(await raceCounters(ctx.pool, ev.raceId)).toMatchObject({ sold: 1, reserved: 1 });
    expect((await call(ctx.app, 'POST', `/v1/me/waitlist/${offer.id}/claim`, { token: a.token })).body.checkoutSessionId).toBe(claimed.body.checkoutSessionId);
    const registrationId = await payFor(a.token, claimed.body.checkoutSessionId, ev.raceId);
    const entry = await ctx.pool.query('SELECT status, registration_id FROM waitlist_entries WHERE id = $1', [offer.id]);
    expect(entry.rows[0]).toEqual({ status: 'converted', registration_id: registrationId });
    expect(await mine(a.token)).toEqual([]);
    expect(await raceCounters(ctx.pool, ev.raceId)).toMatchObject({ sold: 2, reserved: 0 });

    // B is offered the next freed place, turns it down, and it moves on to C.
    await cancel(ev, second.registrationId!);
    const [bOffer] = await mine(b.token);
    expect(bOffer.status).toBe('offered');
    expect((await call(ctx.app, 'DELETE', `/v1/me/waitlist/${bOffer.id}`, { token: b.token })).body.status).toBe('cancelled');
    const [cOffer] = await mine(c.token);
    expect(cOffer.status).toBe('offered');
    expect(await raceCounters(ctx.pool, ev.raceId)).toMatchObject({ sold: 1, reserved: 1 });

    // C lets the offer run out: the place is released and, with nobody left waiting, open to everyone again.
    await ctx.pool.query(`UPDATE waitlist_entries SET offer_expires_at = now() - interval '1 minute' WHERE id = $1`, [cOffer.id]);
    expect((await call(ctx.app, 'POST', `/v1/me/waitlist/${cOffer.id}/claim`, { token: c.token })).body.code).toBe('NO_OFFER');
    await ctx.app.get(WaitlistService).offerFreed();
    expect((await ctx.pool.query('SELECT status FROM waitlist_entries WHERE id = $1', [cOffer.id])).rows[0].status).toBe('expired');
    expect(await raceCounters(ctx.pool, ev.raceId)).toMatchObject({ sold: 1, reserved: 0 });
    expect((await buy(ev)).status).toBe(201);
  });

  it('shows the queues to the team and lets owners and admins offer free places now', async () => {
    const ev = await orgEvent();
    await buy(ev);
    await buy(ev);
    const [a, b] = [await login(ctx.app), await login(ctx.app)];
    await join(a.token, ev.raceId);
    await join(b.token, ev.raceId);
    // The organiser adds a place: offering now hands it to A without waiting for the next run.
    await ctx.pool.query('UPDATE races SET capacity = 3 WHERE id = $1', [ev.raceId]);

    const email = `viewer-${randomUUID()}@org.example`;
    await addOrgMember(ctx.pool, ev.organizationId, email, 'viewer');
    const viewer = await login(ctx.app, email);
    const seen = await call(ctx.app, 'GET', `${ev.base}/waitlist`, { token: viewer.token });
    expect(seen.body.races[0]).toMatchObject({ code: '10K', free: 1, counts: { waiting: 2, offered: 0, converted: 0, expired: 0 } });
    expect(seen.body.races[0].entries.map((e: { position: number }) => e.position)).toEqual([1, 2]);
    expect((await call(ctx.app, 'POST', `${ev.base}/waitlist/offer`, { token: viewer.token })).status).toBe(403);

    const offered = await call(ctx.app, 'POST', `${ev.base}/waitlist/offer`, { token: ev.token });
    expect(offered.body).toMatchObject({ offered: 1, races: [expect.objectContaining({ free: 0, counts: expect.objectContaining({ waiting: 1, offered: 1 }) })] });
    expect((await mine(a.token))[0].status).toBe('offered');
  });
});
