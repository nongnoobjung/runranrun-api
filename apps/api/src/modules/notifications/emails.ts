import { PoolClient } from 'pg';
import { TemplateKey, TemplateVars } from './templates';

type Queryable = Pick<PoolClient, 'query'>;

/** Postgres channel NotificationsService listens on. pg_notify is only delivered when the transaction commits. */
export const EMAIL_CHANNEL = 'kao_transactional_email';

/** A runner's name for an email: { th, en } with the Thai name falling back to the English one. */
export const RUNNER_NAME_SQL = (r: string) =>
  `json_build_object('th', COALESCE(NULLIF(trim(coalesce(${r}.first_name_th, '') || ' ' || coalesce(${r}.last_name_th, '')), ''), initcap(${r}.first_name_en || ' ' || ${r}.last_name_en)),
                     'en', initcap(${r}.first_name_en || ' ' || ${r}.last_name_en))`;
const EVENT_NAME_SQL = (e: string) => `json_build_object('th', ${e}.name_th, 'en', ${e}.name_en)`;

export interface QueuedEmail<K extends TemplateKey> {
  template: K;
  /** The account the email is about; its language decides the template's language (Thai when there is none). */
  userId: string | null;
  /** Where to send it; the account's email when left out. */
  to?: string | null;
  registrationId?: string | null;
  /** One email per key, ever: a retried request or job finds the row already there and queues nothing. */
  dedupeKey: string;
  vars: TemplateVars[K];
}

/**
 * Records a transactional email inside the caller's transaction; NotificationsService sends it after the commit.
 * Nothing is sent if the transaction rolls back, and a second call with the same dedupe key is a no-op.
 * Returns whether a new email was queued. Transactional emails ignore marketing consent: they are about the
 * runner's own purchase or place.
 */
export async function queueEmail<K extends TemplateKey>(db: Queryable, e: QueuedEmail<K>): Promise<boolean> {
  const { rowCount } = await db.query(
    `WITH ins AS (
       INSERT INTO notifications (user_id, registration_id, channel, template_key, recipient, payload, dedupe_key)
       SELECT u.id, $2, 'email', $3, COALESCE($4::text, u.email::text),
              jsonb_build_object('locale', COALESCE(u.locale, 'th'), 'vars', $5::jsonb), $6
         FROM (SELECT $1::uuid AS id) x LEFT JOIN users u ON u.id = x.id
        WHERE COALESCE($4::text, u.email::text) IS NOT NULL
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id)
     SELECT pg_notify('${EMAIL_CHANNEL}', '') FROM ins`,
    [e.userId, e.registrationId ?? null, e.template, e.to ?? null, JSON.stringify(e.vars), e.dedupeKey],
  );
  return (rowCount ?? 0) > 0;
}

/** "Payment received" to the buyer, with the receipt and each runner's ticket. */
export async function queueOrderPaid(db: Queryable, orderId: string): Promise<void> {
  const { rows } = await db.query(
    `SELECT o.id, o.order_no, o.buyer_user_id, o.buyer_email, o.total_satang, e.event_date::text AS event_date, ${EVENT_NAME_SQL('e')} AS event,
            (SELECT json_agg(json_build_object('id', r.id, 'name', ${RUNNER_NAME_SQL('r')}, 'raceCode', ra.code, 'bib', r.bib_number) ORDER BY r.registration_no)
               FROM registrations r JOIN races ra ON ra.id = r.race_id WHERE r.order_id = o.id AND r.status = 'confirmed') AS registrations
       FROM orders o JOIN events e ON e.id = o.event_id WHERE o.id = $1`,
    [orderId],
  );
  const o = rows[0];
  if (!o) return;
  await queueEmail(db, {
    template: 'order_paid', userId: o.buyer_user_id, to: o.buyer_email, dedupeKey: `order_paid:${orderId}`,
    vars: { orderId, orderNo: o.order_no, event: o.event, eventDate: o.event_date, totalSatang: Number(o.total_satang), registrations: o.registrations ?? [] },
  });
}

