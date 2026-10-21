import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { DatabaseError, PoolClient } from 'pg';
import { z } from 'zod';
import { AppConfig, CONFIG } from '../../config';
import { hashIdDoc, sha256Hex } from '../../common/crypto';
import { ProblemException, problems } from '../../common/problem';
import { DbService } from '../../db/db.service';
import { SessionItems } from '../checkout/checkout.service';
import { InventoryService } from '../inventory/inventory.service';
import { NotificationsService } from '../notifications/notifications.service';
import { profileChoice, requireIdDoc, runnerOrProfileSchema } from '../orders/runner.schema';
import { runnerSnapshot } from '../orders/orders.service';
import { ageOn, computeTotals, PricedLine } from '../orders/pricing';
import { writeAudit } from '../org/org-access.service';
import { checkAnswers, loadQuestions } from '../org/org-questions.service';
import { ConsentContext, orderConsentSchema, recordOrderConsents } from '../privacy/privacy.service';
import { runnerFromProfile, saveRunnerProfile } from '../profiles/profiles.service';
import { WaitlistService } from '../waitlist/waitlist.service';
import { completeRaceChange, completeTransfer, releaseChangeOrder, TransferRunner } from './settle';

export const transferRequestSchema = z.object({ toEmail: z.string().trim().toLowerCase().email().max(200) });
export const acceptTransferSchema = z
  .object({ runner: runnerOrProfileSchema, answers: z.record(z.unknown()).optional(), consents: orderConsentSchema.optional(), ...profileChoice })
  .superRefine(requireIdDoc);
export const raceChangeSchema = z.object({ toRaceId: z.string().uuid() });

/** How long a recipient has to accept, unless the event's transfer deadline comes first. */
const TRANSFER_DAYS = 7;

/** Why a runner cannot transfer or change race right now. */
type Blocked =
  | 'NOT_CONFIRMED'
  | 'TRANSFER_NOT_ALLOWED'
  | 'TRANSFER_CLOSED'
  | 'RACE_CHANGE_NOT_ALLOWED'
  | 'RACE_CHANGE_CLOSED'
  | 'ALREADY_PICKED_UP'
  | 'REFUND_IN_PROGRESS'
  | 'TRANSFER_IN_PROGRESS'
  | 'RACE_CHANGE_IN_PROGRESS';

const BLOCKED_TITLE: Record<Blocked, string> = {
  NOT_CONFIRMED: 'Only a paid place can be transferred or moved',
  TRANSFER_NOT_ALLOWED: 'This event does not allow transfers',
  TRANSFER_CLOSED: 'The transfer deadline has passed',
  RACE_CHANGE_NOT_ALLOWED: 'This event does not allow race changes',
  RACE_CHANGE_CLOSED: 'The race change deadline has passed',
  ALREADY_PICKED_UP: 'The race kit has already been picked up',
  REFUND_IN_PROGRESS: 'A refund request is open for this place',
  TRANSFER_IN_PROGRESS: 'A transfer is already open for this place',
  RACE_CHANGE_IN_PROGRESS: 'A race change is waiting for payment',
};

const blocked = (reason: Blocked, extra?: Record<string, unknown>) => new ProblemException(409, reason, BLOCKED_TITLE[reason], undefined, extra);

/** A registration the user holds: theirs as the runner, or bought by them and not since transferred to someone else. */
const OWN_SQL = `
  SELECT r.id, r.status, r.registration_no, r.race_id, r.event_id, r.kit_picked_up_at, r.price_paid_satang,
         r.gender, r.age_on_race_day, r.first_name_en, r.last_name_en, r.first_name_th, r.last_name_th,
         ra.code AS race_code, e.organization_id, e.name_th AS event_name, e.slug AS event_slug, e.hold_minutes,
         e.allow_transfer, e.transfer_fee_satang, e.allow_race_change, e.race_change_fee_satang,
         COALESCE(e.transfer_deadline, e.event_date::timestamp AT TIME ZONE 'Asia/Bangkok') AS transfer_until,
         COALESCE(e.race_change_deadline, e.event_date::timestamp AT TIME ZONE 'Asia/Bangkok') AS race_change_until,
         EXISTS (SELECT 1 FROM refunds f WHERE f.registration_id = r.id AND f.status IN ('requested', 'approved', 'processing')) AS refund_open,
         (SELECT row_to_json(x) FROM (
            SELECT t.id, t.status, t.to_email AS "toEmail", t.fee_satang AS "feeSatang", t.expires_at AS "expiresAt", t.created_at AS "createdAt"
              FROM transfers t WHERE t.from_registration_id = r.id AND t.status IN ('pending', 'accepted')) x) AS open_transfer,
         (SELECT row_to_json(x) FROM (
            SELECT c.id, c.to_race_id AS "toRaceId", tr.code AS "toRaceCode", c.order_id AS "orderId", c.checkout_session_id AS "sessionId",
                   c.price_diff_satang AS "priceDiffSatang", c.fee_satang AS "feeSatang", o.total_satang AS "totalSatang", o.expires_at AS "expiresAt", o.status AS "orderStatus"
              FROM race_changes c JOIN races tr ON tr.id = c.to_race_id LEFT JOIN orders o ON o.id = c.order_id
             WHERE c.registration_id = r.id AND c.status = 'pending_payment') x) AS open_change
    FROM registrations r
    JOIN races ra ON ra.id = r.race_id
    JOIN events e ON e.id = r.event_id
    LEFT JOIN orders o ON o.id = r.order_id
   WHERE r.id = $2 AND (r.runner_user_id = $1 OR (o.buyer_user_id = $1 AND r.transferred_from_id IS NULL))`;

