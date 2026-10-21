import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfig, CONFIG } from '../config';

/**
 * One shared connection for the rate limiter and the waiting room (BullMQ keeps its own). Absent without REDIS_URL.
 * Commands give up quickly so a Redis outage slows nothing down: callers decide whether to fail open or refuse.
 */
@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);
  readonly client?: Redis;
  readonly prefix: string;

  constructor(@Inject(CONFIG) config: AppConfig) {
    this.prefix = config.REDIS_KEY_PREFIX;
    if (!config.REDIS_URL) return;
    this.client = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, commandTimeout: 1000 });
    this.client.on('error', (err) => this.logger.warn(`redis: ${err.message}`));
  }

  key(...parts: string[]): string {
    return this.prefix + parts.join(':');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }
}
