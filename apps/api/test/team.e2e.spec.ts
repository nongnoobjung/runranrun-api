import { randomUUID } from 'node:crypto';
import { addOrgMember } from '../db/fixtures';
import { bootApp, call, login, TestContext, uniqueSlug } from './helpers';

type Role = 'owner' | 'admin' | 'finance' | 'staff' | 'viewer';

describe('organizer team', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await bootApp();
  });
  afterAll(() => ctx.close());

  /** A fresh organisation with one signed-in owner. */
  async function team() {
    const org = await ctx.pool.query<{ id: string }>(
      `INSERT INTO organizations (slug, name_th, status, contact_email) VALUES ($1, 'ทีมทดสอบ', 'active', 'team@org.example') RETURNING id`,
      [uniqueSlug('org')],
    );
    const orgId = org.rows[0].id;
    const owner = await member(orgId, 'owner');
    return { orgId, owner, base: `/v1/org/${orgId}/members` };
  }

  async function member(orgId: string, role: Role) {
    const email = `${role}-${randomUUID()}@org.example`;
    await addOrgMember(ctx.pool, orgId, email, role);
    const { token } = await login(ctx.app, email);
    const list = await call(ctx.app, 'GET', `/v1/org/${orgId}/members`, { token });
    const id = list.body.items.find((m: { email: string }) => m.email === email).id as string;
    return { email, token, id };
  }

  it('invites by email; the person joins when they sign in with that email', async () => {
    const t = await team();
    const email = `new-${randomUUID()}@Example.com`;
    const invited = await call(ctx.app, 'POST', t.base, { token: t.owner.token, body: { email, role: 'staff' } });
    expect(invited.status).toBe(201);
    expect(invited.body.items).toEqual([
      expect.objectContaining({ email: t.owner.email, role: 'owner', status: 'active', you: true }),
      expect.objectContaining({ email: email.toLowerCase(), role: 'staff', status: 'invited', you: false }),
    ]);

    const guest = await login(ctx.app, email.toLowerCase());
    expect((await call(ctx.app, 'GET', t.base, { token: guest.token })).status).toBe(404);
    const mine = await call(ctx.app, 'GET', '/v1/org', { token: guest.token });
    expect(mine.body.items).toEqual([expect.objectContaining({ id: t.orgId, role: 'staff' })]);

    const list = await call(ctx.app, 'GET', t.base, { token: guest.token });
    expect(list.body.items[1]).toEqual(expect.objectContaining({ email: email.toLowerCase(), status: 'active', you: true }));

    const audit = await ctx.pool.query(`SELECT action FROM audit_logs WHERE organization_id = $1 ORDER BY id`, [t.orgId]);
    expect(audit.rows.map((r) => r.action)).toEqual(['member.invite', 'member.accept']);
  });

  it('refuses a second invitation and inviting someone already in the team', async () => {
    const t = await team();
    const email = `twice-${randomUUID()}@org.example`;
    expect((await call(ctx.app, 'POST', t.base, { token: t.owner.token, body: { email, role: 'viewer' } })).status).toBe(201);
    const again = await call(ctx.app, 'POST', t.base, { token: t.owner.token, body: { email: email.toUpperCase(), role: 'admin' } });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_INVITED');

    const existing = await call(ctx.app, 'POST', t.base, { token: t.owner.token, body: { email: t.owner.email, role: 'admin' } });
    expect(existing.status).toBe(409);
    expect(existing.body.code).toBe('ALREADY_MEMBER');

    const bad = await call(ctx.app, 'POST', t.base, { token: t.owner.token, body: { email: 'not-an-email', role: 'boss' } });
    expect(bad.status).toBe(422);
  });

  it('lets only owners change the team; everyone in it can see it', async () => {
    const t = await team();
    const admin = await member(t.orgId, 'admin');
    const outsider = await login(ctx.app);
    expect((await call(ctx.app, 'GET', t.base, { token: outsider.token })).status).toBe(404);
    expect((await call(ctx.app, 'GET', t.base, { token: admin.token })).status).toBe(200);
    expect((await call(ctx.app, 'POST', t.base, { token: admin.token, body: { email: 'x@org.example', role: 'staff' } })).status).toBe(403);
    expect((await call(ctx.app, 'PATCH', `${t.base}/${admin.id}`, { token: admin.token, body: { role: 'owner' } })).status).toBe(403);
    expect((await call(ctx.app, 'DELETE', `${t.base}/${t.owner.id}`, { token: admin.token })).status).toBe(403);
  });

  it('changes roles and removes members, but never the last owner', async () => {
    const t = await team();
    const finance = await member(t.orgId, 'finance');

    const changed = await call(ctx.app, 'PATCH', `${t.base}/${finance.id}`, { token: t.owner.token, body: { role: 'admin' } });
    expect(changed.status).toBe(200);
    expect(changed.body.items.find((m: { id: string }) => m.id === finance.id).role).toBe('admin');
    // The new role applies straight away.
    expect((await call(ctx.app, 'GET', `/v1/org/${t.orgId}/events`, { token: finance.token })).status).toBe(200);

    const demote = await call(ctx.app, 'PATCH', `${t.base}/${t.owner.id}`, { token: t.owner.token, body: { role: 'admin' } });
    expect(demote.status).toBe(409);
    expect(demote.body.code).toBe('LAST_OWNER');
    expect((await call(ctx.app, 'DELETE', `${t.base}/${t.owner.id}`, { token: t.owner.token })).body.code).toBe('LAST_OWNER');

    const removed = await call(ctx.app, 'DELETE', `${t.base}/${finance.id}`, { token: t.owner.token });
    expect(removed.status).toBe(200);
    expect(removed.body.items.map((m: { id: string }) => m.id)).toEqual([t.owner.id]);
    expect((await call(ctx.app, 'GET', t.base, { token: finance.token })).status).toBe(404);

    const audit = await ctx.pool.query(`SELECT action, before_data, after_data FROM audit_logs WHERE organization_id = $1 AND action LIKE 'member.%' ORDER BY id`, [t.orgId]);
    expect(audit.rows).toEqual([
      expect.objectContaining({ action: 'member.role', before_data: { role: 'finance' }, after_data: { role: 'admin' } }),
      expect.objectContaining({ action: 'member.remove' }),
    ]);
  });

  it('keeps one owner when two owners demote each other at the same time', async () => {
    const t = await team();
    const second = await member(t.orgId, 'owner');
    const [a, b] = await Promise.all([
      call(ctx.app, 'PATCH', `${t.base}/${second.id}`, { token: t.owner.token, body: { role: 'viewer' } }),
      call(ctx.app, 'PATCH', `${t.base}/${t.owner.id}`, { token: second.token, body: { role: 'viewer' } }),
    ]);
    // The loser is refused either by the owner lock (409) or, if it arrives after the winner commits,
    // because its caller is no longer an owner (403).
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(200);
    expect([403, 409]).toContain(statuses[1]);
    const owners = await ctx.pool.query(`SELECT count(*)::int AS n FROM org_members WHERE organization_id = $1 AND role = 'owner'`, [t.orgId]);
    expect(owners.rows[0].n).toBe(1);
  });

  it('withdraws an invitation before it is accepted', async () => {
    const t = await team();
    const email = `maybe-${randomUUID()}@org.example`;
    const invited = await call(ctx.app, 'POST', t.base, { token: t.owner.token, body: { email, role: 'staff' } });
    const inviteId = invited.body.items.find((m: { email: string }) => m.email === email).id;
    expect((await call(ctx.app, 'DELETE', `${t.base}/${inviteId}`, { token: t.owner.token })).status).toBe(200);

    const guest = await login(ctx.app, email);
    expect((await call(ctx.app, 'GET', '/v1/org', { token: guest.token })).body.items).toEqual([]);
    expect((await call(ctx.app, 'DELETE', `${t.base}/${inviteId}`, { token: t.owner.token })).status).toBe(404);
  });
});
