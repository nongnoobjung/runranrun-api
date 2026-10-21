import { Inject, Injectable } from '@nestjs/common';
import { DatabaseError, PoolClient } from 'pg';
import { z } from 'zod';
import { AppConfig, CONFIG } from '../../config';
import { decryptPii, encryptPii } from '../../common/crypto';
import { ProblemException, problems } from '../../common/problem';
import { DbService } from '../../db/db.service';
import { InventoryService } from '../inventory/inventory.service';
import { WaitlistService } from '../waitlist/waitlist.service';
import { writeAudit } from '../org/org-access.service';

export const BANKS = ['KBANK', 'SCB', 'BBL', 'KTB', 'BAY', 'TTB', 'GSB', 'KKP', 'CIMBT', 'UOBT', 'LHBANK', 'BAAC'] as const;

export const bankSchema = z.object({
  bankCode: z.enum(BANKS),
  accountName: z.string().trim().min(2).max(120),
  accountNumber: z.string().trim().transform((v) => v.replace(/[\s-]/g, '')).pipe(z.string().regex(/^\d{10,15}$/, '10–15 digits')),
});
type BankAccount = z.infer<typeof bankSchema>;

export const refundRequestSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  /** Where to send the money. Needed for PromptPay and bank payments, which cannot be refunded through the gateway. */
  bank: bankSchema.optional(),
});
export const rejectSchema = z.object({ note: z.string().trim().min(1).max(500) });
export const transferredSchema = z.object({ reference: z.string().trim().min(1).max(100) });
export const cancelSchema = z.object({
  /** 0 cancels without paying anything back. */
  refundSatang: z.number().int().min(0),
  reason: z.string().trim().min(1).max(500),
});
export const refundListSchema = z.object({ status: z.enum(['open', 'closed']).default('open') });

const OPEN = ['requested', 'approved', 'processing'];

/** Why a runner cannot ask for their money back right now. */
type Ineligible = 'NOT_CONFIRMED' | 'REFUND_NOT_ALLOWED' | 'REFUND_CLOSED' | 'ALREADY_PICKED_UP' | 'REFUND_IN_PROGRESS' | 'TRANSFER_IN_PROGRESS' | 'RACE_CHANGE_IN_PROGRESS';

const QUOTE_SQL = `
  SELECT r.id, r.status, r.registration_no, r.price_paid_satang, r.kit_picked_up_at, r.event_id, r.order_id,
         e.organization_id, e.allow_refund, e.refund_percent_bps, e.allow_transfer,
         COALESCE(e.refund_deadline, e.event_date::timestamp AT TIME ZONE 'Asia/Bangkok') AS refund_until,
         (SELECT p.id FROM payments p WHERE p.order_id = r.order_id AND p.status = 'succeeded' LIMIT 1) AS payment_id,
         (SELECT p.method FROM payments p WHERE p.order_id = r.order_id AND p.status = 'succeeded' LIMIT 1) AS method,
         (SELECT row_to_json(f) FROM (
            SELECT id, status, amount_satang AS "amountSatang", created_at AS "createdAt", organizer_note AS note
              FROM refunds WHERE registration_id = r.id ORDER BY created_at DESC LIMIT 1) f) AS last_refund,
         EXISTS (SELECT 1 FROM transfers t WHERE t.from_registration_id = r.id AND t.status IN ('pending', 'accepted') AND t.expires_at > now()) AS transfer_open,
         EXISTS (SELECT 1 FROM race_changes c JOIN orders co ON co.id = c.order_id
                  WHERE c.registration_id = r.id AND c.status = 'pending_payment' AND co.status = 'pending_payment' AND co.expires_at > now()) AS change_open
    FROM registrations r
    JOIN events e ON e.id = r.event_id
    LEFT JOIN orders o ON o.id = r.order_id`;

