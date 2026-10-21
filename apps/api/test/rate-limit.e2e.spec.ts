import { bootApp, call, clearTestRedis, login, seedEvent, TestContext, testRedisConfig } from './helpers';

const PROXY_SECRET = 'test-web-proxy-secret-0123456789';

const shared = Boolean(process.env.TEST_REDIS_URL);

describe(`rate limits (${shared ? 'two instances on Redis' : 'in memory'})`, () => {
  let ctx: TestContext;
  let other: TestContext;

  beforeAll(async () => {
    // With Redis, two instances as in production: the limits are shared between them. Without it, one instance.
    const config = {
      ...testRedisConfig(),
      RATE_LIMIT_ENABLED: 'true',
      RATE_LIMITS: 'public.ip=5/60,checkout.user=2/60,login.ip=1000/60',
      WEB_PROXY_SECRET: PROXY_SECRET,
    };
    ctx = await bootApp({ config });
    other = shared ? await bootApp({ config }) : ctx;
  });
  afterAll(async () => {
    await clearTestRedis(ctx.app);
    if (other !== ctx) await other.close();
    await ctx.close();
  });

  const fromClient = (ip: string) => ({ 'x-kao-client-ip': ip, 'x-kao-proxy-secret': PROXY_SECRET });

  it('answers 429 RATE_LIMITED with Retry-After once a client goes over, across instances', async () => {
    const headers = fromClient('203.0.113.10');
    for (let i = 0; i < 5; i++) {
      const res = await call(i % 2 ? other.app : ctx.app, 'GET', '/v1/events', { headers });
      expect(res.status).toBe(200);
    }
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/events', headers });
    expect(res.statusCode).toBe(429);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const retryAfter = Number(res.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(JSON.parse(res.body)).toMatchObject({ status: 429, code: 'RATE_LIMITED', retryAfterSeconds: retryAfter });

    // Another visitor behind the same web server has their own allowance.
    expect((await call(ctx.app, 'GET', '/v1/events', { headers: fromClient('203.0.113.11') })).status).toBe(200);
  });

  it('only believes the forwarded client IP from the web server', async () => {
    const forged = { 'x-kao-client-ip': '198.51.100.7', 'x-kao-proxy-secret': 'not-the-secret-at-all' };
    // Without the secret the header is ignored, so these all count against the caller's own address.
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await call(ctx.app, 'GET', '/v1/events/filters', { headers: { ...forged, 'x-kao-client-ip': `198.51.100.${i}` } })).status);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
  });

  it('limits checkout per user, whatever address they come from', async () => {
    const ev = await seedEvent(ctx.pool);
    const { token } = await login(ctx.app);
    const body = { eventId: ev.eventId, races: [{ raceId: ev.raceIds['10K'], quantity: 1 }] };
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await call(i % 2 ? other.app : ctx.app, 'POST', '/v1/checkout/sessions', { token, body, headers: fromClient(`192.0.2.${i}`) })).status);
    }
    expect(statuses).toEqual([201, 201, 429]);
    // Someone else is not affected.
    const { token: next } = await login(ctx.app);
    expect((await call(ctx.app, 'POST', '/v1/checkout/sessions', { token: next, body, headers: fromClient('192.0.2.1') })).status).toBe(201);
  });
});

describe('rate limits switched off', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await bootApp({ config: { RATE_LIMITS: 'public.ip=1/60' } });
  });
  afterAll(() => ctx.close());

  it('lets everything through', async () => {
    for (let i = 0; i < 3; i++) expect((await call(ctx.app, 'GET', '/v1/events')).status).toBe(200);
  });
});

describe('rate limits without Redis', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await bootApp({ config: { RATE_LIMIT_ENABLED: 'true', RATE_LIMITS: 'public.ip=2/60' } });
  });
  afterAll(() => ctx.close());

  it('counts in memory on a single instance', async () => {
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await call(ctx.app, 'GET', '/v1/events')).status);
    expect(statuses).toEqual([200, 200, 429]);
  });
});
