import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { Client, PoolClient } from 'pg';
import { z } from 'zod';
import { AppConfig, CONFIG } from '../../config';
import { DbService } from '../../db/db.service';
import { EMAIL_SENDER, EmailSender } from './email-sender';
import { EMAIL_CHANNEL } from './emails';
import { isTemplateKey, Locale, renderTemplate, TemplateKey, TemplateVars } from './templates';

const QUEUE = 'notifications';
const DELIVER = 'deliver-broadcast';
const SEND_DUE = 'send-due-broadcasts';
const BATCH = 200;
/** A transactional email that keeps failing is given up after this many tries, a little later each time. */
const MAX_ATTEMPTS = 5;
const RETRY_MINUTES = [1, 5, 15, 60];

/** Who a broadcast goes to: the same filters as the runner list. */
export const audienceSchema = z.object({
  raceId: z.string().uuid().nullable().default(null),
  status: z.enum(['confirmed', 'pending']).default('confirmed'),
  pickup: z.enum(['picked', 'not_picked']).nullable().default(null),
});
export type Audience = z.infer<typeof audienceSchema>;

/** Placeholders the organiser can put in the subject and message. */
export const PLACEHOLDERS = ['{ชื่อ}', '{บิบ}', '{ระยะ}', '{เวลาปล่อยตัว}'] as const;

export interface Recipient {
  registration_id: string;
  user_id: string | null;
  address: string | null;
  first_name: string;
  bib_number: string | null;
  race_code: string;
  start_at: Date | null;
}

