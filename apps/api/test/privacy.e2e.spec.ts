import { randomUUID } from 'node:crypto';
import { addOrgMember } from '../db/fixtures';
import { POLICY_VERSION } from '../src/modules/privacy/privacy.service';
import { bootApp, buyer, call, login, runner, seedEvent, TestContext } from './helpers';

describe('PDPA: consents, data export and closing an account', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await bootApp();
  });
  afterAll(() => ctx.close());

  const consents = { terms: true, privacy: true, shareWithOrganizer: true, marketing: true };

  /** Orders one 10K place for a new runner (who is the buyer and the runner) with the given consents. */
  async function order(extra: Record<string, unknown> = {}) {
    const me = await login(ctx.app);
    const ev = await seedEvent(ctx.pool, { shirtSizes: [], coupons: [] });
    const raceId = ev.raceIds['10K'];
    const session = await call(ctx.app, 'POST', '/v1/checkout/sessions', { token: me.token, body: { eventId: ev.eventId, races: [{ raceId, quantity: 1 }] } });
    const res = await call(ctx.app, 'POST', '/v1/orders', {
      token: me.token,
      headers: { 'idempotency-key': randomUUID(), 'user-agent': 'e2e-browser' },
      body: { checkoutSessionId: session.body.id, buyer, participants: [{ raceId, isSelf: true, runner: runner({ idDocNumber: '1103700000123' }) }], ...extra },
    });
    return { ...me, ev, res };
  }

  it('records what the buyer agreed to with the order, per runner for the organiser share', async () => {
    const refused = await order({ consents: { ...consents, shareWithOrganizer: false } });
    expect(refused.res.status).toBe(422);

    const placed = await order({ consents });
    expect(placed.res.status).toBe(201);
    const rows = await ctx.pool.query(
      'SELECT purpose, granted, policy_version, registration_id IS NOT NULL AS per_runner, organization_id, user_agent FROM consents WHERE user_id = $1 ORDER BY purpose::text',
      [placed.userId],
    );
    expect(rows.rows).toEqual([
      { purpose: 'terms', granted: true, policy_version: POLICY_VERSION, per_runner: false, organization_id: null, user_agent: 'e2e-browser' },
      { purpose: 'privacy', granted: true, policy_version: POLICY_VERSION, per_runner: false, organization_id: null, user_agent: 'e2e-browser' },
      { purpose: 'share_with_organizer', granted: true, policy_version: POLICY_VERSION, per_runner: true, organization_id: placed.ev.organizationId, user_agent: 'e2e-browser' },
      { purpose: 'marketing', granted: true, policy_version: POLICY_VERSION, per_runner: false, organization_id: null, user_agent: 'e2e-browser' },
    ].sort((a, b) => a.purpose.localeCompare(b.purpose)));

    // Marketing can be withdrawn at any time; the history keeps both answers.
    const withdrawn = await call(ctx.app, 'POST', '/v1/me/consents', { token: placed.token, body: { purpose: 'marketing', granted: false } });
    expect(withdrawn.status).toBe(201);
    expect(withdrawn.body.current).toMatchObject({ terms: { granted: true }, privacy: { granted: true }, marketing: { granted: false } });
    expect(withdrawn.body.history.filter((h: { purpose: string }) => h.purpose === 'marketing')).toHaveLength(2);
    expect((await call(ctx.app, 'POST', '/v1/me/consents', { token: placed.token, body: { purpose: 'terms', granted: false } })).status).toBe(422);
  });

  it('records the consents of someone taking a transferred place', async () => {
    const placed = await order({ consents });
    await ctx.pool.query(`UPDATE registrations SET status = 'confirmed', confirmed_at = now() WHERE order_id = $1`, [placed.res.body.id]);
    await ctx.pool.query('UPDATE events SET allow_transfer = true WHERE id = $1', [placed.ev.eventId]);
    const reg = await ctx.pool.query('SELECT id FROM registrations WHERE order_id = $1', [placed.res.body.id]);
    const email = `taker-${randomUUID()}@example.com`;
    await call(ctx.app, 'POST', `/v1/me/registrations/${reg.rows[0].id}/transfers`, { token: placed.token, body: { toEmail: email } });
    const taker = await login(ctx.app, email);
    const transferId = (await call(ctx.app, 'GET', '/v1/me/transfers', { token: taker.token })).body.incoming[0].id;
    const accepted = await call(ctx.app, 'POST', `/v1/me/transfers/${transferId}/accept`, {
      token: taker.token,
      body: { runner: runner({ firstNameEn: 'Taker' }), consents: { terms: true, privacy: true, shareWithOrganizer: true } },
    });
    expect(accepted.body.status).toBe('completed');
    const rows = await ctx.pool.query('SELECT purpose::text, organization_id FROM consents WHERE user_id = $1 ORDER BY purpose::text', [taker.userId]);
    expect(rows.rows).toEqual([
      { purpose: 'privacy', organization_id: null },
      { purpose: 'share_with_organizer', organization_id: placed.ev.organizationId },
      { purpose: 'terms', organization_id: null },
    ]);
  });

  it('gives the account holder a copy of their data without the full ID number', async () => {
    const placed = await order({ consents });
    await call(ctx.app, 'POST', '/v1/me/profiles', { token: placed.token, body: { ...runner({ idDocNumber: '1103700000999' }), nickname: 'ตัวฉัน' } });
    const data = await call(ctx.app, 'GET', '/v1/me/data', { token: placed.token });
    expect(data.status).toBe(200);
    expect(data.body).toMatchObject({
      policyVersion: POLICY_VERSION,
      account: { email: expect.stringContaining('@example.com') },
      registrations: [expect.objectContaining({ id_doc_last4: '0123', first_name_en: 'SOMCHAI', race: '10K' })],
      orders: [expect.objectContaining({ status: 'pending_payment' })],
      savedRunners: [expect.objectContaining({ nickname: 'ตัวฉัน', id_doc_last4: '0999' })],
      consents: expect.arrayContaining([expect.objectContaining({ purpose: 'privacy', granted: true })]),
    });
    const text = JSON.stringify(data.body);
    expect(text).not.toContain('1103700000123');
    expect(text).not.toContain('1103700000999');
    expect(text).not.toContain('idDocNumberEnc');
  });

  it('closes an account once nothing upcoming depends on it, and signs it out', async () => {
    const busy = await order({ consents });
    expect((await call(ctx.app, 'DELETE', '/v1/me', { token: busy.token, body: { confirm: true } })).body).toMatchObject({ code: 'UPCOMING_REGISTRATIONS', count: 1 });

    const ownerEmail = `owner-${randomUUID()}@org.example`;
    const ev = await seedEvent(ctx.pool, { shirtSizes: [], coupons: [] });
    await addOrgMember(ctx.pool, ev.organizationId, ownerEmail, 'owner');
    await ctx.pool.query(`DELETE FROM org_members WHERE organization_id = $1 AND user_id <> (SELECT id FROM users WHERE email = $2)`, [ev.organizationId, ownerEmail]);
    const owner = await login(ctx.app, ownerEmail);
    expect((await call(ctx.app, 'DELETE', '/v1/me', { token: owner.token, body: { confirm: true } })).body.code).toBe('LAST_OWNER');

    const email = `leaving-${randomUUID()}@example.com`;
    const leaving = await login(ctx.app, email);
    await call(ctx.app, 'POST', '/v1/me/profiles', { token: leaving.token, body: runner() });
    await call(ctx.app, 'POST', '/v1/me/consents', { token: leaving.token, body: { purpose: 'marketing', granted: true } });
    expect((await call(ctx.app, 'DELETE', '/v1/me', { token: leaving.token, body: {} })).status).toBe(422);
    const closed = await call(ctx.app, 'DELETE', '/v1/me', { token: leaving.token, body: { confirm: true } });
    expect(closed.body).toEqual({ deleted: true });

    const user = await ctx.pool.query('SELECT email, display_name, status, deleted_at IS NOT NULL AS deleted FROM users WHERE id = $1', [leaving.userId]);
    expect(user.rows[0]).toEqual({ email: `deleted-${leaving.userId}@deleted.invalid`, display_name: null, status: 'deleted', deleted: true });
    expect((await ctx.pool.query('SELECT count(*)::int AS n FROM runner_profiles WHERE owner_user_id = $1', [leaving.userId])).rows[0].n).toBe(0);
    const marketing = await ctx.pool.query(`SELECT granted FROM consents WHERE user_id = $1 AND purpose = 'marketing' ORDER BY granted_at DESC LIMIT 1`, [leaving.userId]);
    expect(marketing.rows[0].granted).toBe(false);
    // The old session stops working, and the email can start a brand-new account.
    expect((await call(ctx.app, 'GET', '/v1/me/registrations', { token: leaving.token })).status).toBe(401);
    expect((await login(ctx.app, email)).userId).not.toBe(leaving.userId);
  });
});