const REGISTRATION_SQL = `
  SELECT r.id, r.bib_number, r.bib_assigned_at, ra.code AS race_code, ${RUNNER_NAME_SQL('r')} AS name, ${EVENT_NAME_SQL('e')} AS event, e.slug,
         COALESCE(r.runner_user_id, o.buyer_user_id) AS user_id, COALESCE(r.email::text, o.buyer_email::text) AS address
    FROM registrations r JOIN races ra ON ra.id = r.race_id JOIN events e ON e.id = r.event_id LEFT JOIN orders o ON o.id = r.order_id
   WHERE r.id = $1`;

/** The runner's bib, newly given or changed by the organiser. Assigning the same number again sends nothing. */
export async function queueBibAssigned(db: Queryable, registrationId: string, previousBib: string | null): Promise<void> {
  const r = (await db.query(REGISTRATION_SQL, [registrationId])).rows[0];
  if (!r?.bib_number || r.bib_number === previousBib) return;
  await queueEmail(db, {
    template: 'bib_assigned', userId: r.user_id, to: r.address, registrationId,
    dedupeKey: `bib_assigned:${registrationId}:${r.bib_number}:${new Date(r.bib_assigned_at ?? Date.now()).getTime()}`,
    vars: { registrationId, event: r.event, raceCode: r.race_code, name: r.name, bib: r.bib_number, previousBib },
  });
}

/** A refund the organiser approved, declined or paid out, to whoever asked for it (else the buyer). */
export async function queueRefundEmail(db: Queryable, refundId: string, template: 'refund_approved' | 'refund_rejected' | 'refund_transferred'): Promise<void> {
  const { rows } = await db.query(
    `SELECT f.id, f.amount_satang, f.organizer_note, f.transfer_reference, f.registration_id, p.method,
            ra.code AS race_code, CASE WHEN r.id IS NULL THEN NULL ELSE ${RUNNER_NAME_SQL('r')} END AS name, ${EVENT_NAME_SQL('e')} AS event,
            COALESCE(f.requested_by, r.runner_user_id, o.buyer_user_id) AS user_id,
            CASE WHEN f.requested_by IS NULL THEN COALESCE(r.email::text, o.buyer_email::text) END AS address
       FROM refunds f
       JOIN orders o ON o.id = f.order_id
       JOIN events e ON e.id = o.event_id
       LEFT JOIN registrations r ON r.id = f.registration_id
       LEFT JOIN races ra ON ra.id = r.race_id
       LEFT JOIN payments p ON p.id = f.payment_id
      WHERE f.id = $1`,
    [refundId],
  );
  const f = rows[0];
  if (!f) return;
  const base = { userId: f.user_id, to: f.address, registrationId: f.registration_id, dedupeKey: `${template}:${refundId}` };
  const amountSatang = Number(f.amount_satang);
  if (template === 'refund_approved') {
    await queueEmail(db, { ...base, template, vars: { event: f.event, raceCode: f.race_code, name: f.name, amountSatang, byTransfer: f.method !== 'card' } });
  } else if (template === 'refund_rejected') {
    await queueEmail(db, { ...base, template, vars: { event: f.event, raceCode: f.race_code, name: f.name, note: f.organizer_note } });
  } else {
    await queueEmail(db, { ...base, template, vars: { event: f.event, raceCode: f.race_code, name: f.name, amountSatang, reference: f.transfer_reference } });
  }
}

/** Both sides of a completed transfer: the sender's place is gone, the recipient has a new ticket. */
export async function queueTransferCompleted(db: Queryable, transferId: string): Promise<void> {
  const { rows } = await db.query(
    `SELECT t.to_user_id, t.to_email, t.from_registration_id, t.to_registration_id FROM transfers t WHERE t.id = $1`,
    [transferId],
  );
  const t = rows[0];
  if (!t?.to_registration_id) return;
  const from = (await db.query(REGISTRATION_SQL, [t.from_registration_id])).rows[0];
  const to = (await db.query(REGISTRATION_SQL, [t.to_registration_id])).rows[0];
  await queueEmail(db, {
    template: 'transfer_sent', userId: from.user_id, to: from.address, registrationId: from.id, dedupeKey: `transfer_sent:${transferId}`,
    vars: { event: from.event, raceCode: from.race_code, toName: to.name },
  });
  await queueEmail(db, {
    template: 'transfer_received', userId: t.to_user_id, to: t.to_user_id ? null : t.to_email, registrationId: to.id, dedupeKey: `transfer_received:${transferId}`,
    vars: { registrationId: to.id, event: to.event, raceCode: to.race_code, name: to.name, bib: to.bib_number },
  });
}