const startTime = new Intl.DateTimeFormat('th-TH-u-ca-gregory', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Bangkok' });

/** Fills the placeholders for one runner; anything unknown stays as typed. */
export function render(text: string, r: Pick<Recipient, 'first_name' | 'bib_number' | 'race_code' | 'start_at'>): string {
  return text
    .replaceAll('{ชื่อ}', r.first_name)
    .replaceAll('{บิบ}', r.bib_number ?? '-')
    .replaceAll('{ระยะ}', r.race_code)
    .replaceAll('{เวลาปล่อยตัว}', r.start_at ? startTime.format(r.start_at) : '-');
}

/** Each registration matching the audience, with the email to reach it (the runner's, else the buyer's). */
export async function recipients(db: Pick<PoolClient, 'query'>, eventId: string, a: Audience): Promise<Recipient[]> {
  const params: unknown[] = [eventId, a.status];
  const where = ['r.event_id = $1', 'r.status = $2'];
  if (a.raceId) {
    params.push(a.raceId);
    where.push(`r.race_id = $${params.length}`);
  }
  if (a.pickup === 'picked') where.push('r.kit_picked_up_at IS NOT NULL');
  if (a.pickup === 'not_picked') where.push('r.kit_picked_up_at IS NULL');
  const { rows } = await db.query<Recipient>(
    `SELECT r.id AS registration_id, COALESCE(r.runner_user_id, o.buyer_user_id) AS user_id, COALESCE(r.email, o.buyer_email) AS address,
            COALESCE(r.first_name_th, initcap(r.first_name_en)) AS first_name, r.bib_number, ra.code AS race_code, ra.start_at
       FROM registrations r JOIN races ra ON ra.id = r.race_id LEFT JOIN orders o ON o.id = r.order_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.registration_no`,
    params,
  );
  return rows;
}

/**
 * Queues and delivers broadcast emails. With Redis the delivery runs on a BullMQ worker (and scheduled broadcasts are
 * picked up every 30 seconds); without it (tests, a bare local setup) it runs inline in the request.
 *
 * Transactional emails (see emails.ts) are rows queued inside the transaction of whatever they are about. A Postgres
 * LISTEN on EMAIL_CHANNEL wakes flush() right after that transaction commits, so the request never waits for the email
 * provider; the 30-second job also flushes, which picks up retries and anything queued while no API was listening.
 * Tests call flush() themselves.
 */
@Injectable()
export class NotificationsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(NotificationsService.name);
  private queue?: Queue;
  private worker?: Worker;
  private listener?: Client;
  private flushing?: Promise<number>;
  private flushAgain = false;
  private closed = false;
  private retryTimer?: NodeJS.Timeout;

  constructor(
    private readonly dbs: DbService,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.NODE_ENV === 'test') return;
    await this.listen();
    this.wake();
    if (!this.config.REDIS_URL) {
      // No job scheduler without Redis: retry failed sends from here instead.
      this.retryTimer = setInterval(() => this.wake(), 60_000);
      this.retryTimer.unref();
      return;
    }
    const connection = { url: this.config.REDIS_URL };
    this.queue = new Queue(QUEUE, { connection });
    await this.queue.upsertJobScheduler(SEND_DUE, { every: 30_000 }, { name: SEND_DUE });
    this.worker = new Worker(
      QUEUE,
      async (job) => {
        if (job.name === DELIVER) return { sent: await this.deliver(job.data.broadcastId as string) };
        if (job.name === SEND_DUE) return { started: await this.sendDue(), transactional: await this.flush() };
        return null;
      },
      { connection, concurrency: 2 },
    );
    this.worker.on('failed', (job, err) => this.logger.error(`job ${job?.name} failed: ${err.message}`));
  }

  async onApplicationShutdown(): Promise<void> {
    this.closed = true;
    clearInterval(this.retryTimer);
    await this.worker?.close();
    await this.queue?.close();
    await this.listener?.end().catch(() => undefined);
    await this.flushing?.catch(() => undefined);
  }

  /** Listens for committed transactional emails on a connection of its own, reconnecting if it drops. */
  private async listen(): Promise<void> {
    const client = new Client({ connectionString: this.config.DATABASE_URL });
    client.on('notification', () => this.wake());
    client.on('error', (err) => {
      this.logger.warn(`email listener lost its connection: ${err.message}`);
      this.listener = undefined;
      if (!this.closed) setTimeout(() => void this.listen().catch(() => undefined), 5_000).unref();
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${EMAIL_CHANNEL}`);
      this.listener = client;
    } catch (err) {
      this.logger.warn(`could not listen for transactional emails, the 30-second job will send them: ${(err as Error).message}`);
      await client.end().catch(() => undefined);
    }
  }

  /** Starts a flush, or asks the running one to go round again so nothing committed meanwhile waits for the next job. */
  private wake(): void {
    if (this.closed) return;
    if (this.flushing) {
      this.flushAgain = true;
      return;
    }
    this.flushing = this.flush()
      .catch((err) => {
        this.logger.error(`sending transactional emails failed: ${(err as Error).message}`);
        return 0;
      })
      .finally(() => {
        this.flushing = undefined;
        if (this.flushAgain) {
          this.flushAgain = false;
          this.wake();
        }
      });
  }

  /**
   * Sends every transactional email that is due. Rows are locked while they are sent (FOR UPDATE SKIP LOCKED), so
   * several API instances flushing at once never send the same email twice. Returns how many were sent.
   */
  async flush(): Promise<number> {
    let sent = 0;
    for (;;) {
      const batch = await this.dbs.transaction(async (_tx, client) => {
        const { rows } = await client.query<{ id: string; recipient: string; template_key: string; attempts: number; payload: { locale?: Locale; vars?: unknown } }>(
          `SELECT id, recipient, template_key, attempts, payload FROM notifications
            WHERE status = 'queued' AND broadcast_id IS NULL AND channel = 'email'
              AND (next_attempt_at IS NULL OR next_attempt_at <= now())
            ORDER BY created_at LIMIT 50
            FOR UPDATE SKIP LOCKED`,
        );
        for (const n of rows) {
          try {
            if (!isTemplateKey(n.template_key)) throw new Error(`unknown template ${n.template_key}`);
            const email = renderTemplate(n.template_key as TemplateKey, n.payload.vars as TemplateVars[TemplateKey], n.payload.locale === 'en' ? 'en' : 'th', this.config.PUBLIC_WEB_URL);
            const messageId = await this.email.send({ to: n.recipient, ...email });
            await client.query(`UPDATE notifications SET status = 'sent', provider_msg_id = $2, attempts = attempts + 1, sent_at = now(), last_error = NULL WHERE id = $1`, [n.id, messageId]);
            sent += 1;
          } catch (err) {
            const attempts = n.attempts + 1;
            const retryIn = RETRY_MINUTES[attempts - 1];
            await client.query(
              `UPDATE notifications SET status = $2, attempts = $3, last_error = $4, next_attempt_at = now() + make_interval(mins => $5) WHERE id = $1`,
              [n.id, attempts >= MAX_ATTEMPTS ? 'failed' : 'queued', attempts, (err as Error).message, retryIn ?? 0],
            );
          }
        }
        return rows.length;
      });
      if (batch < 50) return sent;
    }
  }

  /**
   * Turns a draft or due scheduled broadcast into one queued email per reachable runner, then starts delivery.
   * Returns false when the broadcast is not in a state that can be sent (someone else already started it).
   */
  async start(broadcastId: string): Promise<boolean> {
    const started = await this.dbs.transaction(async (_tx, client) => {
      const { rows } = await client.query(
        `SELECT * FROM broadcasts WHERE id = $1 AND status IN ('draft', 'scheduled') FOR UPDATE`,
        [broadcastId],
      );
      const b = rows[0];
      if (!b) return false;
      const list = (await recipients(client, b.event_id, audienceSchema.parse(b.audience_filter))).filter((r) => r.address);
      for (const r of list) {
        await client.query(
          `INSERT INTO notifications (user_id, registration_id, broadcast_id, channel, template_key, recipient, payload, dedupe_key)
           VALUES ($1, $2, $3, 'email', 'broadcast', $4, $5, $6) ON CONFLICT (dedupe_key) DO NOTHING`,
          [r.user_id, r.registration_id, broadcastId, r.address, JSON.stringify({ subject: render(b.subject ?? '', r), text: render(b.body, r) }),
            `broadcast:${broadcastId}:${r.registration_id}:email`],
        );
      }
      await client.query(`UPDATE broadcasts SET status = 'sending', recipient_count = $2, scheduled_at = COALESCE(scheduled_at, now()) WHERE id = $1`, [
        broadcastId, list.length,
      ]);
      return true;
    });
    if (!started) return false;
    try {
      if (!this.queue) throw new Error('no queue');
      // BullMQ refuses ':' in custom job ids. One delivery job per broadcast.
      await this.queue.add(DELIVER, { broadcastId }, { jobId: `${DELIVER}-${broadcastId}`, removeOnComplete: true });
    } catch (err) {
      // Without a queue (or if Redis is down) deliver here, so emails already queued in the database are not left behind.
      if (this.queue) this.logger.warn(`queueing broadcast ${broadcastId} failed, delivering inline: ${(err as Error).message}`);
      await this.deliver(broadcastId);
    }
    return true;
  }

  /** Sends the broadcast's queued emails in batches and marks the broadcast sent when none are left. */
  async deliver(broadcastId: string): Promise<number> {
    let sent = 0;
    for (;;) {
      const { rows } = await this.dbs.pool.query<{ id: string; recipient: string; payload: { subject: string; text: string } }>(
        `SELECT id, recipient, payload FROM notifications WHERE broadcast_id = $1 AND status = 'queued' ORDER BY created_at LIMIT ${BATCH}`,
        [broadcastId],
      );
      if (rows.length === 0) break;
      for (const n of rows) {
        try {
          const messageId = await this.email.send({ to: n.recipient, subject: n.payload.subject, text: n.payload.text });
          await this.dbs.pool.query(`UPDATE notifications SET status = 'sent', provider_msg_id = $2, attempts = attempts + 1, sent_at = now() WHERE id = $1`, [n.id, messageId]);
          sent += 1;
        } catch (err) {
          await this.dbs.pool.query(`UPDATE notifications SET status = 'failed', attempts = attempts + 1, last_error = $2 WHERE id = $1`, [n.id, (err as Error).message]);
        }
      }
    }
    await this.dbs.pool.query(
      `UPDATE broadcasts b SET status = 'sent', sent_at = COALESCE(sent_at, now()),
              sent_count = (SELECT count(*) FROM notifications n WHERE n.broadcast_id = b.id AND n.status = 'sent'),
              failed_count = (SELECT count(*) FROM notifications n WHERE n.broadcast_id = b.id AND n.status = 'failed')
        WHERE b.id = $1 AND b.status = 'sending'`,
      [broadcastId],
    );
    return sent;
  }

  /**
   * Starts every scheduled broadcast whose time has come, and finishes any broadcast whose emails have sat queued for
   * five minutes (a worker that stopped mid-way). Returns how many broadcasts it started.
   */
  async sendDue(): Promise<number> {
    const { rows } = await this.dbs.pool.query<{ id: string }>(`SELECT id FROM broadcasts WHERE status = 'scheduled' AND scheduled_at <= now() ORDER BY scheduled_at`);
    let started = 0;
    for (const r of rows) if (await this.start(r.id)) started += 1;
    const stuck = await this.dbs.pool.query<{ broadcast_id: string }>(
      `SELECT DISTINCT n.broadcast_id FROM notifications n JOIN broadcasts b ON b.id = n.broadcast_id
        WHERE n.status = 'queued' AND b.status = 'sending' AND n.created_at < now() - interval '5 minutes'`,
    );
    for (const s of stuck.rows) await this.deliver(s.broadcast_id);
    return started;
  }

  /** A single email to one address, e.g. a test of a draft sent to the organiser themselves. */
  async sendNow(to: string, subject: string, text: string, userId: string | null, templateKey: string): Promise<void> {
    const messageId = await this.email.send({ to, subject, text });
    await this.dbs.pool.query(
      `INSERT INTO notifications (user_id, channel, template_key, recipient, payload, status, provider_msg_id, attempts, sent_at)
       VALUES ($1, 'email', $2, $3, $4, 'sent', $5, 1, now())`,
      [userId, templateKey, to, JSON.stringify({ subject, text }), messageId],
    );
  }
}
