import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { setPlatformRole } from '../db/fixtures';
import { bootApp, call, login, TestContext } from './helpers';

/** The runner site, the organiser backoffice and admin sign in separately: a token only opens the front it was issued for. */
describe('token audiences', () => {
  let ctx: TestContext;
  let email: string;

  beforeAll(async () => {
    ctx = await bootApp();
    // Platform staff, so a refusal below comes from the token's audience and not from the account's role.
    email = `staff-${randomUUID()}@kao.example`;
    await setPlatformRole(ctx.pool, email, 'superadmin');
  });
  afterAll(() => ctx.close());

  const statuses = async (token: string) => ({
    me: (await call(ctx.app, 'GET', '/v1/me/registrations', { token })).status,
    org: (await call(ctx.app, 'GET', '/v1/org', { token })).status,
    admin: (await call(ctx.app, 'GET', '/v1/admin/me', { token })).status,
    retention: (await call(ctx.app, 'GET', '/v1/admin/retention', { token })).status,
  });

  it('a runner-site sign-in reaches the runner endpoints only', async () => {
    const { token } = await login(ctx.app, email, 'site');
    expect(await statuses(token)).toEqual({ me: 200, org: 401, admin: 401, retention: 401 });
  });

  it('an organiser sign-in reaches the organiser backoffice but not admin', async () => {
    const { token } = await login(ctx.app, email, 'organizer');
    expect(await statuses(token)).toEqual({ me: 200, org: 200, admin: 401, retention: 401 });
  });

  it('an admin sign-in reaches admin but not the organiser backoffice', async () => {
    const { token } = await login(ctx.app, email, 'admin');
    expect(await statuses(token)).toEqual({ me: 200, org: 401, admin: 200, retention: 200 });
  });

  it('signing in without naming a front is a runner-site sign-in', async () => {
    const res = await call(ctx.app, 'POST', '/v1/dev/login', { body: { email } });
    expect(res.status).toBe(201);
    expect(await statuses(res.body.accessToken)).toMatchObject({ me: 200, org: 401, admin: 401 });
  });

  it('a token issued before audiences existed counts as a runner-site token', async () => {
    const userId = (await login(ctx.app, email)).userId;
    const token = await ctx.app.get(JwtService).signAsync({ sub: userId });
    expect(await statuses(token)).toMatchObject({ me: 200, org: 401, admin: 401 });
  });

  it('rejects an unknown front', async () => {
    const res = await call(ctx.app, 'POST', '/v1/dev/login', { body: { email, audience: 'backoffice' } });
    expect(res.status).toBe(422);
  });
});
