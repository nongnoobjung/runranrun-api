import { RedisService } from '../../common/redis.service';

export type JoinResult = { admittedUntil: number } | { rank: number; size: number };

export interface AdmitOptions {
  now: number;
  /** Time between two runners at the event's rate. */
  intervalMs: number;
  /** Lets in at most this much time's worth at once, e.g. after the job was down. */
  maxBurstMs: number;
  ttlMs: number;
  /** Exactly this many instead of by rate (development tools and tests). */
  count?: number;
}

/** Where an event's queue lives. Ranks are 0-based; an admission is remembered until it runs out. */
export interface QueueStore {
  /** Already admitted (and not run out) → when it runs out; otherwise joins at the back once. */
  join(eventId: string, userId: string, now: number): Promise<JoinResult>;
  status(eventId: string, userId: string, now: number): Promise<{ admittedUntil: number | null; rank: number | null; size: number }>;
  /** Lets the next runners in; returns how many. */
  admit(eventId: string, opts: AdmitOptions): Promise<number>;
  /** Events with someone waiting. */
  activeEvents(): Promise<string[]>;
  drop(eventId: string): Promise<void>;
}

/** Queue keys live this long after the last join, so a forgotten queue does not stay in Redis forever. */
const QUEUE_KEEP_MS = 3 * 24 * 3600_000;

// KEYS: queue, seq, admitted, active. ARGV: user, now, eventId, keepMs.
// Already admitted (and not run out) → {1, expiresAt}. Otherwise joins at the back once and → {0, rank, size}.
const JOIN_SCRIPT = `
local exp = redis.call('ZSCORE', KEYS[3], ARGV[1])
if exp then
  if tonumber(exp) > tonumber(ARGV[2]) then return {1, exp} end
  redis.call('ZREM', KEYS[3], ARGV[1])
end
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  redis.call('ZADD', KEYS[1], redis.call('INCR', KEYS[2]), ARGV[1])
  redis.call('SADD', KEYS[4], ARGV[3])
  redis.call('PEXPIRE', KEYS[1], ARGV[4])
  redis.call('PEXPIRE', KEYS[2], ARGV[4])
end
return {0, redis.call('ZRANK', KEYS[1], ARGV[1]), redis.call('ZCARD', KEYS[1])}`;

// KEYS: queue, admitted, last, active. ARGV: now, intervalMs, maxBurstMs, tokenTtlMs, eventId, count.
// count < 0 lets in as many as the rate allows since the last batch (at most maxBurstMs worth); otherwise exactly count.
const ADMIT_SCRIPT = `
local now = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
local n = tonumber(ARGV[6])
local last = nil
if n < 0 then
  local interval = tonumber(ARGV[2])
  last = tonumber(redis.call('GET', KEYS[3]) or (now - interval))
  if last < now - tonumber(ARGV[3]) then last = now - tonumber(ARGV[3]) end
  n = math.floor((now - last) / interval)
  if n <= 0 then return 0 end
  last = last + n * interval
end
local popped = redis.call('ZPOPMIN', KEYS[1], n)
local admitted = #popped / 2
if admitted > 0 then
  local exp = now + tonumber(ARGV[4])
  for i = 1, #popped, 2 do redis.call('ZADD', KEYS[2], exp, popped[i]) end
  redis.call('PEXPIRE', KEYS[2], ARGV[4])
end
if last then
  if admitted < n then last = now end
  redis.call('SET', KEYS[3], math.floor(last), 'PX', 3600000)
end
if redis.call('ZCARD', KEYS[1]) == 0 then redis.call('SREM', KEYS[4], ARGV[5]) end
return admitted`;

/**
 * A sorted set per event scored by a per-event counter: the order is exactly the order of arrival however many join
 * at once, and a position is one ZRANK away. Each step is one script, so instances never see a half-done change.
 */
export class RedisQueueStore implements QueueStore {
  constructor(private readonly redis: RedisService) {}

  async join(eventId: string, userId: string, now: number): Promise<JoinResult> {
    const k = this.keys(eventId);
    const res = (await this.client.eval(JOIN_SCRIPT, 4, k.queue, k.seq, k.admitted, k.active, userId, now, eventId, QUEUE_KEEP_MS)) as
      | [1, string]
      | [0, number, number];
    return res[0] === 1 ? { admittedUntil: Number(res[1]) } : { rank: res[1], size: res[2] };
  }

