import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { ProblemException, problems } from '../../common/problem';
import { DbService } from '../../db/db.service';
import { Audience, audienceSchema, NotificationsService, recipients, render } from '../notifications/notifications.service';
import { writeAudit } from './org-access.service';

export const broadcastFieldsSchema = z.object({
  subject: z.string().trim().min(1).max(150),
  body: z.string().trim().min(1).max(2000),
  audience: audienceSchema,
});
export const createBroadcastSchema = broadcastFieldsSchema.extend({ audience: audienceSchema.default({}) });
export const previewSchema = z.object({
  audience: audienceSchema.default({}),
  subject: z.string().max(150).default(''),
  body: z.string().max(2000).default(''),
});
export const sendSchema = z.object({
  /** Send at this time instead of now; must be in the future. */
  scheduledAt: z.string().datetime({ offset: true }).nullable().default(null),
});

@Injectable()
export class OrgBroadcastsService {
  constructor(
    private readonly dbs: DbService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(eventId: string) {
    const { rows } = await this.dbs.pool.query(
      `SELECT b.*, b.channels::text[] AS channel_list, u.display_name, u.email AS created_by_email FROM broadcasts b LEFT JOIN users u ON u.id = b.created_by
        WHERE b.event_id = $1 ORDER BY (b.status = 'draft') DESC, COALESCE(b.sent_at, b.scheduled_at, b.created_at) DESC`,
      [eventId],
    );
    return { items: rows.map(view) };
  }

  /** How many runners the audience reaches, how many have no email, and the message as the first of them will see it. */
  async preview(eventId: string, input: z.infer<typeof previewSchema>) {
    const list = await recipients(this.dbs.pool, eventId, input.audience);
    const reachable = list.filter((r) => r.address);
    const first = reachable[0];
    return {
      count: reachable.length,
      withoutEmail: list.length - reachable.length,
      sample: first ? { to: first.address, subject: render(input.subject, first), body: render(input.body, first) } : null,
    };
  }

  async create(userId: string, orgId: string, eventId: string, input: z.infer<typeof createBroadcastSchema>) {
    const { rows } = await this.dbs.pool.query<{ id: string }>(
      `INSERT INTO broadcasts (event_id, channels, subject, body, audience_filter, created_by) VALUES ($1, '{email}', $2, $3, $4, $5) RETURNING id`,
      [eventId, input.subject, input.body, JSON.stringify(input.audience), userId],
    );
    await writeAudit(this.dbs.pool, { actorId: userId, organizationId: orgId, eventId, action: 'broadcast.create', entityType: 'broadcast', entityId: rows[0].id });
    return this.get(eventId, rows[0].id);
  }

  async update(userId: string, orgId: string, eventId: string, id: string, patch: Partial<z.infer<typeof broadcastFieldsSchema>>) {
    return this.dbs.transaction(async (_tx, client) => {
      await lockDraft(client, eventId, id);
      await client.query(
        `UPDATE broadcasts SET subject = COALESCE($2, subject), body = COALESCE($3, body), audience_filter = COALESCE($4, audience_filter) WHERE id = $1`,
        [id, patch.subject ?? null, patch.body ?? null, patch.audience ? JSON.stringify(patch.audience) : null],
      );
      await writeAudit(client, { actorId: userId, organizationId: orgId, eventId, action: 'broadcast.update', entityType: 'broadcast', entityId: id });
      return this.get(eventId, id, client);
    });
  }

  async remove(userId: string, orgId: string, eventId: string, id: string) {
    return this.dbs.transaction(async (_tx, client) => {
      await lockDraft(client, eventId, id);
      await client.query('DELETE FROM broadcasts WHERE id = $1', [id]);
      await writeAudit(client, { actorId: userId, organizationId: orgId, eventId, action: 'broadcast.delete', entityType: 'broadcast', entityId: id });
      return { id };
    });
  }

  /** Sends the draft, filled in with the first recipient's details, to the organiser's own email. */
  async sendTest(userId: string, eventId: string, id: string) {
    const b = await this.get(eventId, id);
    const me = await this.dbs.pool.query<{ email: string | null }>('SELECT email FROM users WHERE id = $1', [userId]);
    const to = me.rows[0]?.email;
    if (!to) throw new ProblemException(409, 'NO_EMAIL', 'Your account has no email address to send the test to');
    const sample = await this.preview(eventId, { audience: b.audience, subject: b.subject, body: b.body });
    await this.notifications.sendNow(to, `[ทดสอบ] ${sample.sample?.subject ?? b.subject}`, sample.sample?.body ?? b.body, userId, 'broadcast_test');
    return { to };
  }

  /** Sends now, or schedules for later; a scheduled broadcast goes out within half a minute of its time. */
  async send(userId: string, orgId: string, eventId: string, id: string, scheduledAt: string | null) {
    if (scheduledAt && new Date(scheduledAt).getTime() <= Date.now()) {
      throw problems.validation('Pick a time in the future', [{ path: 'scheduledAt', message: 'in the past' }]);
    }
    await this.dbs.transaction(async (_tx, client) => {
      await lockDraft(client, eventId, id);
      const { rows } = await client.query('SELECT audience_filter FROM broadcasts WHERE id = $1', [id]);
      const list = await recipients(client, eventId, audienceSchema.parse(rows[0].audience_filter));
      if (!list.some((r) => r.address)) throw new ProblemException(409, 'NO_RECIPIENTS', 'No runner in this audience has an email address');
      if (scheduledAt) await client.query(`UPDATE broadcasts SET status = 'scheduled', scheduled_at = $2 WHERE id = $1`, [id, scheduledAt]);
      await writeAudit(client, {
        actorId: userId, organizationId: orgId, eventId, action: scheduledAt ? 'broadcast.schedule' : 'broadcast.send', entityType: 'broadcast', entityId: id,
        after: { scheduledAt },
      });
    });
    if (!scheduledAt) await this.notifications.start(id);
    return this.get(eventId, id);
  }

  /** Takes a scheduled broadcast back to a draft before it goes out. */
  async unschedule(userId: string, orgId: string, eventId: string, id: string) {
    const { rowCount } = await this.dbs.pool.query(
      `UPDATE broadcasts SET status = 'draft', scheduled_at = NULL WHERE id = $1 AND event_id = $2 AND status = 'scheduled'`,
      [id, eventId],
    );
    if (!rowCount) throw new ProblemException(409, 'NOT_SCHEDULED', 'This broadcast is not waiting to be sent');
    await writeAudit(this.dbs.pool, { actorId: userId, organizationId: orgId, eventId, action: 'broadcast.unschedule', entityType: 'broadcast', entityId: id });
    return this.get(eventId, id);
  }

  private async get(eventId: string, id: string, db: Pick<PoolClient, 'query'> = this.dbs.pool) {
    const { rows } = await db.query(
      `SELECT b.*, b.channels::text[] AS channel_list, u.display_name, u.email AS created_by_email FROM broadcasts b LEFT JOIN users u ON u.id = b.created_by WHERE b.id = $1 AND b.event_id = $2`,
      [id, eventId],
    );
    if (!rows[0]) throw problems.notFound('Broadcast');
    return view(rows[0]);
  }
}

async function lockDraft(client: PoolClient, eventId: string, id: string) {
  const { rows } = await client.query<{ status: string }>('SELECT status FROM broadcasts WHERE id = $1 AND event_id = $2 FOR UPDATE', [id, eventId]);
  if (!rows[0]) throw problems.notFound('Broadcast');
  if (rows[0].status !== 'draft') throw new ProblemException(409, 'BROADCAST_NOT_DRAFT', 'Only a draft can be changed or sent', undefined, { status: rows[0].status });
}

function view(b: Record<string, any>) {
  return {
    id: b.id,
    status: b.status as 'draft' | 'scheduled' | 'sending' | 'sent' | 'cancelled',
    channels: b.channel_list as string[],
    subject: b.subject as string,
    body: b.body as string,
    audience: audienceSchema.parse(b.audience_filter) as Audience,
    scheduledAt: b.scheduled_at,
    sentAt: b.sent_at,
    recipientCount: b.recipient_count,
    sentCount: b.sent_count,
    failedCount: b.failed_count,
    createdBy: b.display_name ?? b.created_by_email ?? null,
    createdAt: b.created_at,
  };
}