type OwnRow = Record<string, any>;

@Injectable()
export class ChangesService {
  private readonly logger = new Logger(ChangesService.name);

  constructor(
    private readonly dbs: DbService,
    private readonly inventory: InventoryService,
    private readonly waitlist: WaitlistService,
    private readonly notifications: NotificationsService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  // ---------------------------------------------------------------- runner: what is possible

  /** What the runner may do with a place today: transfer it, move it to another race, or neither and why. */
  async options(userId: string, registrationId: string) {
    const r = await this.own(this.dbs.pool, userId, registrationId);
    const races = await this.dbs.pool.query(
      `SELECT ra.id, ra.code, ra.name_th, ra.distance_km, ra.age_min, ra.age_max, ra.gender_restriction,
              v.available, v.current_price_satang,
              EXISTS (SELECT 1 FROM waitlist_entries w WHERE w.race_id = ra.id AND w.status IN ('waiting', 'offered')) AS queued
         FROM races ra JOIN v_race_availability v ON v.race_id = ra.id
        WHERE ra.event_id = $1 AND ra.is_active AND ra.id <> $2
        ORDER BY ra.sort_order, ra.distance_km DESC`,
      [r.event_id, r.race_id],
    );
    const fee = Number(r.race_change_fee_satang);
    const paid = Number(r.price_paid_satang);
    return {
      registrationId: r.id as string,
      registrationNo: r.registration_no as string,
      raceCode: r.race_code as string,
      runner: runnerName(r),
      event: { slug: r.event_slug as string, name: r.event_name as string },
      pricePaidSatang: paid,
      transfer: {
        allowed: this.blocker(r, 'transfer') === null,
        reason: this.blocker(r, 'transfer'),
        feeSatang: Number(r.transfer_fee_satang),
        until: r.transfer_until as Date,
        open: r.open_transfer,
      },
      raceChange: {
        allowed: this.blocker(r, 'change') === null,
        reason: this.blocker(r, 'change'),
        feeSatang: fee,
        until: r.race_change_until as Date,
        open: r.open_change ? { ...r.open_change, totalSatang: Number(r.open_change.totalSatang ?? 0) } : null,
        options: races.rows.map((ra) => {
          const price = ra.current_price_satang === null ? null : Number(ra.current_price_satang);
          const diff = price === null ? null : price - paid;
          const why =
            price === null ? 'NO_PRICE_AVAILABLE'
            : ra.available <= 0 || ra.queued ? 'SOLD_OUT'
            : notEligible(ra, r) ? 'RACE_NOT_ELIGIBLE'
            : null;
          return {
            raceId: ra.id as string,
            code: ra.code as string,
            name: ra.name_th as string,
            distanceKm: Number(ra.distance_km),
            priceSatang: price,
            priceDiffSatang: diff,
            // Moving to a cheaper race pays nothing back; moving up pays the difference.
            dueSatang: diff === null ? null : Math.max(diff, 0) + fee,
            available: why === null,
            reason: why,
          };
        }),
      },
    };
  }

  // ---------------------------------------------------------------- runner: transfers

  async createTransfer(userId: string, registrationId: string, toEmail: string) {
    const created = await this.dbs.transaction(async (_tx, client) => {
      await client.query('SELECT 1 FROM registrations WHERE id = $1 FOR UPDATE', [registrationId]);
      const r = await this.own(client, userId, registrationId);
      const reason = this.blocker(r, 'transfer') ?? (r.open_transfer ? 'TRANSFER_IN_PROGRESS' : null);
      if (reason) throw blocked(reason);
      const me = await client.query<{ email: string | null; display_name: string | null }>('SELECT email, display_name FROM users WHERE id = $1', [userId]);
      if (me.rows[0]?.email?.toLowerCase() === toEmail) {
        throw new ProblemException(422, 'SELF_TRANSFER', 'Enter the email of the person taking your place');
      }
      const recipient = await client.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [toEmail]);
      const { rows } = await client.query<{ id: string; expires_at: Date }>(
        `INSERT INTO transfers (from_registration_id, from_user_id, to_email, to_user_id, accept_token_hash, fee_satang, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, LEAST(now() + make_interval(days => $7), $8))
         RETURNING id, expires_at`,
        [
          registrationId, userId, toEmail, recipient.rows[0]?.id ?? null, sha256Hex(randomBytes(24).toString('base64url')),
          r.transfer_fee_satang, TRANSFER_DAYS, r.transfer_until,
        ],
      );
      await writeAudit(client, {
        actorId: userId, organizationId: r.organization_id, eventId: r.event_id, action: 'transfer.create',
        entityType: 'transfer', entityId: rows[0].id, after: { registrationId, toEmail },
      });
      return { r, transfer: rows[0], sender: me.rows[0]?.display_name || runnerName(r).th || runnerName(r).en, recipientId: recipient.rows[0]?.id ?? null };
    });

    const { r, transfer } = created;
    const fee = Number(r.transfer_fee_satang);
    const until = new Intl.DateTimeFormat('th-TH', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Bangkok' }).format(transfer.expires_at);
    const text = [
      `${created.sender} โอนสิทธิ์วิ่ง ${r.race_code} งาน ${r.event_name} ให้คุณ`,
      '',
      `เข้าสู่ระบบด้วยอีเมลนี้ แล้วกรอกข้อมูลผู้วิ่งเพื่อรับสิทธิ์ภายใน ${until}`,
      fee > 0 ? `ผู้รับโอนชำระค่าธรรมเนียมโอนสิทธิ์ ${(fee / 100).toLocaleString('th-TH')} บาท` : '',
      `${this.config.PUBLIC_WEB_URL}/me/transfers`,
    ].filter((l, i, all) => l !== '' || all[i - 1] !== '').join('\n');
    // The recipient also sees the transfer whenever they sign in, so a failed email only loses the nudge.
    await this.notifications
      .sendNow(toEmail, `รับโอนสิทธิ์วิ่ง ${r.event_name}`, text, created.recipientId, 'transfer_offer')
      .catch((err: Error) => this.logger.warn(`transfer email to ${toEmail} failed: ${err.message}`));
    return this.options(userId, registrationId);
  }

  /** The sender takes the offer back; a fee the recipient has not paid yet is called off with it. */
  async cancelTransfer(userId: string, transferId: string) {
    return this.dbs.transaction(async (_tx, client) => {
      const { rows } = await client.query(
        `SELECT id, status, fee_order_id, from_registration_id FROM transfers WHERE id = $1 AND from_user_id = $2 FOR UPDATE`,
        [transferId, userId],
      );
      const t = rows[0];
      if (!t) throw problems.notFound('Transfer');
      if (!['pending', 'accepted'].includes(t.status)) throw new ProblemException(409, 'TRANSFER_CLOSED', 'This transfer is already closed');
      if (t.status === 'accepted') await this.callOffOrder(client, t.fee_order_id, 'cancelled');
      await client.query(`UPDATE transfers SET status = 'cancelled', cancelled_at = now(), runner_payload = NULL WHERE id = $1`, [transferId]);
      return { id: transferId, status: 'cancelled', registrationId: t.from_registration_id as string };
    });
  }

  /** Transfers offered to the user (by their email) and the ones they have sent. */
  async mine(userId: string) {
    const { rows } = await this.dbs.pool.query(
      `SELECT t.id, t.status, t.to_email, t.fee_satang, t.expires_at, t.created_at, t.completed_at, t.fee_order_id, t.from_user_id,
              t.to_registration_id, t.from_registration_id,
              (t.from_user_id = $1) AS outgoing,
              r.registration_no, r.race_id, r.first_name_en, r.last_name_en, r.first_name_th, r.last_name_th, r.shirt_size,
              ra.code AS race_code, ra.distance_km, e.slug AS event_slug, e.name_th AS event_name, e.event_date::text AS event_date,
              COALESCE(u.display_name, u.email::text) AS sender, o.status AS fee_order_status
         FROM transfers t
         JOIN registrations r ON r.id = t.from_registration_id
         JOIN races ra ON ra.id = r.race_id
         JOIN events e ON e.id = r.event_id
         JOIN users u ON u.id = t.from_user_id
         LEFT JOIN orders o ON o.id = t.fee_order_id
        WHERE t.from_user_id = $1
           OR ((t.to_user_id = $1 OR t.to_email = (SELECT email FROM users WHERE id = $1)) AND t.status IN ('pending', 'accepted', 'completed'))
        ORDER BY t.created_at DESC
        LIMIT 50`,
      [userId],
    );
    const view = (t: Record<string, any>) => ({
      id: t.id as string,
      status: t.status === 'pending' && new Date(t.expires_at) <= new Date() ? 'expired' : (t.status as string),
      toEmail: t.to_email as string,
      sender: t.sender as string,
      feeSatang: Number(t.fee_satang),
      expiresAt: t.expires_at as Date,
      createdAt: t.created_at as Date,
      completedAt: t.completed_at as Date | null,
      // A fee order the recipient started and can still pay.
      feeOrderId: t.status === 'accepted' && t.fee_order_status === 'pending_payment' ? (t.fee_order_id as string) : null,
      registrationId: (t.outgoing ? t.from_registration_id : t.to_registration_id) as string | null,
      race: { id: t.race_id as string, code: t.race_code as string, distanceKm: Number(t.distance_km) },
      event: { slug: t.event_slug as string, name: t.event_name as string, eventDate: t.event_date as string },
      shirtSize: t.shirt_size as string | null,
      // The recipient only learns who is giving them the place, not the sender's runner details.
      ...(t.outgoing ? { registrationNo: t.registration_no as string, runner: runnerName(t) } : {}),
    });
    return {
      incoming: rows.filter((t) => !t.outgoing).map(view),
      outgoing: rows.filter((t) => t.outgoing).map(view),
    };
  }

  /**
   * The recipient takes the place with their own details. With no fee the place is theirs at once; otherwise
   * the details are kept on the transfer and the place moves when the fee order is paid.
   */
  async acceptTransfer(userId: string, transferId: string, input: z.infer<typeof acceptTransferSchema>, context: ConsentContext = { ip: null, userAgent: null }) {
    const result = await this.dbs.transaction(async (_tx, client) => {
      const { rows } = await client.query(
        `SELECT t.id, t.status, t.fee_satang, t.expires_at, t.fee_order_id, t.from_registration_id, t.to_email,
                r.status AS reg_status, r.kit_picked_up_at, r.race_id, r.event_id, r.id_doc_hash AS from_hash,
                ra.code AS race_code, ra.name_th AS race_name, ra.age_min, ra.age_max, ra.gender_restriction,
                e.event_date::text AS event_date, e.organization_id, e.hold_minutes,
                o.status AS fee_order_status
           FROM transfers t
           JOIN registrations r ON r.id = t.from_registration_id
           JOIN races ra ON ra.id = r.race_id
           JOIN events e ON e.id = r.event_id
           LEFT JOIN orders o ON o.id = t.fee_order_id
          WHERE t.id = $1 AND (t.to_user_id = $2 OR t.to_email = (SELECT email FROM users WHERE id = $2))
          FOR UPDATE OF t`,
        [transferId, userId],
      );
      const t = rows[0];
      if (!t) throw problems.notFound('Transfer');
      if (t.status === 'accepted' && t.fee_order_status === 'pending_payment') {
        return { status: 'pending_payment' as const, orderId: t.fee_order_id as string };
      }
      if (t.status !== 'pending' || new Date(t.expires_at) <= new Date()) {
        throw new ProblemException(409, 'TRANSFER_CLOSED', 'This transfer is no longer open');
      }
      if (t.reg_status !== 'confirmed' || t.kit_picked_up_at) {
        throw new ProblemException(409, 'TRANSFER_UNAVAILABLE', 'This place can no longer be transferred');
      }

      const runner = input.profileId
        ? await runnerFromProfile(client, userId, input.profileId, input.runner, this.config.PII_ENCRYPTION_KEY)
        : input.runner.idDocNumber ? { ...input.runner, idDocNumber: input.runner.idDocNumber } : null;
      if (!runner) throw problems.validation('That saved runner is not available', [{ path: 'profileId', message: 'not found' }]);
      const age = ageOn(runner.birthDate, t.event_date);
      const errors: { path: string; message: string }[] = [];
      if (t.age_min !== null && age < t.age_min) errors.push({ path: 'runner.birthDate', message: `ต้องอายุอย่างน้อย ${t.age_min} ปีในวันแข่ง` });
      if (t.age_max !== null && age > t.age_max) errors.push({ path: 'runner.birthDate', message: `อายุเกิน ${t.age_max} ปีในวันแข่ง` });
      if (t.gender_restriction && t.gender_restriction !== runner.gender) errors.push({ path: 'runner.gender', message: 'ระยะนี้รับเฉพาะบางเพศ' });
      const questions = await loadQuestions(client, t.event_id);
      const answers = checkAnswers(questions, t.race_id, input.answers, 'answers', errors);
      if (errors.length) throw problems.validation(`This runner cannot take the ${t.race_code} place`, errors);

      const idDocHash = hashIdDoc(runner.idDocNumber, this.config.PII_HASH_KEY);
      const taken = await client.query(
        `SELECT 1 FROM registrations WHERE race_id = $1 AND id_doc_hash = $2 AND status IN ('pending', 'confirmed')`,
        [t.race_id, idDocHash],
      );
      if (taken.rowCount || idDocHash === t.from_hash) {
        throw new ProblemException(409, 'ALREADY_REGISTERED', 'This runner already holds a place in this race');
      }

      const payload: TransferRunner = {
        snapshot: runnerSnapshot(runner, this.config.PII_ENCRYPTION_KEY),
        idDocHash, age, answers,
        firstNameEn: runner.firstNameEn.toUpperCase(), lastNameEn: runner.lastNameEn.toUpperCase(),
        firstNameTh: runner.firstNameTh ?? null, lastNameTh: runner.lastNameTh ?? null,
        gender: runner.gender, birthDate: runner.birthDate, nationality: runner.nationality.toUpperCase(),
        email: runner.email ?? null, phone: runner.phone ?? null,
      };
      await client.query('UPDATE transfers SET to_user_id = $2, runner_payload = $3 WHERE id = $1', [transferId, userId, JSON.stringify(payload)]);
      if (input.saveProfile) {
        await saveRunnerProfile(client, userId, runner, false, { pii: this.config.PII_ENCRYPTION_KEY, hash: this.config.PII_HASH_KEY });
      }
      if (input.consents) {
        await recordOrderConsents(client, { userId, organizationId: t.organization_id, registrationIds: [], consents: input.consents, context });
      }

      const fee = Number(t.fee_satang);
      if (fee === 0) {
        if (!(await completeTransfer(client, transferId))) throw new ProblemException(409, 'TRANSFER_UNAVAILABLE', 'This place can no longer be transferred');
        const done = await client.query<{ to_registration_id: string }>('SELECT to_registration_id FROM transfers WHERE id = $1', [transferId]);
        return { status: 'completed' as const, registrationId: done.rows[0].to_registration_id };
      }

      const user = await client.query<{ email: string | null; display_name: string | null }>('SELECT email, display_name FROM users WHERE id = $1', [userId]);
      const orderId = await this.createOrder(client, {
        eventId: t.event_id, organizationId: t.organization_id, userId, holdMinutes: t.hold_minutes,
        buyer: { name: `${runner.firstNameTh ?? runner.firstNameEn} ${runner.lastNameTh ?? runner.lastNameEn}`, email: user.rows[0]?.email ?? runner.email ?? null, phone: runner.phone ?? null },
        lines: [{ type: 'transfer_fee', description: `ค่าธรรมเนียมรับโอนสิทธิ์ ${t.race_code}`, unitPriceSatang: fee }],
      });
      await client.query(`UPDATE transfers SET status = 'accepted', fee_order_id = $2 WHERE id = $1`, [transferId, orderId.orderId]);
      return { status: 'pending_payment' as const, orderId: orderId.orderId };
    });
    return result;
  }

  /** The recipient turns the place down; the sender keeps it and may offer it to someone else. */
  async declineTransfer(userId: string, transferId: string) {
    return this.dbs.transaction(async (_tx, client) => {
      const { rows } = await client.query(
        `SELECT id, status, fee_order_id FROM transfers
          WHERE id = $1 AND (to_user_id = $2 OR to_email = (SELECT email FROM users WHERE id = $2)) FOR UPDATE`,
        [transferId, userId],
      );
      const t = rows[0];
      if (!t) throw problems.notFound('Transfer');
      if (!['pending', 'accepted'].includes(t.status)) throw new ProblemException(409, 'TRANSFER_CLOSED', 'This transfer is already closed');
      if (t.status === 'accepted') await this.callOffOrder(client, t.fee_order_id, 'cancelled');
      await client.query(`UPDATE transfers SET status = 'rejected', runner_payload = NULL WHERE id = $1`, [transferId]);
      return { id: transferId, status: 'rejected' };
    });
  }

  /** Lapses transfers nobody accepted in time. Run by the 30-second job. */
  async expireTransfers(): Promise<number> {
    const res = await this.dbs.pool.query(`UPDATE transfers SET status = 'expired' WHERE status = 'pending' AND expires_at < now()`);
    return res.rowCount ?? 0;
  }

  // ---------------------------------------------------------------- runner: race changes

  /**
   * Holds a place in the new race and creates the order for the difference and fee. When nothing is due the
   * runner moves at once; otherwise they move when the order is paid, and the hold lapses with the order.
   */
  async requestRaceChange(userId: string, registrationId: string, toRaceId: string) {
    const result = await this.dbs.transaction(async (_tx, client) => {
      await client.query('SELECT 1 FROM registrations WHERE id = $1 FOR UPDATE', [registrationId]);
      let r = await this.own(client, userId, registrationId);
      if (r.lapsed_change) {
        // The last attempt ran out of time (or its checkout was dropped) but has not been tidied up yet.
        await this.callOffOrder(client, r.lapsed_change.orderId, 'expired');
        r = await this.own(client, userId, registrationId);
      }
      if (r.open_change) throw blocked('RACE_CHANGE_IN_PROGRESS', { orderId: r.open_change.orderId });
      const reason = this.blocker(r, 'change');
      if (reason) throw blocked(reason);

      const target = await client.query(
        `SELECT ra.id, ra.code, ra.name_th, ra.age_min, ra.age_max, ra.gender_restriction,
                EXISTS (SELECT 1 FROM waitlist_entries w WHERE w.race_id = ra.id AND w.status IN ('waiting', 'offered')) AS queued
           FROM races ra WHERE ra.id = $1 AND ra.event_id = $2 AND ra.is_active AND ra.id <> $3`,
        [toRaceId, r.event_id, r.race_id],
      );
      const to = target.rows[0];
      if (!to) throw problems.validation('Choose another race of this event', [{ path: 'toRaceId', message: 'invalid' }]);
      if (notEligible(to, r)) throw new ProblemException(409, 'RACE_NOT_ELIGIBLE', `This runner cannot enter ${to.code}`);
      // People queuing for a full race get its freed places first.
      if (to.queued) throw new ProblemException(409, 'SOLD_OUT', 'This race is full', undefined, { raceId: to.id });

      const session = await client.query<{ id: string; expires_at: Date }>(
        `INSERT INTO checkout_sessions (event_id, user_id, items, expires_at)
         VALUES ($1, $2, '{}', now() + make_interval(mins => $3)) RETURNING id, expires_at`,
        [r.event_id, userId, r.hold_minutes],
      );
      const { id: sessionId, expires_at: expiresAt } = session.rows[0];
      const hold = await this.inventory.reserveRace(client, to.id, 1);
      await client.query(
        `INSERT INTO inventory_holds (checkout_session_id, race_id, price_tier_id, quantity, expires_at) VALUES ($1, $2, $3, 1, $4)`,
        [sessionId, to.id, hold.priceTierId, expiresAt],
      );
      const items: SessionItems = {
        races: [{ raceId: to.id, code: to.code, quantity: 1, priceTierId: hold.priceTierId, tierName: hold.tierName, priceSatang: hold.priceSatang }],
        variants: [],
      };
      await client.query('UPDATE checkout_sessions SET items = $2 WHERE id = $1', [sessionId, JSON.stringify(items)]);

      const diff = hold.priceSatang - Number(r.price_paid_satang);
      const fee = Number(r.race_change_fee_satang);
      const user = await client.query<{ email: string | null; display_name: string | null }>('SELECT email, display_name FROM users WHERE id = $1', [userId]);
      const order = await this.createOrder(client, {
        eventId: r.event_id, organizationId: r.organization_id, userId, sessionId, expiresAt,
        buyer: { name: user.rows[0]?.display_name ?? runnerName(r).en, email: user.rows[0]?.email ?? null, phone: null },
        lines: [
          { type: 'race', raceId: to.id, priceTierId: hold.priceTierId, description: `เปลี่ยนเป็น ${to.code} · ส่วนต่างราคา`, unitPriceSatang: Math.max(diff, 0) },
          ...(fee > 0 ? [{ type: 'change_fee' as const, description: 'ค่าธรรมเนียมเปลี่ยนระยะ', unitPriceSatang: fee }] : []),
        ],
      });
      const change = await client.query<{ id: string }>(
        `INSERT INTO race_changes (registration_id, from_race_id, to_race_id, price_diff_satang, fee_satang, order_id, checkout_session_id, requested_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [registrationId, r.race_id, to.id, diff, fee, order.orderId, sessionId, userId],
      );

      if (order.totalSatang > 0) return { status: 'pending_payment' as const, orderId: order.orderId, raceChangeId: change.rows[0].id, fromRaceId: null };
      // Nothing to pay: the order is settled on the spot and the runner moves now.
      await this.inventory.commitSession(client, sessionId);
      await client.query(`UPDATE orders SET status = 'paid', paid_at = now() WHERE id = $1`, [order.orderId]);
      await client.query(`UPDATE checkout_sessions SET status = 'converted' WHERE id = $1`, [sessionId]);
      await completeRaceChange(client, change.rows[0].id);
      return { status: 'completed' as const, orderId: order.orderId, raceChangeId: change.rows[0].id, fromRaceId: r.race_id as string };
    });
    if (result.fromRaceId) await this.waitlist.offerFreed(result.fromRaceId);
    const { fromRaceId: _, ...view } = result;
    return view;
  }

  /** Gives up a race change that is waiting for payment; the place in the new race goes back on sale. */
  async cancelRaceChange(userId: string, raceChangeId: string) {
    return this.dbs.transaction(async (_tx, client) => {
      const { rows } = await client.query(
        `SELECT c.id, c.status, c.order_id, c.registration_id FROM race_changes c
          WHERE c.id = $1 AND c.requested_by = $2 FOR UPDATE`,
        [raceChangeId, userId],
      );
      const c = rows[0];
      if (!c) throw problems.notFound('Race change');
      if (c.status !== 'pending_payment') throw new ProblemException(409, 'RACE_CHANGE_CLOSED', 'This race change is already closed');
      await this.callOffOrder(client, c.order_id, 'cancelled');
      return { id: raceChangeId, status: 'cancelled', registrationId: c.registration_id as string };
    });
  }

  // ---------------------------------------------------------------- organiser

  /** Every transfer and race change in the event, newest first. */
  async forEvent(eventId: string) {
    const transfers = await this.dbs.pool.query(
      `SELECT t.id, t.status, t.to_email, t.fee_satang, t.expires_at, t.created_at, t.completed_at,
              f.id AS from_id, f.registration_no AS from_no, ${nameSql('f')} AS from_name,
              n.id AS to_id, n.registration_no AS to_no, ${nameSql('n')} AS to_name,
              ra.code AS race_code, COALESCE(n.bib_number, f.bib_number) AS bib_number
         FROM transfers t
         JOIN registrations f ON f.id = t.from_registration_id
         LEFT JOIN registrations n ON n.id = t.to_registration_id
         JOIN races ra ON ra.id = f.race_id
        WHERE f.event_id = $1
        ORDER BY t.created_at DESC LIMIT 200`,
      [eventId],
    );
    const changes = await this.dbs.pool.query(
      `SELECT c.id, c.status, c.price_diff_satang, c.fee_satang, c.created_at, c.completed_at, c.order_id,
              r.id AS registration_id, r.registration_no, r.bib_number, ${nameSql('r')} AS name,
              fr.code AS from_code, tr.code AS to_code, o.total_satang, o.status AS order_status,
              COALESCE(u.display_name, u.email::text) AS requested_by, (u.id = r.runner_user_id OR u.id = ro.buyer_user_id) AS by_runner
         FROM race_changes c
         JOIN registrations r ON r.id = c.registration_id
         LEFT JOIN orders ro ON ro.id = r.order_id
         JOIN races fr ON fr.id = c.from_race_id
         JOIN races tr ON tr.id = c.to_race_id
         LEFT JOIN orders o ON o.id = c.order_id
         LEFT JOIN users u ON u.id = c.requested_by
        WHERE r.event_id = $1
        ORDER BY c.created_at DESC LIMIT 200`,
      [eventId],
    );
    const now = Date.now();
    return {
      transfers: transfers.rows.map((t) => ({
        id: t.id as string,
        status: t.status === 'pending' && new Date(t.expires_at).getTime() <= now ? 'expired' : (t.status as string),
        raceCode: t.race_code as string,
        bibNumber: t.bib_number as string | null,
        from: { registrationId: t.from_id as string, registrationNo: t.from_no as string, name: t.from_name as string },
        to: { email: t.to_email as string, registrationId: t.to_id as string | null, registrationNo: t.to_no as string | null, name: t.to_name as string | null },
        feeSatang: Number(t.fee_satang),
        expiresAt: t.expires_at as Date,
        createdAt: t.created_at as Date,
        completedAt: t.completed_at as Date | null,
      })),
      raceChanges: changes.rows.map((c) => ({
        id: c.id as string,
        status: c.status as string,
        registrationId: c.registration_id as string,
        registrationNo: c.registration_no as string,
        name: c.name as string,
        bibNumber: c.bib_number as string | null,
        fromRaceCode: c.from_code as string,
        toRaceCode: c.to_code as string,
        priceDiffSatang: Number(c.price_diff_satang),
        feeSatang: Number(c.fee_satang),
        paidSatang: c.order_status === 'paid' ? Number(c.total_satang) : 0,
        byOrganizer: c.order_id === null,
        requestedBy: c.requested_by as string | null,
        createdAt: c.created_at as Date,
        completedAt: c.completed_at as Date | null,
      })),
    };
  }

  /**
   * The organiser moves a runner to another race of the event: no payment, and the event's change policy and the
   * race's age rules do not apply. The new race must still have a free place.
   */
  async organiserRaceChange(actorId: string, eventId: string, registrationId: string, toRaceId: string) {
    let fromRaceId: string;
    try {
      fromRaceId = await this.dbs.transaction(async (_tx, client) => {
        const { rows } = await client.query(
          'SELECT id, status, race_id FROM registrations WHERE id = $1 AND event_id = $2 FOR UPDATE',
          [registrationId, eventId],
        );
        const r = rows[0];
        if (!r) throw problems.notFound('Registration');
        if (r.status !== 'confirmed') throw blocked('NOT_CONFIRMED');
        const target = await client.query('SELECT id FROM races WHERE id = $1 AND event_id = $2 AND is_active AND id <> $3', [toRaceId, eventId, r.race_id]);
        if (!target.rowCount) throw problems.validation('Choose another race of this event', [{ path: 'toRaceId', message: 'invalid' }]);
        const taken = await client.query(
          'UPDATE races SET sold = sold + 1 WHERE id = $1 AND sold + reserved + 1 <= capacity RETURNING id',
          [toRaceId],
        );
        if (!taken.rowCount) throw new ProblemException(409, 'SOLD_OUT', 'This race is full', undefined, { raceId: toRaceId });
        const change = await client.query<{ id: string }>(
          `INSERT INTO race_changes (registration_id, from_race_id, to_race_id, requested_by) VALUES ($1, $2, $3, $4) RETURNING id`,
          [registrationId, r.race_id, toRaceId, actorId],
        );
        await completeRaceChange(client, change.rows[0].id, actorId);
        return r.race_id as string;
      });
    } catch (err) {
      if (err instanceof DatabaseError && err.code === '23505' && err.constraint === 'uq_race_changes_open') throw blocked('RACE_CHANGE_IN_PROGRESS');
      throw err;
    }
    await this.waitlist.offerFreed(fromRaceId);
    return { registrationId, toRaceId };
  }

  // ---------------------------------------------------------------- internals

  private async own(db: Pick<PoolClient, 'query'>, userId: string, registrationId: string): Promise<OwnRow> {
    const { rows } = await db.query(OWN_SQL, [userId, registrationId]);
    const r = rows[0];
    if (!r) throw problems.notFound('Registration');
    // A change whose order ran out or was dropped is over, even before the 30-second job marks it so.
    const c = r.open_change;
    if (c && (c.orderStatus !== 'pending_payment' || new Date(c.expiresAt) <= new Date())) {
      r.lapsed_change = c;
      r.open_change = null;
    }
    return r;
  }

  /** The first reason the runner cannot start a transfer or race change; an open one of the same kind is shown, not a blocker. */
  private blocker(r: OwnRow, kind: 'transfer' | 'change'): Blocked | null {
    if (r.status !== 'confirmed') return 'NOT_CONFIRMED';
    if (kind === 'transfer' && !r.allow_transfer) return 'TRANSFER_NOT_ALLOWED';
    if (kind === 'change' && !r.allow_race_change) return 'RACE_CHANGE_NOT_ALLOWED';
    const until = new Date(kind === 'transfer' ? r.transfer_until : r.race_change_until);
    if (until.getTime() <= Date.now()) return kind === 'transfer' ? 'TRANSFER_CLOSED' : 'RACE_CHANGE_CLOSED';
    if (r.kit_picked_up_at) return 'ALREADY_PICKED_UP';
    if (r.refund_open) return 'REFUND_IN_PROGRESS';
    if (kind === 'transfer' && r.open_change) return 'RACE_CHANGE_IN_PROGRESS';
    if (kind === 'change' && r.open_transfer) return 'TRANSFER_IN_PROGRESS';
    return null;
  }

  /**
   * An order for a fee or price difference: no platform share and no coupon, but the usual payment fee. It runs on a
   * checkout session of its own, so the 30-second job expires it like any other unpaid order.
   */
  private async createOrder(
    client: PoolClient,
    o: {
      eventId: string; organizationId: string; userId: string; sessionId?: string; expiresAt?: Date; holdMinutes?: number;
      buyer: { name: string; email: string | null; phone: string | null };
      lines: { type: 'race' | 'transfer_fee' | 'change_fee'; raceId?: string; priceTierId?: string; description: string; unitPriceSatang: number }[];
    },
  ): Promise<{ orderId: string; totalSatang: number }> {
    let { sessionId, expiresAt } = o;
    if (!sessionId) {
      const session = await client.query<{ id: string; expires_at: Date }>(
        `INSERT INTO checkout_sessions (event_id, user_id, items, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(mins => $4)) RETURNING id, expires_at`,
        [o.eventId, o.userId, JSON.stringify({ races: [], variants: [] } satisfies SessionItems), o.holdMinutes ?? 15],
      );
      sessionId = session.rows[0].id;
      expiresAt = session.rows[0].expires_at;
    }
    const priced: PricedLine[] = o.lines.map((l, i) => ({ key: String(i), unitPriceSatang: l.unitPriceSatang, quantity: 1 }));
    const totals = computeTotals(priced, null, this.config.RUNNER_FEE_BPS);
    const seq = await client.query<{ n: string }>(`SELECT nextval('order_no_seq') AS n`);
    const orderNo = `KAO${new Date().getFullYear().toString().slice(2)}-${seq.rows[0].n.padStart(6, '0')}`;
    const order = await client.query<{ id: string }>(
      `INSERT INTO orders (order_no, event_id, organization_id, buyer_user_id, checkout_session_id,
                           subtotal_satang, fee_satang, total_satang, buyer_name, buyer_email, buyer_phone, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [
        orderNo, o.eventId, o.organizationId, o.userId, sessionId, totals.subtotalSatang, totals.feeSatang, totals.totalSatang,
        o.buyer.name, o.buyer.email, o.buyer.phone, expiresAt,
      ],
    );
    const orderId = order.rows[0].id;
    for (const l of o.lines) {
      await client.query(
        `INSERT INTO order_items (order_id, item_type, race_id, price_tier_id, description, quantity, unit_price_satang, total_satang)
         VALUES ($1, $2, $3, $4, $5, 1, $6, $6)`,
        [orderId, l.type, l.raceId ?? null, l.priceTierId ?? null, l.description, l.unitPriceSatang],
      );
    }
    if (totals.feeSatang > 0) {
      await client.query(
        `INSERT INTO order_items (order_id, item_type, description, quantity, unit_price_satang, total_satang)
         VALUES ($1, 'fee', 'Payment fee', 1, $2, $2)`,
        [orderId, totals.feeSatang],
      );
    }
    return { orderId, totalSatang: totals.totalSatang };
  }

  /**
   * Closes an unpaid change order and its checkout: held places go back, a QR already shown stops counting
   * (a payment that still arrives is refunded), and the change it was for lapses.
   */
  private async callOffOrder(client: PoolClient, orderId: string | null, status: 'cancelled' | 'expired'): Promise<void> {
    if (!orderId) return;
    const { rows } = await client.query<{ checkout_session_id: string | null }>(
      `UPDATE orders SET status = $2, cancelled_at = CASE WHEN $3 THEN now() END
        WHERE id = $1 AND status = 'pending_payment' RETURNING checkout_session_id`,
      [orderId, status, status === 'cancelled'],
    );
    if (rows[0]) {
      await client.query(`UPDATE payments SET status = 'expired' WHERE order_id = $1 AND status = 'pending'`, [orderId]);
      if (rows[0].checkout_session_id) {
        await this.inventory.releaseSession(client, rows[0].checkout_session_id);
        await client.query(`UPDATE checkout_sessions SET status = $2 WHERE id = $1 AND status = 'active'`, [
          rows[0].checkout_session_id, status === 'cancelled' ? 'abandoned' : 'expired',
        ]);
      }
    }
    await releaseChangeOrder(client, orderId);
  }
}

function runnerName(r: Record<string, any>) {
  return { en: `${r.first_name_en} ${r.last_name_en}`, th: r.first_name_th ? `${r.first_name_th} ${r.last_name_th ?? ''}`.trim() : null };
}

function nameSql(alias: string): string {
  return `COALESCE(NULLIF(trim(coalesce(${alias}.first_name_th, '') || ' ' || coalesce(${alias}.last_name_th, '')), ''), ${alias}.first_name_en || ' ' || ${alias}.last_name_en)`;
}

/** Whether the runner's age on race day or gender keeps them out of the race. */
function notEligible(race: Record<string, any>, r: Record<string, any>): boolean {
  return (
    (race.age_min !== null && r.age_on_race_day < race.age_min) ||
    (race.age_max !== null && r.age_on_race_day > race.age_max) ||
    (race.gender_restriction !== null && race.gender_restriction !== r.gender)
  );
}