  async status(eventId: string, userId: string, now: number) {
    const k = this.keys(eventId);
    const replies = await this.client.multi().zscore(k.admitted, userId).zrank(k.queue, userId).zcard(k.queue).exec();
    const [exp, rank, size] = (replies ?? []).map(([err, value]) => {
      if (err) throw err;
      return value;
    }) as [string | null, number | null, number];
    return { admittedUntil: exp !== null && Number(exp) > now ? Number(exp) : null, rank, size };
  }

  async admit(eventId: string, o: AdmitOptions): Promise<number> {
    const k = this.keys(eventId);
    return (await this.client.eval(ADMIT_SCRIPT, 4, k.queue, k.admitted, k.last, k.active, o.now, o.intervalMs, o.maxBurstMs, o.ttlMs, eventId, o.count ?? -1)) as number;
  }

  activeEvents(): Promise<string[]> {
    return this.client.smembers(this.redis.key('wr', 'active'));
  }

  async drop(eventId: string): Promise<void> {
    const k = this.keys(eventId);
    await this.client.multi().del(k.queue, k.seq, k.last).srem(k.active, eventId).exec();
  }

  private get client() {
    return this.redis.client!;
  }

  private keys(eventId: string) {
    return {
      queue: this.redis.key('wr', eventId, 'queue'),
      seq: this.redis.key('wr', eventId, 'seq'),
      admitted: this.redis.key('wr', eventId, 'admitted'),
      last: this.redis.key('wr', eventId, 'last'),
      active: this.redis.key('wr', 'active'),
    };
  }
}

/** The same rules in this process, for development without Redis. Each instance would have its own queue. */
export class MemoryQueueStore implements QueueStore {
  private readonly queues = new Map<string, { waiting: Map<string, true>; admitted: Map<string, number>; last?: number }>();

  async join(eventId: string, userId: string, now: number): Promise<JoinResult> {
    const q = this.queue(eventId);
    const until = q.admitted.get(userId);
    if (until !== undefined && until > now) return { admittedUntil: until };
    q.admitted.delete(userId);
    // A Map keeps insertion order, which is the order of arrival.
    q.waiting.set(userId, true);
    return { rank: [...q.waiting.keys()].indexOf(userId), size: q.waiting.size };
  }

  async status(eventId: string, userId: string, now: number) {
    const q = this.queue(eventId);
    const until = q.admitted.get(userId);
    const rank = [...q.waiting.keys()].indexOf(userId);
    return { admittedUntil: until !== undefined && until > now ? until : null, rank: rank < 0 ? null : rank, size: q.waiting.size };
  }

  async admit(eventId: string, o: AdmitOptions): Promise<number> {
    const q = this.queue(eventId);
    for (const [user, until] of q.admitted) if (until <= o.now) q.admitted.delete(user);
    let n = o.count ?? -1;
    let last: number | undefined;
    if (n < 0) {
      last = Math.max(q.last ?? o.now - o.intervalMs, o.now - o.maxBurstMs);
      n = Math.floor((o.now - last) / o.intervalMs);
      if (n <= 0) return 0;
      last += n * o.intervalMs;
    }
    const popped = [...q.waiting.keys()].slice(0, n);
    for (const user of popped) {
      q.waiting.delete(user);
      q.admitted.set(user, o.now + o.ttlMs);
    }
    if (last !== undefined) q.last = popped.length < n ? o.now : Math.floor(last);
    return popped.length;
  }

  async activeEvents(): Promise<string[]> {
    return [...this.queues].filter(([, q]) => q.waiting.size > 0).map(([id]) => id);
  }

  async drop(eventId: string): Promise<void> {
    const q = this.queues.get(eventId);
    if (q) this.queues.set(eventId, { waiting: new Map(), admitted: q.admitted });
  }

  private queue(eventId: string) {
    let q = this.queues.get(eventId);
    if (!q) this.queues.set(eventId, (q = { waiting: new Map(), admitted: new Map() }));
    return q;
  }
}
