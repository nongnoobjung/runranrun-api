import { randomUUID } from 'node:crypto';
import { bootApp, buyer, call, login, runner, seedEvent, TestContext } from './helpers';

describe('runner profiles', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await bootApp();
  });
  afterAll(() => ctx.close());

  const profile = (overrides: Record<string, unknown> = {}) => ({ ...runner(), nickname: 'ชาย', shirtSize: 'M', ...overrides });

  /** Holds one 10K place and orders it with the given participant. */
  async function order(token: string, participant: Record<string, unknown>) {
    const ev = await seedEvent(ctx.pool, { shirtSizes: [], coupons: [] });
    const raceId = ev.raceIds['10K'];
    const session = await call(ctx.app, 'POST', '/v1/checkout/sessions', { token, body: { eventId: ev.eventId, races: [{ raceId, quantity: 1 }] } });
    return call(ctx.app, 'POST', '/v1/orders', {
      token,
      headers: { 'idempotency-key': randomUUID() },
      body: { checkoutSessionId: session.body.id, buyer, participants: [{ raceId, ...participant }] },
    });
  }

  it('keeps a runner list per account without ever sending the ID number back', async () => {
    const me = await login(ctx.app);
    const mine = profile({ isSelf: true, idDocNumber: '1-1037-00000-12-3' });
    const created = await call(ctx.app, 'POST', '/v1/me/profiles', { token: me.token, body: mine });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ isSelf: true, firstNameEn: 'SOMCHAI', idDocLast4: '0123', nickname: 'ชาย', shirtSize: 'M' });
    expect(JSON.stringify(created.body)).not.toContain('1103700000123');

    const again = await call(ctx.app, 'POST', '/v1/me/profiles', { token: me.token, body: profile({ idDocNumber: '1103700000123' }) });
    expect(again.body.code).toBe('PROFILE_EXISTS');

    const kid = await call(ctx.app, 'POST', '/v1/me/profiles', { token: me.token, body: profile({ firstNameEn: 'Nong', isSelf: true }) });
    // Only one profile is the account holder's own.
    const list = (await call(ctx.app, 'GET', '/v1/me/profiles', { token: me.token })).body.items;
    expect(list.map((p: { firstNameEn: string; isSelf: boolean }) => [p.firstNameEn, p.isSelf])).toEqual([['NONG', true], ['SOMCHAI', false]]);

    const renamed = await call(ctx.app, 'PATCH', `/v1/me/profiles/${created.body.id}`, { token: me.token, body: { nickname: 'พ่อ', isSelf: true } });
    expect(renamed.body).toMatchObject({ nickname: 'พ่อ', isSelf: true, idDocLast4: '0123' });

    const other = await login(ctx.app);
    expect((await call(ctx.app, 'GET', '/v1/me/profiles', { token: other.token })).body.items).toEqual([]);
    expect((await call(ctx.app, 'PATCH', `/v1/me/profiles/${kid.body.id}`, { token: other.token, body: { nickname: 'x' } })).status).toBe(404);
    expect((await call(ctx.app, 'DELETE', `/v1/me/profiles/${kid.body.id}`, { token: other.token })).status).toBe(404);
    expect((await call(ctx.app, 'DELETE', `/v1/me/profiles/${kid.body.id}`, { token: me.token })).body.deleted).toBe(true);
    expect((await call(ctx.app, 'GET', '/v1/me/profiles', { token: me.token })).body.items).toHaveLength(1);
  });

  it('registers a saved runner without the ID number, and saves new runners when asked', async () => {
    const me = await login(ctx.app);
    const saved = await call(ctx.app, 'POST', '/v1/me/profiles', { token: me.token, body: profile() });
    const { idDocNumber: _, ...withoutId } = runner();

    expect((await order(me.token, { runner: withoutId })).status).toBe(422);
    const placed = await order(me.token, { runner: withoutId, profileId: saved.body.id });
    expect(placed.status).toBe(201);
    const reg = await ctx.pool.query('SELECT r.runner_profile_id, r.id_doc_hash = p.id_doc_hash AS same_id FROM registrations r JOIN runner_profiles p ON p.id = $2 WHERE r.order_id = $1', [
      placed.body.id, saved.body.id,
    ]);
    expect(reg.rows[0]).toEqual({ runner_profile_id: saved.body.id, same_id: true });

    // Someone else's profile cannot be used.
    const stranger = await login(ctx.app);
    const stolen = await order(stranger.token, { runner: withoutId, profileId: saved.body.id });
    expect(stolen.status).toBe(422);
    expect(stolen.body.errors).toEqual([{ path: 'participants.0.profileId', message: 'not found' }]);

    // Ticking "save" stores the runner once; saving the same person again refreshes the same profile.
    const fresh = runner({ firstNameEn: 'Mali', gender: 'female' });
    await order(stranger.token, { runner: fresh, isSelf: true, saveProfile: true });
    await order(stranger.token, { runner: { ...fresh, emergencyName: 'คนใหม่' }, saveProfile: true });
    const theirs = (await call(ctx.app, 'GET', '/v1/me/profiles', { token: stranger.token })).body.items;
    expect(theirs).toEqual([expect.objectContaining({ firstNameEn: 'MALI', isSelf: true, emergencyName: 'คนใหม่' })]);
  });
});
