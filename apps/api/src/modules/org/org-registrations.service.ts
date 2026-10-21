import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppConfig, CONFIG } from '../../config';
import { decryptPii } from '../../common/crypto';
import { ProblemException, problems } from '../../common/problem';
import { DbService } from '../../db/db.service';
import { writeAudit } from './org-access.service';
import { loadQuestions, Question } from './org-questions.service';

export const listQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  raceId: z.string().uuid().optional(),
  status: z.enum(['pending', 'confirmed', 'cancelled', 'transferred', 'refunded']).optional(),
  pickup: z.enum(['picked', 'not_picked']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export const checkinSchema = z.object({
  /** The QR on the runner's ticket (qr_token), a bib number or a registration number. */
  code: z.string().trim().min(1).max(64),
  /** Generated on the scanning device so a retried request cannot check the runner in twice. */
  clientUuid: z.string().uuid(),
  pickedUpBy: z.string().trim().max(120).nullable().default(null),
  shirtSizeGiven: z.string().trim().max(10).nullable().default(null),
  /** When the device recorded the pickup, for scans queued offline. A clock ahead of the server counts as now. */
  scannedAt: z.string().datetime({ offset: true }).optional(),
});

/** A queue of pickups recorded offline, in the order they were scanned. */
export const checkinBatchSchema = z.object({ items: z.array(checkinSchema).min(1).max(200) });

const LIST_COLUMNS = `
  r.id, r.registration_no, r.bib_number, r.status, r.first_name_th, r.last_name_th, r.first_name_en, r.last_name_en,
  r.gender, r.age_on_race_day, r.shirt_size, r.email, r.phone, r.kit_picked_up_at, r.created_at, r.confirmed_at,
  ra.id AS race_id, ra.code AS race_code, ag.code AS age_group, o.order_no`;

const LIST_FROM = `
  FROM registrations r
  JOIN races ra ON ra.id = r.race_id
  LEFT JOIN age_groups ag ON ag.id = r.age_group_id
  LEFT JOIN orders o ON o.id = r.order_id`;

@Injectable()
export class OrgRegistrationsService {
  constructor(
    private readonly dbs: DbService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async list(eventId: string, query: ListQuery) {
    const { where, params } = filters(eventId, query);
    params.push(query.limit, query.offset);
    const { rows } = await this.dbs.pool.query(
      `SELECT ${LIST_COLUMNS}, count(*) OVER () AS total ${LIST_FROM}
        WHERE ${where}
        ORDER BY r.created_at DESC, r.registration_no DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const counts = await this.dbs.pool.query(
      `SELECT count(*)::int AS all,
              count(*) FILTER (WHERE status = 'confirmed')::int AS confirmed,
              count(*) FILTER (WHERE status = 'pending')::int AS pending,
              count(*) FILTER (WHERE status = 'confirmed' AND kit_picked_up_at IS NULL)::int AS not_picked
         FROM registrations WHERE event_id = $1`,
      [eventId],
    );
    return { items: rows.map(listView), total: Number(rows[0]?.total ?? 0), counts: counts.rows[0] };
  }

  /** Detail for one runner. The ID number stays masked; revealing it is a separate, audited call. */
  async get(orgId: string, registrationId: string) {
    const r = await this.load(orgId, registrationId);
    const snap = r.runner_snapshot as Record<string, string | null>;
    const questions = await loadQuestions(this.dbs.pool, r.event_id, true);
    const checkins = await this.dbs.pool.query(
      `SELECT checkin_type, scanned_at, picked_up_by, shirt_size_given, voided_at FROM checkins
        WHERE registration_id = $1 ORDER BY scanned_at`,
      [registrationId],
    );
    const changes = await this.dbs.pool.query<{ at: Date; kind: 'race_change' | 'transferred_in' | 'transferred_out'; detail: string }>(
      `SELECT c.completed_at AS at, 'race_change' AS kind, fr.code || ' → ' || tr.code AS detail
         FROM race_changes c JOIN races fr ON fr.id = c.from_race_id JOIN races tr ON tr.id = c.to_race_id
        WHERE c.registration_id = $1 AND c.status = 'completed'
       UNION ALL
       SELECT t.completed_at, 'transferred_in', 'จาก ' || f.registration_no
         FROM transfers t JOIN registrations f ON f.id = t.from_registration_id
        WHERE t.to_registration_id = $1 AND t.status = 'completed'
       UNION ALL
       SELECT t.completed_at, 'transferred_out', 'ให้ ' || coalesce(n.registration_no, t.to_email::text)
         FROM transfers t LEFT JOIN registrations n ON n.id = t.to_registration_id
        WHERE t.from_registration_id = $1 AND t.status = 'completed'`,
      [registrationId],
    );
    const timeline = [
      { at: r.created_at, kind: 'registered' as const, detail: r.order_no },
      ...changes.rows,
      ...(r.paid_at ? [{ at: r.paid_at, kind: 'paid' as const, detail: String(r.order_total) }] : []),
      ...checkins.rows.map((c) => ({
        at: c.scanned_at,
        kind: c.voided_at ? ('checkin_voided' as const) : ('kit_pickup' as const),
        detail: c.picked_up_by ? `รับแทนโดย ${c.picked_up_by}` : null,
      })),
    ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    return {
      ...listView(r),
      birthDate: r.birth_date_text,
      nationality: r.nationality,
      idDocType: snap.idDocType,
      idDocMasked: maskIdDoc(snap.idDocLast4 ?? ''),
      bloodType: snap.bloodType,
      emergency: { name: snap.emergencyName, phone: snap.emergencyPhone },
      answers: answerList(questions, r.answers),
      pricePaidSatang: Number(r.price_paid_satang),
      order: r.order_no
        ? { orderNo: r.order_no, status: r.order_status, totalSatang: Number(r.order_total), paidAt: r.paid_at, buyerName: r.buyer_name, buyerEmail: r.buyer_email }
        : null,
      timeline,
    };
  }

  /** Shows the full ID number and records who looked, as PDPA requires for sensitive data. */
  async revealIdDoc(userId: string, orgId: string, registrationId: string) {
    const r = await this.load(orgId, registrationId);
    const enc = (r.runner_snapshot as { idDocNumberEnc?: string }).idDocNumberEnc;
    if (!enc) throw problems.notFound('ID document');
    await writeAudit(this.dbs.pool, {
      actorId: userId, organizationId: orgId, eventId: r.event_id, action: 'registration.reveal_id_doc',
      entityType: 'registration', entityId: registrationId,
    });
    return { idDocNumber: decryptPii(Buffer.from(enc, 'base64'), this.config.PII_ENCRYPTION_KEY) };
  }

  /** CSV for Excel: UTF-8 with a BOM so Thai names open correctly. No ID numbers or health data. */
  async exportCsv(userId: string, orgId: string, eventId: string, query: Omit<ListQuery, 'limit' | 'offset'>) {
    const { where, params } = filters(eventId, query);
    const { rows } = await this.dbs.pool.query(
      `SELECT ${LIST_COLUMNS}, r.birth_date::text AS birth_date, r.nationality, r.runner_snapshot->>'emergencyName' AS emergency_name,
              r.runner_snapshot->>'emergencyPhone' AS emergency_phone, r.price_paid_satang, r.answers
         ${LIST_FROM}
        WHERE ${where}
        ORDER BY ra.sort_order, r.bib_number NULLS LAST, r.registration_no`,
      params,
    );
    await writeAudit(this.dbs.pool, {
      actorId: userId, organizationId: orgId, eventId, action: 'registrations.export', entityType: 'event', entityId: eventId,
      after: { filters: query, rows: rows.length },
    });
    // One column per question, headed by its label, including questions removed after runners answered them.
    const questions = (await loadQuestions(this.dbs.pool, eventId, true)).filter((q) => q.isActive || rows.some((r) => q.key in r.answers));
    const header = [
      'registration_no', 'bib', 'status', 'race', 'first_name_th', 'last_name_th', 'first_name_en', 'last_name_en', 'gender',
      'birth_date', 'age', 'age_group', 'nationality', 'shirt_size', 'email', 'phone', 'emergency_name', 'emergency_phone',
      'order_no', 'price_paid_baht', 'kit_picked_up_at', ...questions.map((q) => q.label),
    ];
    const lines = rows.map((r) =>
      [
        r.registration_no, r.bib_number, r.status, r.race_code, r.first_name_th, r.last_name_th, r.first_name_en, r.last_name_en,
        r.gender, r.birth_date, r.age_on_race_day, r.age_group, r.nationality, r.shirt_size, r.email, r.phone, r.emergency_name,
        r.emergency_phone, r.order_no, (Number(r.price_paid_satang) / 100).toFixed(2),
        r.kit_picked_up_at ? new Date(r.kit_picked_up_at).toISOString() : null,
        ...questions.map((q) => answerText(r.answers[q.key])),
      ].map(csvCell).join(','),
    );
    return `﻿${[header.join(','), ...lines].join('\r\n')}\r\n`;
  }

  /** What the scanner shows before staff hand over the kit. */
  async lookup(eventId: string, code: string) {
    const r = await this.findByCode(eventId, code);
    return checkinView(r);
  }

  async checkin(userId: string, orgId: string, eventId: string, input: z.infer<typeof checkinSchema>) {
    return (await this.record(userId, orgId, eventId, input, false)).registration;
  }

  /**
   * Sends a device's offline queue. Each item is its own transaction, so a runner who was already
   * picked up at another table, asked for a refund or never paid is reported for that item and the rest still go through.
   */
  async checkinBatch(userId: string, orgId: string, eventId: string, items: z.infer<typeof checkinBatchSchema>['items']) {
    const results = [];
    for (const item of items) {
      try {
        const { registration, replayed } = await this.record(userId, orgId, eventId, item, true);
        results.push({ clientUuid: item.clientUuid, ok: true as const, replayed, registration });
      } catch (err) {
        if (!(err instanceof ProblemException) || (err.status !== 404 && err.status !== 409)) throw err;
        const registration = (err.extra?.registration as ReturnType<typeof checkinView> | undefined) ?? null;
        results.push({ clientUuid: item.clientUuid, ok: false as const, code: err.code, registration });
      }
    }
    return { results };
  }

  /**
   * What the check-in page keeps on the device to work without a network: confirmed runners only,
   * with nothing beyond what staff need to hand over the kit. The QR token is sent as a SHA-256 hash
   * so a copied roster cannot be turned into tickets.
   */
  async roster(userId: string, orgId: string, eventId: string) {
    const { rows } = await this.dbs.pool.query(
      `SELECT r.id, r.registration_no, r.bib_number, r.first_name_th, r.last_name_th, r.first_name_en, r.last_name_en,
              r.shirt_size, r.kit_picked_up_at, ra.code AS race_code, encode(sha256(convert_to(r.qr_token, 'UTF8')), 'hex') AS qr_hash,
              EXISTS (SELECT 1 FROM refunds f WHERE f.registration_id = r.id AND f.status = 'requested') AS refund_pending,
              now() AS generated_at
         FROM registrations r
         JOIN races ra ON ra.id = r.race_id
        WHERE r.event_id = $1 AND r.status = 'confirmed'
        ORDER BY ra.sort_order, r.bib_number NULLS LAST, r.registration_no`,
      [eventId],
    );
    await writeAudit(this.dbs.pool, {
      actorId: userId, organizationId: orgId, eventId, action: 'checkins.roster_download', entityType: 'event', entityId: eventId,
      after: { rows: rows.length },
    });
    return {
      generatedAt: rows[0]?.generated_at ?? new Date(),
      items: rows.map((r) => ({
        id: r.id,
        registrationNo: r.registration_no,
        bibNumber: r.bib_number,
        name: { th: r.first_name_th ? `${r.first_name_th} ${r.last_name_th ?? ''}`.trim() : null, en: `${r.first_name_en} ${r.last_name_en}` },
        raceCode: r.race_code,
        shirtSize: r.shirt_size,
        qrHash: r.qr_hash,
        kitPickedUpAt: r.kit_picked_up_at,
        refundPending: r.refund_pending,
      })),
    };
  }

  private async record(userId: string, orgId: string, eventId: string, input: z.infer<typeof checkinSchema>, offline: boolean) {
    return this.dbs.transaction(async (_tx, client) => {
      const replay = () =>
        client.query(
          `SELECT c.registration_id FROM checkins c JOIN registrations r ON r.id = c.registration_id
            WHERE c.client_uuid = $1 AND r.event_id = $2`,
          [input.clientUuid, eventId],
        );
      const earlier = await replay();
      if (earlier.rows[0]) return { registration: checkinView(await this.findById(client, earlier.rows[0].registration_id)), replayed: true };

      const r = await this.findByCode(eventId, input.code, client, true);
      if (r.status !== 'confirmed') {
        throw new ProblemException(409, 'NOT_CONFIRMED', 'This registration is not paid or is no longer valid', undefined, { registration: checkinView(r) });
      }
      const refund = await client.query(`SELECT 1 FROM refunds WHERE registration_id = $1 AND status = 'requested'`, [r.id]);
      if (refund.rowCount) {
        throw new ProblemException(409, 'REFUND_PENDING', 'This runner has asked for a refund; settle it before handing over the kit', undefined, { registration: checkinView(r) });
      }
      if (r.kit_picked_up_at) {
        // The same request sent twice at once waits on the row lock above, then finds its own pickup.
        const raced = await replay();
        if (raced.rows[0]) return { registration: checkinView(r), replayed: true };
        throw new ProblemException(409, 'ALREADY_PICKED_UP', 'This runner has already collected the kit', undefined, { registration: checkinView(r) });
      }
      const inserted = await client.query(
        `INSERT INTO checkins (registration_id, checkin_type, picked_up_by, shirt_size_given, client_uuid, scanned_at)
         VALUES ($1, 'kit_pickup', $2, $3, $4, LEAST(coalesce($5::timestamptz, now()), now()))
         RETURNING scanned_at`,
        [r.id, input.pickedUpBy, input.shirtSizeGiven, input.clientUuid, input.scannedAt ?? null],
      );
      const updated = await client.query(
        'UPDATE registrations SET kit_picked_up_at = $2, updated_at = now() WHERE id = $1 RETURNING kit_picked_up_at',
        [r.id, inserted.rows[0].scanned_at],
      );
      await writeAudit(client, {
        actorId: userId, organizationId: orgId, eventId, action: 'registration.kit_pickup', entityType: 'registration', entityId: r.id,
        after: { pickedUpBy: input.pickedUpBy, shirtSizeGiven: input.shirtSizeGiven, ...(offline ? { offline, scannedAt: inserted.rows[0].scanned_at } : {}) },
      });
      return { registration: checkinView({ ...r, kit_picked_up_at: updated.rows[0].kit_picked_up_at }), replayed: false };
    });
  }

  private async load(orgId: string, registrationId: string) {
    const { rows } = await this.dbs.pool.query(
      `SELECT ${LIST_COLUMNS}, r.event_id, r.runner_snapshot, r.answers, r.birth_date::text AS birth_date_text, r.nationality, r.price_paid_satang,
              o.status AS order_status, o.total_satang AS order_total, o.paid_at, o.buyer_name, o.buyer_email
         ${LIST_FROM}
         JOIN events e ON e.id = r.event_id
        WHERE r.id = $1 AND e.organization_id = $2`,
      [registrationId, orgId],
    );
    if (!rows[0]) throw problems.notFound('Registration');
    return rows[0];
  }

  private async findByCode(eventId: string, code: string, client: Queryable = this.dbs.pool, lock = false) {
    const { rows } = await client.query(
      `SELECT ${CHECKIN_COLUMNS} ${LIST_FROM}
        WHERE r.event_id = $1 AND (r.qr_token = $2 OR r.bib_number = $2 OR r.registration_no = upper($2))
          AND r.status NOT IN ('transferred')
        ORDER BY (r.status = 'confirmed') DESC LIMIT 1
        ${lock ? 'FOR UPDATE OF r' : ''}`,
      [eventId, code],
    );
    if (!rows[0]) throw new ProblemException(404, 'REGISTRATION_NOT_FOUND', 'No runner in this event matches that code');
    return rows[0];
  }

  private async findById(client: Queryable, id: string) {
    const { rows } = await client.query(`SELECT ${CHECKIN_COLUMNS} ${LIST_FROM} WHERE r.id = $1`, [id]);
    return rows[0];
  }
}

type Queryable = { query: DbService['pool']['query'] };

const CHECKIN_COLUMNS = `${LIST_COLUMNS}, r.runner_snapshot->>'emergencyName' AS emergency_name`;

function filters(eventId: string, q: Omit<ListQuery, 'limit' | 'offset'>) {
  const where = ['r.event_id = $1'];
  const params: unknown[] = [eventId];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replaceAll('?', `$${params.length}`));
  };
  if (q.q) {
    params.push(`%${q.q}%`, q.q);
    const like = `$${params.length - 1}`;
    const exact = `$${params.length}`;
    where.push(
      `(r.first_name_en || ' ' || r.last_name_en ILIKE ${like}
        OR coalesce(r.first_name_th, '') || ' ' || coalesce(r.last_name_th, '') ILIKE ${like}
        OR r.email ILIKE ${like} OR r.phone ILIKE ${like}
        OR r.bib_number = ${exact} OR r.registration_no = upper(${exact}) OR o.order_no = upper(${exact}))`,
    );
  }
  if (q.raceId) add('r.race_id = ?', q.raceId);
  if (q.status) add('r.status = ?', q.status);
  if (q.pickup === 'picked') where.push('r.kit_picked_up_at IS NOT NULL');
  if (q.pickup === 'not_picked') where.push(`r.kit_picked_up_at IS NULL AND r.status = 'confirmed'`);
  return { where: where.join(' AND '), params };
}

function listView(r: Record<string, any>) {
  return {
    id: r.id,
    registrationNo: r.registration_no,
    bibNumber: r.bib_number,
    status: r.status,
    name: { th: r.first_name_th ? `${r.first_name_th} ${r.last_name_th ?? ''}`.trim() : null, en: `${r.first_name_en} ${r.last_name_en}` },
    gender: r.gender,
    age: r.age_on_race_day,
    ageGroup: r.age_group,
    race: { id: r.race_id, code: r.race_code },
    shirtSize: r.shirt_size,
    email: r.email,
    phone: r.phone,
    orderNo: r.order_no,
    kitPickedUpAt: r.kit_picked_up_at,
    createdAt: r.created_at,
  };
}

function checkinView(r: Record<string, any>) {
  return { ...listView(r), emergencyName: r.emergency_name ?? null };
}

/** The runner's answers in form order, with each question's label. */
function answerList(questions: Question[], answers: Record<string, unknown>) {
  return questions
    .filter((q) => q.key in answers)
    .map((q) => ({ key: q.key, label: q.label, type: q.type, value: answers[q.key] }));
}

function answerText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.join('; ');
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

function maskIdDoc(last4: string): string {
  return `•••••••••${last4}`;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  // A leading = + - @ would run as a formula in Excel.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
