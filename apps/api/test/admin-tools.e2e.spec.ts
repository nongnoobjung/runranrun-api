import { randomUUID } from 'node:crypto';
import { addOrgMember, createEvent, setPlatformRole } from '../db/fixtures';
import { redact } from '../src/modules/admin/admin-audit.service';
import { AdminUsersService } from '../src/modules/admin/admin-users.service';
import { bootApp, buyer, call, login, runner, TestContext, uniqueSlug } from './helpers';

describe('admin tools: platform fees, audit log, users', () => {
  let ctx: TestContext;
  const tokens: Record<'support' | 'finance' | 'admin' | 'superadmin', { token: string; userId: string; email: string }> = {} as never;

  beforeAll(async () => {
    ctx = await bootApp();
    for (const role of ['support', 'finance', 'admin', 'superadmin'] as const) {
      const email = `${role}-${randomUUID()}@kao.example`;
      await setPlatformRole(ctx.pool, email, role);
      tokens[role] = { ...(await login(ctx.app, email)), email };
    }
  });
  afterAll(async () => {
    // Other suites expect no platform default fee.
    await ctx.pool.query('DELETE FROM platform_fees WHERE organization_id IS NULL');
    await ctx.close();
  });

  /** An organisation of its own with one 10K event (฿900) and its owner. */
  async function orgEvent() {
    const created = await createEvent(
      ctx.pool,
      {
        slug: uniqueSlug(),
        nameTh: 'งานค่าธรรมเนียม',
        eventDate: '2027-06-01',
        races: [{ code: '10K', nameTh: 'มินิ', distanceKm: 10, capacity: 50, bibStart: 1, bibEnd: 50, tiers: [{ name: 'ปกติ', priceSatang: 90_000 }] }],
      },
      uniqueSlug('org'),
    );
    const email = `owner-${randomUUID()}@org.example`;
    await addOrgMember(ctx.pool, created.organizationId, email, 'owner');
    return { ...created, owner: await login(ctx.app, email) };
  }

  /** Creates an order (not paid) for one runner and returns the platform fee fixed on it. */
  async function orderFee(ev: Awaited<ReturnType<typeof orgEvent>>) {
    const { token } = await login(ctx.app);
    const raceId = ev.raceIds['10K'];
    const session = await call(ctx.app, 'POST', '/v1/checkout/sessions', { token, body: { eventId: ev.eventId, races: [{ raceId, quantity: 1 }] } });
    const order = await call(ctx.app, 'POST', '/v1/orders', {
      token,
      headers: { 'idempotency-key': randomUUID() },
      body: { checkoutSessionId: session.body.id, buyer, participants: [{ raceId, runner: runner() }] },
    });
    expect(order.status).toBe(201);
    const { rows } = await ctx.pool.query('SELECT platform_fee_satang FROM orders WHERE id = $1', [order.body.id]);
    return { id: order.body.id as string, fee: Number(rows[0].platform_fee_satang) };
  }

  const feeOf = async (orderId: string) => Number((await ctx.pool.query('SELECT platform_fee_satang FROM orders WHERE id = $1', [orderId])).rows[0].platform_fee_satang);

  describe('platform fees', () => {
    it('lets finance, admin and superadmin change rates; support only sees the rate in force', async () => {
      const ev = await orgEvent();
      const body = { percentBps: 500, fixedPerRegistrationSatang: 1_000 };
      expect((await call(ctx.app, 'GET', '/v1/admin/platform-fees', { token: tokens.support.token })).status).toBe(403);
      expect((await call(ctx.app, 'PUT', `/v1/admin/organizations/${ev.organizationId}/platform-fee`, { token: tokens.support.token, body })).status).toBe(403);
      expect((await call(ctx.app, 'PUT', '/v1/admin/platform-fees/default', { token: tokens.support.token, body })).status).toBe(403);
      expect((await call(ctx.app, 'PUT', `/v1/admin/organizations/${ev.organizationId}/platform-fee`, { token: ev.owner.token, body })).status).toBe(403);
      for (const role of ['finance', 'admin', 'superadmin'] as const) {
        const res = await call(ctx.app, 'PUT', `/v1/admin/organizations/${ev.organizationId}/platform-fee`, { token: tokens[role].token, body });
        expect(res.status).toBe(200);
        expect((await call(ctx.app, 'GET', '/v1/admin/platform-fees', { token: tokens[role].token })).status).toBe(200);
      }
      const org = await call(ctx.app, 'GET', `/v1/admin/organizations/${ev.organizationId}`, { token: tokens.support.token });
      expect(org.body.platformFee.current).toMatchObject({ percentBps: 500, fixedPerRegistrationSatang: 1_000, source: 'organization' });
      // Each change kept the one before as history, closed where the next began.
      const history = org.body.platformFee.history;
      expect(history.map((r: { state: string }) => r.state)).toEqual(['current', 'ended', 'ended']);
      expect(history[1].effectiveTo).toBe(history[0].effectiveFrom);
      expect(history[0].createdBy).toBe(tokens.superadmin.email);

      const bad = await call(ctx.app, 'PUT', `/v1/admin/organizations/${ev.organizationId}/platform-fee`, { token: tokens.admin.token, body: { percentBps: 10_001, fixedPerRegistrationSatang: 0 } });
      expect(bad.status).toBe(422);
      const past = await call(ctx.app, 'PUT', `/v1/admin/organizations/${ev.organizationId}/platform-fee`, {
        token: tokens.admin.token,
        body: { ...body, effectiveFrom: new Date(Date.now() - 86_400_000).toISOString() },
      });
      expect(past.status).toBe(422);
    });

    it('charges new orders the rate in force and leaves existing orders as they were', async () => {
      const ev = await orgEvent();
      await call(ctx.app, 'PUT', '/v1/admin/platform-fees/default', { token: tokens.finance.token, body: { percentBps: 300, fixedPerRegistrationSatang: 0 } });
      const first = await orderFee(ev);
      expect(first.fee).toBe(2_700); // 3% of ฿900, the default

      const set = await call(ctx.app, 'PUT', `/v1/admin/organizations/${ev.organizationId}/platform-fee`, {
        token: tokens.finance.token,
        body: { percentBps: 500, fixedPerRegistrationSatang: 1_000 },
      });
      expect(set.body.current).toMatchObject({ percentBps: 500, source: 'organization' });
      const second = await orderFee(ev);
      expect(second.fee).toBe(4_500 + 1_000);
      expect(await feeOf(first.id)).toBe(2_700);

      // A rate scheduled for later does not apply yet; scheduling again replaces it.
      const later = new Date(Date.now() + 7 * 86_400_000).toISOString();
      await call(ctx.app, 'PUT', `/v1/admin/organizations/${ev.organizationId}/platform-fee`, { token: tokens.admin.token, body: { percentBps: 100, fixedPerRegistrationSatang: 0, effectiveFrom: later } });
      const again = await call(ctx.app, 'PUT', `/v1/admin/organizations/${ev.organizationId}/platform-fee`, { token: tokens.admin.token, body: { percentBps: 200, fixedPerRegistrationSatang: 0, effectiveFrom: later } });
      expect(again.body.history.filter((r: { state: string }) => r.state === 'scheduled')).toEqual([expect.objectContaining({ percentBps: 200 })]);
      expect((await orderFee(ev)).fee).toBe(5_500);
      const list = await call(ctx.app, 'GET', '/v1/admin/platform-fees', { token: tokens.finance.token });
      expect(list.body.default.current).toMatchObject({ percentBps: 300 });
      expect(list.body.organizations.find((o: { id: string }) => o.id === ev.organizationId)).toMatchObject({
        current: { percentBps: 500 },
        scheduled: [{ percentBps: 200 }],
      });

      // Back to the default: the organisation's own rate ends and the scheduled one is dropped.
      const cleared = await call(ctx.app, 'DELETE', `/v1/admin/organizations/${ev.organizationId}/platform-fee`, { token: tokens.admin.token });
      expect(cleared.body.current).toMatchObject({ percentBps: 300, source: 'default' });
      expect(cleared.body.history.every((r: { state: string }) => r.state === 'ended')).toBe(true);
      expect((await orderFee(ev)).fee).toBe(2_700);
      expect((await call(ctx.app, 'DELETE', `/v1/admin/organizations/${ev.organizationId}/platform-fee`, { token: tokens.admin.token })).body.code).toBe('NO_OWN_FEE');
      expect([await feeOf(first.id), await feeOf(second.id)]).toEqual([2_700, 5_500]);

      const audit = await call(ctx.app, 'GET', `/v1/admin/audit?organizationId=${ev.organizationId}&action=admin.platform_fee`, { token: tokens.support.token });
      expect(audit.body.items.map((i: { action: string }) => i.action)).toEqual([
        'admin.platform_fee_clear', 'admin.platform_fee_set', 'admin.platform_fee_set', 'admin.platform_fee_set',
      ]);
      const detail = await call(ctx.app, 'GET', `/v1/admin/audit/${audit.body.items[3].id}`, { token: tokens.support.token });
      // The organisation had no rate of its own before (it paid the default).
      expect(detail.body).toMatchObject({ before: null, after: { percentBps: 500, fixedPerRegistrationSatang: 1_000 }, actor: { email: tokens.finance.email } });
    });
  });

  describe('audit log', () => {
    it('is open to every platform role and filters by organisation, event, actor, action and day', async () => {
      const ev = await orgEvent();
      const someone = await login(ctx.app);
      expect((await call(ctx.app, 'GET', '/v1/admin/audit', { token: someone.token })).status).toBe(403);
      expect((await call(ctx.app, 'GET', '/v1/admin/audit', { token: ev.owner.token })).status).toBe(403);

      await call(ctx.app, 'PATCH', `/v1/org/${ev.organizationId}/events/${ev.eventId}`, { token: ev.owner.token, body: { nameTh: 'งานเปลี่ยนชื่อ' } });
      await call(ctx.app, 'POST', `/v1/admin/organizations/${ev.organizationId}/suspend`, { token: tokens.admin.token, body: { reason: 'ทดสอบ' } });
      for (const role of ['support', 'finance', 'admin', 'superadmin'] as const) {
        expect((await call(ctx.app, 'GET', `/v1/admin/audit?organizationId=${ev.organizationId}`, { token: tokens[role].token })).status).toBe(200);
      }
      const all = (await call(ctx.app, 'GET', `/v1/admin/audit?organizationId=${ev.organizationId}`, { token: tokens.support.token })).body;
      expect(all.items.map((i: { action: string }) => i.action)).toEqual(['admin.org_suspend', 'event.update']);
      expect(all.items[0]).toMatchObject({ organization: { id: ev.organizationId }, actor: { email: tokens.admin.email }, entityType: 'organization' });

      const q = (s: string) => call(ctx.app, 'GET', `/v1/admin/audit?organizationId=${ev.organizationId}&${s}`, { token: tokens.support.token }).then((r) => r.body.items.map((i: { action: string }) => i.action));
      expect(await q(`eventId=${ev.eventId}`)).toEqual(['event.update']);
      expect(await q('action=admin.')).toEqual(['admin.org_suspend']);
      expect(await q(`actor=${encodeURIComponent(tokens.admin.email.slice(0, 20).toUpperCase())}`)).toEqual(['admin.org_suspend']);
      expect(await q('actor=%25')).toEqual([]);
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
      expect(await q(`from=${today}&to=${today}`)).toHaveLength(2);
      expect(await q('from=2020-01-01&to=2020-01-31')).toEqual([]);
      expect((await call(ctx.app, 'GET', '/v1/admin/audit?from=yesterday', { token: tokens.support.token })).status).toBe(422);
      // Empty form fields are ignored.
      expect(await q('actor=&action=&from=')).toHaveLength(2);

      // Pages of one, newest first.
      const page1 = (await call(ctx.app, 'GET', `/v1/admin/audit?organizationId=${ev.organizationId}&limit=1`, { token: tokens.support.token })).body;
      expect(page1.items).toHaveLength(1);
      const page2 = (await call(ctx.app, 'GET', `/v1/admin/audit?organizationId=${ev.organizationId}&limit=1&before=${page1.nextBefore}`, { token: tokens.support.token })).body;
      expect(page2.items[0].action).toBe('event.update');
      expect(page2.nextBefore).toBeNull();

      const detail = await call(ctx.app, 'GET', `/v1/admin/audit/${all.items[0].id}`, { token: tokens.support.token });
      expect(detail.body).toMatchObject({ action: 'admin.org_suspend', after: { reason: 'ทดสอบ' } });
      expect((await call(ctx.app, 'GET', '/v1/admin/audit/999999999', { token: tokens.support.token })).status).toBe(404);
    });

    it('never shows secrets or full ID numbers', async () => {
      const ev = await orgEvent();
      await ctx.pool.query(`UPDATE organizations SET status = 'pending_kyc', contact_phone = '0899999999' WHERE id = $1`, [ev.organizationId]);
      await call(ctx.app, 'PATCH', `/v1/org/${ev.organizationId}/kyc`, { token: ev.owner.token, body: { taxId: '0105556012341', contactPhone: '0812345678' } });
      const { items } = (await call(ctx.app, 'GET', `/v1/admin/audit?organizationId=${ev.organizationId}&action=kyc.company_update`, { token: tokens.support.token })).body;
      expect(items).toHaveLength(1);
      const detail = (await call(ctx.app, 'GET', `/v1/admin/audit/${items[0].id}`, { token: tokens.support.token })).body;
      expect(detail.after).toEqual({ taxId: '••••2341', contactPhone: '••••5678' });
      expect(detail.before).toEqual({ taxId: null, contactPhone: '••••9999' });
      expect(JSON.stringify(detail)).not.toMatch(/0105556012341|0812345678|0899999999/);

      expect(
        redact({ accessToken: 'abc', id_doc_number: '1-1001-00012-34-5', bank: { accountNumber: '1234567890' }, note: 'id 1100100012345', date: '2027-01-01', bib: '1234', footprint: 'x', rows: [{ password: 'x' }] }),
      ).toEqual({ accessToken: '[ซ่อน]', id_doc_number: '••••2345', bank: { accountNumber: '••••7890' }, note: 'id 1100100012345', date: '2027-01-01', bib: '1234', footprint: 'x', rows: [{ password: '[ซ่อน]' }] });
    });
  });

  describe('users', () => {
    it('finds people by email or name and shows what they have on the platform', async () => {
      const ev = await orgEvent();
      const email = `findme-${randomUUID()}@runner.example`;
      const person = await login(ctx.app, email);
      await ctx.pool.query(`UPDATE users SET display_name = 'สมหญิง ค้นเจอ' WHERE id = $1`, [person.userId]);
      await addOrgMember(ctx.pool, ev.organizationId, email, 'finance');

      expect((await call(ctx.app, 'GET', '/v1/admin/users?q=findme', { token: person.token })).status).toBe(403);
      const byEmail = (await call(ctx.app, 'GET', `/v1/admin/users?q=${email.slice(0, 15)}`, { token: tokens.support.token })).body.items;
      expect(byEmail.map((u: { id: string }) => u.id)).toContain(person.userId);
      const byName = (await call(ctx.app, 'GET', `/v1/admin/users?q=${encodeURIComponent('ค้นเจอ')}`, { token: tokens.support.token })).body.items;
      expect(byName[0]).toMatchObject({ id: person.userId, email, platformRole: 'user', status: 'active', lastLoginAt: expect.any(String) });
      const staff = (await call(ctx.app, 'GET', '/v1/admin/users?role=staff', { token: tokens.support.token })).body.items;
      expect(staff.every((u: { platformRole: string }) => u.platformRole !== 'user')).toBe(true);

      const detail = (await call(ctx.app, 'GET', `/v1/admin/users/${person.userId}`, { token: tokens.support.token })).body;
      expect(detail).toMatchObject({
        email,
        self: false,
        registrations: { total: 0, active: 0 },
        orderCount: 0,
        teams: [{ id: ev.organizationId, role: 'finance', accepted: true }],
      });
      expect((await call(ctx.app, 'GET', `/v1/admin/users/${randomUUID()}`, { token: tokens.support.token })).status).toBe(404);
    });

    it('suspends an account so its sign-in stops working, and reactivates it', async () => {
      const person = await login(ctx.app);
      expect((await call(ctx.app, 'GET', '/v1/me/registrations', { token: person.token })).status).toBe(200);

      expect((await call(ctx.app, 'POST', `/v1/admin/users/${person.userId}/suspend`, { token: tokens.support.token, body: { reason: 'สแปม' } })).status).toBe(403);
      expect((await call(ctx.app, 'POST', `/v1/admin/users/${person.userId}/suspend`, { token: tokens.finance.token, body: { reason: 'สแปม' } })).status).toBe(403);
      expect((await call(ctx.app, 'POST', `/v1/admin/users/${person.userId}/suspend`, { token: tokens.admin.token, body: { reason: '' } })).status).toBe(422);
      const suspended = await call(ctx.app, 'POST', `/v1/admin/users/${person.userId}/suspend`, { token: tokens.admin.token, body: { reason: 'สแปม' } });
      expect(suspended.body).toMatchObject({ status: 'suspended', statusNote: 'สแปม' });
      expect((await call(ctx.app, 'GET', '/v1/me/registrations', { token: person.token })).status).toBe(401);
      expect((await call(ctx.app, 'POST', `/v1/admin/users/${person.userId}/suspend`, { token: tokens.admin.token, body: { reason: 'สแปม' } })).body.code).toBe('INVALID_STATUS');

      const back = await call(ctx.app, 'POST', `/v1/admin/users/${person.userId}/reactivate`, { token: tokens.admin.token });
      expect(back.body).toMatchObject({ status: 'active', statusNote: null });
      expect((await call(ctx.app, 'GET', '/v1/me/registrations', { token: person.token })).status).toBe(200);

      const audit = (await call(ctx.app, 'GET', `/v1/admin/audit?entityId=${person.userId}`, { token: tokens.support.token })).body.items;
      expect(audit.map((i: { action: string }) => i.action)).toEqual(['admin.user_reactivate', 'admin.user_suspend']);
      expect(audit[1]).toMatchObject({ organization: null, entityType: 'user', actor: { email: tokens.admin.email } });
    });

    it('lets only a superadmin suspend staff or change platform roles, never on their own account', async () => {
      const email = `newstaff-${randomUUID()}@kao.example`;
      const person = await login(ctx.app, email);
      const role = (token: string, userId: string, r: string) => call(ctx.app, 'PUT', `/v1/admin/users/${userId}/platform-role`, { token, body: { role: r } });

      expect((await role(tokens.admin.token, person.userId, 'support')).status).toBe(403);
      const promoted = await role(tokens.superadmin.token, person.userId, 'support');
      expect(promoted.body).toMatchObject({ platformRole: 'support' });
      expect((await call(ctx.app, 'GET', '/v1/admin/me', { token: person.token })).body.role).toBe('support');
      expect((await role(tokens.superadmin.token, person.userId, 'owner')).status).toBe(422);

      // Staff accounts are suspended by a superadmin only.
      expect((await call(ctx.app, 'POST', `/v1/admin/users/${person.userId}/suspend`, { token: tokens.admin.token, body: { reason: 'ลาออก' } })).status).toBe(403);
      expect((await call(ctx.app, 'POST', `/v1/admin/users/${person.userId}/suspend`, { token: tokens.superadmin.token, body: { reason: 'ลาออก' } })).status).toBe(200);
      expect((await call(ctx.app, 'GET', '/v1/admin/me', { token: person.token })).status).toBe(401);

      for (const self of ['admin', 'superadmin'] as const) {
        const me = tokens[self];
        expect((await call(ctx.app, 'POST', `/v1/admin/users/${me.userId}/suspend`, { token: me.token, body: { reason: 'x' } })).body.code).toBe('CANNOT_CHANGE_SELF');
      }
      expect((await role(tokens.superadmin.token, tokens.superadmin.userId, 'admin')).body.code).toBe('CANNOT_CHANGE_SELF');
      expect((await call(ctx.app, 'GET', `/v1/admin/users/${tokens.superadmin.userId}`, { token: tokens.superadmin.token })).body.self).toBe(true);
    });

    it('always keeps one active superadmin, even when two demote each other at once', async () => {
      // Only two superadmins on the platform for this test.
      const a = tokens.superadmin;
      const bEmail = `super-b-${randomUUID()}@kao.example`;
      await setPlatformRole(ctx.pool, bEmail, 'superadmin');
      const b = await login(ctx.app, bEmail);
      await ctx.pool.query(`UPDATE users SET platform_role = 'admin' WHERE platform_role = 'superadmin' AND id NOT IN ($1, $2)`, [a.userId, b.userId]);

      const results = await Promise.all([
        call(ctx.app, 'PUT', `/v1/admin/users/${b.userId}/platform-role`, { token: a.token, body: { role: 'admin' } }),
        call(ctx.app, 'PUT', `/v1/admin/users/${a.userId}/platform-role`, { token: b.token, body: { role: 'admin' } }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, expect.any(Number)]);
      const loser = results.find((r) => r.status !== 200)!;
      expect([403, 409]).toContain(loser.status);
      if (loser.status === 409) expect(loser.body.code).toBe('LAST_SUPERADMIN');
      const left = await ctx.pool.query(`SELECT id FROM users WHERE platform_role = 'superadmin' AND status = 'active'`);
      expect(left.rows).toHaveLength(1);

      // Whoever acts, the last one is not demoted or suspended (the routes also stop anyone changing themselves).
      const users = ctx.app.get(AdminUsersService);
      const last = left.rows[0].id as string;
      await expect(users.setRole(tokens.admin.userId, last, 'admin')).rejects.toMatchObject({ code: 'LAST_SUPERADMIN' });
      await expect(users.suspend(tokens.admin.userId, 'superadmin', last, 'x')).rejects.toMatchObject({ code: 'LAST_SUPERADMIN' });
      expect((await ctx.pool.query('SELECT platform_role, status FROM users WHERE id = $1', [last])).rows[0]).toEqual({ platform_role: 'superadmin', status: 'active' });
    });
  });
});
