import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { AppConfig, CONFIG } from '../../config';
import { safeEqual } from '../../common/crypto';
import { ProblemException, problems } from '../../common/problem';
import { RedisService } from '../../common/redis.service';
import { DbService } from '../../db/db.service';
import { MemoryQueueStore, QueueStore, RedisQueueStore } from './queue-store';

export interface QueueStatus {
  eventId: string;
  status: 'not_required' | 'waiting' | 'admitted' | 'not_joined';
  /** 1 = next to be let in. */
  position: number | null;
  waiting: number;
  admitPerMinute: number;
  estimatedWaitSeconds: number | null;
  opensAt: Date | null;
  admission: { token: string; expiresAt: Date } | null;
}

interface EventQueueSettings {
  id: string;
  status: string;
  use_waiting_room: boolean;
  queue_admit_per_minute: number;
  registration_opens_at: Date | null;
  registration_closes_at: Date | null;
}

/** Event settings are read on every poll; a few seconds of staleness spares the database during a rush. */
const SETTINGS_CACHE_MS = 3000;

/**
 * Waiting room for high-demand events (`events.use_waiting_room`). Runners join a Redis sorted set scored by a
 * per-event counter, so the order is exactly the order of arrival and a position is one ZRANK away: the polling of
 * thousands of waiting runners never touches Postgres beyond a cached settings read. A job lets them in batches
 * at `queue_admit_per_minute`; an admitted runner gets a signed token, bound to them and the event, that
 * `POST /v1/checkout/sessions` requires. Checking it needs no Redis, so checkout itself does not depend on the queue.
 * Without Redis (development only) the queue is kept in memory.
 */
