import { Inject, Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { AppConfig, CONFIG } from '../../config';
import { decryptPii, encryptPii } from '../../common/crypto';
import { ProblemException, problems } from '../../common/problem';
import { DbService } from '../../db/db.service';
import { writeAudit } from '../org/org-access.service';
import { OrgEventsService } from '../org/org-events.service';
import { OrgFinanceService, OWED, PAID } from '../org/org-finance.service';
import { documentView, OrgKycService } from '../org/org-kyc.service';
import { bankSchema } from '../refunds/refunds.service';

export type PlatformRole = 'user' | 'support' | 'finance' | 'admin' | 'superadmin';

/** What each platform role may do in the admin backoffice. */
const PERMISSIONS = {
  view: ['support', 'finance', 'admin', 'superadmin'],
  review_events: ['admin', 'superadmin'],
  manage_orgs: ['admin', 'superadmin'],
  payouts: ['finance', 'admin', 'superadmin'],
  retention: ['admin', 'superadmin'],
} as const satisfies Record<string, readonly PlatformRole[]>;
export type AdminPermission = keyof typeof PERMISSIONS;

export const reviewSchema = z.object({ note: z.string().trim().min(1).max(1000) });
export const orgListSchema = z.object({ status: z.enum(['pending_kyc', 'active', 'suspended', 'all']).default('all') });
export const suspendSchema = z.object({ reason: z.string().trim().min(1).max(1000) });
export const docRejectSchema = z.object({ reason: z.string().trim().min(1).max(500) });
export const orgSettingsSchema = z.object({ reviewEvents: z.boolean() });
export const adminBankSchema = bankSchema.extend({ branch: z.string().trim().max(100).optional() });
export const paidSchema = z.object({ transferRef: z.string().trim().min(1).max(100) });

const sum = (rows: Record<string, unknown>[], k: string) => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0);

