import { applyDecorators, CanActivate, ExecutionContext, Inject, Injectable, Logger, SetMetadata, UseGuards } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FastifyReply, FastifyRequest } from 'fastify';
import { isIP } from 'node:net';
import { AppConfig, CONFIG } from '../config';
import { AuthUser } from './auth';
import { safeEqual } from './crypto';
import { ProblemException } from './problem';
import { RedisService } from './redis.service';

interface Limit {
  limit: number;
  windowSeconds: number;
}

/**
 * Requests per window, per client IP and (when signed in) per user. Per-IP limits stay generous because mobile
 * networks in Thailand put many people behind one address; the per-user limits are the tight ones.
 * Each can be changed with RATE_LIMITS (see config).
 */
export const RATE_LIMIT_POLICIES = {
  login: { ip: { limit: 100, windowSeconds: 60 } },
  public: { ip: { limit: 600, windowSeconds: 60 } },
  queue: { ip: { limit: 600, windowSeconds: 60 }, user: { limit: 60, windowSeconds: 60 } },
  checkout: { ip: { limit: 120, windowSeconds: 60 }, user: { limit: 10, windowSeconds: 60 } },
  order: { ip: { limit: 120, windowSeconds: 60 }, user: { limit: 20, windowSeconds: 60 } },
  payment: { ip: { limit: 120, windowSeconds: 60 }, user: { limit: 20, windowSeconds: 60 } },
} satisfies Record<string, { ip: Limit; user?: Limit }>;

export type RateLimitPolicy = keyof typeof RATE_LIMIT_POLICIES;

export const CLIENT_IP_HEADER = 'x-kao-client-ip';
export const PROXY_SECRET_HEADER = 'x-kao-proxy-secret';

// Fixed window: the first hit starts the window, later hits only count. Returns the count and the window's time left.
const HIT_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {n, ttl}`;

/** Counts hits in Redis so every API instance shares the same limits; in memory when there is no Redis (development). */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);
  private readonly memory = new Map<string, { count: number; resetAt: number }>();

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly redis: RedisService,
  ) {}

  limitFor(policy: RateLimitPolicy, scope: 'ip' | 'user'): Limit | undefined {
    const defaults: { ip: Limit; user?: Limit } = RATE_LIMIT_POLICIES[policy];
    return this.config.RATE_LIMITS[`${policy}.${scope}`] ?? defaults[scope];
  }

  /** Counts one request; returns how long to wait (ms) when it is over the limit, or 0. */
  async hit(key: string, { limit, windowSeconds }: Limit): Promise<number> {
    const windowMs = windowSeconds * 1000;
    const { count, ttl } = await this.count(key, windowMs);
    return count > limit ? Math.max(ttl, 1) : 0;
  }

  private async count(key: string, windowMs: number): Promise<{ count: number; ttl: number }> {
    const client = this.redis.client;
    if (client) {
      try {
        const [count, ttl] = (await client.eval(HIT_SCRIPT, 1, this.redis.key('rl', key), windowMs)) as [number, number];
        return { count, ttl };
      } catch (err) {
        // Better to let a request through than to take checkout down with Redis.
        this.logger.warn(`rate limit skipped: ${(err as Error).message}`);
        return { count: 0, ttl: 0 };
      }
    }
    const now = Date.now();
    let entry = this.memory.get(key);
    if (!entry || entry.resetAt <= now) {
      if (this.memory.size > 50_000) for (const [k, v] of this.memory) if (v.resetAt <= now) this.memory.delete(k);
      entry = { count: 0, resetAt: now + windowMs };
      this.memory.set(key, entry);
    }
    entry.count += 1;
    return { count: entry.count, ttl: entry.resetAt - now };
  }

  /**
   * The browser never calls the API itself, so every request arrives from the web server. The web passes the
   * visitor's address along with the shared secret; without the secret the header is ignored.
   */
  clientIp(req: FastifyRequest): string {
    const secret = this.config.WEB_PROXY_SECRET;
    const given = req.headers[PROXY_SECRET_HEADER];
    const claimed = req.headers[CLIENT_IP_HEADER];
    if (secret && typeof given === 'string' && typeof claimed === 'string' && isIP(claimed) && safeEqual(given, secret)) return claimed;
    return req.ip;
  }
}

const POLICY_KEY = 'kao:rate-limit';

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly reflector: Reflector,
    private readonly limits: RateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.config.RATE_LIMIT_ENABLED) return true;
    const policy = this.reflector.get<RateLimitPolicy>(POLICY_KEY, context.getHandler());
    if (!policy) return true;
    const http = context.switchToHttp();
    const req = http.getRequest<FastifyRequest & { user?: AuthUser }>();

    const checks: [string, Limit][] = [];
    const ipLimit = this.limits.limitFor(policy, 'ip');
    if (ipLimit) checks.push([`${policy}:ip:${this.limits.clientIp(req)}`, ipLimit]);
    const userLimit = this.limits.limitFor(policy, 'user');
    if (userLimit && req.user) checks.push([`${policy}:user:${req.user.id}`, userLimit]);

    const waits = await Promise.all(checks.map(([key, limit]) => this.limits.hit(key, limit)));
    const waitMs = Math.max(0, ...waits);
    if (waitMs === 0) return true;
    const retryAfterSeconds = Math.ceil(waitMs / 1000);
    void http.getResponse<FastifyReply>().header('retry-after', String(retryAfterSeconds));
    throw new ProblemException(429, 'RATE_LIMITED', 'Too many requests', `Try again in ${retryAfterSeconds} seconds`, { retryAfterSeconds });
  }
}

/**
 * Limits a route by the named policy. Put it on the handler: guards on the controller (AuthGuard) run first,
 * so a signed-in user is known by then.
 */
export const RateLimit = (policy: RateLimitPolicy) => applyDecorators(SetMetadata(POLICY_KEY, policy), UseGuards(RateLimitGuard));
