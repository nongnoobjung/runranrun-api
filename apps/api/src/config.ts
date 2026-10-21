import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_SIZE: z.coerce.number().int().positive().default(20),
  REDIS_URL: z.string().url().optional(),
  /** Prepended to the rate limit and waiting room keys, so environments can share one Redis. */
  REDIS_KEY_PREFIX: z.string().default('kao:'),
  JWT_SECRET: z.string().min(32),
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  /** 32-byte key, base64. Encrypts ID card / passport numbers at rest. */
  PII_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64'),
  /** Separate key for the lookup hash so the hash cannot be reversed with the encryption key. */
  PII_HASH_KEY: z.string().min(32),
  /** Fee charged to the runner on top of the order, in basis points (200 = 2%). */
  RUNNER_FEE_BPS: z.coerce.number().int().min(0).max(1000).default(200),
  PAYMENT_GATEWAY: z.enum(['fake', 'omise']).default('fake'),
  FAKE_GATEWAY_SECRET: z.string().default('fake-gateway-dev-secret'),
  OMISE_PUBLIC_KEY: z.string().optional(),
  OMISE_SECRET_KEY: z.string().optional(),
  PUBLIC_WEB_URL: z.string().url().default('http://localhost:3000'),
  /** How long a waitlist offer holds a place for the runner before it passes to the next in line. */
  WAITLIST_OFFER_HOURS: z.coerce.number().positive().max(168).default(24),
  RATE_LIMIT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Overrides of the default limits, e.g. `checkout.user=10/60,public.ip=1200/60` (requests per seconds). */
  RATE_LIMITS: z
    .string()
    .default('')
    .transform((v, ctx) => {
      const out: Record<string, { limit: number; windowSeconds: number }> = {};
      for (const part of v.split(',').map((p) => p.trim()).filter(Boolean)) {
        const m = part.match(/^([a-z]+\.(?:ip|user))=(\d+)\/(\d+)$/);
        if (!m || Number(m[3]) < 1) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `bad entry "${part}", expected name.ip=limit/seconds` });
          continue;
        }
        out[m[1]] = { limit: Number(m[2]), windowSeconds: Number(m[3]) };
      }
      return out;
    }),
  /**
   * Shared with the web server. Only a request carrying it may say which client IP it is acting for
   * (x-kao-client-ip); everyone else is limited by the address the request came from.
   */
  WEB_PROXY_SECRET: z.string().min(16).optional(),
  /** How long an admitted runner has to start their checkout before the queue token runs out. */
  WAITING_ROOM_TOKEN_MINUTES: z.coerce.number().int().min(1).max(120).default(10),
  /** How often the admission job lets the next runners in. */
  WAITING_ROOM_TICK_SECONDS: z.coerce.number().int().min(1).max(60).default(5),
  /** Where private files (KYC documents) go. Only `local` for now; an S3/R2 driver can be added behind FileStorage. */
  STORAGE_DRIVER: z.enum(['local']).default('local'),
  /** Directory for the local driver, relative to the working directory unless absolute. */
  STORAGE_LOCAL_DIR: z.string().min(1).default('storage'),
  ENABLE_DEV_ENDPOINTS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const config = parsed.data;
  if (config.NODE_ENV === 'production' && config.ENABLE_DEV_ENDPOINTS) {
    throw new Error('ENABLE_DEV_ENDPOINTS must be false in production');
  }
  if (config.PAYMENT_GATEWAY === 'omise' && !config.OMISE_SECRET_KEY) {
    throw new Error('OMISE_SECRET_KEY is required when PAYMENT_GATEWAY=omise');
  }
  if (config.NODE_ENV === 'production' && config.PAYMENT_GATEWAY === 'fake') {
    throw new Error('PAYMENT_GATEWAY=fake is not allowed in production');
  }
  return config;
}

export const CONFIG = Symbol('CONFIG');
