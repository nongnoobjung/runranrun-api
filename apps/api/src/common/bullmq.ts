import type { ConnectionOptions } from 'bullmq';
import { AppConfig } from '../config';

/**
 * Connection and key prefix for every BullMQ queue and worker. Keys live under `${REDIS_KEY_PREFIX}bull:<queue>`, like the
 * rate limit and waiting room keys, so APIs sharing one Redis each take only their own jobs and run them against their own
 * database.
 */
export function bullOptions(config: Pick<AppConfig, 'REDIS_URL' | 'REDIS_KEY_PREFIX'>): { connection: ConnectionOptions; prefix: string } {
  if (!config.REDIS_URL) throw new Error('BullMQ needs REDIS_URL');
  return { connection: { url: config.REDIS_URL }, prefix: `${config.REDIS_KEY_PREFIX}bull` };
}
