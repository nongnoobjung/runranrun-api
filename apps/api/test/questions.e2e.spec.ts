import { randomUUID } from 'node:crypto';
import { addOrgMember, createEvent } from '../db/fixtures';
import { bootApp, buyer, call, login, runner, TestContext, uniqueSlug } from './helpers';

describe('registration form questions', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await bootApp();
  });
  afterAll(() => ctx.close());

  /** A published event with a 21K and a 10K race in its own organisation, plus its signed-in owner. */
  async function orgEvent() {
    const slug = uniqueSlug();
    const created = await createEvent(
      ctx.pool,
      {
        slug,
        nameTh: 'งานมีคำถาม',
        eventDate: '2027-03-01',
        races: [
          { code: '21K', nameTh: 'ฮาล์ฟ', distanceKm: 21.1, capacity: 50, bibStart: 1, bibEnd: 50, tiers: [{ name: 'ปกติ', priceSatang: 90_000 }] },
          { code: '10K', nameTh: 'มินิ', distanceKm: 10, capacity: 50, bibStart: 101, bibEnd: 150, tiers: [{ name: 'ปกติ', priceSatang: 50_000 }] },
        ],
      },
      uniqueSlug('org'),
    );
    const email = `owner-${randomUUID()}@org.example`;
    await addOrgMember(ctx.pool, created.organizationId, email, 'owner');
    const { token } = await login(ctx.app, email);
    return { ...created, slug, token, base: `/v1/org/${created.organizationId}/events/${created.eventId}`, org: `/v1/org/${created.organizationId}` };
  }

  async function addQuestion(ev: Awaited<ReturnType<typeof orgEvent>>, body: Record<string, unknown>) {
    const res = await call(ctx.app, 'POST', `${ev.base}/questions`, { token: ev.token, body });
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    return res.body.items.at(-1) as { id: string; key: string };
  }

  /** Holds one place in `raceCode` and tries to order it with the given answers. */
  async function order(ev: Awaited<ReturnType<typeof orgEvent>>, raceCode: string, answers: Record<string, unknown>) {
    const { token } = await login(ctx.app);
    const raceId = ev.raceIds[raceCode];
    const session = await call(ctx.app, 'POST', '/v1/checkout/sessions', { token, body: { eventId: ev.eventId, races: [{ raceId, quantity: 1 }] } });
    return call(ctx.app, 'POST', '/v1/orders', {
      token,
      headers: { 'idempotency-key': randomUUID() },
      body: { checkoutSessionId: session.body.id, buyer, participants: [{ raceId, runner: runner(), answers }] },
    });
  }

  it('lets organisers build the form and runners see it on the event page', async () => {
    const ev = await orgEvent();
    const club = await addQuestion(ev, { label: 'ชื่อชมรมวิ่ง', type: 'text' });
    const before = await addQuestion(ev, { label: 'เคยวิ่งฮาล์ฟไหม', type: 'select', options: ['เคย', 'ไม่เคย', 'เคย'], required: true, raceIds: [ev.raceIds['21K']] });

    const list = await call(ctx.app, 'GET', `${ev.base}/questions`, { token: ev.token });
    expect(list.body.items).toEqual([
      expect.objectContaining({ id: club.id, label: 'ชื่อชมรมวิ่ง', type: 'text', required: false, raceIds: null, answered: 0 }),
      expect.objectContaining({ id: before.id, options: ['เคย', 'ไม่เคย'], required: true, raceIds: [ev.raceIds['21K']] }),
    ]);

    const reordered = await call(ctx.app, 'PUT', `${ev.base}/questions/order`, { token: ev.token, body: { ids: [before.id, club.id] } });
    expect(reordered.body.items.map((q: { id: string }) => q.id)).toEqual([before.id, club.id]);
    expect((await call(ctx.app, 'PUT', `${ev.base}/questions/order`, { token: ev.token, body: { ids: [before.id] } })).status).toBe(422);

    const publicEvent = await call(ctx.app, 'GET', `/v1/events/${ev.slug}`);
    expect(publicEvent.body.questions).toEqual([
      expect.objectContaining({ key: before.key, label: 'เคยวิ่งฮาล์ฟไหม', type: 'select', required: true }),
      expect.objectContaining({ key: club.key, label: 'ชื่อชมรมวิ่ง' }),
    ]);
    expect(publicEvent.body.questions[0]).not.toHaveProperty('id');

    const audit = await ctx.pool.query(`SELECT action FROM audit_logs WHERE event_id = $1 ORDER BY id`, [ev.eventId]);
    expect(audit.rows.map((r) => r.action)).toEqual(['question.create', 'question.create', 'question.reorder']);
  });

  it('refuses malformed questions and members who cannot edit the event', async () => {
    const ev = await orgEvent();
    const other = await orgEvent();
    const tooFew = await call(ctx.app, 'POST', `${ev.base}/questions`, { token: ev.token, body: { label: 'เลือก', type: 'select', options: ['ทางเดียว'] } });
    expect(tooFew.status).toBe(422);
    expect(tooFew.body.errors).toEqual([expect.objectContaining({ path: 'options' })]);
    const foreignRace = await call(ctx.app, 'POST', `${ev.base}/questions`, { token: ev.token, body: { label: 'x', type: 'text', raceIds: [other.raceIds['10K']] } });
    expect(foreignRace.status).toBe(422);
    expect((await call(ctx.app, 'POST', `${ev.base}/questions`, { token: ev.token, body: { label: 'ใบรับรองแพทย์', type: 'file' } })).status).toBe(422);
    expect((await call(ctx.app, 'POST', `${ev.base}/questions`, { token: ev.token, body: { label: 'อายุ', type: 'number', min: 10, max: 5 } })).status).toBe(422);

    const viewerEmail = `viewer-${randomUUID()}@org.example`;
    await addOrgMember(ctx.pool, ev.organizationId, viewerEmail, 'viewer');
    const viewer = await login(ctx.app, viewerEmail);
    expect((await call(ctx.app, 'GET', `${ev.base}/questions`, { token: viewer.token })).status).toBe(200);
    expect((await call(ctx.app, 'POST', `${ev.base}/questions`, { token: viewer.token, body: { label: 'x', type: 'text' } })).status).toBe(403);
  });

  it('checks each runner’s answers for their race and keeps them on the registration', async () => {
    const ev = await orgEvent();
    const halfOnly = await addQuestion(ev, { label: 'เคยวิ่งฮาล์ฟไหม', type: 'select', options: ['เคย', 'ไม่เคย'], required: true, raceIds: [ev.raceIds['21K']] });
    const pace = await addQuestion(ev, { label: 'เพซโดยประมาณ (นาที/กม.)', type: 'number', min: 3, max: 15 });
    const waiver = await addQuestion(ev, { label: 'ยอมรับข้อตกลง', type: 'checkbox', required: true });
    const shoes = await addQuestion(ev, { label: 'รองเท้า', type: 'multiselect', options: ['ถนน', 'เทรล', 'คาร์บอน'] });

    const missing = await order(ev, '21K', { [pace.key]: '20' });
    expect(missing.status).toBe(422);
    expect(missing.body.errors.map((e: { path: string }) => e.path).sort()).toEqual(
      [`participants.0.answers.${halfOnly.key}`, `participants.0.answers.${pace.key}`, `participants.0.answers.${waiver.key}`].sort(),
    );
    expect((await order(ev, '21K', { [halfOnly.key]: 'อาจจะ', [waiver.key]: true })).status).toBe(422);

    // The 21K-only question is not asked of a 10K runner; unknown keys are dropped.
    const ok = await order(ev, '10K', { [waiver.key]: true, [pace.key]: '6.5', [shoes.key]: ['ถนน', 'ถนน', 'เทรล'], extra: 'x', [halfOnly.key]: 'เคย' });
    expect(ok.status).toBe(201);
    const reg = await ctx.pool.query('SELECT id, answers FROM registrations WHERE order_id = $1', [ok.body.id]);
    expect(reg.rows[0].answers).toEqual({ [waiver.key]: true, [pace.key]: 6.5, [shoes.key]: ['ถนน', 'เทรล'] });

    const detail = await call(ctx.app, 'GET', `${ev.org}/registrations/${reg.rows[0].id}`, { token: ev.token });
    expect(detail.body.answers).toEqual([
      { key: pace.key, label: 'เพซโดยประมาณ (นาที/กม.)', type: 'number', value: 6.5 },
      { key: waiver.key, label: 'ยอมรับข้อตกลง', type: 'checkbox', value: true },
      { key: shoes.key, label: 'รองเท้า', type: 'multiselect', value: ['ถนน', 'เทรล'] },
    ]);

    const csv = await ctx.app.inject({ method: 'GET', url: `${ev.base}/registrations.csv`, headers: { authorization: `Bearer ${ev.token}` } });
    const [header, row] = csv.body.replace(/^﻿/, '').trim().split('\r\n');
    expect(header.endsWith(',เคยวิ่งฮาล์ฟไหม,เพซโดยประมาณ (นาที/กม.),ยอมรับข้อตกลง,รองเท้า')).toBe(true);
    expect(row.endsWith(',,6.5,yes,ถนน; เทรล')).toBe(true);
  });

  it('locks the type of answered questions and keeps their answers when removed', async () => {
    const ev = await orgEvent();
    const club = await addQuestion(ev, { label: 'ชื่อชมรม', type: 'text' });
    const unused = await addQuestion(ev, { label: 'ไม่มีใครตอบ', type: 'text' });
    const ok = await order(ev, '10K', { [club.key]: 'Riverside Runners' });
    expect(ok.status).toBe(201);

    const retype = await call(ctx.app, 'PATCH', `${ev.base}/questions/${club.id}`, { token: ev.token, body: { type: 'number' } });
    expect(retype.status).toBe(409);
    expect(retype.body.code).toBe('QUESTION_IN_USE');
    const relabel = await call(ctx.app, 'PATCH', `${ev.base}/questions/${club.id}`, { token: ev.token, body: { label: 'ชมรมหรือทีม', required: true } });
    expect(relabel.body.items[0]).toEqual(expect.objectContaining({ label: 'ชมรมหรือทีม', required: true, answered: 1 }));

    expect((await call(ctx.app, 'DELETE', `${ev.base}/questions/${unused.id}`, { token: ev.token })).status).toBe(200);
    const removed = await call(ctx.app, 'DELETE', `${ev.base}/questions/${club.id}`, { token: ev.token });
    expect(removed.body.items).toEqual([]);
    expect((await call(ctx.app, 'GET', `/v1/events/${ev.slug}`)).body.questions).toEqual([]);
    const rows = await ctx.pool.query('SELECT key, is_active FROM form_questions WHERE event_id = $1', [ev.eventId]);
    expect(rows.rows).toEqual([{ key: club.key, is_active: false }]);

    const reg = await ctx.pool.query('SELECT id FROM registrations WHERE order_id = $1', [ok.body.id]);
    const detail = await call(ctx.app, 'GET', `${ev.org}/registrations/${reg.rows[0].id}`, { token: ev.token });
    expect(detail.body.answers).toEqual([{ key: club.key, label: 'ชมรมหรือทีม', type: 'text', value: 'Riverside Runners' }]);
  });
});