@Injectable()
export class RefundsService {
  constructor(
    private readonly dbs: DbService,
    private readonly inventory: InventoryService,
    private readonly waitlist: WaitlistService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  // ---------------------------------------------------------------- runner

  /** What the runner would get back today under the event's policy, or why they cannot ask. */
  async quote(userId: string, registrationId: string, db: Pick<PoolClient, 'query'> = this.dbs.pool) {
    return (await this.loadQuote(userId, registrationId, db)).quote;
  }

  private async loadQuote(userId: string, registrationId: string, db: Pick<PoolClient, 'query'>) {
    const { rows } = await db.query(`${QUOTE_SQL} WHERE r.id = $2 AND (r.runner_user_id = $1 OR (o.buyer_user_id = $1 AND r.transferred_from_id IS NULL))`, [userId, registrationId]);
    const r = rows[0];
    if (!r) throw problems.notFound('Registration');
    const paid = Number(r.price_paid_satang);
    const amount = Math.floor((paid * r.refund_percent_bps) / 10_000);
    const last = r.last_refund as { status: string } | null;
    let reason: Ineligible | null = null;
    if (last && OPEN.includes(last.status)) reason = 'REFUND_IN_PROGRESS';
    else if (r.status !== 'confirmed') reason = 'NOT_CONFIRMED';
    else if (!r.allow_refund || amount === 0) reason = 'REFUND_NOT_ALLOWED';
    else if (new Date(r.refund_until).getTime() <= Date.now()) reason = 'REFUND_CLOSED';
    else if (r.kit_picked_up_at) reason = 'ALREADY_PICKED_UP';
    else if (r.transfer_open) reason = 'TRANSFER_IN_PROGRESS';
    else if (r.change_open) reason = 'RACE_CHANGE_IN_PROGRESS';
    const quote = {
      registrationId: r.id as string,
      eligible: reason === null,
      reason,
      pricePaidSatang: paid,
      percentBps: r.refund_percent_bps,
      amountSatang: amount,
      refundUntil: r.refund_until,
      paymentMethod: r.method,
      needsBankAccount: r.method !== 'card',
      allowTransfer: r.allow_transfer,
      lastRequest: r.last_refund as { id: string; status: string; amountSatang: number; createdAt: string; note: string | null } | null,
    };
    return { quote, row: r };
  }

  async request(userId: string, registrationId: string, input: z.infer<typeof refundRequestSchema>) {
    try {
      return await this.dbs.transaction(async (_tx, client) => {
        await client.query('SELECT 1 FROM registrations WHERE id = $1 FOR UPDATE', [registrationId]);
        const { quote: q, row } = await this.loadQuote(userId, registrationId, client);
        if (!q.eligible) throw ineligible(q.reason!);
        if (q.needsBankAccount && !input.bank) {
          throw problems.validation('Give the bank account to send the money to', [{ path: 'bank', message: 'required' }]);
        }
        const bank = input.bank ? encryptPii(JSON.stringify(input.bank), this.config.PII_ENCRYPTION_KEY) : null;
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO refunds (order_id, payment_id, registration_id, status, amount_satang, reason, requested_by, manual_bank_info_enc)
           VALUES ($1, $2, $3, 'requested', $4, $5, $6, $7) RETURNING id`,
          [row.order_id, row.payment_id, registrationId, q.amountSatang, input.reason, userId, bank],
        );
        await writeAudit(client, {
          actorId: userId, organizationId: row.organization_id, eventId: row.event_id, action: 'refund.request',
          entityType: 'refund', entityId: rows[0].id, after: { amountSatang: q.amountSatang, reason: input.reason },
        });
        return this.quote(userId, registrationId, client);
      });
    } catch (err) {
      if (err instanceof DatabaseError && err.code === '23505' && err.constraint === 'uq_refunds_open_registration') throw ineligible('REFUND_IN_PROGRESS');
      throw err;
    }
  }

  // ---------------------------------------------------------------- organiser

  async list(eventId: string, status: 'open' | 'closed') {
    const statuses = status === 'open' ? ['requested', 'approved'] : ['rejected', 'succeeded', 'failed'];
    const { rows } = await this.dbs.pool.query(
      `SELECT f.*, r.registration_no, r.bib_number, r.price_paid_satang, r.status AS registration_status,
              COALESCE(NULLIF(trim(coalesce(r.first_name_th, '') || ' ' || coalesce(r.last_name_th, '')), ''), r.first_name_en || ' ' || r.last_name_en) AS name,
              ra.code AS race_code, p.method
         FROM refunds f
         JOIN registrations r ON r.id = f.registration_id
         JOIN races ra ON ra.id = r.race_id
         LEFT JOIN payments p ON p.id = f.payment_id
        WHERE r.event_id = $1 AND f.status = ANY($2::refund_status[])
        ORDER BY f.created_at`,
      [eventId, statuses],
    );
    const counts = await this.dbs.pool.query<{ requested: number; approved: number; closed: number }>(
      `SELECT count(*) FILTER (WHERE f.status = 'requested')::int AS requested,
              count(*) FILTER (WHERE f.status = 'approved')::int AS approved,
              count(*) FILTER (WHERE f.status IN ('rejected', 'succeeded', 'failed'))::int AS closed
         FROM refunds f JOIN registrations r ON r.id = f.registration_id WHERE r.event_id = $1`,
      [eventId],
    );
    return { items: rows.map((f) => this.view(f)), counts: counts.rows[0] };
  }

  /** Accepts a runner's request: the place is given up now, and the money is owed until it is marked transferred. */
  async approve(userId: string, orgId: string, eventId: string, refundId: string) {
    const result = await this.dbs.transaction(async (_tx, client) => {
      const f = await this.lockRefund(client, eventId, refundId, 'requested');
      await this.giveUpPlace(client, f.registration_id, 'refunded', `refund: ${f.reason ?? ''}`.trim(), Number(f.amount_satang));
      await client.query(`UPDATE refunds SET status = 'approved', approved_by = $2, updated_at = now() WHERE id = $1`, [refundId, userId]);
      await writeAudit(client, { actorId: userId, organizationId: orgId, eventId, action: 'refund.approve', entityType: 'refund', entityId: refundId });
      return { id: refundId, status: 'approved' };
    });
    // The freed place goes to the race's waitlist first.
    await this.waitlist.offerFreed();
    return result;
  }

  async reject(userId: string, orgId: string, eventId: string, refundId: string, note: string) {
    return this.dbs.transaction(async (_tx, client) => {
      await this.lockRefund(client, eventId, refundId, 'requested');
      await client.query(`UPDATE refunds SET status = 'rejected', organizer_note = $2, approved_by = $3, updated_at = now() WHERE id = $1`, [refundId, note, userId]);
      await writeAudit(client, { actorId: userId, organizationId: orgId, eventId, action: 'refund.reject', entityType: 'refund', entityId: refundId, after: { note } });
      return { id: refundId, status: 'rejected' };
    });
  }

  /** PromptPay cannot refund through the gateway, so the organiser transfers the money and records the reference here. */
  async markTransferred(userId: string, orgId: string, eventId: string, refundId: string, reference: string) {
    return this.dbs.transaction(async (_tx, client) => {
      await this.lockRefund(client, eventId, refundId, 'approved');
      await client.query(
        `UPDATE refunds SET status = 'succeeded', transfer_reference = $2, processed_at = now(), updated_at = now() WHERE id = $1`,
        [refundId, reference],
      );
      await writeAudit(client, { actorId: userId, organizationId: orgId, eventId, action: 'refund.transferred', entityType: 'refund', entityId: refundId, after: { reference } });
      return { id: refundId, status: 'succeeded' };
    });
  }

  /** The organiser cancels a paid place themselves, paying back `refundSatang` (up to what the runner paid). */
  async cancelRegistration(userId: string, orgId: string, eventId: string, registrationId: string, input: z.infer<typeof cancelSchema>) {
    try {
      const result = await this.dbs.transaction(async (_tx, client) => {
        const { rows } = await client.query(
          `SELECT r.id, r.status, r.order_id, r.price_paid_satang,
                  (SELECT p.id FROM payments p WHERE p.order_id = r.order_id AND p.status = 'succeeded' LIMIT 1) AS payment_id
             FROM registrations r WHERE r.id = $1 AND r.event_id = $2 FOR UPDATE OF r`,
          [registrationId, eventId],
        );
        const r = rows[0];
        if (!r) throw new ProblemException(404, 'REGISTRATION_NOT_FOUND', 'No runner in this event matches that registration');
        if (r.status !== 'confirmed') throw ineligible('NOT_CONFIRMED');
        const open = await client.query(`SELECT 1 FROM refunds WHERE registration_id = $1 AND status = ANY($2::refund_status[])`, [registrationId, OPEN]);
        if (open.rowCount) throw ineligible('REFUND_IN_PROGRESS');
        if (input.refundSatang > Number(r.price_paid_satang)) {
          throw problems.validation('The refund cannot be more than the runner paid', [{ path: 'refundSatang', message: 'above price paid' }]);
        }
        const refunding = input.refundSatang > 0;
        await this.giveUpPlace(client, registrationId, refunding ? 'refunded' : 'cancelled', input.reason, input.refundSatang);
        let refundId: string | null = null;
        if (refunding) {
          const ins = await client.query<{ id: string }>(
            `INSERT INTO refunds (order_id, payment_id, registration_id, status, amount_satang, reason, approved_by)
             VALUES ($1, $2, $3, 'approved', $4, $5, $6) RETURNING id`,
            [r.order_id, r.payment_id, registrationId, input.refundSatang, input.reason, userId],
          );
          refundId = ins.rows[0].id;
        }
        await writeAudit(client, {
          actorId: userId, organizationId: orgId, eventId, action: 'registration.cancel', entityType: 'registration', entityId: registrationId,
          after: { refundSatang: input.refundSatang, reason: input.reason, refundId },
        });
        return { registrationId, status: refunding ? 'refunded' : 'cancelled', refundId };
      });
      // The freed place goes to the race's waitlist first.
      await this.waitlist.offerFreed();
      return result;
    } catch (err) {
      if (err instanceof DatabaseError && err.code === '23505' && err.constraint === 'uq_refunds_open_registration') throw ineligible('REFUND_IN_PROGRESS');
      throw err;
    }
  }

  /**
   * Ends a paid place: the race, price tier and shirt are back on sale, the bib number is freed, and the order
   * records what is owed back. When no paid place is left on the order its coupon use is voided too.
   */
  private async giveUpPlace(client: PoolClient, registrationId: string, status: 'refunded' | 'cancelled', reason: string, refundSatang: number) {
    const { rows } = await client.query<{ order_id: string | null }>(
      `UPDATE registrations SET status = $2, cancelled_at = now(), cancel_reason = $3, bib_number = NULL, updated_at = now()
        WHERE id = $1 AND status = 'confirmed' RETURNING order_id`,
      [registrationId, status, reason],
    );
    if (!rows[0]) throw ineligible('NOT_CONFIRMED');
    await this.inventory.releaseRegistration(client, registrationId);
    const orderId = rows[0].order_id;
    if (!orderId) return;
    const left = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM registrations WHERE order_id = $1 AND status = 'confirmed'`, [orderId]);
    const none = left.rows[0].n === 0;
    await client.query(
      `UPDATE orders SET refunded_satang = refunded_satang + $2,
              status = CASE WHEN $3 AND refunded_satang + $2 = 0 THEN 'cancelled'::order_status
                            WHEN $3 THEN 'refunded'::order_status
                            WHEN refunded_satang + $2 > 0 THEN 'partially_refunded'::order_status
                            ELSE status END,
              cancelled_at = CASE WHEN $3 THEN now() ELSE cancelled_at END, updated_at = now()
        WHERE id = $1`,
      [orderId, refundSatang, none],
    );
    if (none) await client.query('UPDATE coupon_redemptions SET voided_at = now() WHERE order_id = $1 AND voided_at IS NULL', [orderId]);
  }

  private async lockRefund(client: PoolClient, eventId: string, refundId: string, expected: string) {
    const { rows } = await client.query(
      `SELECT f.* FROM refunds f JOIN registrations r ON r.id = f.registration_id
        WHERE f.id = $1 AND r.event_id = $2 FOR UPDATE OF f`,
      [refundId, eventId],
    );
    const f = rows[0];
    if (!f) throw problems.notFound('Refund');
    if (f.status !== expected) throw new ProblemException(409, 'REFUND_STATE', `This refund is ${f.status}, not ${expected}`, undefined, { status: f.status });
    return f;
  }

  private view(f: Record<string, any>) {
    let bank: BankAccount | null = null;
    if (f.manual_bank_info_enc) bank = JSON.parse(decryptPii(f.manual_bank_info_enc, this.config.PII_ENCRYPTION_KEY));
    return {
      id: f.id,
      status: f.status,
      amountSatang: Number(f.amount_satang),
      reason: f.reason,
      requestedByRunner: f.requested_by !== null,
      createdAt: f.created_at,
      updatedAt: f.updated_at,
      note: f.organizer_note,
      transferReference: f.transfer_reference,
      paymentMethod: f.method,
      bank,
      registration: {
        id: f.registration_id,
        registrationNo: f.registration_no,
        name: f.name,
        raceCode: f.race_code,
        bibNumber: f.bib_number,
        status: f.registration_status,
        pricePaidSatang: Number(f.price_paid_satang),
      },
    };
  }
}

function ineligible(code: Ineligible): ProblemException {
  const titles: Record<Ineligible, string> = {
    NOT_CONFIRMED: 'Only a paid place can be refunded or cancelled',
    REFUND_NOT_ALLOWED: 'This event does not refund registrations',
    REFUND_CLOSED: 'The refund period for this event has ended',
    ALREADY_PICKED_UP: 'The kit has already been collected',
    REFUND_IN_PROGRESS: 'A refund for this registration is already in progress',
    TRANSFER_IN_PROGRESS: 'A transfer is open for this place',
    RACE_CHANGE_IN_PROGRESS: 'A race change is waiting for payment',
  };
  return new ProblemException(409, code, titles[code]);
}
