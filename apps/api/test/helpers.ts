import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createApp } from '../src/app.factory';
import { AppConfig, loadConfig } from '../src/config';
import { DbService } from '../src/db/db.service';
import { createEvent, EventFixture } from '../db/fixtures';
import { FAKE_SIGNATURE_HEADER, fakeChargeCompleteBody, signFakeWebhook } from '../src/modules/payments/fake.gateway';
import { PaymentGateway } from '../src/modules/payments/gateway';

export const FAKE_SECRET = 'test-fake-gateway-secret';

export function testConfig(overrides: Partial<Record<string, string>> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_POOL_SIZE: '30',
    JWT_SECRET: 'test-jwt-secret-that-is-long-enough-0123456789',
    PII_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    PII_HASH_KEY: 'test-pii-hash-key-that-is-long-enough-0123',
    RUNNER_FEE_BPS: '200',
    PAYMENT_GATEWAY: 'fake',
    FAKE_GATEWAY_SECRET: FAKE_SECRET,
    ENABLE_DEV_ENDPOINTS: 'true',
    ...overrides,
  });
}

export interface TestContext {
  app: NestFastifyApplication;
  pool: Pool;
  close(): Promise<void>;
}

export async function bootApp(overrides: { gateway?: PaymentGateway } = {}): Promise<TestContext> {
  const app = await createApp(testConfig(), overrides);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const pool = app.get(DbService).pool;
  return { app, pool, close: () => app.close() };
}

export interface Res<T = any> {
  status: number;
  body: T;
}

export async function call<T = any>(
  app: NestFastifyApplication,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {},
): Promise<Res<T>> {
  const res = await app.inject({
    method,
    url,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined || opts.raw ? { 'content-type': 'application/json' } : {}),
      ...opts.headers,
    },
    payload: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
}

export async function login(app: NestFastifyApplication, email = `runner-${randomUUID()}@example.com`): Promise<{ token: string; userId: string }> {
  const res = await call(app, 'POST', '/v1/dev/login', { body: { email } });
  if (res.status !== 201) throw new Error(`login failed: ${JSON.stringify(res.body)}`);
  return { token: res.body.accessToken, userId: res.body.userId };
}

export function uniqueSlug(prefix = 'test-event'): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export async function seedEvent(pool: Pool, overrides: Partial<EventFixture> = {}) {
  const fixture: EventFixture = {
    slug: uniqueSlug(),
    nameTh: 'งานทดสอบ',
    eventDate: '2027-02-14',
    races: [
      {
        code: '21K', nameTh: 'ฮาล์ฟ', distanceKm: 21.1, capacity: 100, ageMin: 16, bibStart: 1, bibEnd: 100,
        tiers: [{ name: 'Early bird', priceSatang: 120_000, quota: 50 }, { name: 'ปกติ', priceSatang: 140_000 }],
      },
      {
        code: '10K', nameTh: 'มินิ', distanceKm: 10, capacity: 100, bibStart: 2001, bibEnd: 2100,
        tiers: [{ name: 'ปกติ', priceSatang: 90_000 }],
      },
    ],
    shirtSizes: [
      { label: 'S', chestIn: 36, stock: 100 },
      { label: 'M', chestIn: 38, stock: 100 },
    ],
    coupons: [{ code: 'RUN10', type: 'percent', value: 1000, usageLimit: 100, usagePerUser: 1 }],
    ...overrides,
  };
  const created = await createEvent(pool, fixture);
  return { ...created, slug: fixture.slug };
}

let idCounter = 0;
/** A plausible but fake 13-digit Thai ID, unique within the test run. */
export function fakeThaiId(): string {
  idCounter += 1;
  return `1${String(Date.now()).slice(-6)}${String(idCounter).padStart(6, '0')}`;
}

export function runner(overrides: Record<string, unknown> = {}) {
  return {
    firstNameTh: 'สมชาย',
    lastNameTh: 'ใจดี',
    firstNameEn: 'Somchai',
    lastNameEn: 'Jaidee',
    gender: 'male',
    birthDate: '1990-03-12',
    nationality: 'TH',
    idDocType: 'thai_id',
    idDocNumber: fakeThaiId(),
    emergencyName: 'สมหญิง ใจดี',
    emergencyPhone: '081-234-5678',
    ...overrides,
  };
}

export const buyer = { name: 'สมชาย ใจดี', email: 'somchai@example.com', phone: '081-234-5678' };

export async function sendFakeWebhook(app: NestFastifyApplication, chargeId: string, status: 'successful' | 'failed' | 'expired' = 'successful', eventId?: string) {
  const raw = fakeChargeCompleteBody(chargeId, status, eventId);
  return call(app, 'POST', '/v1/webhooks/payments/fake', {
    raw,
    headers: { [FAKE_SIGNATURE_HEADER]: signFakeWebhook(raw, FAKE_SECRET) },
  });
}

export async function raceCounters(pool: Pool, raceId: string) {
  const { rows } = await pool.query('SELECT capacity, reserved, sold FROM races WHERE id = $1', [raceId]);
  return rows[0] as { capacity: number; reserved: number; sold: number };
}