@Injectable()
export class WaitingRoomService {
  private readonly logger = new Logger(WaitingRoomService.name);
  private readonly tokenKey: Buffer;
  private readonly settingsCache = new Map<string, { at: number; value: EventQueueSettings | undefined }>();
  private readonly store?: QueueStore;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly dbs: DbService,
    redis: RedisService,
  ) {
    this.tokenKey = createHmac('sha256', config.JWT_SECRET).update('kao waiting room token v1').digest();
    // Several production instances each with a queue of their own would let people in out of order.
    if (redis.client) this.store = new RedisQueueStore(redis);
    else if (config.NODE_ENV !== 'production') this.store = new MemoryQueueStore();
  }

  get available(): boolean {
    return Boolean(this.store);
  }

  async join(userId: string, eventId: string): Promise<QueueStatus> {
    const e = await this.settings(eventId);
    if (!e.use_waiting_room) return this.notRequired(e);
    if (e.status !== 'published' || (e.registration_closes_at && new Date() >= e.registration_closes_at)) {
      throw new ProblemException(409, 'REGISTRATION_CLOSED', 'Registration is not open for this event');
    }
    const res = await this.queues().join(eventId, userId, Date.now());
    if ('admittedUntil' in res) return this.admitted(e, userId, res.admittedUntil, 0);
    return this.waiting(e, res.rank + 1, res.size);
  }

  async status(userId: string, eventId: string): Promise<QueueStatus> {
    const e = await this.settings(eventId);
    if (!e.use_waiting_room) return this.notRequired(e);
    const { admittedUntil, rank, size } = await this.queues().status(eventId, userId, Date.now());
    if (admittedUntil !== null) return this.admitted(e, userId, admittedUntil, size);
    if (rank === null) return { ...this.waiting(e, null, size), status: 'not_joined' };
    return this.waiting(e, rank + 1, size);
  }

  /**
   * One tick of the admission job: lets the next runners into every event with a queue, at its rate.
   * Without anyone queueing this is a single SMEMBERS.
   */
  async admitDue(): Promise<number> {
    if (!this.store) return 0;
    const active = await this.store.activeEvents();
    if (active.length === 0) return 0;
    const { rows } = await this.dbs.pool.query<EventQueueSettings>(
      `SELECT id, status, use_waiting_room, queue_admit_per_minute, registration_opens_at, registration_closes_at FROM events WHERE id = ANY($1::uuid[])`,
      [active],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    let total = 0;
    for (const eventId of active) {
      const e = byId.get(eventId);
      if (!e || !e.use_waiting_room) {
        // Turned off: everyone left in it can go straight to checkout now, so the queue is dropped.
        await this.store.drop(eventId);
        continue;
      }
      if (e.registration_opens_at && new Date() < e.registration_opens_at) continue;
      total += await this.admit(e);
    }
    return total;
  }

  /** Lets in the next `count` runners right away (development tools and tests). */
  async admitNow(eventId: string, count: number): Promise<number> {
    return this.admit(await this.settings(eventId, true), count);
  }

  /** Throws unless `token` admits this runner to this event's checkout right now. */
  verifyToken(token: string | undefined, eventId: string, userId: string): void {
    const required = () => new ProblemException(403, 'QUEUE_REQUIRED', 'Join the queue for this event before registering');
    if (!token) throw required();
    const [payload, mac] = token.split('.');
    if (!payload || !mac || !safeEqual(mac, this.mac(payload))) throw required();
    let claims: { e?: string; u?: string; x?: number };
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      throw required();
    }
    if (claims.e !== eventId || claims.u !== userId || typeof claims.x !== 'number') throw required();
    if (claims.x <= Date.now()) {
      throw new ProblemException(403, 'QUEUE_TOKEN_EXPIRED', 'Your turn to register has run out. Join the queue again.');
    }
  }

  private async admit(e: EventQueueSettings, count?: number): Promise<number> {
    const admitted = await this.queues().admit(e.id, {
      now: Date.now(),
      intervalMs: 60_000 / e.queue_admit_per_minute,
      maxBurstMs: this.config.WAITING_ROOM_TICK_SECONDS * 2000,
      ttlMs: this.config.WAITING_ROOM_TOKEN_MINUTES * 60_000,
      count,
    });
    if (admitted > 0) this.logger.log(`event ${e.id}: admitted ${admitted}`);
    return admitted;
  }

  private waiting(e: EventQueueSettings, position: number | null, size: number): QueueStatus {
    const untilOpen = e.registration_opens_at ? Math.max(0, e.registration_opens_at.getTime() - Date.now()) : 0;
    return {
      eventId: e.id,
      status: 'waiting',
      position,
      waiting: size,
      admitPerMinute: e.queue_admit_per_minute,
      // Batches go out every tick, so even the first in line waits for the next one.
      estimatedWaitSeconds:
        position === null ? null : Math.ceil(untilOpen / 1000 + (position * 60) / e.queue_admit_per_minute + this.config.WAITING_ROOM_TICK_SECONDS),
      opensAt: e.registration_opens_at,
      admission: null,
    };
  }

  private admitted(e: EventQueueSettings, userId: string, expiresAt: number, size: number): QueueStatus {
    const payload = Buffer.from(JSON.stringify({ e: e.id, u: userId, x: expiresAt })).toString('base64url');
    return {
      eventId: e.id,
      status: 'admitted',
      position: null,
      waiting: size,
      admitPerMinute: e.queue_admit_per_minute,
      estimatedWaitSeconds: 0,
      opensAt: e.registration_opens_at,
      admission: { token: `${payload}.${this.mac(payload)}`, expiresAt: new Date(expiresAt) },
    };
  }

  private notRequired(e: EventQueueSettings): QueueStatus {
    return {
      eventId: e.id, status: 'not_required', position: null, waiting: 0, admitPerMinute: e.queue_admit_per_minute,
      estimatedWaitSeconds: 0, opensAt: e.registration_opens_at, admission: null,
    };
  }

  private async settings(eventId: string, fresh = false): Promise<EventQueueSettings> {
    const cached = this.settingsCache.get(eventId);
    let value = cached && !fresh && Date.now() - cached.at < SETTINGS_CACHE_MS ? cached.value : undefined;
    if (!value) {
      const { rows } = await this.dbs.pool.query<EventQueueSettings>(
        `SELECT id, status, use_waiting_room, queue_admit_per_minute, registration_opens_at, registration_closes_at
           FROM events WHERE id = $1 AND status IN ('published', 'closed')`,
        [eventId],
      );
      value = rows[0];
      if (this.settingsCache.size > 1000) this.settingsCache.clear();
      this.settingsCache.set(eventId, { at: Date.now(), value });
    }
    if (!value) throw problems.notFound('Event');
    return value;
  }

  private queues(): QueueStore {
    if (!this.store) throw new ProblemException(503, 'QUEUE_UNAVAILABLE', 'The waiting room is not available right now');
    return this.store;
  }

  private mac(payload: string): string {
    return createHmac('sha256', this.tokenKey).update(payload).digest('base64url');
  }
}
