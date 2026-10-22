import { Inject, Injectable, Logger } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AppConfig, CONFIG } from '../../config';
import { FILE_STORAGE, FileStorage } from '../../common/storage';
import { DbService } from '../../db/db.service';

/** What one run erased (or, in the report, would erase), per kind of record. */
export interface RetentionCounts {
  /** Registrations whose runner details were cut down to what results, kit history and accounting need. */
  registrations: number;
  /** Orders whose buyer contact details went (amounts stay; unpaid ones lose the name and billing details too). */
  orders: number;
  /** Transfers whose recipient email and details went. */
  transfers: number;
  /** Closed accounts whose remaining sign-ins, sessions and messages went. */
  closedAccounts: number;
  /** KYC files deleted from storage. */
  kycDocuments: number;
  /** One-time codes and stored idempotent responses long past their expiry. */
  expiredCodes: number;
}

type Db = Pick<PoolClient, 'query'>;

/** The parts of a runner snapshot a confirmed registration keeps: the name on results and kit lists, and the ID type. */
const SNAPSHOT_KEEPS = ['firstNameTh', 'lastNameTh', 'firstNameEn', 'lastNameEn', 'gender', 'nationality', 'idDocType'];

/**
 * Data retention (PDPA: personal data is kept only as long as it is needed). A daily job (JobsService) erases what the
 * periods in config say is no longer needed; admins see what is due with a dry run (`GET /v1/admin/retention`).
 *
 * - Registrations of events that ended more than RETENTION_REGISTRATION_DAYS ago: the encrypted ID number and its last
 *   digits, the ID hash, birth date (only the year stays), blood type, emergency contact, email, phone and answers to
 *   the organiser's questions go. Name, gender, nationality, race, bib, age on race day, age group, shirt size, status,
 *   price paid and kit pickup stay for results, kit history and accounting. A proxy's ID note at kit pickup goes too.
 * - Orders of those events: buyer email, phone and shipping address go; amounts, buyer name and billing details stay
 *   for accounting. Closed refund requests lose the runner's bank details; amounts and the transfer reference stay.
 * - Unpaid orders that lapsed RETENTION_UNPAID_DAYS ago, with their never-confirmed registrations: everything the buyer
 *   typed goes, names included. Transfers that were not completed lose the recipient's email and details as well.
 * - Accounts closed RETENTION_CLOSED_ACCOUNT_DAYS ago: sign-in identities, sessions, messages and stored responses go,
 *   and their registrations and orders are erased as above without waiting for the event period.
 * - KYC files: a rejected document RETENTION_KYC_DAYS after review, and every document of a team still waiting for KYC
 *   with no activity for that long. Approved documents of working teams stay.
 * - Consents and audit_logs are kept as evidence of what was agreed and who did what; nothing here deletes them.
 *
 * Every step works in batches of RETENTION_BATCH_SIZE rows, one short transaction each, and marks what it erased
 * (`pii_erased_at`), so running it again changes nothing.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly dbs: DbService,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  get periods() {
    return {
      registrationDays: this.config.RETENTION_REGISTRATION_DAYS,
      unpaidDays: this.config.RETENTION_UNPAID_DAYS,
      closedAccountDays: this.config.RETENTION_CLOSED_ACCOUNT_DAYS,
      kycDays: this.config.RETENTION_KYC_DAYS,
    };
  }

  /**
   * What each step looks at: the ids of the rows it would erase now. Registrations, orders and transfers take
   * $1 = days after an event, $2 = days after an unpaid order or transfer lapsed, $3 = days after an account closed.
   */
  private steps() {
    const p = this.periods;
    const three = [p.registrationDays, p.unpaidDays, p.closedAccountDays];
    return {
      registrations: {
        table: 'registrations',
        params: three,
        sql: `SELECT r.id FROM registrations r JOIN events e ON e.id = r.event_id
               WHERE r.pii_erased_at IS NULL AND coalesce(e.event_end_date, e.event_date) < current_date - $1::int
              UNION
              SELECT r.id FROM registrations r
               WHERE r.pii_erased_at IS NULL AND r.confirmed_at IS NULL AND r.status = 'cancelled'
                 AND r.cancelled_at < now() - make_interval(days => $2::int)
              UNION
              SELECT r.id FROM registrations r JOIN users u ON u.id = r.runner_user_id
               WHERE r.pii_erased_at IS NULL AND u.status = 'deleted' AND u.deleted_at < now() - make_interval(days => $3::int)
              UNION
              -- What a closed account typed in for others; a place transferred on to someone else is theirs now.
              SELECT r.id FROM registrations r JOIN orders o ON o.id = r.order_id JOIN users u ON u.id = o.buyer_user_id
               WHERE r.pii_erased_at IS NULL AND r.transferred_from_id IS NULL
                 AND u.status = 'deleted' AND u.deleted_at < now() - make_interval(days => $3::int)`,
      },
      orders: {
        table: 'orders',
        params: three,
        sql: `SELECT o.id FROM orders o JOIN events e ON e.id = o.event_id
               WHERE o.pii_erased_at IS NULL AND coalesce(e.event_end_date, e.event_date) < current_date - $1::int
              UNION
              SELECT o.id FROM orders o
               WHERE o.pii_erased_at IS NULL AND o.paid_at IS NULL AND o.status IN ('expired', 'cancelled')
                 AND coalesce(o.cancelled_at, o.expires_at, o.created_at) < now() - make_interval(days => $2::int)
              UNION
              SELECT o.id FROM orders o JOIN users u ON u.id = o.buyer_user_id
               WHERE o.pii_erased_at IS NULL AND u.status = 'deleted' AND u.deleted_at < now() - make_interval(days => $3::int)`,
      },
      transfers: {
        table: 'transfers',
        params: three,
        sql: `SELECT t.id FROM transfers t JOIN registrations r ON r.id = t.from_registration_id JOIN events e ON e.id = r.event_id
               WHERE t.pii_erased_at IS NULL AND coalesce(e.event_end_date, e.event_date) < current_date - $1::int
              UNION
              SELECT t.id FROM transfers t
               WHERE t.pii_erased_at IS NULL AND t.status IN ('rejected', 'expired', 'cancelled')
                 AND coalesce(t.cancelled_at, t.expires_at) < now() - make_interval(days => $2::int)
              UNION
              SELECT t.id FROM transfers t JOIN users u ON u.id IN (t.from_user_id, t.to_user_id)
               WHERE t.pii_erased_at IS NULL AND u.status = 'deleted' AND u.deleted_at < now() - make_interval(days => $3::int)`,
      },
      closedAccounts: {
        table: 'users',
        params: [p.closedAccountDays],
        sql: `SELECT u.id FROM users u
               WHERE u.status = 'deleted' AND u.pii_erased_at IS NULL AND u.deleted_at < now() - make_interval(days => $1::int)`,
      },
      kycDocuments: {
        table: 'organizer_kyc_documents',
        params: [p.kycDays],
        sql: `SELECT d.id FROM organizer_kyc_documents d
               WHERE d.status = 'rejected' AND d.reviewed_at < now() - make_interval(days => $1::int)
              UNION
              -- A team that stopped part-way through signing up: nothing changed and nothing uploaded for the whole period.
              SELECT d.id FROM organizer_kyc_documents d JOIN organizations o ON o.id = d.organization_id
               WHERE o.status = 'pending_kyc' AND o.updated_at < now() - make_interval(days => $1::int)
                 AND NOT EXISTS (SELECT 1 FROM organizer_kyc_documents x
                                  WHERE x.organization_id = o.id AND x.created_at >= now() - make_interval(days => $1::int))`,
      },
    };
  }

  /** What a run would erase now, without changing anything, plus what is kept on purpose. */
  async report() {
    const steps = this.steps();
    const count = async (step: { sql: string; params: number[] }) =>
      Number((await this.dbs.pool.query(`SELECT count(*) AS n FROM (${step.sql}) c`, step.params)).rows[0].n);
    const codes = await this.dbs.pool.query(
      `SELECT (SELECT count(*) FROM otp_codes WHERE expires_at < now() - make_interval(days => $1::int))
            + (SELECT count(*) FROM idempotency_keys WHERE expires_at < now() - make_interval(days => $1::int)) AS n`,
      [this.periods.unpaidDays],
    );
    const due: RetentionCounts = {
      registrations: await count(steps.registrations),
      orders: await count(steps.orders),
      transfers: await count(steps.transfers),
      closedAccounts: await count(steps.closedAccounts),
      kycDocuments: await count(steps.kycDocuments),
      expiredCodes: Number(codes.rows[0].n),
    };
    const kept = await this.dbs.pool.query(
      `SELECT (SELECT count(*) FROM consents)::int AS consents, (SELECT min(granted_at) FROM consents) AS consents_since,
              (SELECT count(*) FROM audit_logs)::int AS audit_logs, (SELECT min(created_at) FROM audit_logs) AS audit_logs_since`,
    );
    const last = await this.dbs.pool.query(
      `SELECT actor_type, actor_id, after_data, created_at FROM audit_logs WHERE action = 'retention.run' ORDER BY id DESC LIMIT 1`,
    );
    const k = kept.rows[0];
    const l = last.rows[0];
    return {
      dryRun: true as const,
      periods: this.periods,
      schedule: this.config.RETENTION_SCHEDULE,
      due,
      kept: {
        consents: { count: k.consents as number, since: k.consents_since as Date | null },
        auditLogs: { count: k.audit_logs as number, since: k.audit_logs_since as Date | null },
      },
      lastRun: l ? { at: l.created_at as Date, byUserId: (l.actor_id as string | null) ?? null, counts: l.after_data as RetentionCounts } : null,
    };
  }

  /** Erases everything that is due, batch by batch. `actorId` is the admin who asked; the daily job passes nothing. */
  async run(actorId: string | null = null): Promise<RetentionCounts> {
    const steps = this.steps();
    const counts: RetentionCounts = {
      registrations: await this.batches(steps.registrations, (db, ids) => this.eraseRegistrations(db, ids)),
      orders: await this.batches(steps.orders, (db, ids) => this.eraseOrders(db, ids)),
      transfers: await this.batches(steps.transfers, (db, ids) => this.eraseTransfers(db, ids)),
      closedAccounts: await this.batches(steps.closedAccounts, (db, ids) => this.eraseAccounts(db, ids)),
      kycDocuments: await this.batches(steps.kycDocuments, (db, ids) => this.deleteKycDocuments(db, ids, actorId)),
      expiredCodes: await this.deleteExpiredCodes(),
    };
    await this.dbs.pool.query(
      `INSERT INTO audit_logs (actor_type, actor_id, action, entity_type, after_data) VALUES ($1, $2, 'retention.run', 'retention', $3)`,
      [actorId ? 'admin' : 'system', actorId, JSON.stringify(counts)],
    );
    this.logger.log(`retention: ${Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(' ')}`);
    return counts;
  }

  /**
   * Takes up to a batch of candidates, locks them (skipping rows another run holds) and hands them to `erase`, one
   * transaction per batch, until a batch comes back short.
   */
  private async batches(step: { table: string; sql: string; params: number[] }, erase: (db: Db, ids: string[]) => Promise<void>): Promise<number> {
    const size = this.config.RETENTION_BATCH_SIZE;
    let total = 0;
    for (;;) {
      const n = await this.dbs.transaction(async (_tx, client) => {
        const { rows } = await client.query<{ id: string }>(
          `SELECT id FROM ${step.table} WHERE id IN (${step.sql} LIMIT ${size}) FOR UPDATE SKIP LOCKED`,
          step.params,
        );
        if (rows.length) await erase(client, rows.map((r) => r.id));
        return rows.length;
      });
      total += n;
      if (n < size) return total;
    }
  }

  private async eraseRegistrations(db: Db, ids: string[]) {
    await db.query('UPDATE checkins SET proxy_doc_note = NULL WHERE registration_id = ANY($1) AND proxy_doc_note IS NOT NULL', [ids]);
    // A registration that was never confirmed (an unpaid checkout) has nothing to keep for results or kit history.
    await db.query(
      `UPDATE registrations r SET
         runner_snapshot = CASE WHEN r.confirmed_at IS NULL THEN '{}'::jsonb
                                ELSE coalesce((SELECT jsonb_object_agg(key, value) FROM jsonb_each(r.runner_snapshot) WHERE key = ANY($2)), '{}'::jsonb) END
                           || jsonb_build_object('erasedAt', now()),
         first_name_en = CASE WHEN r.confirmed_at IS NULL THEN '' ELSE r.first_name_en END,
         last_name_en = CASE WHEN r.confirmed_at IS NULL THEN '' ELSE r.last_name_en END,
         first_name_th = CASE WHEN r.confirmed_at IS NULL THEN NULL ELSE r.first_name_th END,
         last_name_th = CASE WHEN r.confirmed_at IS NULL THEN NULL ELSE r.last_name_th END,
         birth_date = make_date(extract(year FROM r.birth_date)::int, 1, 1),
         id_doc_hash = 'erased:' || r.id, email = NULL, phone = NULL, answers = '{}',
         pii_erased_at = now(), updated_at = now()
       WHERE r.id = ANY($1)`,
      [ids, SNAPSHOT_KEEPS],
    );
  }

  private async eraseOrders(db: Db, ids: string[]) {
    await db.query(
      `UPDATE orders SET buyer_email = NULL, buyer_phone = NULL, shipping_address = NULL,
              buyer_name = CASE WHEN paid_at IS NULL THEN NULL ELSE buyer_name END,
              billing_info = CASE WHEN paid_at IS NULL THEN NULL ELSE billing_info END,
              pii_erased_at = now(), updated_at = now()
        WHERE id = ANY($1)`,
      [ids],
    );
    await db.query(
      `UPDATE refunds SET manual_bank_info_enc = NULL, updated_at = now()
        WHERE order_id = ANY($1) AND manual_bank_info_enc IS NOT NULL AND status IN ('succeeded', 'rejected', 'failed')`,
      [ids],
    );
  }

  private async eraseTransfers(db: Db, ids: string[]) {
    await db.query(
      `UPDATE transfers SET to_email = 'erased-' || id || '@erased.invalid', runner_payload = NULL, pii_erased_at = now() WHERE id = ANY($1)`,
      [ids],
    );
  }

  /** The account row itself was already wiped when it was closed (PrivacyService.deleteAccount). */
  private async eraseAccounts(db: Db, ids: string[]) {
    for (const table of ['auth_identities', 'user_sessions', 'notifications', 'idempotency_keys']) {
      await db.query(`DELETE FROM ${table} WHERE user_id = ANY($1)`, [ids]);
    }
    await db.query('UPDATE users SET pii_erased_at = now(), updated_at = now() WHERE id = ANY($1)', [ids]);
  }

  /**
   * Deletes the files, then the rows (with an audit entry each); if a file cannot be deleted the batch rolls back and
   * the next run tries again. The upload and review entries in audit_logs stay.
   */
  private async deleteKycDocuments(db: Db, ids: string[], actorId: string | null) {
    const { rows } = await db.query<{ file_key: string }>('SELECT file_key FROM organizer_kyc_documents WHERE id = ANY($1)', [ids]);
    for (const d of rows) await this.storage.delete(d.file_key);
    await db.query(
      `WITH gone AS (DELETE FROM organizer_kyc_documents WHERE id = ANY($1) RETURNING id, organization_id, doc_type, status)
       INSERT INTO audit_logs (actor_type, actor_id, organization_id, action, entity_type, entity_id, before_data)
       SELECT $2::actor_type, $3::uuid, organization_id, 'retention.kyc_document_delete', 'kyc_document', id, jsonb_build_object('type', doc_type, 'status', status)
         FROM gone`,
      [ids, actorId ? 'admin' : 'system', actorId],
    );
  }

  /** One-time codes and idempotent responses (which hold order details) long after they stopped being usable. */
  private async deleteExpiredCodes(): Promise<number> {
    const size = this.config.RETENTION_BATCH_SIZE;
    const days = this.config.RETENTION_UNPAID_DAYS;
    let total = 0;
    for (const sql of [
      `DELETE FROM otp_codes WHERE id IN (SELECT id FROM otp_codes WHERE expires_at < now() - make_interval(days => $1::int) LIMIT ${size})`,
      `DELETE FROM idempotency_keys WHERE (scope, key) IN (SELECT scope, key FROM idempotency_keys WHERE expires_at < now() - make_interval(days => $1::int) LIMIT ${size})`,
    ]) {
      for (;;) {
        const { rowCount } = await this.dbs.pool.query(sql, [days]);
        total += rowCount ?? 0;
        if ((rowCount ?? 0) < size) break;
      }
    }
    return total;
  }
}
