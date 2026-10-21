import { randomUUID } from 'node:crypto';
import { addOrgMember, createEvent } from '../db/fixtures';
import { bootApp, buyer, call, login, runner, sendFakeWebhook, TestContext, uniqueSlug } from './helpers';

describe('results across events', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await bootApp();
  });
  afterAll(() => ctx.close());

  /** An event with a 21K (bibs 0001–) and a 10K (bibs 2001–) and its own owner; the name is unique to the test. */
  async function orgEvent(eventDate: string) {
    const slug = uniqueSlug();
    const name = `งานรวมผล ${slug.slice(-8)}`;
    const created = await createEvent(
      ctx.pool,
      {
        slug,
        nameTh: name,
        nameEn: `Index Run ${slug.slice(-8)}`,
        eventDate,
        races: [
          { code: '21K', nameTh: 'ฮาล์ฟ', distanceKm: 21.1, capacity: 50, bibStart: 1, bibEnd: 50, tiers: [{ name: 'ปกติ', priceSatang: 90_000 }] },
          { code: '10K', nameTh: 'มินิ', distanceKm: 10, capacity: 50, bibStart: 2001, bibEnd: 2050, tiers: [{ name: 'ปกติ', priceSatang: 50_000 }] },
        ],
      },
      uniqueSlug('org'),
    );
    const email = `owner-${randomUUID()}@org.example`;
    await addOrgMember(ctx.pool, created.organizationId, email, 'owner');
    const { token } = await login(ctx.app, email);
    return { ...created, slug, name, token, base: `/v1/org/${created.organizationId}/events/${created.eventId}` };
  }

  /** A paid runner in `raceCode`; returns their bib and the buyer's token. */
  async function paid(ev: Awaited<ReturnType<typeof orgEvent>>, raceCode: string, person = runner()) {
    const { token } = await login(ctx.app);
    const raceId = ev.raceIds[raceCode];
    const session = await call(ctx.app, 'POST', '/v1/checkout/sessions', { token, body: { eventId: ev.eventId, races: [{ raceId, quantity: 1 }] } });
    const order = await call(ctx.app, 'POST', '/v1/orders', {
      token,
      headers: { 'idempotency-key': randomUUID() },
      body: { checkoutSessionId: session.body.id, buyer, participants: [{ raceId, runner: person }] },
    });
    const payment = await call(ctx.app, 'POST', `/v1/orders/${order.body.id}/payments`, { token, headers: { 'idempotency-key': randomUUID() }, body: { method: 'promptpay' } });
    const charge = await ctx.pool.query('SELECT gateway_charge_id FROM payments WHERE id = $1', [payment.body.id]);
    await sendFakeWebhook(ctx.app, charge.rows[0].gateway_charge_id);
    const reg = await ctx.pool.query('SELECT bib_number FROM registrations WHERE order_id = $1', [order.body.id]);
    return { bib: reg.rows[0].bib_number as string, token };
  }

  const importCsv = async (ev: Awaited<ReturnType<typeof orgEvent>>, lines: string[]) => {
    const res = await call(ctx.app, 'POST', `${ev.base}/results/import`, { token: ev.token, body: { csv: ['bib,chip_time,status', ...lines].join('\n'), dryRun: false } });
    expect(res.body.applied).toBe(true);
  };
  const publish = (ev: Awaited<ReturnType<typeof orgEvent>>, published: boolean) =>
    call(ctx.app, 'POST', `${ev.base}/results/publish`, { token: ev.token, body: { published } });

  it('lists only events with published results, newest first, with finishers per race', async () => {
    const older = await orgEvent('2030-01-10');
    const newer = await orgEvent('2030-02-20');
    const tag = randomUUID().slice(0, 6);
    const a = await paid(older, '21K', runner({ lastNameTh: `ก่อน${tag}` }));
    const b = await paid(older, '21K');
    const c = await paid(older, '10K');
    const d = await paid(newer, '10K');
    await importCsv(older, [`${a.bib},1:50:00,`, `${b.bib},,DNF`, `${c.bib},55:00,`]);
    await importCsv(newer, [`${d.bib},48:00,`]);

    const listed = async (q?: string) =>
      (await call(ctx.app, 'GET', `/v1/results${q ? `?q=${encodeURIComponent(q)}` : ''}`)).body as { total: number; items: { slug: string }[] };
    // Imported but not published: nowhere to be seen.
    expect((await listed(older.name)).total).toBe(0);
    expect((await listed()).items.map((i) => i.slug)).not.toContain(older.slug);

    await publish(older, true);
    await publish(newer, true);
    const one = await call(ctx.app, 'GET', `/v1/results?q=${encodeURIComponent(older.name)}`);
    expect(one.body.total).toBe(1);
    expect(one.body.items[0]).toMatchObject({
      slug: older.slug,
      name: { th: older.name },
      eventDate: '2030-01-10',
      publishedAt: expect.any(String),
      finishers: 2,
      races: [
        { id: older.raceIds['21K'], code: '21K', name: 'ฮาล์ฟ', distanceKm: 21.1, finishers: 1 },
        { id: older.raceIds['10K'], code: '10K', name: 'มินิ', distanceKm: 10, finishers: 1 },
      ],
    });
    // The 21K of the newer event has no results, so only the 10K shows. The English name finds it too.
    const byEn = await call(ctx.app, 'GET', `/v1/results?q=${encodeURIComponent(`index run ${newer.slug.slice(-8)}`)}`);
    expect(byEn.body.items.map((i: { races: { code: string }[] }) => i.races.map((r) => r.code))).toEqual([['10K']]);

    const all = await listed();
    const order = all.items.map((i) => i.slug).filter((s) => s === older.slug || s === newer.slug);
    expect(order).toEqual([newer.slug, older.slug]);

    // Taking results down takes the event off the list again.
    await publish(newer, false);
    expect((await listed()).items.map((i) => i.slug)).not.toContain(newer.slug);
    expect((await call(ctx.app, 'GET', '/v1/results?limit=0')).status).toBe(422);
  });

  it('finds a runner by name or bib across published events only', async () => {
    const tag = randomUUID().slice(0, 6);
    const shown = await orgEvent('2031-05-01');
    const hidden = await orgEvent('2031-06-01');
    const mine = await paid(shown, '10K', runner({ firstNameTh: 'ค้นหา', lastNameTh: `เจอ${tag}`, gender: 'female' }));
    const other = await paid(hidden, '10K', runner({ firstNameTh: 'ค้นหา', lastNameTh: `ซ่อน${tag}` }));
    await importCsv(shown, [`${mine.bib},50:00,`]);
    await importCsv(hidden, [`${other.bib},40:00,`]);
    await publish(shown, true);

    const byName = await call(ctx.app, 'GET', `/v1/results/search?q=${encodeURIComponent(tag)}`);
    expect(byName.status).toBe(200);
    expect(byName.body).toEqual({
      hasMore: false,
      items: [
        {
          event: { slug: shown.slug, name: shown.name, eventDate: '2031-05-01' },
          race: { id: shown.raceIds['10K'], code: '10K', name: 'มินิ', distanceKm: 10 },
          bib: mine.bib,
          name: `ค้นหา เจอ${tag}`,
          gender: 'female',
          ageGroup: 'F40-49',
          status: 'FIN',
          gunTimeMs: null,
          chipTimeMs: 3_000_000,
          paceSecPerKm: 300,
          rankOverall: 1,
          rankGender: 1,
          rankAgeGroup: 1,
        },
      ],
    });
    // No ID numbers, contact details or registration ids leak into search.
    expect(JSON.stringify(byName.body)).not.toMatch(/registration|idDoc|email|phone/i);

    // Both events gave bib 2001 to their only 10K runner; only the published one is found, and the latest event comes first.
    expect(mine.bib).toBe(other.bib);
    const byBib = await call(ctx.app, 'GET', `/v1/results/search?q=${mine.bib}`);
    expect(byBib.body.items.every((i: { bib: string }) => i.bib === mine.bib)).toBe(true);
    expect(byBib.body.items[0].event.slug).toBe(shown.slug);
    expect(byBib.body.items.map((i: { event: { slug: string } }) => i.event.slug)).not.toContain(hidden.slug);

    const limited = await call(ctx.app, 'GET', `/v1/results/search?q=${encodeURIComponent('ค้นหา')}&limit=1`);
    expect(limited.body.items).toHaveLength(1);
    expect((await call(ctx.app, 'GET', '/v1/results/search?q=x')).status).toBe(422);
    expect((await call(ctx.app, 'GET', '/v1/results/search')).status).toBe(422);
  });

  it("shows a signed-in runner their own published results", async () => {
    const ev = await orgEvent('2031-07-01');
    const me = await paid(ev, '21K');
    const someone = await paid(ev, '21K');
    await importCsv(ev, [`${me.bib},2:01:00,`, `${someone.bib},1:59:00,`]);

    expect((await call(ctx.app, 'GET', '/v1/me/results', { token: me.token })).body.items).toEqual([]);
    await publish(ev, true);
    const mine = await call(ctx.app, 'GET', '/v1/me/results', { token: me.token });
    expect(mine.body.items).toEqual([
      expect.objectContaining({ event: expect.objectContaining({ slug: ev.slug }), race: expect.objectContaining({ code: '21K' }), bib: me.bib, rankOverall: 2 }),
    ]);
    const stranger = await login(ctx.app);
    expect((await call(ctx.app, 'GET', '/v1/me/results', { token: stranger.token })).body.items).toEqual([]);
    expect((await call(ctx.app, 'GET', '/v1/me/results')).status).toBe(401);
  });
});