export async function queueRaceChangeCompleted(db: Queryable, raceChangeId: string): Promise<void> {
  const { rows } = await db.query(
    `SELECT c.registration_id, fr.code AS from_race FROM race_changes c JOIN races fr ON fr.id = c.from_race_id WHERE c.id = $1`,
    [raceChangeId],
  );
  if (!rows[0]) return;
  const r = (await db.query(REGISTRATION_SQL, [rows[0].registration_id])).rows[0];
  await queueEmail(db, {
    template: 'race_change_completed', userId: r.user_id, to: r.address, registrationId: r.id, dedupeKey: `race_change_completed:${raceChangeId}`,
    vars: { registrationId: r.id, event: r.event, fromRace: rows[0].from_race, toRace: r.race_code, name: r.name, bib: r.bib_number },
  });
}

/** One email per waitlist offer; an entry is offered at most once. */
export async function queueWaitlistOffers(db: Queryable, entryIds: string[]): Promise<void> {
  if (entryIds.length === 0) return;
  const { rows } = await db.query(
    `SELECT w.id, w.user_id, w.offer_expires_at, ra.code AS race_code, e.slug, ${EVENT_NAME_SQL('e')} AS event
       FROM waitlist_entries w JOIN races ra ON ra.id = w.race_id JOIN events e ON e.id = ra.event_id
      WHERE w.id = ANY($1::uuid[])`,
    [entryIds],
  );
  for (const w of rows) {
    await queueEmail(db, {
      template: 'waitlist_offer', userId: w.user_id, dedupeKey: `waitlist_offer:${w.id}`,
      vars: { event: w.event, eventSlug: w.slug, raceCode: w.race_code, expiresAt: new Date(w.offer_expires_at).toISOString() },
    });
  }
}

/**
 * "Results are out" to every finisher matched to a registration, in one statement however big the race.
 * Unpublishing and publishing again (say, after a correction) does not email anyone twice.
 */
export async function queueResultsPublished(db: Queryable, eventId: string): Promise<number> {
  const { rowCount } = await db.query(
    `WITH ins AS (
       INSERT INTO notifications (user_id, registration_id, channel, template_key, recipient, payload, dedupe_key)
       SELECT u.id, r.id, 'email', 'results_published', COALESCE(r.email::text, o.buyer_email::text),
              jsonb_build_object('locale', COALESCE(u.locale, 'th'), 'vars', jsonb_build_object(
                'event', ${EVENT_NAME_SQL('e')}, 'eventSlug', e.slug, 'raceCode', ra.code, 'name', ${RUNNER_NAME_SQL('r')},
                'timeMs', COALESCE(res.chip_time_ms, res.gun_time_ms), 'rank', res.rank_overall)),
              'results_published:' || res.event_id || ':' || r.id
         FROM results res
         JOIN registrations r ON r.id = res.registration_id
         JOIN races ra ON ra.id = res.race_id
         JOIN events e ON e.id = res.event_id
         LEFT JOIN orders o ON o.id = r.order_id
         LEFT JOIN users u ON u.id = COALESCE(r.runner_user_id, o.buyer_user_id)
        WHERE res.event_id = $1 AND res.status = 'FIN' AND res.is_published
          AND COALESCE(r.email::text, o.buyer_email::text) IS NOT NULL
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id)
     SELECT pg_notify('${EMAIL_CHANNEL}', '') FROM ins`,
    [eventId],
  );
  return rowCount ?? 0;
}
