import { RedisService } from '../src/common/redis.service';
import { DbService } from '../src/db/db.service';
import { CheckoutService } from '../src/modules/checkout/checkout.service';
import { OrgEventsService } from '../src/modules/org/org-events.service';
import { WaitingRoomService } from '../src/modules/waiting-room/waiting-room.service';
import { bootApp, call, clearTestRedis, login, seedEvent, TestContext, testConfig, testRedisConfig } from './helpers';

// On Redis when global-setup found one, otherwise on the in-memory store: the rules are the same.
describe(`waiting room (${process.env.TEST_REDIS_URL ? 'Redis' : 'in memory'})`, () => {
  let ctx: TestContext;
  let rooms: WaitingRoomService;

  beforeAll(async () => {
    ctx = await bootApp({ config: { ...testRedisConfig(), WAITING_ROOM_TOKEN_MINUTES: '10' } });
    rooms = ctx.app.get(WaitingRoomService);
  });
  afterAll(async () => {
    await clearTestRedis(ctx.app);
    await ctx.close();
  });

  async function queuedEvent(admitPerMinute = 60) {
    const ev = await seedEvent(ctx.pool);
    await ctx.pool.query('UPDATE events SET use_waiting_room = true, queue_admit_per_minute = $2 WHERE id = $1', [ev.eventId, admitPerMinute]);
    return ev;
  }

  const join = (token: string, eventId: string) => call(ctx.app, 'POST', '/v1/checkout/queue', { token, body: { eventId } });
  const status = (token: string, eventId: string) => call(ctx.app, 'GET', `/v1/checkout/queue/${eventId}`, { token });
  const checkout = (token: string, ev: { eventId: string; raceIds: Record<string, string> }, queueToken?: string) =>
    call(ctx.app, 'POST', '/v1/checkout/sessions', {
      token,
      headers: queueToken ? { 'x-queue-admission': queueToken } : {},
      body: { eventId: ev.eventId, races: [{ raceId: ev.raceIds['10K'], quantity: 1 }] },
    });

  it('needs no queue for an event without a waiting room', async () => {
    const ev = await seedEvent(ctx.pool);
    const { token } = await login(ctx.app);
    const res = await join(token, ev.eventId);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('not_required');
    expect((await checkout(token, ev)).status).toBe(201);
  });

  it('shows the event in its public details', async () => {
    const ev = await queuedEvent();
    const res = await call(ctx.app, 'GET', `/v1/events/${ev.slug}`);
    expect(res.body.policy.waitingRoom).toBe(true);
  });

  it('queues runners in order of arrival, shows their position and lets them in in batches', async () => {
    const ev = await queuedEvent(60);
    const runners = [];
    for (let i = 0; i < 3; i++) runners.push(await login(ctx.app));

    for (const [i, r] of runners.entries()) {
      const res = await join(r.token, ev.eventId);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: 'waiting', position: i + 1, waiting: i + 1, admission: null, admitPerMinute: 60 });
      expect(res.body.estimatedWaitSeconds).toBeGreaterThan(0);
    }
    // Joining again keeps the place.
    expect((await join(runners[0].token, ev.eventId)).body.position).toBe(1);
    expect((await status(runners[2].token, ev.eventId)).body).toMatchObject({ status: 'waiting', position: 3 });
    const stranger = await login(ctx.app);
    expect((await status(stranger.token, ev.eventId)).body).toMatchObject({ status: 'not_joined', position: null, waiting: 3 });

    expect(await rooms.admitNow(ev.eventId, 2)).toBe(2);
    const first = await status(runners[0].token, ev.eventId);
    expect(first.body.status).toBe('admitted');
    expect(typeof first.body.admission.token).toBe('string');
    expect(new Date(first.body.admission.expiresAt).getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect((await status(runners[1].token, ev.eventId)).body.status).toBe('admitted');
    expect((await status(runners[2].token, ev.eventId)).body).toMatchObject({ status: 'waiting', position: 1, waiting: 1 });
    // An admitted runner who joins again stays admitted.
    expect((await join(runners[0].token, ev.eventId)).body.status).toBe('admitted');
  });

  it('admits at the event rate on each tick of the job', async () => {
    // 600 a minute = one every 100 ms; the first tick may let in at most two ticks' worth (10 s).
    const ev = await queuedEvent(600);
    const runners = await Promise.all(Array.from({ length: 5 }, () => login(ctx.app)));
    for (const r of runners) await join(r.token, ev.eventId);
    await rooms.admitDue();
    const after = await Promise.all(runners.map((r) => status(r.token, ev.eventId)));
    // Only one tick's worth of time has passed since the first batch was due: a single place.
    expect(after.filter((r) => r.body.status === 'admitted')).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 350));
    await rooms.admitDue();
    const later = await Promise.all(runners.map((r) => status(r.token, ev.eventId)));
    expect(later.filter((r) => r.body.status === 'admitted').length).toBeGreaterThanOrEqual(4);
    expect(later[0].body.status).toBe('admitted');
  });

  it('does not admit anyone before registration opens', async () => {
    const ev = await seedEvent(ctx.pool, { opensAt: new Date(Date.now() + 3600_000) });
    await ctx.pool.query('UPDATE events SET use_waiting_room = true, queue_admit_per_minute = 600 WHERE id = $1', [ev.eventId]);
    const { token } = await login(ctx.app);
    const joined = await join(token, ev.eventId);
    expect(joined.body.status).toBe('waiting');
    expect(joined.body.estimatedWaitSeconds).toBeGreaterThan(3500);
    await rooms.admitDue();
    expect((await status(token, ev.eventId)).body.status).toBe('waiting');
  });

  it('requires a valid, unexpired token of the runner for checkout', async () => {
    const ev = await queuedEvent();
    const a = await login(ctx.app);
    const b = await login(ctx.app);

    const none = await checkout(a.token, ev);
    expect(none.status).toBe(403);
    expect(none.body.code).toBe('QUEUE_REQUIRED');
    expect((await checkout(a.token, ev, 'forged.token')).body.code).toBe('QUEUE_REQUIRED');

    await join(a.token, ev.eventId);
    await rooms.admitNow(ev.eventId, 1);
    const admission = (await status(a.token, ev.eventId)).body.admission.token as string;

    // Bound to the runner and the event.
    expect((await checkout(b.token, ev, admission)).body.code).toBe('QUEUE_REQUIRED');
    const other = await queuedEvent();
    expect((await checkout(a.token, other, admission)).body.code).toBe('QUEUE_REQUIRED');
    // Tampering with the claims breaks the signature.
    const [payload, mac] = admission.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const extended = Buffer.from(JSON.stringify({ ...claims, x: claims.x + 3600_000 })).toString('base64url');
    expect((await checkout(a.token, ev, `${extended}.${mac}`)).body.code).toBe('QUEUE_REQUIRED');

    const ok = await checkout(a.token, ev, admission);
    expect(ok.status).toBe(201);
    const saved = await ctx.pool.query('SELECT queue_token FROM checkout_sessions WHERE id = $1', [ok.body.id]);
    expect(saved.rows[0].queue_token).toBe(admission);
  });

  it('refuses an admission that has run out, and lets the runner queue again', async () => {
    const short = await bootApp({ config: { ...testRedisConfig(), WAITING_ROOM_TOKEN_MINUTES: '1' } });
    try {
      const shortRooms = short.app.get(WaitingRoomService);
      const ev = await queuedEvent();
      const { token } = await login(short.app);
      await call(short.app, 'POST', '/v1/checkout/queue', { token, body: { eventId: ev.eventId } });
      await shortRooms.admitNow(ev.eventId, 1);
      const admission = (await call(short.app, 'GET', `/v1/checkout/queue/${ev.eventId}`, { token })).body.admission;

      const realNow = Date.now;
      Date.now = () => realNow() + 61_000;
      try {
        const res = await call(short.app, 'POST', '/v1/checkout/sessions', {
          token,
          headers: { 'x-queue-admission': admission.token },
          body: { eventId: ev.eventId, races: [{ raceId: ev.raceIds['10K'], quantity: 1 }] },
        });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('QUEUE_TOKEN_EXPIRED');
        const again = await call(short.app, 'POST', '/v1/checkout/queue', { token, body: { eventId: ev.eventId } });
        expect(again.body).toMatchObject({ status: 'waiting', position: 1 });
      } finally {
        Date.now = realNow;
      }
    } finally {
      await clearTestRedis(short.app);
      await short.close();
    }
  });

  it('lets a waitlist offer skip the queue', async () => {
    const ev = await queuedEvent();
    const { userId } = await login(ctx.app);
    // The waitlist claim path: its place is already held for the runner.
    const created = await ctx.app.get(CheckoutService).create(userId, { eventId: ev.eventId, races: [{ raceId: ev.raceIds['10K'], quantity: 1 }], variants: [] }, { beforeReserve: async () => undefined });
    expect(created.status).toBe('active');
  });

  it('keeps one consistent order when many runners join at once', async () => {
    const ev = await queuedEvent(1000);
    const runners = await Promise.all(Array.from({ length: 60 }, () => login(ctx.app)));
    // Everyone joins at the same moment, some twice.
    const joins = await Promise.all([...runners, ...runners.slice(0, 20)].map((r) => join(r.token, ev.eventId)));
    expect(joins.every((r) => r.status === 201 && r.body.status === 'waiting')).toBe(true);

    const positions = await Promise.all(runners.map(async (r) => (await status(r.token, ev.eventId)).body.position as number));
    expect(new Set(positions).size).toBe(60);
    expect([...positions].sort((x, y) => x - y)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));

    // Batches go out from the front of that order.
    await rooms.admitNow(ev.eventId, 25);
    const after = await Promise.all(runners.map((r) => status(r.token, ev.eventId)));
    after.forEach((res, i) => {
      if (positions[i] <= 25) expect(res.body.status).toBe('admitted');
      else expect(res.body).toMatchObject({ status: 'waiting', position: positions[i] - 25 });
    });
  });

  it('drops the queue once the organiser turns the waiting room off', async () => {
    const ev = await queuedEvent();
    const { token } = await login(ctx.app);
    await join(token, ev.eventId);
    await ctx.pool.query('UPDATE events SET use_waiting_room = false WHERE id = $1', [ev.eventId]);
    await rooms.admitDue();
    // Turned on again later, the old queue is gone.
    await ctx.pool.query('UPDATE events SET use_waiting_room = true WHERE id = $1', [ev.eventId]);
    await new Promise((resolve) => setTimeout(resolve, 3100)); // past the settings cache
    expect((await status(token, ev.eventId)).body).toMatchObject({ status: 'not_joined', waiting: 0 });
  });

  it('lets organisers turn it on and set the rate', async () => {
    const owner = await login(ctx.app, 'organizer-wr@riverside.example');
    const org = await call(ctx.app, 'POST', '/v1/dev/organizations', { body: { nameTh: 'ทีมคิว', ownerEmail: 'organizer-wr@riverside.example', status: 'active' } });
    const created = await call(ctx.app, 'POST', `/v1/org/${org.body.id}/events`, { token: owner.token, body: { nameTh: 'งานคิวยาว', eventDate: '2027-05-01' } });
    expect(created.status).toBe(201);
    const base = `/v1/org/${org.body.id}/events/${created.body.id}`;
    const patched = await call(ctx.app, 'PATCH', base, { token: owner.token, body: { useWaitingRoom: true, queueAdmitPerMinute: 250 } });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ useWaitingRoom: true, queueAdmitPerMinute: 250 });
    expect((await call(ctx.app, 'PATCH', base, { token: owner.token, body: { queueAdmitPerMinute: 0 } })).status).toBe(422);
  });
});

describe('waiting room in production without Redis', () => {
  it('cannot be turned on, since each instance would keep a queue of its own', async () => {
    const config = { ...testConfig(), NODE_ENV: 'production' as const };
    const rooms = new WaitingRoomService(config, {} as DbService, new RedisService(config));
    expect(rooms.available).toBe(false);
    const events = new OrgEventsService({} as DbService, rooms);
    await expect(events.update('user', 'org', 'event', { useWaitingRoom: true })).rejects.toMatchObject({ status: 409, code: 'WAITING_ROOM_UNAVAILABLE' });
  });
});
