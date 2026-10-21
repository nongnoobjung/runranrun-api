import Redis from 'ioredis';
import { Client } from 'pg';
import { migrate } from '../db/migrate';

/**
 * Creates a throwaway database on the server in TEST_DATABASE_ADMIN_URL (default: local Postgres),
 * applies the real migrations and points the tests at it.
 */
export default async function globalSetup(): Promise<void> {
  const admin = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres@127.0.0.1:5432/postgres';
  const name = `kao_test_${Date.now()}_${process.pid}`;
  const client = new Client({ connectionString: admin });
  await client.connect();
  await client.query(`CREATE DATABASE ${name}`);
  await client.end();

  const url = new URL(admin);
  url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString();
  process.env.TEST_DATABASE_NAME = name;
  await migrate(process.env.DATABASE_URL, () => undefined);

  // The waiting room and shared rate limit tests use a real Redis when there is one (TEST_REDIS_URL, default the
  // local docker-compose one); without it they run on the in-memory stores.
  const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';
  const redis = new Redis(redisUrl, { lazyConnect: true, connectTimeout: 1000, maxRetriesPerRequest: 0, retryStrategy: () => null });
  redis.on('error', () => undefined);
  try {
    await redis.connect();
    await redis.ping();
    process.env.TEST_REDIS_URL = redisUrl;
  } catch {
    delete process.env.TEST_REDIS_URL;
    console.warn(`No Redis at ${redisUrl}: waiting room and rate limit tests use the in-memory stores`);
  } finally {
    redis.disconnect();
  }
}
