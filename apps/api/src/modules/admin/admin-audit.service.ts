import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { problems } from '../../common/problem';
import { uuidSchema } from '../../common/validation';
import { DbService } from '../../db/db.service';

/** An empty form field counts as not filled in. */
const optional = <S extends z.ZodTypeAny>(schema: S) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

export const auditQuerySchema = z.object({
  organizationId: optional(uuidSchema),
  eventId: optional(uuidSchema),
  entityId: optional(uuidSchema),
  /** Part of the email of whoever did it. */
  actor: optional(z.string().trim().min(1).max(200)),
  /** The start of the action, e.g. `admin.` or `refund.approve`. */
  action: optional(z.string().trim().min(1).max(100)),
  /** Calendar days in Thai time, both included. */
  from: optional(z.string().date()),
  to: optional(z.string().date()),
  /** Paging: entries older than this id. */
  before: optional(z.coerce.number().int().positive()),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const like = (q: string) => q.replace(/[%_\\]/g, '\\$&');

/** Keys whose value is never shown, and keys that are identity or account numbers shown by their last four digits. */
const HIDDEN = /token|secret|password|otp|hash|cvv|_enc$|Enc$/i;
const NUMBER = /taxId|tax_id|idNumber|id_number|idDoc|id_doc|nationalId|national_id|citizen|passport|accountNumber|account_number|cardNumber|card_number|phone/i;
/** Anything that looks like an ID card, tax, phone or account number, whatever its key (a date has eight digits). */
const looksLikeNumber = (v: string) => /^[\d\s-]+$/.test(v) && v.replace(/\D/g, '').length >= 9;

const lastFour = (v: string) => `••••${v.replace(/\D/g, '').slice(-4)}`;

/** A copy of what was audited that is safe to show staff: no secrets and no full ID or account numbers. */
export function redact(value: unknown, key = ''): unknown {
  if (value === null || value === undefined) return value;
  if (key && HIDDEN.test(key)) return '[ซ่อน]';
  if (Array.isArray(value)) return value.map((v) => redact(v, key));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  if (typeof value === 'string' && /\d/.test(value) && ((key && NUMBER.test(key)) || looksLikeNumber(value))) return lastFour(value);
  if (typeof value === 'number' && key && NUMBER.test(key)) return lastFour(String(value));
  return value;
}

const view = (r: Record<string, any>) => ({
  id: Number(r.id),
  createdAt: r.created_at as Date,
  action: r.action as string,
  actor: r.actor_id ? { id: r.actor_id as string, email: r.actor_email as string | null, name: r.actor_name as string | null } : null,
  actorType: r.actor_type as string,
  organization: r.organization_id ? { id: r.organization_id as string, nameTh: r.org_name as string } : null,
  event: r.event_id ? { id: r.event_id as string, nameTh: r.event_name as string } : null,
  entityType: r.entity_type as string,
  entityId: r.entity_id as string | null,
});

const select = (extra = '') => `SELECT a.id, a.created_at, a.action, a.actor_type, a.actor_id, u.email AS actor_email, u.display_name AS actor_name,
                       a.organization_id, o.name_th AS org_name, a.event_id, e.name_th AS event_name, a.entity_type, a.entity_id ${extra}
                  FROM audit_logs a
                  LEFT JOIN users u ON u.id = a.actor_id
                  LEFT JOIN organizations o ON o.id = a.organization_id
                  LEFT JOIN events e ON e.id = a.event_id`;

/** Read-only view of audit_logs for platform staff. */
@Injectable()
export class AdminAuditService {
  constructor(private readonly dbs: DbService) {}

  /** Newest first, `limit` at a time; `nextBefore` fetches the next (older) page. */
  async list(q: z.infer<typeof auditQuerySchema>) {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replaceAll('?', `$${params.length}`));
    };
    if (q.organizationId) add('a.organization_id = ?', q.organizationId);
    if (q.eventId) add('a.event_id = ?', q.eventId);
    if (q.entityId) add('a.entity_id = ?', q.entityId);
    if (q.actor) add(`u.email ILIKE '%' || ? || '%'`, like(q.actor));
    if (q.action) add(`a.action LIKE ? || '%'`, like(q.action));
    if (q.from) add(`a.created_at >= (?::date)::timestamp AT TIME ZONE 'Asia/Bangkok'`, q.from);
    if (q.to) add(`a.created_at < (?::date + 1)::timestamp AT TIME ZONE 'Asia/Bangkok'`, q.to);
    if (q.before) add('a.id < ?', q.before);
    params.push(q.limit + 1);
    const { rows } = await this.dbs.pool.query(
      `${select()} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.id DESC LIMIT $${params.length}`,
      params,
    );
    const items = rows.slice(0, q.limit).map(view);
    return { items, nextBefore: rows.length > q.limit ? items.at(-1)!.id : null };
  }

  /** One entry with what changed, secrets and full ID numbers masked. */
  async get(id: number) {
    const { rows } = await this.dbs.pool.query(
      `${select(', a.before_data, a.after_data, a.request_id')} WHERE a.id = $1`,
      [id],
    );
    const r = rows[0];
    if (!r) throw problems.notFound('Audit entry');
    return { ...view(r), before: redact(r.before_data), after: redact(r.after_data), requestId: r.request_id as string | null };
  }
}
