import { randomUUID } from 'node:crypto';
import { addOrgMember, createEvent } from '../db/fixtures';
import { bootApp, buyer, call, login, runner, sendFakeWebhook, TestContext, uniqueSlug } from './helpers';

describe('bib numbers', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await bootApp();
  });
  afterAll(() => ctx.close());

  /** 10K numbered 0001–0050 automatically; 21K starts without a range. */
  async function orgEvent() {
    const created = await createEvent(
      ctx.pool,
      {
        slug: uniqueSlug(),
        nameTh: 'งานบิบ',
        eventDate: '2027-03-01',
        races: [
          { code: '10K', nameTh: 'มินิ', distanceKm: 10, capacity: 50, bibStart: 1, bibEnd: 50, tiers: [{ name: 'ปกติ', priceSatang: 50_000 }] },
          { code: '21K', nameTh: 'ฮาล์ฟ', distanceKm: 21.1, capacity: 50, tiers: [{ name: 'ปกติ', priceSatang: 90_000 }] },
        ],
      },
      uniqueSlug('org'),
    );
    const email = `owner-${randomUUID()}@org.example`;
    await addOrgMember(ctx.pool, created.organizationId, email, 'owner');
    const { token } = await login(ctx.app, email);
    return { ...created, token, base: `/v1/org/${created.organizationId}/events/${created.eventId}` };
  }

  /** Orders one place in `raceCode`; pays for it unless `pay` is false. */
  async function register(ev: Awaited<ReturnType<typeof orgEvent>>, raceCode: string, pay = true) {
    const { token } = await login(ctx.app);
    const raceId = ev.raceIds[raceCode];
    const session = await call(ctx.app, 'POST', '/v1/checkout/sessions', { token, body: { eventId: ev.eventId, races: [{ raceId, quantity: 1 }] } });
    const order = await call(ctx.app, 'POST', '/v1/orders', {
      token,
      headers: { 'idempotency-key': randomUUID() },
      body: { checkoutSessionId: session.body.id, buyer, participants: [{ raceId, runner: runner() }] },
    });
    if (pay) {
      const payment = await call(ctx.app, 'POST', `/v1/orders/${order.body.id}/payments`, { token, headers: { 'idempotency-key': randomUUID() }, body: { method: 'promptpay' } });
      const charge = await ctx.pool.query('SELECT gateway_charge_id FROM payments WHERE id = $1', [payment.body.id]);
      await sendFakeWebhook(ctx.app, charge.rows[0].gateway_charge_id);
    }
    const reg = await ctx.pool.query('SELECT id, registration_no, bib_number FROM registrations WHERE order_id = $1', [order.body.id]);
    return reg.rows[0] as { id: string; registration_no: string; bib_number: string | null };
  }

  const bibOf = async (id: string) => (await ctx.pool.query('SELECT bib_number FROM registrations WHERE id = $1', [id])).rows[0].bib_number;

  it('shows each race’s range and who is still waiting for a number', async () => {
    const ev = await orgEvent();
    const a = await register(ev, '10K');
    await register(ev, '10K');
    const half = await register(ev, '21K');
    await register(ev, '10K', false);
    expect(a.bib_number).toBe('0001');
    expect(half.bib_number).toBeNull();

    const res = await call(ctx.app, 'GET', `${ev.base}/bibs`, { token: ev.token });
    expect(res.body.races).toEqual([
      expect.objectContaining({ code: '10K', start: 1, end: 50, next: 3, confirmed: 2, assigned: 2, waiting: 0, rangeFull: false }),
      expect.objectContaining({ code: '21K', start: null, next: null, confirmed: 1, assigned: 0, waiting: 1 }),
    ]);
    expect(res.body.totals).toEqual({ confirmed: 3, assigned: 2 });
    expect(res.body.waiting).toEqual([expect.objectContaining({ id: half.id, registrationNo: half.registration_no, raceCode: '21K' })]);
  });

  it('sets, changes and clears a number by hand, keeping numbers unique in the event', async () => {
    const ev = await orgEvent();
    const a = await register(ev, '10K');
    const half = await register(ev, '21K');
    const unpaid = await register(ev, '10K', false);
    const path = (id: string) => `${ev.base}/registrations/${id}/bib`;

    expect((await call(ctx.app, 'PUT', path(half.id), { token: ev.token, body: { bibNumber: ' v-01 ' } })).body).toEqual({ id: half.id, bibNumber: 'V-01' });
    const taken = await call(ctx.app, 'PUT', path(half.id), { token: ev.token, body: { bibNumber: '0001' } });
    expect(taken.status).toBe(409);
    expect(taken.body).toMatchObject({ code: 'BIB_TAKEN', registrationNo: a.registration_no });
    expect((await call(ctx.app, 'PUT', path(unpaid.id), { token: ev.token, body: { bibNumber: '9999' } })).body.code).toBe('NOT_CONFIRMED');
    expect((await call(ctx.app, 'PUT', path(half.id), { token: ev.token, body: { bibNumber: 'no spaces' } })).status).toBe(422);

    expect((await call(ctx.app, 'PUT', path(a.id), { token: ev.token, body: { bibNumber: null } })).status).toBe(200);
    expect(await bibOf(a.id)).toBeNull();
    // Freed, so it can be given to someone else.
    expect((await call(ctx.app, 'PUT', path(half.id), { token: ev.token, body: { bibNumber: '0001' } })).status).toBe(200);

    const viewerEmail = `viewer-${randomUUID()}@org.example`;
    await addOrgMember(ctx.pool, ev.organizationId, viewerEmail, 'viewer');
    const viewer = await login(ctx.app, viewerEmail);
    expect((await call(ctx.app, 'GET', `${ev.base}/bibs`, { token: viewer.token })).status).toBe(200);
    expect((await call(ctx.app, 'PUT', path(half.id), { token: viewer.token, body: { bibNumber: '7' } })).status).toBe(403);

    const audit = await ctx.pool.query(`SELECT before_data, after_data FROM audit_logs WHERE event_id = $1 AND action = 'bib.set' ORDER BY id`, [ev.eventId]);
    expect(audit.rows.map((r) => [r.before_data.bibNumber, r.after_data.bibNumber])).toEqual([[null, 'V-01'], ['0001', null], ['V-01', '0001']]);
  });

  it('numbers everyone still waiting, skipping numbers already taken and stopping when the range runs out', async () => {
    const ev = await orgEvent();
    const first = await register(ev, '21K');
    const second = await register(ev, '21K');
    const third = await register(ev, '21K');
    const tenK = await register(ev, '10K');
    expect((await call(ctx.app, 'PATCH', `${ev.base}/races/${ev.raceIds['21K']}`, { token: ev.token, body: { bibStart: 500, bibEnd: 502 } })).status).toBe(200);
    await call(ctx.app, 'PUT', `${ev.base}/registrations/${tenK.id}/bib`, { token: ev.token, body: { bibNumber: '0501' } });

    const res = await call(ctx.app, 'POST', `${ev.base}/bibs/assign`, { token: ev.token, body: {} });
    expect(res.status).toBe(201);
    expect(res.body.assigned).toBe(2);
    expect([await bibOf(first.id), await bibOf(second.id), await bibOf(third.id)]).toEqual(['0500', '0502', null]);
    expect(res.body.races.find((r: { code: string }) => r.code === '21K')).toMatchObject({ rangeFull: true, waiting: 1 });
    expect(res.body.waiting.map((w: { id: string }) => w.id)).toEqual([third.id]);
  });

  it('imports numbers from a CSV after checking every line', async () => {
    const ev = await orgEvent();
    const a = await register(ev, '10K');
    const b = await register(ev, '10K');
    const c = await register(ev, '10K');
    const unpaid = await register(ev, '10K', false);
    const importCsv = (csv: string, dryRun: boolean) => call(ctx.app, 'POST', `${ev.base}/bibs/import`, { token: ev.token, body: { csv, dryRun } });

    // a and b swap numbers; c keeps 0003, so nobody else may take it.
    const bad = [
      '﻿registration_no,first_name_en,bib',
      `${a.registration_no},A,0002`,
      `${b.registration_no},B,0001`,
      `R999999,Ghost,0010`,
      `${unpaid.registration_no},U,0011`,
      `${b.registration_no},B again,0012`,
      `"${a.registration_no.toLowerCase()}",A,"bad bib!"`,
      `${c.registration_no},C,`,
      `${a.registration_no},A,0003`,
    ].join('\r\n');
    const preview = await importCsv(bad, false);
    expect(preview.status).toBe(200);
    expect(preview.body.applied).toBe(false);
    expect(preview.body.errors.map((e: { line: number; message: string }) => [e.line, e.message])).toEqual([
      [4, 'REGISTRATION_NOT_FOUND'], [5, 'NOT_CONFIRMED'], [6, 'DUPLICATE_REGISTRATION'], [7, 'INVALID_BIB'], [9, 'DUPLICATE_REGISTRATION'],
    ]);
    expect(await bibOf(a.id)).toBe('0001');

    const takenByOther = await importCsv(`registration_no,bib\n${a.registration_no},0003\n`, true);
    expect(takenByOther.body.errors).toEqual([expect.objectContaining({ line: 2, message: 'BIB_TAKEN' })]);

    const swap = `registration_no,bib\n${a.registration_no},0002\n${b.registration_no},0001\n${c.registration_no},0003\n`;
    const dry = await importCsv(swap, true);
    expect(dry.body).toMatchObject({ rows: 3, errors: [], applied: false });
    expect(dry.body.changes).toEqual([
      expect.objectContaining({ registrationNo: a.registration_no, from: '0001', to: '0002' }),
      expect.objectContaining({ registrationNo: b.registration_no, from: '0002', to: '0001' }),
    ]);
    expect(await bibOf(a.id)).toBe('0001');

    const applied = await importCsv(swap, false);
    expect(applied.body.applied).toBe(true);
    expect([await bibOf(a.id), await bibOf(b.id), await bibOf(c.id)]).toEqual(['0002', '0001', '0003']);
    const audit = await ctx.pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE event_id = $1 AND action = 'bibs.import'`, [ev.eventId]);
    expect(audit.rows[0].n).toBe(1);

    expect((await importCsv('name,number\nx,1\n', true)).status).toBe(422);
  });
});
