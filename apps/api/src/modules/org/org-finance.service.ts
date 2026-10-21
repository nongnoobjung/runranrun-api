import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DbService } from '../../db/db.service';
import { writeAudit } from './org-access.service';

/** Orders whose money was taken; refunded ones still count, their refunds are subtracted separately. */
const PAID = `('paid', 'partially_refunded', 'refunded')`;
/** Refunds the organiser owes or has already paid back. */
const OWED = `('approved', 'processing', 'succeeded')`;

export const transactionsQuerySchema = z.object({
  status: z.enum(['all', 'paid', 'refunded', 'pending']).default('all'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
type TransactionsQuery = z.infer<typeof transactionsQuerySchema>;

const STATUS_FILTER: Record<TransactionsQuery['status'], string> = {
  all: `o.status IN ('pending_payment', 'paid', 'partially_refunded', 'refunded', 'cancelled')`,
  paid: `o.status = 'paid'`,
  refunded: `o.status IN ('partially_refunded', 'refunded', 'cancelled')`,
  pending: `o.status = 'pending_payment'`,
};

/**
 * Money per event, all integer satang:
 *   sales      = what was sold (places and add-ons, before discounts)
 *   discounts  = coupon discounts
 *   platformFee = the platform's share, fixed on each order when it was placed
 *   refunds    = refunds approved or paid back
 *   net        = sales − discounts − platformFee − refunds  (what the organiser is owed)
 * The runner fee is paid by runners on top and goes to the platform, so it is shown but not part of net.
 */
const SUMMARY_SQL = `
  WITH paid AS (SELECT * FROM orders o WHERE o.organization_id = $1 AND o.status IN ${PAID} AND ($2::uuid IS NULL OR o.event_id = $2))
  SELECT e.id AS event_id, e.name_th, e.event_date::text AS event_date,
         count(p.id)::int AS orders,
         COALESCE(sum(p.subtotal_satang), 0)::bigint AS sales,
         COALESCE(sum(p.discount_satang), 0)::bigint AS discounts,
         COALESCE(sum(p.fee_satang), 0)::bigint AS runner_fees,
         COALESCE(sum(p.platform_fee_satang), 0)::bigint AS platform_fees,
         COALESCE(sum(p.total_satang), 0)::bigint AS collected,
         (SELECT count(*) FROM registrations r JOIN paid pp ON pp.id = r.order_id WHERE pp.event_id = e.id AND r.status = 'confirmed')::int AS runners,
         (SELECT count(*) FROM refunds f JOIN paid pp ON pp.id = f.order_id WHERE pp.event_id = e.id AND f.status IN ${OWED})::int AS refund_count,
         (SELECT COALESCE(sum(f.amount_satang), 0) FROM refunds f JOIN paid pp ON pp.id = f.order_id WHERE pp.event_id = e.id AND f.status IN ${OWED})::bigint AS refunds,
         (SELECT COALESCE(sum(f.amount_satang), 0) FROM refunds f JOIN paid pp ON pp.id = f.order_id WHERE pp.event_id = e.id AND f.status = 'succeeded')::bigint AS refunds_paid,
         (SELECT count(*) FROM orders q WHERE q.event_id = e.id AND q.status = 'pending_payment')::int AS pending_orders,
         (SELECT COALESCE(sum(q.total_satang), 0) FROM orders q WHERE q.event_id = e.id AND q.status = 'pending_payment')::bigint AS pending_amount,
         (SELECT COALESCE(sum(po.amount_satang), 0) FROM payouts po JOIN settlements s ON s.id = po.settlement_id
           WHERE s.event_id = e.id AND po.status = 'paid')::bigint AS paid_out
    FROM events e LEFT JOIN paid p ON p.event_id = e.id
   WHERE e.organization_id = $1 AND ($2::uuid IS NULL OR e.id = $2)
   GROUP BY e.id ORDER BY e.event_date DESC, e.name_th`;

@Injectable()
export class OrgFinanceService {
  constructor(private readonly dbs: DbService) {}

  async eventSummary(orgId: string, eventId: string) {
    const { rows } = await this.dbs.pool.query(SUMMARY_SQL, [orgId, eventId]);
    return { summary: summaryView(rows[0]), payouts: await this.payouts(orgId, eventId), bankAccount: await this.bankAccount(orgId) };
  }

  /** Every event of the organisation, plus their totals. */
  async orgSummary(orgId: string) {
    const { rows } = await this.dbs.pool.query(SUMMARY_SQL, [orgId, null]);
    const events = rows.map((r) => ({ eventId: r.event_id, nameTh: r.name_th, eventDate: r.event_date, ...summaryView(r) }));
    const keys = ['orders', 'runners', 'salesSatang', 'discountsSatang', 'runnerFeesSatang', 'platformFeesSatang', 'collectedSatang', 'refundCount',
      'refundsSatang', 'refundsPaidSatang', 'pendingOrders', 'pendingSatang', 'netSatang', 'paidOutSatang', 'toPayOutSatang'] as const;
    const totals = Object.fromEntries(keys.map((k) => [k, events.reduce((s, e) => s + e[k], 0)])) as Record<(typeof keys)[number], number>;
    return { totals, events, payouts: await this.payouts(orgId, null), bankAccount: await this.bankAccount(orgId) };
  }

  async transactions(orgId: string, eventId: string, query: TransactionsQuery) {
    const { rows } = await this.dbs.pool.query(
      `${TRANSACTIONS_SQL} AND ${STATUS_FILTER[query.status]}
        ORDER BY COALESCE(o.paid_at, o.created_at) DESC, o.order_no DESC LIMIT $3 OFFSET $4`,
      [orgId, eventId, query.limit, query.offset],
    );
    const total = await this.dbs.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM orders o WHERE o.organization_id = $1 AND o.event_id = $2 AND ${STATUS_FILTER[query.status]}`,
      [orgId, eventId],
    );
    return { items: rows.map(transactionView), total: total.rows[0].n };
  }

  /** The transaction list as CSV for Excel (UTF-8 with BOM). Buyer names make it personal data, so the export is audited. */
  async transactionsCsv(userId: string, orgId: string, eventId: string, status: TransactionsQuery['status']) {
    const { rows } = await this.dbs.pool.query(
      `${TRANSACTIONS_SQL} AND ${STATUS_FILTER[status]} ORDER BY COALESCE(o.paid_at, o.created_at), o.order_no`,
      [orgId, eventId],
    );
    await writeAudit(this.dbs.pool, {
      actorId: userId, organizationId: orgId, eventId, action: 'finance.export', entityType: 'event', entityId: eventId, after: { status, rows: rows.length },
    });
    const baht = (n: number | null) => (n === null ? '' : (n / 100).toFixed(2));
    const header = ['order_no', 'status', 'created_at', 'paid_at', 'method', 'buyer_name', 'runners', 'sales', 'discount', 'runner_fee', 'paid_by_buyer',
      'platform_fee', 'refunded', 'net'];
    const lines = rows.map(transactionView).map((t) =>
      [
        t.orderNo, t.status, new Date(t.createdAt).toISOString(), t.paidAt ? new Date(t.paidAt).toISOString() : '', t.method ?? '', t.buyerName ?? '', t.runners,
        baht(t.salesSatang), baht(t.discountSatang), baht(t.runnerFeeSatang), baht(t.totalSatang), baht(t.platformFeeSatang), baht(t.refundedSatang), baht(t.netSatang),
      ].map(csvCell).join(','),
    );
    return `﻿${[header.join(','), ...lines].join('\r\n')}\r\n`;
  }

  /** Settlement rounds and their transfers, newest first. Read-only: the platform calculates and pays them. */
  private async payouts(orgId: string, eventId: string | null) {
    const { rows } = await this.dbs.pool.query(
      `SELECT s.id, s.event_id, e.name_th AS event_name, s.period_start, s.period_end, s.status, s.order_count, s.gross_satang, s.refunds_satang,
              s.platform_fee_satang, s.gateway_fee_satang, s.withholding_tax_satang, s.adjustments_satang, s.net_satang,
              po.status AS payout_status, po.amount_satang AS payout_amount, po.transfer_ref, po.paid_at, b.bank_code, b.account_number_last4
         FROM settlements s
         LEFT JOIN events e ON e.id = s.event_id
         LEFT JOIN LATERAL (SELECT * FROM payouts p WHERE p.settlement_id = s.id ORDER BY p.created_at DESC LIMIT 1) po ON true
         LEFT JOIN bank_accounts b ON b.id = po.bank_account_id
        WHERE s.organization_id = $1 AND ($2::uuid IS NULL OR s.event_id = $2) AND s.status <> 'void'
        ORDER BY s.period_end DESC`,
      [orgId, eventId],
    );
    return rows.map((s) => ({
      id: s.id,
      event: s.event_id ? { id: s.event_id, nameTh: s.event_name } : null,
      periodStart: s.period_start,
      periodEnd: s.period_end,
      status: s.status as 'open' | 'calculated' | 'approved' | 'paid',
      orders: s.order_count,
      grossSatang: Number(s.gross_satang),
      refundsSatang: Number(s.refunds_satang),
      feesSatang: Number(s.platform_fee_satang) + Number(s.gateway_fee_satang),
      withholdingTaxSatang: Number(s.withholding_tax_satang),
      adjustmentsSatang: Number(s.adjustments_satang),
      netSatang: Number(s.net_satang),
      payout: s.payout_status
        ? { status: s.payout_status as 'pending' | 'processing' | 'paid' | 'failed', amountSatang: Number(s.payout_amount), transferRef: s.transfer_ref, paidAt: s.paid_at, bankCode: s.bank_code, accountLast4: s.account_number_last4 }
        : null,
    }));
  }

  private async bankAccount(orgId: string) {
    const { rows } = await this.dbs.pool.query(
      `SELECT bank_code, account_name, account_number_last4, branch, verified_at FROM bank_accounts
        WHERE organization_id = $1 ORDER BY is_default DESC, created_at LIMIT 1`,
      [orgId],
    );
    const b = rows[0];
    return b ? { bankCode: b.bank_code, accountName: b.account_name, accountLast4: b.account_number_last4, branch: b.branch, verified: b.verified_at !== null } : null;
  }
}

const TRANSACTIONS_SQL = `
  SELECT o.order_no, o.status, o.created_at, o.paid_at, o.buyer_name, o.subtotal_satang, o.discount_satang, o.fee_satang, o.total_satang,
         o.platform_fee_satang, o.refunded_satang,
         (SELECT p.method FROM payments p WHERE p.order_id = o.id ORDER BY (p.status = 'succeeded') DESC, p.created_at DESC LIMIT 1) AS method,
         (SELECT count(*) FROM registrations r WHERE r.order_id = o.id)::int AS runners
    FROM orders o
   WHERE o.organization_id = $1 AND o.event_id = $2`;

function summaryView(r: Record<string, any>) {
  const n = (k: string) => Number(r?.[k] ?? 0);
  const net = n('sales') - n('discounts') - n('platform_fees') - n('refunds');
  return {
    orders: n('orders'),
    runners: n('runners'),
    salesSatang: n('sales'),
    discountsSatang: n('discounts'),
    runnerFeesSatang: n('runner_fees'),
    platformFeesSatang: n('platform_fees'),
    collectedSatang: n('collected'),
    refundCount: n('refund_count'),
    refundsSatang: n('refunds'),
    refundsPaidSatang: n('refunds_paid'),
    pendingOrders: n('pending_orders'),
    pendingSatang: n('pending_amount'),
    netSatang: net,
    paidOutSatang: n('paid_out'),
    toPayOutSatang: net - n('paid_out'),
  };
}

function transactionView(o: Record<string, any>) {
  const counted = ['paid', 'partially_refunded', 'refunded'].includes(o.status);
  const sales = Number(o.subtotal_satang);
  const discount = Number(o.discount_satang);
  const platformFeeSatang = Number(o.platform_fee_satang);
  const refunded = Number(o.refunded_satang);
  return {
    orderNo: o.order_no,
    status: o.status as 'pending_payment' | 'paid' | 'partially_refunded' | 'refunded' | 'cancelled',
    createdAt: o.created_at,
    paidAt: o.paid_at,
    method: o.method as string | null,
    buyerName: o.buyer_name,
    runners: o.runners,
    salesSatang: sales,
    discountSatang: discount,
    runnerFeeSatang: Number(o.fee_satang),
    totalSatang: Number(o.total_satang),
    platformFeeSatang,
    refundedSatang: refunded,
    /** What this order adds to the organiser's payout; null while it is not paid. */
    netSatang: counted ? sales - discount - platformFeeSatang - refunded : null,
  };
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  // A leading = + @ would run as a formula in Excel; negative numbers are left alone.
  if (/^[=+@\t\r]/.test(s) || (/^-/.test(s) && !/^-\d/.test(s))) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
