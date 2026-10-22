import { NestFastifyApplication } from '@nestjs/platform-fastify';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { createApp } from '../src/app.factory';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { testConfig, testRedisConfig } from './helpers';

const redisUrl = process.env.TEST_REDIS_URL;

// Two APIs on one Redis (say dev and demo, each with its own database) must each run only their own jobs.
(redisUrl ? describe : describe.skip)('BullMQ queues on a shared Redis', () => {
  const apps: { app: NestFastifyApplication; prefix: string; delivered: string[] }[] = [];

  beforeAll(async () => {
    for (let i = 0; i < 2; i++) {
      const redis = testRedisConfig();
      // The workers only start outside NODE_ENV=test.
      const app = await createApp(testConfig({ ...redis, NODE_ENV: 'development' }));
      app.useLogger(['error']);
      const delivered: string[] = [];
      jest.spyOn(app.get(NotificationsService), 'deliver').mockImplementation(async (id) => {
        delivered.push(id);
        return 0;
      });
      await app.init();
      apps.push({ app, prefix: redis.REDIS_KEY_PREFIX, delivered });
    }
  });

  afterAll(async () => {
    for (const { app } of apps) await app.close();
    const redis = new Redis(redisUrl!);
    for (const { prefix } of apps) {
      const keys = await redis.keys(`${prefix}*`);
      if (keys.length) await redis.del(...keys);
    }
    await redis.quit();
  });

  it('keeps notification jobs under REDIS_KEY_PREFIX, where only that API picks them up', async () => {
    const [a, b] = apps;
    // What NotificationsService queues when a broadcast is sent, added under the first API's prefix.
    const queue = new Queue('notifications', { connection: { url: redisUrl! }, prefix: `${a.prefix}bull` });
    const ids = Array.from({ length: 10 }, () => randomUUID());
    try {
      for (const id of ids) await queue.add('deliver-broadcast', { broadcastId: id }, { jobId: `deliver-broadcast-${id}`, removeOnComplete: true });
      for (let waited = 0; a.delivered.length < ids.length && waited < 10_000; waited += 100) await new Promise((r) => setTimeout(r, 100));
    } finally {
      await queue.close();
    }
    expect(a.delivered.sort()).toEqual([...ids].sort());
    expect(b.delivered).toEqual([]);
  });
});
