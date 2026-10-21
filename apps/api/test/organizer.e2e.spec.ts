import { randomUUID } from 'node:crypto';
import { addOrgMember, createEvent } from '../db/fixtures';
import { bootApp, buyer, call, fakeThaiId, login, runner, seedEvent, sendFakeWebhook, TestContext, uniqueSlug } from './helpers';

type EventRef = { eventId: string; raceIds: Record<string, string>; variantIds: Record<string, string> };

describe('organizer backoffice', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await bootApp();
  });
  afterAll(() => ctx.close());

  /** A published event in its own organisation, plus a signed-in member with the given role. */
  async function orgEvent(role: 'owner' | 'admin' | 'finance' | 'staff' | 'viewer' = 'owner') {
    const slug = uniqueSlug();
    const created = await createEvent(
      ctx.pool,
      {
        slug,
        nameTh: 'งานของผู้จัด',
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
    const base = `/v1/org/${created.organizationId}/events/${created.eventId}`;
    return { ...created, slug, token, base, org: `/v1/org/${created.organizationId}` };
  }

  /** Buys one place as a runner and pays for it. */
  async function pendingRegistration(ev: EventRef, person = runner(), extra: Record<string, unknown> = {}) {
    const { token } = await login(ctx.app);
    const raceId = ev.raceIds['10K'];
    const shirtVariantId = ev.variantIds.M;
    const session = await call(ctx.app, 'POST', '/v1/checkout/sessions', {
      token,
      body: { eventId: ev.eventId, races: [{ raceId, quantity: 1 }], variants: [{ variantId: shirtVariantId, quantity: 1 }] },
    });
    const order = await call(ctx.app, 'POST', '/v1/orders', {
      token,
      headers: { 'idempotency-key': randomUUID() },
      body: { checkoutSessionId: session.body.id, buyer, participants: [{ raceId, shirtVariantId, runner: person }], ...extra },
    });
    if (order.status !== 201) throw new Error(JSON.stringify(order.body));
    return { token, orderId: order.body.id as string };
  }

  /** Buys one 10K place with an M shirt as a fresh runner and pays for it. */
  async function paidRegistration(ev: EventRef, person = runner(), extra: Record<string, unknown> = {}) {
    const { token, orderId } = await pendingRegistration(ev, person, extra);
    const order = { body: { id: orderId } };
    const payment = await call(ctx.app, 'POST', `/v1/orders/${order.body.id}/payments`, {
      token,
      headers: { 'idempotency-key': randomUUID() },
      body: { method: 'promptpay' },
    });
    const charge = await ctx.pool.query('SELECT gateway_charge_id FROM payments WHERE id = $1', [payment.body.id]);
    await sendFakeWebhook(ctx.app, charge.rows[0].gateway_charge_id);
    const reg = await ctx.pool.query('SELECT id, qr_token, bib_number, registration_no FROM registrations WHERE order_id = $1', [order.body.id]);
    return reg.rows[0] as { id: string; qr_token: string; bib_number: string; registration_no: string };
  }

  describe('access', () => {
    it('hides other organisations and limits each role', async () => {
      const ev = await orgEvent('viewer');
      const outsider = await login(ctx.app);
      expect((await call(ctx.app, 'GET', `${ev.base}/dashboard`, { token: outsider.token })).status).toBe(404);
      expect((await call(ctx.app, 'GET', '/v1/org', { token: outsider.token })).body.items).toEqual([]);

      const mine = await call(ctx.app, 'GET', '/v1/org', { token: ev.token });
      expect(mine.body.items).toEqual([expect.objectContaining({ id: ev.organizationId, role: 'viewer' })]);
      expect((await call(ctx.app, 'GET', `${ev.base}/dashboard`, { token: ev.token })).status).toBe(200);
      expect((await call(ctx.app, 'PATCH', ev.base, { token: ev.token, body: { nameTh: 'แก้ชื่อ' } })).status).toBe(403);
      expect((await call(ctx.app, 'GET', `${ev.base}/registrations.csv`, { token: ev.token })).status).toBe(403);
      expect((await call(ctx.app, 'POST', `${ev.base}/checkins`, { token: ev.token, body: { code: 'x', clientUuid: randomUUID() } })).status).toBe(403);

      // An event of another organisation is not reachable through this organisation's URL.
      const other = await seedEvent(ctx.pool);
      expect((await call(ctx.app, 'GET', `${ev.org}/events/${other.eventId}`, { token: ev.token })).status).toBe(404);
    });
  });

  describe('building an event', () => {
    it('creates a draft, refuses to open it until it is complete, then opens it to runners', async () => {
      const owner = await orgEvent('owner');
      const created = await call(ctx.app, 'POST', `${owner.org}/events`, {
        token: owner.token,
        body: { nameTh: 'เทรลดอยสุเทพ', nameEn: 'Doi Suthep Trail', eventType: 'trail', eventDate: '2027-06-20' },
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ status: 'draft', eventType: 'trail', races: [], shirt: null });
      expect(created.body.slug).toMatch(/^doi-suthep-trail-[0-9a-f]{4}$/);
      const base = `${owner.org}/events/${created.body.id}`;

      const early = await call(ctx.app, 'POST', `${base}/publish`, { token: owner.token });
      expect(early.status).toBe(409);
      expect(early.body).toMatchObject({ code: 'EVENT_NOT_READY', missing: ['basics', 'registration_window', 'races', 'prices'] });

      const race = await call(ctx.app, 'POST', `${base}/races`, {
        token: owner.token,
        body: { code: '25K', nameTh: 'เทรล 25 กม.', distanceKm: 25, capacity: 300, bibStart: 1, bibEnd: 300 },
      });
      expect(race.status).toBe(201);
      const raceId = race.body.races[0].id;
      const overlap = await call(ctx.app, 'POST', `${base}/races`, {
        token: owner.token,
        body: { code: '10K', nameTh: 'เทรล 10 กม.', distanceKm: 10, capacity: 300, bibStart: 250, bibEnd: 500 },
      });
      expect(overlap.status).toBe(409);
      expect(overlap.body).toMatchObject({ code: 'BIB_RANGE_OVERLAP', race: '25K' });

      const now = Date.now();
      const tier = await call(ctx.app, 'POST', `${base}/races/${raceId}/price-tiers`, {
        token: owner.token,
        body: { name: 'ปกติ', priceSatang: 150_000, startsAt: new Date(now - 60_000).toISOString(), endsAt: new Date(now + 30 * 86_400_000).toISOString() },
      });
      expect(tier.status).toBe(201);
      const shirts = await call(ctx.app, 'PUT', `${base}/shirts`, {
        token: owner.token,
        body: { nameTh: 'เสื้อเทรล', sizes: [{ label: 's', chestIn: 36, stock: 100 }, { label: 'M', chestIn: 38, stock: null }] },
      });
      expect(shirts.status).toBe(200);
      expect(shirts.body.shirt.sizes.map((s: any) => s.label)).toEqual(['S', 'M']);

      const details = await call(ctx.app, 'PATCH', base, {
        token: owner.token,
        body: {
          provinceCode: 'CNX', venueName: 'ลานวัดพระธาตุดอยสุเทพ',
          registrationOpensAt: new Date(now - 60_000).toISOString(), registrationClosesAt: new Date(now + 20 * 86_400_000).toISOString(),
        },
      });
      expect(details.body.readiness.every((r: any) => r.ok)).toBe(true);

      const published = await call(ctx.app, 'POST', `${base}/publish`, { token: owner.token });
      expect(published.status).toBe(201);
      expect(published.body.status).toBe('published');

      const pub = await call(ctx.app, 'GET', `/v1/events/${created.body.slug}`);
      expect(pub.status).toBe(200);
      expect(pub.body.races[0]).toMatchObject({ code: '25K', priceSatang: 150_000 });

      const slugChange = await call(ctx.app, 'PATCH', base, { token: owner.token, body: { slug: 'another-link' } });
      expect(slugChange.body.code).toBe('SLUG_LOCKED');

      const audit = await ctx.pool.query(`SELECT action FROM audit_logs WHERE event_id = $1 ORDER BY id`, [created.body.id]);
      expect(audit.rows.map((r) => r.action)).toEqual(
        expect.arrayContaining(['event.create', 'race.create', 'price_tier.create', 'shirts.update', 'event.update', 'event.published']),
      );
    });

    it('will not cut capacity, quotas or stock below what is already sold', async () => {
      const ev = await orgEvent('admin');
      await paidRegistration(ev);
      const full = await call(ctx.app, 'GET', ev.base, { token: ev.token });
      const tierId = full.body.races[0].tiers[0].id;

      const capacity = await call(ctx.app, 'PATCH', `${ev.base}/races/${ev.raceIds['10K']}`, { token: ev.token, body: { capacity: 0 } });
      expect(capacity.body.code).toBe('CAPACITY_BELOW_SOLD');
      const quota = await call(ctx.app, 'PATCH', `${ev.base}/races/${ev.raceIds['10K']}/price-tiers/${tierId}`, { token: ev.token, body: { quota: 0 } });
      expect(quota.body.code).toBe('QUOTA_BELOW_SOLD');
      const removeTier = await call(ctx.app, 'DELETE', `${ev.base}/races/${ev.raceIds['10K']}/price-tiers/${tierId}`, { token: ev.token });
      expect(removeTier.body.code).toBe('TIER_HAS_SALES');
      const removeRace = await call(ctx.app, 'DELETE', `${ev.base}/races/${ev.raceIds['10K']}`, { token: ev.token });
      expect(removeRace.body.code).toBe('RACE_HAS_REGISTRATIONS');

      const bibs = await call(ctx.app, 'PATCH', `${ev.base}/races/${ev.raceIds['10K']}`, { token: ev.token, body: { bibStart: 100 } });
      expect(bibs.body.code).toBe('BIBS_ISSUED');
      const grow = await call(ctx.app, 'PATCH', `${ev.base}/races/${ev.raceIds['10K']}`, { token: ev.token, body: { capacity: 80, bibEnd: 80 } });
      expect(grow.status).toBe(200);
      expect(grow.body.races[0]).toMatchObject({ capacity: 80, bibEnd: 80, sold: 1 });
    });

    it('closes and reopens registration', async () => {
      const ev = await orgEvent('owner');
      const closed = await call(ctx.app, 'POST', `${ev.base}/close`, { token: ev.token });
      expect(closed.body.status).toBe('closed');
      const { token } = await login(ctx.app);
      const blocked = await call(ctx.app, 'POST', '/v1/checkout/sessions', {
        token, body: { eventId: ev.eventId, races: [{ raceId: ev.raceIds['10K'], quantity: 1 }] },
      });
      expect(blocked.body.code).toBe('REGISTRATION_CLOSED');
      expect((await call(ctx.app, 'GET', `/v1/events/${ev.slug}`)).body.races[0].availability).toBe('closed');
      const again = await call(ctx.app, 'POST', `${ev.base}/close`, { token: ev.token });
      expect(again.body.code).toBe('INVALID_STATUS');
      expect((await call(ctx.app, 'POST', `${ev.base}/publish`, { token: ev.token })).body.status).toBe('published');
    });
  });

  describe('coupons', () => {
    it('creates codes and locks the discount once a runner has used it', async () => {
      const ev = await orgEvent('owner');
      const created = await call(ctx.app, 'POST', `${ev.base}/coupons`, {
        token: ev.token,
        body: { code: 'friends20', discountType: 'percent', discountValue: 2000, usageLimit: 10 },
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ code: 'FRIENDS20', used: 0, isActive: true });
      const dupe = await call(ctx.app, 'POST', `${ev.base}/coupons`, { token: ev.token, body: { code: 'FRIENDS20', discountType: 'fixed', discountValue: 100 } });
      expect(dupe.body.code).toBe('COUPON_CODE_TAKEN');
      const tooMuch = await call(ctx.app, 'POST', `${ev.base}/coupons`, { token: ev.token, body: { code: 'ALL', discountType: 'percent', discountValue: 10_001 } });
      expect(tooMuch.status).toBe(422);

      await paidRegistration(ev, runner(), { couponCode: 'FRIENDS20' });
      const list = await call(ctx.app, 'GET', `${ev.base}/coupons`, { token: ev.token });
      expect(list.body.items.find((c: any) => c.code === 'FRIENDS20')).toMatchObject({ used: 1, discountGivenSatang: 10_000 });

      const url = `${ev.base}/coupons/${created.body.id}`;
      expect((await call(ctx.app, 'PATCH', url, { token: ev.token, body: { discountValue: 5000 } })).body.code).toBe('COUPON_IN_USE');
      expect((await call(ctx.app, 'PATCH', url, { token: ev.token, body: { usageLimit: 0 } })).status).toBe(422);
      const off = await call(ctx.app, 'PATCH', url, { token: ev.token, body: { isActive: false, usageLimit: 1 } });
      expect(off.body).toMatchObject({ isActive: false, usageLimit: 1 });
    });
  });

  describe('runners', () => {
    it('lists, searches and exports runners, and audits every look at an ID number', async () => {
      const ev = await orgEvent('owner');
      const idDocNumber = fakeThaiId();
      const reg = await paidRegistration(ev, runner({ firstNameTh: 'มานี', lastNameTh: 'มีนา', firstNameEn: 'Manee', idDocNumber }));
      await paidRegistration(ev, runner({ firstNameTh: 'ปิติ', firstNameEn: 'Piti', emergencyName: '=HYPERLINK("x")' }));

      const all = await call(ctx.app, 'GET', `${ev.base}/registrations`, { token: ev.token });
      expect(all.body.total).toBe(2);
      expect(all.body.counts).toMatchObject({ all: 2, confirmed: 2, not_picked: 2 });
      const found = await call(ctx.app, 'GET', `${ev.base}/registrations?q=${encodeURIComponent('มานี')}`, { token: ev.token });
      expect(found.body.items).toEqual([expect.objectContaining({ id: reg.id, bibNumber: reg.bib_number, status: 'confirmed' })]);
      const byBib = await call(ctx.app, 'GET', `${ev.base}/registrations?q=${reg.bib_number}`, { token: ev.token });
      expect(byBib.body.items.map((r: any) => r.id)).toEqual([reg.id]);

      const detail = await call(ctx.app, 'GET', `${ev.org}/registrations/${reg.id}`, { token: ev.token });
      expect(detail.body).toMatchObject({ idDocMasked: `•••••••••${idDocNumber.slice(-4)}`, emergency: { name: 'สมหญิง ใจดี' } });
      expect(JSON.stringify(detail.body)).not.toContain(idDocNumber);
      expect(detail.body.timeline.map((t: any) => t.kind)).toEqual(['registered', 'paid']);

      const revealed = await call(ctx.app, 'POST', `${ev.org}/registrations/${reg.id}/reveal-id-doc`, { token: ev.token });
      expect(revealed.body.idDocNumber).toBe(idDocNumber);
      const audit = await ctx.pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'registration.reveal_id_doc' AND entity_id = $1`, [reg.id]);
      expect(audit.rows[0].n).toBe(1);

      const res = await ctx.app.inject({ method: 'GET', url: `${ev.base}/registrations.csv`, headers: { authorization: `Bearer ${ev.token}` } });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.body.startsWith('﻿registration_no,bib')).toBe(true);
      expect(res.body).toContain('มานี');
      expect(res.body).toContain(`"'=HYPERLINK(""x"")"`);
      expect(res.body).not.toContain(idDocNumber);
    });

    it('checks a runner in once, by QR or bib, and tolerates the scanner retrying', async () => {
      const ev = await orgEvent('staff');
      const reg = await paidRegistration(ev);

      const lookup = await call(ctx.app, 'GET', `${ev.base}/checkins/lookup?code=${reg.qr_token}`, { token: ev.token });
      expect(lookup.body).toMatchObject({ id: reg.id, kitPickedUpAt: null, emergencyName: 'สมหญิง ใจดี' });

      const clientUuid = randomUUID();
      const first = await call(ctx.app, 'POST', `${ev.base}/checkins`, { token: ev.token, body: { code: reg.qr_token, clientUuid } });
      expect(first.status).toBe(201);
      expect(first.body.kitPickedUpAt).not.toBeNull();
      const retry = await call(ctx.app, 'POST', `${ev.base}/checkins`, { token: ev.token, body: { code: reg.qr_token, clientUuid } });
      expect(retry.status).toBe(201);
      const twice = await call(ctx.app, 'POST', `${ev.base}/checkins`, { token: ev.token, body: { code: reg.bib_number, clientUuid: randomUUID() } });
      expect(twice.status).toBe(409);
      expect(twice.body).toMatchObject({ code: 'ALREADY_PICKED_UP', registration: { id: reg.id } });
      expect((await ctx.pool.query('SELECT count(*)::int AS n FROM checkins WHERE registration_id = $1', [reg.id])).rows[0].n).toBe(1);

      const unknown = await call(ctx.app, 'GET', `${ev.base}/checkins/lookup?code=nope`, { token: ev.token });
      expect(unknown.body.code).toBe('REGISTRATION_NOT_FOUND');
      // A runner from another event cannot be checked in here.
      const other = await seedEvent(ctx.pool);
      const elsewhere = await paidRegistration(other);
      expect((await call(ctx.app, 'GET', `${ev.base}/checkins/lookup?code=${elsewhere.qr_token}`, { token: ev.token })).status).toBe(404);
    });

    it('turns away runners who have not paid', async () => {
      const ev = await orgEvent('owner');
      const { orderId } = await pendingRegistration(ev);
      const reg = (await ctx.pool.query('SELECT registration_no FROM registrations WHERE order_id = $1', [orderId])).rows[0];
      const res = await call(ctx.app, 'POST', `${ev.base}/checkins`, { token: ev.token, body: { code: reg.registration_no, clientUuid: randomUUID() } });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'NOT_CONFIRMED', registration: { status: 'pending' } });
    });
  });

  it('summarises sales on the dashboard', async () => {
    const ev = await orgEvent('finance');
    await paidRegistration(ev, runner({ firstNameTh: 'ชูใจ' }));
    const res = await call(ctx.app, 'GET', `${ev.base}/dashboard`, { token: ev.token });
    expect(res.status).toBe(200);
    expect(res.body.kpis).toMatchObject({ confirmed: 1, pendingPayment: 0, pickedUp: 0, last24h: 1, capacity: 50 });
    // 500 baht + 2% runner fee
    expect(res.body.kpis.revenueSatang).toBe(51_000);
    expect(res.body.daily).toHaveLength(14);
    expect(res.body.daily.at(-1).count).toBe(1);
    expect(res.body.races).toEqual([expect.objectContaining({ code: '10K', sold: 1, capacity: 50, currentPriceSatang: 50_000 })]);
    expect(res.body.shirts).toEqual([expect.objectContaining({ label: 'M', stock: 20 })]);
    expect(res.body.recent[0]).toMatchObject({ name: 'ชูใจ ใจดี', raceCode: '10K' });
  });
});
