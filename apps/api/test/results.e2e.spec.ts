import { randomUUID } from 'node:crypto';
import { addOrgMember, createEvent } from '../db/fixtures';
import { bootApp, buyer, call, login, runner, sendFakeWebhook, TestContext, uniqueSlug } from './helpers';

describe('race results', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await bootApp();
  });
  afterAll(() => ctx.close());

  /** 21K (bibs 0001–, 3 h cut-off) and 10K (bibs 2001–) in their own organisation. */
  async function orgEvent() {
    const slug = uniqueSlug();
    const created = await createEvent(
      ctx.pool,
      {
        slug,
        nameTh: 'งานผลวิ่ง',
        eventDate: '2027-03-01',
        races: [
          { code: '21K', nameTh: 'ฮาล์ฟ', distanceKm: 21.1, capacity: 50, bibStart: 1, bibEnd: 50, tiers: [{ name: 'ปกติ', priceSatang: 90_000 }] },
          { code: '10K', nameTh: 'มินิ', distanceKm: 10, capacity: 50, bibStart: 2001, bibEnd: 2050, tiers: [{ name: 'ปกติ', priceSatang: 50_000 }] },
        ],
      },
      uniqueSlug('org'),
    );
    await ctx.pool.query(`UPDATE races SET cutoff_minutes = 180 WHERE id = $1`, [created.raceIds['21K']]);
    const email = `owner-${randomUUID()}@org.example`;
    await addOrgMember(ctx.pool, created.organizationId, email, 'owner');
    const { token } = await login(ctx.app, email);
    return { ...created, slug, token, base: `/v1/org/${created.organizationId}/events/${created.eventId}` };
  }

  /** A paid runner in `raceCode`; returns their bib. */
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
    return reg.rows[0].bib_number as string;
  }

  /** Three 21K runners (the second a woman) and two 10K runners. */
  async function field(ev: Awaited<ReturnType<typeof orgEvent>>) {
    const a = await paid(ev, '21K', runner({ firstNameTh: 'เอ', lastNameTh: 'วิ่งไว', firstNameEn: 'A', lastNameEn: 'Fast' }));
    const b = await paid(ev, '21K', runner({ firstNameTh: 'บี', lastNameTh: 'สายลม', firstNameEn: 'B', lastNameEn: 'Wind', gender: 'female' }));
    const c = await paid(ev, '21K', runner({ firstNameTh: 'ซี', lastNameTh: 'ไม่ถึง', firstNameEn: 'C', lastNameEn: 'Late' }));
    const d = await paid(ev, '10K', runner({ firstNameTh: 'ดี', lastNameTh: 'สิบโล', firstNameEn: 'D', lastNameEn: 'Ten' }));
    const e = await paid(ev, '10K', runner({ firstNameTh: 'อี', lastNameTh: 'เร็วเกิน', firstNameEn: 'E', lastNameEn: 'Quick' }));
    return { a, b, c, d, e };
  }

  const importCsv = (ev: Awaited<ReturnType<typeof orgEvent>>, csv: string, dryRun: boolean) =>
    call(ctx.app, 'POST', `${ev.base}/results/import`, { token: ev.token, body: { csv, dryRun } });

  it('checks every line against the paid runners and writes nothing while anything is wrong', async () => {
    const ev = await orgEvent();
    const f = await field(ev);
    const csv = ['bib,chip_time,gun_time,status', `${f.a},1:50:00,1:50:20,`, '9999,1:00:00,,', `${f.a},1:51:00,,`, `${f.b},2:xx,,`, `${f.c},,,FIN`].join('\n');
    const res = await importCsv(ev, csv, false);
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(false);
    expect(res.body.errors.map((e: { line: number; code: string }) => [e.line, e.code])).toEqual([
      [3, 'BIB_NOT_FOUND'], [4, 'DUPLICATE_BIB'], [5, 'INVALID_TIME'], [6, 'MISSING_TIME'],
    ]);
    expect((await ctx.pool.query('SELECT count(*)::int AS n FROM results WHERE event_id = $1', [ev.eventId])).rows[0].n).toBe(0);
    expect((await importCsv(ev, 'name\nx\n', true)).status).toBe(422);
  });

  it('ranks finishers per race, flags odd times, publishes and serves them to runners', async () => {
    const ev = await orgEvent();
    const f = await field(ev);
    const csv = [
      'Bib,Chip Time,Gun Time,Status',
      `${f.a},1:50:00,1:50:30,`,
      `${f.b},2:00:00,1:59:00,`, // gun before chip
      `${f.c},3:30:00,3:31:00,`, // over the 3 h cut-off
      `${f.d},55:00,55:10,`,
      `${f.e},20:00,20:05,`, // 2:00 per km: too fast to be true
    ].join('\r\n');

    const dry = await importCsv(ev, csv, true);
    expect(dry.body).toMatchObject({ rows: 5, matched: 5, errors: [], applied: false });
    expect(dry.body.warnings.map((w: { bib: string; code: string }) => [w.bib, w.code]).sort()).toEqual(
      [[f.b, 'GUN_BEFORE_CHIP'], [f.c, 'OVER_CUTOFF'], [f.e, 'TOO_FAST']].sort(),
    );
    expect(dry.body.races).toEqual([{ code: '21K', FIN: 3, DNF: 0, DNS: 0, DQ: 0 }, { code: '10K', FIN: 2, DNF: 0, DNS: 0, DQ: 0 }]);

    expect((await call(ctx.app, 'GET', `/v1/events/${ev.slug}/results`)).body.code).toBe('RESULTS_NOT_PUBLISHED');
    expect((await call(ctx.app, 'POST', `${ev.base}/results/publish`, { token: ev.token, body: { published: true } })).body.code).toBe('NO_RESULTS');

    expect((await importCsv(ev, csv, false)).body.applied).toBe(true);
    const ranks = await ctx.pool.query(`SELECT bib_number, rank_overall, rank_gender, pace_sec_per_km FROM results WHERE event_id = $1 ORDER BY bib_number`, [ev.eventId]);
    expect(ranks.rows).toEqual([
      { bib_number: f.a, rank_overall: 1, rank_gender: 1, pace_sec_per_km: 313 },
      { bib_number: f.b, rank_overall: 2, rank_gender: 1, pace_sec_per_km: 341 },
      { bib_number: f.c, rank_overall: 3, rank_gender: 2, pace_sec_per_km: 597 },
      { bib_number: f.d, rank_overall: 2, rank_gender: 2, pace_sec_per_km: 330 },
      { bib_number: f.e, rank_overall: 1, rank_gender: 1, pace_sec_per_km: 120 },
    ]);

    const summary = await call(ctx.app, 'GET', `${ev.base}/results`, { token: ev.token });
    expect(summary.body.publishedAt).toBeNull();
    expect(summary.body.races[0]).toMatchObject({ code: '21K', runners: 3, counts: { FIN: 3, DNF: 0, DNS: 0, DQ: 0 } });
    expect(summary.body.races[0].top.map((t: { name: string }) => t.name)).toEqual(['เอ วิ่งไว', 'บี สายลม', 'ซี ไม่ถึง']);
    expect(summary.body.lastImport).toMatchObject({ rows: 5, warnings: expect.arrayContaining([expect.objectContaining({ code: 'TOO_FAST' })]) });

    // Not public until the organiser publishes.
    expect((await call(ctx.app, 'GET', `/v1/events/${ev.slug}/results`)).body.code).toBe('RESULTS_NOT_PUBLISHED');
    const published = await call(ctx.app, 'POST', `${ev.base}/results/publish`, { token: ev.token, body: { published: true } });
    expect(published.body.publishedAt).not.toBeNull();
    expect((await call(ctx.app, 'GET', `/v1/events/${ev.slug}`)).body.resultsPublishedAt).not.toBeNull();

    const pub = await call(ctx.app, 'GET', `/v1/events/${ev.slug}/results`);
    expect(pub.body.races.map((r: { code: string; finishers: number }) => [r.code, r.finishers])).toEqual([['21K', 3], ['10K', 2]]);
    expect(pub.body.raceId).toBe(ev.raceIds['21K']);
    expect(pub.body.items.map((i: { bib: string; rankOverall: number }) => [i.bib, i.rankOverall])).toEqual([[f.a, 1], [f.b, 2], [f.c, 3]]);
    expect(pub.body.items[0]).toMatchObject({ name: 'เอ วิ่งไว', status: 'FIN', chipTimeMs: 6_600_000, gunTimeMs: 6_630_000 });
    const women = await call(ctx.app, 'GET', `/v1/events/${ev.slug}/results?gender=female`);
    expect(women.body).toMatchObject({ total: 1, items: [expect.objectContaining({ bib: f.b, rankGender: 1 })] });
    expect((await call(ctx.app, 'GET', `/v1/events/${ev.slug}/results?q=สายลม`)).body.items.map((i: { bib: string }) => i.bib)).toEqual([f.b]);
    const tenK = await call(ctx.app, 'GET', `/v1/events/${ev.slug}/results?race=${ev.raceIds['10K']}&q=${f.d}`);
    expect(tenK.body.items.map((i: { bib: string }) => i.bib)).toEqual([f.d]);

    // A corrected file replaces the old one; C is now a DNF and E is gone. Published files stay public.
    const fixed = ['bib,chip_time,status', `${f.a},1:50:00,FIN`, `${f.b},2:00:00,FIN`, `${f.c},,DNF`, `${f.d},55:00,FIN`].join('\n');
    expect((await importCsv(ev, fixed, false)).body.applied).toBe(true);
    const after = await call(ctx.app, 'GET', `/v1/events/${ev.slug}/results`);
    expect(after.body.items.map((i: { bib: string; status: string; rankOverall: number | null }) => [i.bib, i.status, i.rankOverall])).toEqual([
      [f.a, 'FIN', 1], [f.b, 'FIN', 2], [f.c, 'DNF', null],
    ]);
    expect((await call(ctx.app, 'GET', `/v1/events/${ev.slug}/results?race=${ev.raceIds['10K']}`)).body.total).toBe(1);

    expect((await call(ctx.app, 'POST', `${ev.base}/results/publish`, { token: ev.token, body: { published: false } })).body.publishedAt).toBeNull();
    expect((await call(ctx.app, 'GET', `/v1/events/${ev.slug}/results`)).body.code).toBe('RESULTS_NOT_PUBLISHED');
    const audit = await ctx.pool.query(`SELECT action FROM audit_logs WHERE event_id = $1 AND action LIKE 'results.%' ORDER BY id`, [ev.eventId]);
    expect(audit.rows.map((r) => r.action)).toEqual(['results.import', 'results.publish', 'results.import', 'results.unpublish']);
  });

  it('lets everyone in the team see results but only owners and admins change them', async () => {
    const ev = await orgEvent();
    const email = `viewer-${randomUUID()}@org.example`;
    await addOrgMember(ctx.pool, ev.organizationId, email, 'viewer');
    const viewer = await login(ctx.app, email);
    expect((await call(ctx.app, 'GET', `${ev.base}/results`, { token: viewer.token })).status).toBe(200);
    expect((await call(ctx.app, 'POST', `${ev.base}/results/import`, { token: viewer.token, body: { csv: 'bib,chip_time\n1,1:00:00\n' } })).status).toBe(403);
    expect((await call(ctx.app, 'POST', `${ev.base}/results/publish`, { token: viewer.token, body: { published: true } })).status).toBe(403);
  });
});