/**
 * The platform's own backoffice: approving events before they first go live, approving organisers (KYC) and
 * their bank account, and paying organisers what they are owed. Every change is written to audit_logs.
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly dbs: DbService,
    private readonly events: OrgEventsService,
    private readonly finance: OrgFinanceService,
    private readonly kyc: OrgKycService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** The caller's platform role, or 403 when it does not allow `permission`. */
  async require(userId: string, permission: AdminPermission): Promise<PlatformRole> {
    const { rows } = await this.dbs.pool.query<{ platform_role: PlatformRole }>('SELECT platform_role FROM users WHERE id = $1', [userId]);
    const role = rows[0]?.platform_role ?? 'user';
    if (!this.allows(role, permission)) throw problems.forbidden();
    return role;
  }

  allows(role: PlatformRole, permission: AdminPermission): boolean {
    return (PERMISSIONS[permission] as readonly PlatformRole[]).includes(role);
  }

  async me(userId: string) {
    const role = await this.require(userId, 'view');
    return { role, can: Object.fromEntries(Object.entries(PERMISSIONS).map(([k, roles]) => [k, (roles as readonly string[]).includes(role)])) };
  }

  /** Counts for the admin home page. */
  async overview() {
    const { rows } = await this.dbs.pool.query(
      `SELECT (SELECT count(*) FROM events WHERE status = 'pending_review')::int AS pending_review,
              (SELECT count(*) FROM organizations WHERE status = 'pending_kyc')::int AS pending_kyc,
              (SELECT count(*) FROM organizations WHERE status = 'suspended')::int AS suspended,
              (SELECT count(*) FROM settlements WHERE status IN ('calculated', 'approved'))::int AS settlements_open`,
    );
    const owed = await this.owed();
    return {
      pendingReview: rows[0].pending_review as number,
      pendingKyc: rows[0].pending_kyc as number,
      suspended: rows[0].suspended as number,
      settlementsOpen: rows[0].settlements_open as number,
      toSettleSatang: owed.reduce((s, e) => s + e.toSettleSatang, 0),
      eventsToSettle: owed.filter((e) => e.toSettleSatang > 0).length,
    };
  }

  // ---------------------------------------------------------------- event review

  async reviewQueue() {
    const { rows } = await this.dbs.pool.query(
      `SELECT e.id, e.slug, e.name_th, e.event_date::text AS event_date, e.province_code, e.submitted_at, e.organization_id,
              o.name_th AS org_name, o.status AS org_status,
              (SELECT count(*) FROM races r WHERE r.event_id = e.id AND r.is_active)::int AS races,
              (SELECT COALESCE(sum(capacity), 0) FROM races r WHERE r.event_id = e.id AND r.is_active)::int AS capacity
         FROM events e JOIN organizations o ON o.id = e.organization_id
        WHERE e.status = 'pending_review'
        ORDER BY e.submitted_at NULLS LAST`,
    );
    return {
      items: rows.map((e) => ({
        id: e.id as string,
        slug: e.slug as string,
        nameTh: e.name_th as string,
        eventDate: e.event_date as string,
        province: e.province_code as string | null,
        submittedAt: e.submitted_at as Date | null,
        races: e.races as number,
        capacity: e.capacity as number,
        organization: { id: e.organization_id as string, nameTh: e.org_name as string, status: e.org_status as string },
      })),
    };
  }

  /** The event as its organiser set it up, plus who runs it, for the reviewer. */
  async event(eventId: string) {
    const org = await this.orgOfEvent(eventId);
    const [event, organization] = await Promise.all([this.events.get(org, eventId), this.organization(org)]);
    return { event, organization: { id: organization.id, nameTh: organization.nameTh, status: organization.status, reviewEvents: organization.reviewEvents } };
  }

  /** Lets the event go live; it opens for registration straight away. */
  async approveEvent(actorId: string, eventId: string) {
    const orgId = await this.orgOfEvent(eventId);
    return this.dbs.transaction(async (_tx, client) => {
      const ready = await this.events.get(orgId, eventId, client);
      const missing = ready.readiness.filter((r) => !r.ok).map((r) => r.key);
      if (missing.length) throw new ProblemException(409, 'EVENT_NOT_READY', 'The event is missing parts it needs before opening', undefined, { missing });
      const { rowCount } = await client.query(
        `UPDATE events SET status = 'published', published_at = COALESCE(published_at, now()), reviewed_by = $2, reviewed_at = now(),
                           review_note = NULL, updated_at = now()
          WHERE id = $1 AND status = 'pending_review'`,
        [eventId, actorId],
      );
      if (!rowCount) throw new ProblemException(409, 'INVALID_STATUS', 'This event is not waiting for review');
      await writeAudit(client, { actorId, organizationId: orgId, eventId, action: 'admin.event_approve', entityType: 'event', entityId: eventId });
      return { id: eventId, status: 'published' };
    });
  }

  /** Sends the event back to its organiser as a draft, with what to fix. */
  async rejectEvent(actorId: string, eventId: string, note: string) {
    const orgId = await this.orgOfEvent(eventId);
    return this.dbs.transaction(async (_tx, client) => {
      const { rowCount } = await client.query(
        `UPDATE events SET status = 'draft', reviewed_by = $2, review_note = $3, updated_at = now() WHERE id = $1 AND status = 'pending_review'`,
        [eventId, actorId, note],
      );
      if (!rowCount) throw new ProblemException(409, 'INVALID_STATUS', 'This event is not waiting for review');
      await writeAudit(client, { actorId, organizationId: orgId, eventId, action: 'admin.event_reject', entityType: 'event', entityId: eventId, after: { note } });
      return { id: eventId, status: 'draft', note };
    });
  }

  // ---------------------------------------------------------------- organisers

  async organizations(status: z.infer<typeof orgListSchema>['status']) {
    const { rows } = await this.dbs.pool.query(
      `SELECT o.id, o.slug, o.name_th, o.status, o.review_events, o.contact_email, o.created_at, o.kyc_approved_at,
              (SELECT count(*) FROM events e WHERE e.organization_id = o.id)::int AS events,
              (SELECT count(*) FROM events e WHERE e.organization_id = o.id AND e.status = 'pending_review')::int AS pending_review,
              (SELECT count(*) FROM organizer_kyc_documents d WHERE d.organization_id = o.id AND d.status = 'pending')::int AS pending_docs,
              EXISTS (SELECT 1 FROM bank_accounts b WHERE b.organization_id = o.id AND b.verified_at IS NOT NULL) AS bank_verified,
              EXISTS (SELECT 1 FROM bank_accounts b WHERE b.organization_id = o.id AND b.verified_at IS NULL) AS bank_submitted
         FROM organizations o
        WHERE $1 = 'all' OR o.status = $1::org_status
        ORDER BY (o.status = 'pending_kyc') DESC, o.created_at DESC
        LIMIT 200`,
      [status],
    );
    const counts = await this.dbs.pool.query<{ status: string; n: number }>('SELECT status::text, count(*)::int AS n FROM organizations GROUP BY status');
    return {
      items: rows.map((o) => ({
        id: o.id as string,
        slug: o.slug as string,
        nameTh: o.name_th as string,
        status: o.status as 'pending_kyc' | 'active' | 'suspended',
        reviewEvents: o.review_events as boolean,
        contactEmail: o.contact_email as string | null,
        createdAt: o.created_at as Date,
        kycApprovedAt: o.kyc_approved_at as Date | null,
        events: o.events as number,
        pendingReview: o.pending_review as number,
        pendingDocs: o.pending_docs as number,
        bankVerified: o.bank_verified as boolean,
        bankSubmitted: o.bank_submitted as boolean,
      })),
      counts: Object.fromEntries(counts.rows.map((c) => [c.status, c.n])) as Record<string, number>,
    };
  }

  /**
   * Everything the reviewer checks. The bank account the owner submitted comes with its full number for staff who
   * may verify it (`revealBank`), to compare against the bank book; everyone else sees the last four digits.
   */
  async organization(orgId: string, { revealBank = true }: { revealBank?: boolean } = {}) {
    const { rows } = await this.dbs.pool.query(
      `SELECT o.*, a.email AS approved_by_email FROM organizations o LEFT JOIN users a ON a.id = o.kyc_approved_by WHERE o.id = $1`,
      [orgId],
    );
    const o = rows[0];
    if (!o) throw problems.notFound('Organisation');
    const [members, docs, bank, events] = await Promise.all([
      this.dbs.pool.query(
        `SELECT m.role, m.accepted_at, COALESCE(u.email, m.invited_email)::text AS email, u.display_name
           FROM org_members m LEFT JOIN users u ON u.id = m.user_id WHERE m.organization_id = $1 ORDER BY m.role, m.created_at`,
        [orgId],
      ),
      this.dbs.pool.query(
        `SELECT id, doc_type, file_name, content_type, size_bytes, status, reject_reason, reviewed_at, created_at FROM organizer_kyc_documents
          WHERE organization_id = $1 ORDER BY created_at DESC`,
        [orgId],
      ),
      this.dbs.pool.query(
        `SELECT bank_code, account_name, account_number_last4, account_number_enc, branch, verified_at, created_at FROM bank_accounts
          WHERE organization_id = $1 AND (is_default OR verified_at IS NULL) ORDER BY created_at DESC`,
        [orgId],
      ),
      this.dbs.pool.query(
        `SELECT id, name_th, status, event_date::text AS event_date FROM events WHERE organization_id = $1 ORDER BY event_date DESC LIMIT 50`,
        [orgId],
      ),
    ]);
    const b = bank.rows.find((r) => r.verified_at);
    const submitted = bank.rows.find((r) => !r.verified_at);
    return {
      id: o.id as string,
      slug: o.slug as string,
      nameTh: o.name_th as string,
      nameEn: o.name_en as string | null,
      legalName: o.legal_name as string | null,
      taxId: o.tax_id as string | null,
      contactEmail: o.contact_email as string | null,
      contactPhone: o.contact_phone as string | null,
      websiteUrl: o.website_url as string | null,
      isVatRegistered: o.is_vat_registered as boolean,
      address: o.address as Record<string, string> | null,
      status: o.status as 'pending_kyc' | 'active' | 'suspended',
      statusNote: o.status_note as string | null,
      reviewEvents: o.review_events as boolean,
      kycApprovedAt: o.kyc_approved_at as Date | null,
      kycApprovedBy: o.approved_by_email as string | null,
      createdAt: o.created_at as Date,
      members: members.rows.map((m) => ({ email: m.email as string, name: m.display_name as string | null, role: m.role as string, accepted: m.accepted_at !== null })),
      documents: docs.rows.map(documentView),
      bankAccount: b ? { bankCode: b.bank_code as string, accountName: b.account_name as string, accountLast4: b.account_number_last4 as string, branch: b.branch as string | null, verified: true } : null,
      submittedBankAccount: submitted
        ? {
            bankCode: submitted.bank_code as string,
            accountName: submitted.account_name as string,
            accountLast4: submitted.account_number_last4 as string,
            accountNumber: revealBank ? decryptPii(submitted.account_number_enc, this.config.PII_ENCRYPTION_KEY) : null,
            branch: submitted.branch as string | null,
            submittedAt: submitted.created_at as Date,
          }
        : null,
      events: events.rows.map((e) => ({ id: e.id as string, nameTh: e.name_th as string, status: e.status as string, eventDate: e.event_date as string })),
    };
  }

  /** KYC passed: the organisation may open events, and its pending documents count as checked. */
  async approveOrganization(actorId: string, orgId: string) {
    return this.orgChange(actorId, orgId, 'admin.org_approve', async (client) => {
      const { rowCount } = await client.query(
        `UPDATE organizations SET status = 'active', kyc_approved_at = now(), kyc_approved_by = $2, status_note = NULL, updated_at = now()
          WHERE id = $1 AND status = 'pending_kyc'`,
        [orgId, actorId],
      );
      if (!rowCount) throw new ProblemException(409, 'INVALID_STATUS', 'Only an organisation waiting for KYC can be approved');
      await client.query(
        `UPDATE organizer_kyc_documents SET status = 'approved', reviewed_by = $2, reviewed_at = now() WHERE organization_id = $1 AND status = 'pending'`,
        [orgId, actorId],
      );
    });
  }

  /** Stops the organisation opening or reopening events; events already open stay open. */
  async suspendOrganization(actorId: string, orgId: string, reason: string) {
    return this.orgChange(actorId, orgId, 'admin.org_suspend', async (client) => {
      const { rowCount } = await client.query(
        `UPDATE organizations SET status = 'suspended', status_note = $2, updated_at = now() WHERE id = $1 AND status <> 'suspended'`,
        [orgId, reason],
      );
      if (!rowCount) throw new ProblemException(409, 'INVALID_STATUS', 'The organisation is already suspended');
    }, { reason });
  }

  async reactivateOrganization(actorId: string, orgId: string) {
    return this.orgChange(actorId, orgId, 'admin.org_reactivate', async (client) => {
      const { rowCount } = await client.query(
        `UPDATE organizations SET status = CASE WHEN kyc_approved_at IS NULL THEN 'pending_kyc'::org_status ELSE 'active'::org_status END,
                                  status_note = NULL, updated_at = now()
          WHERE id = $1 AND status = 'suspended'`,
        [orgId],
      );
      if (!rowCount) throw new ProblemException(409, 'INVALID_STATUS', 'Only a suspended organisation can be reactivated');
    });
  }

  async updateOrganization(actorId: string, orgId: string, input: z.infer<typeof orgSettingsSchema>) {
    return this.orgChange(actorId, orgId, 'admin.org_settings', async (client) => {
      await client.query('UPDATE organizations SET review_events = $2, updated_at = now() WHERE id = $1', [orgId, input.reviewEvents]);
    }, input);
  }

  /**
   * Records the bank account checked against the organisation's bank book; payouts go to it. It takes the place of
   * anything the owner submitted.
   */
  async setBankAccount(actorId: string, orgId: string, input: z.infer<typeof adminBankSchema>) {
    return this.orgChange(actorId, orgId, 'admin.org_bank_account', async (client) => {
      await client.query('DELETE FROM bank_accounts WHERE organization_id = $1 AND verified_at IS NULL', [orgId]);
      await client.query('UPDATE bank_accounts SET is_default = false WHERE organization_id = $1 AND is_default', [orgId]);
      await client.query(
        `INSERT INTO bank_accounts (organization_id, bank_code, account_name, account_number_enc, account_number_last4, branch, is_default, verified_at, verified_by)
         VALUES ($1, $2, $3, $4, $5, $6, true, now(), $7)`,
        [
          orgId, input.bankCode, input.accountName, encryptPii(input.accountNumber, this.config.PII_ENCRYPTION_KEY),
          input.accountNumber.slice(-4), input.branch ?? null, actorId,
        ],
      );
    }, { bankCode: input.bankCode, accountLast4: input.accountNumber.slice(-4) });
  }

  /** The account the owner submitted matches the bank book: it becomes the one payouts go to. */
  async verifyBankAccount(actorId: string, orgId: string) {
    let after: unknown;
    const result = await this.orgChange(actorId, orgId, 'admin.org_bank_verify', async (client) => {
      const { rows } = await client.query(
        'SELECT id, bank_code, account_number_last4 FROM bank_accounts WHERE organization_id = $1 AND verified_at IS NULL FOR UPDATE',
        [orgId],
      );
      if (!rows[0]) throw new ProblemException(409, 'NO_BANK_SUBMISSION', 'The organiser has not submitted a bank account to verify');
      await client.query('UPDATE bank_accounts SET is_default = false WHERE organization_id = $1 AND is_default', [orgId]);
      await client.query('UPDATE bank_accounts SET is_default = true, verified_at = now(), verified_by = $2, updated_at = now() WHERE id = $1', [
        rows[0].id, actorId,
      ]);
      after = { bankCode: rows[0].bank_code, accountLast4: rows[0].account_number_last4 };
    }, () => after);
    return result;
  }

  // ---------------------------------------------------------------- KYC documents

  /** One document checked: approved, or sent back with what is wrong so the owner can upload a new one. */
  async reviewDocument(actorId: string, orgId: string, docId: string, decision: { status: 'approved' } | { status: 'rejected'; reason: string }) {
    const reason = decision.status === 'rejected' ? decision.reason : null;
    return this.orgChange(actorId, orgId, decision.status === 'approved' ? 'admin.kyc_doc_approve' : 'admin.kyc_doc_reject', async (client) => {
      const { rowCount } = await client.query(
        `UPDATE organizer_kyc_documents SET status = $3, reject_reason = $4, reviewed_by = $5, reviewed_at = now()
          WHERE id = $1 AND organization_id = $2`,
        [docId, orgId, decision.status, reason, actorId],
      );
      if (!rowCount) throw problems.notFound('Document');
    }, { documentId: docId, ...decision });
  }

  /** The document's file for staff who can see the organisation; the view is audited. */
  async documentFile(actorId: string, orgId: string, docId: string) {
    return this.kyc.file(actorId, orgId, docId, 'admin.kyc_doc_view');
  }

  // ---------------------------------------------------------------- settlements and payouts

  /** Events with money collected, what has been settled so far, and what is still to settle. */
  async payouts() {
    const owed = await this.owed();
    const { rows } = await this.dbs.pool.query(
      `SELECT s.id, s.event_id, e.name_th AS event_name, o.name_th AS org_name, s.organization_id, s.status, s.period_start, s.period_end,
              s.order_count, s.gross_satang, s.refunds_satang, s.platform_fee_satang, s.net_satang, s.created_at, s.approved_at,
              po.status AS payout_status, po.transfer_ref, po.paid_at, b.bank_code, b.account_number_last4
         FROM settlements s
         JOIN organizations o ON o.id = s.organization_id
         LEFT JOIN events e ON e.id = s.event_id
         LEFT JOIN LATERAL (SELECT * FROM payouts p WHERE p.settlement_id = s.id ORDER BY p.created_at DESC LIMIT 1) po ON true
         LEFT JOIN bank_accounts b ON b.id = po.bank_account_id
        WHERE s.status <> 'void'
        ORDER BY (s.status IN ('calculated', 'approved')) DESC, s.created_at DESC
        LIMIT 100`,
    );
    return {
      events: owed.filter((e) => e.toSettleSatang !== 0 || e.openSettlement),
      settlements: rows.map((s) => ({
        id: s.id as string,
        status: s.status as 'calculated' | 'approved' | 'paid',
        event: { id: s.event_id as string, nameTh: s.event_name as string },
        organization: { id: s.organization_id as string, nameTh: s.org_name as string },
        periodStart: s.period_start as Date,
        periodEnd: s.period_end as Date,
        orders: s.order_count as number,
        grossSatang: Number(s.gross_satang),
        refundsSatang: Number(s.refunds_satang),
        platformFeeSatang: Number(s.platform_fee_satang),
        netSatang: Number(s.net_satang),
        createdAt: s.created_at as Date,
        approvedAt: s.approved_at as Date | null,
        payout: s.payout_status
          ? { status: s.payout_status as string, transferRef: s.transfer_ref as string | null, paidAt: s.paid_at as Date | null, bankCode: s.bank_code as string, accountLast4: s.account_number_last4 as string }
          : null,
      })),
    };
  }

  /**
   * A settlement round for the event: everything collected since the last round (sales after discounts, less refunds
   * owed and the platform's fee). Rounds add up, so a refund approved after a round is taken off the next one.
   */
  async createSettlement(actorId: string, eventId: string) {
    const orgId = await this.orgOfEvent(eventId);
    return this.dbs.transaction(async (_tx, client) => {
      await client.query('SELECT 1 FROM events WHERE id = $1 FOR UPDATE', [eventId]);
      const open = await client.query(`SELECT id FROM settlements WHERE event_id = $1 AND status IN ('calculated', 'approved')`, [eventId]);
      if (open.rowCount) throw new ProblemException(409, 'SETTLEMENT_OPEN', 'Pay or void the open round for this event first', undefined, { settlementId: open.rows[0].id });
      const { summary } = await this.finance.eventSummary(orgId, eventId);
      const before = await client.query(
        `SELECT order_count, gross_satang, refunds_satang, platform_fee_satang, period_end FROM settlements
          WHERE event_id = $1 AND status <> 'void' ORDER BY period_end`,
        [eventId],
      );
      const gross = summary.salesSatang - summary.discountsSatang - sum(before.rows, 'gross_satang');
      const refunds = summary.refundsSatang - sum(before.rows, 'refunds_satang');
      const fee = summary.platformFeesSatang - sum(before.rows, 'platform_fee_satang');
      const net = gross - refunds - fee;
      if (net <= 0) throw new ProblemException(409, 'NOTHING_TO_SETTLE', 'There is nothing new to pay out for this event');
      const start = before.rows.at(-1)?.period_end ?? (await client.query('SELECT created_at FROM events WHERE id = $1', [eventId])).rows[0].created_at;
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO settlements (organization_id, event_id, period_start, period_end, status, order_count, gross_satang, refunds_satang, platform_fee_satang, net_satang)
         VALUES ($1, $2, $3, now(), 'calculated', $4, $5, $6, $7, $8) RETURNING id`,
        [orgId, eventId, start, Math.max(0, summary.orders - sum(before.rows, 'order_count')), gross, refunds, fee, net],
      );
      await client.query(
        `UPDATE orders SET settlement_id = $2 WHERE event_id = $1 AND settlement_id IS NULL AND status IN ('paid', 'partially_refunded', 'refunded')`,
        [eventId, rows[0].id],
      );
      await writeAudit(client, {
        actorId, organizationId: orgId, eventId, action: 'admin.settlement_create', entityType: 'settlement', entityId: rows[0].id, after: { gross, refunds, fee, net },
      });
      return { id: rows[0].id, status: 'calculated', grossSatang: gross, refundsSatang: refunds, platformFeeSatang: fee, netSatang: net };
    });
  }

  /** Signs the round off and queues its transfer to the organisation's verified bank account. */
  async approveSettlement(actorId: string, settlementId: string) {
    return this.settlementChange(actorId, settlementId, 'admin.settlement_approve', ['calculated'], async (client, s) => {
      const bank = await client.query<{ id: string }>(
        `SELECT id FROM bank_accounts WHERE organization_id = $1 AND verified_at IS NOT NULL ORDER BY is_default DESC, created_at DESC LIMIT 1`,
        [s.organization_id],
      );
      if (!bank.rows[0]) throw new ProblemException(409, 'NO_BANK_ACCOUNT', 'Record and verify the organisation bank account first');
      await client.query(`UPDATE settlements SET status = 'approved', approved_by = $2, approved_at = now(), updated_at = now() WHERE id = $1`, [s.id, actorId]);
      await client.query(
        `INSERT INTO payouts (settlement_id, organization_id, bank_account_id, amount_satang, created_by) VALUES ($1, $2, $3, $4, $5)`,
        [s.id, s.organization_id, bank.rows[0].id, s.net_satang, actorId],
      );
    });
  }

  /** The money has been transferred: the organiser sees it as paid out on their finance page. */
  async markPaid(actorId: string, settlementId: string, transferRef: string) {
    return this.settlementChange(actorId, settlementId, 'admin.settlement_paid', ['approved'], async (client, s) => {
      await client.query(`UPDATE payouts SET status = 'paid', transfer_ref = $2, paid_at = now(), updated_at = now() WHERE settlement_id = $1 AND status = 'pending'`, [
        s.id, transferRef,
      ]);
      await client.query(`UPDATE settlements SET status = 'paid', updated_at = now() WHERE id = $1`, [s.id]);
    }, { transferRef });
  }

  /** Drops a round that was not paid; its orders and amounts go into the next round. */
  async voidSettlement(actorId: string, settlementId: string) {
    return this.settlementChange(actorId, settlementId, 'admin.settlement_void', ['calculated', 'approved'], async (client, s) => {
      await client.query(`UPDATE payouts SET status = 'failed', failure_reason = 'void', updated_at = now() WHERE settlement_id = $1 AND status = 'pending'`, [s.id]);
      await client.query(`UPDATE settlements SET status = 'void', updated_at = now() WHERE id = $1`, [s.id]);
      await client.query('UPDATE orders SET settlement_id = NULL WHERE settlement_id = $1', [s.id]);
    });
  }

  // ---------------------------------------------------------------- internals

  /**
   * Per event with money taken: what is owed in total (the organiser finance page's net) and what has not been put in a
   * round yet. One query for every event, so the payouts page stays quick as events pile up.
   */
  private async owed() {
    const { rows } = await this.dbs.pool.query(
      `WITH paid AS (SELECT * FROM orders WHERE status IN ${PAID}),
            per AS (SELECT event_id, organization_id, sum(subtotal_satang) AS sales, sum(discount_satang) AS discounts,
                           sum(platform_fee_satang) AS fees
                      FROM paid GROUP BY event_id, organization_id)
       SELECT per.event_id, per.organization_id, per.sales, per.discounts, per.fees, e.name_th, e.event_date::text AS event_date, o.name_th AS org_name,
              (SELECT COALESCE(sum(f.amount_satang), 0) FROM refunds f JOIN paid pp ON pp.id = f.order_id
                WHERE pp.event_id = per.event_id AND f.status IN ${OWED})::bigint AS refunds,
              (SELECT COALESCE(sum(po.amount_satang), 0) FROM payouts po JOIN settlements st ON st.id = po.settlement_id
                WHERE st.event_id = per.event_id AND po.status = 'paid')::bigint AS paid_out,
              (SELECT COALESCE(sum(net_satang), 0) FROM settlements WHERE event_id = per.event_id AND status <> 'void')::bigint AS settled,
              (SELECT id FROM settlements WHERE event_id = per.event_id AND status IN ('calculated', 'approved') LIMIT 1) AS open_id,
              EXISTS (SELECT 1 FROM bank_accounts b WHERE b.organization_id = per.organization_id AND b.verified_at IS NOT NULL) AS bank_verified
         FROM per JOIN events e ON e.id = per.event_id JOIN organizations o ON o.id = per.organization_id`,
    );
    return rows
      .map((r) => {
        const net = Number(r.sales) - Number(r.discounts) - Number(r.fees) - Number(r.refunds);
        return {
          eventId: r.event_id as string,
          nameTh: r.name_th as string,
          eventDate: r.event_date as string,
          organization: { id: r.organization_id as string, nameTh: r.org_name as string },
          netSatang: net,
          settledSatang: Number(r.settled),
          paidOutSatang: Number(r.paid_out),
          toSettleSatang: net - Number(r.settled),
          openSettlement: (r.open_id as string | null) ?? null,
          bankVerified: r.bank_verified as boolean,
        };
      })
      .sort((a, b) => b.toSettleSatang - a.toSettleSatang);
  }

  private async orgOfEvent(eventId: string): Promise<string> {
    const { rows } = await this.dbs.pool.query<{ organization_id: string }>('SELECT organization_id FROM events WHERE id = $1', [eventId]);
    if (!rows[0]) throw problems.notFound('Event');
    return rows[0].organization_id;
  }

  /** `after` may be a function when what to audit is only known once the change ran. */
  private async orgChange(actorId: string, orgId: string, action: string, change: (client: PoolClient) => Promise<void>, after?: unknown) {
    await this.dbs.transaction(async (_tx, client) => {
      const exists = await client.query('SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE', [orgId]);
      if (!exists.rowCount) throw problems.notFound('Organisation');
      await change(client);
      await writeAudit(client, { actorId, organizationId: orgId, action, entityType: 'organization', entityId: orgId, after: typeof after === 'function' ? after() : after });
    });
    return this.organization(orgId);
  }

  private async settlementChange(
    actorId: string,
    settlementId: string,
    action: string,
    from: string[],
    change: (client: PoolClient, s: Record<string, any>) => Promise<void>,
    after?: unknown,
  ) {
    await this.dbs.transaction(async (_tx, client) => {
      const { rows } = await client.query('SELECT * FROM settlements WHERE id = $1 FOR UPDATE', [settlementId]);
      const s = rows[0];
      if (!s) throw problems.notFound('Settlement');
      if (!from.includes(s.status)) throw new ProblemException(409, 'INVALID_STATUS', `The round is ${s.status}`);
      await change(client, s);
      await writeAudit(client, { actorId, organizationId: s.organization_id, eventId: s.event_id, action, entityType: 'settlement', entityId: s.id, after });
    });
    return (await this.payouts()).settlements.find((s) => s.id === settlementId) ?? { id: settlementId };
  }
}
