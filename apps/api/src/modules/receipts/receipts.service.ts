import { Inject, Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { AppConfig, CONFIG } from '../../config';
import { ProblemException, problems } from '../../common/problem';
import { DbService } from '../../db/db.service';
import { validTaxId } from '../org/org-kyc.service';
import { writeAudit } from '../org/org-access.service';

type Queryable = Pick<PoolClient, 'query'>;

const VAT_BPS = 700;
/** Branch "00000" is how the Revenue Department writes a head office. */
export const HEAD_OFFICE = '00000';

/** What a buyer gives for a full tax invoice: at checkout (orders.billing_info) or later from the receipt page. */
export const billingSchema = z.object({
  name: z.string().trim().min(2).max(200),
  taxId: z
    .string()
    .trim()
    .transform((v) => v.replace(/[\s-]/g, ''))
    .pipe(z.string().refine(validTaxId, 'A valid 13-digit tax ID')),
  /** "00000" for a head office, the 5-digit branch number otherwise, null for a person. */
  branch: z.string().trim().regex(/^\d{5}$/, '5 digits').nullable().default(null),
  address: z.string().trim().min(10).max(500),
});
export type Billing = z.infer<typeof billingSchema>;

export type DocType = 'receipt' | 'abbreviated_tax_invoice' | 'tax_invoice';

export interface Issuer {
  kind: 'organizer' | 'platform';
  name: string;
  taxId: string | null;
  branch: string | null;
  address: string;
  vatRegistered: boolean;
  /** When the platform issues, the organiser it received the money for. */
  onBehalfOf: string | null;
}

/** The platform's own details, for organisers who have not given a legal name and tax ID. */
export type PlatformIssuer = Pick<AppConfig, 'PLATFORM_LEGAL_NAME' | 'PLATFORM_TAX_ID' | 'PLATFORM_BRANCH' | 'PLATFORM_ADDRESS' | 'PLATFORM_VAT_REGISTERED'>;

const OPEN_STATUSES = ['paid', 'partially_refunded'];

function formatAddress(a: Record<string, string> | null): string {
  if (!a) return '';
  return [a.line1, a.subdistrict, a.district, a.province, a.postcode].filter((p) => p && p.trim()).join(' ');
}

/**
 * Who issues the order's documents: the organiser when it has a legal name and tax ID (it sells the place), otherwise
 * the platform, which collected the money on the organiser's behalf.
 */
function issuerFor(o: Record<string, any>, platform: PlatformIssuer): Issuer {
  if (o.legal_name && o.tax_id) {
    return {
      kind: 'organizer', name: o.legal_name, taxId: o.tax_id, branch: HEAD_OFFICE, address: formatAddress(o.org_address),
      vatRegistered: o.is_vat_registered, onBehalfOf: null,
    };
  }
  return {
    kind: 'platform', name: platform.PLATFORM_LEGAL_NAME, taxId: platform.PLATFORM_TAX_ID || null,
    branch: platform.PLATFORM_TAX_ID ? platform.PLATFORM_BRANCH : null, address: platform.PLATFORM_ADDRESS,
    vatRegistered: platform.PLATFORM_VAT_REGISTERED && Boolean(platform.PLATFORM_TAX_ID), onBehalfOf: o.org_name,
  };
}

/**
 * Issues the next document for an order, inside the caller's transaction (which must hold the order row locked).
 * The number comes from the issuer's counter for the year, taken under a row lock and returned on rollback, so each
 * issuer's numbers run 1, 2, 3 … with no gaps and no repeats however many payments arrive at once.
 */
async function issueDocument(client: Queryable, orderId: string, platform: PlatformIssuer, billing: Billing | null, replacesId: string | null) {
  const { rows } = await client.query(
    `SELECT o.id, o.total_satang, o.buyer_name, org.id AS org_id, org.name_th AS org_name, org.legal_name, org.tax_id,
            org.is_vat_registered, org.address AS org_address
       FROM orders o JOIN organizations org ON org.id = o.organization_id WHERE o.id = $1`,
    [orderId],
  );
  const o = rows[0];
  const issuer = issuerFor(o, platform);
  const counter = await client.query<{ doc_year: number; last_no: number }>(
    `INSERT INTO document_counters (issuer_key, doc_year, last_no)
     VALUES ($1, EXTRACT(YEAR FROM now() AT TIME ZONE 'Asia/Bangkok'), 1)
     ON CONFLICT (issuer_key, doc_year) DO UPDATE SET last_no = document_counters.last_no + 1
     RETURNING doc_year, last_no`,
    [issuer.kind === 'organizer' ? o.org_id : 'platform'],
  );
  const { doc_year: year, last_no: seq } = counter.rows[0];
  const total = Number(o.total_satang);
  const vat = issuer.vatRegistered ? Math.round((total * VAT_BPS) / (10_000 + VAT_BPS)) : 0;
  const docType: DocType = !issuer.vatRegistered ? 'receipt' : billing ? 'tax_invoice' : 'abbreviated_tax_invoice';
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO tax_invoices (invoice_no, order_id, issuer_org_id, doc_type, doc_year, doc_seq, issuer_snapshot,
                               buyer_name, buyer_tax_id, buyer_branch, buyer_address, subtotal_satang, vat_satang, total_satang, replaces_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
    [
      `RC${year}-${String(seq).padStart(6, '0')}`, orderId, issuer.kind === 'organizer' ? o.org_id : null, docType, year, seq, JSON.stringify(issuer),
      billing?.name ?? o.buyer_name ?? '-', billing?.taxId ?? null, billing?.branch ?? null, billing?.address ?? '',
      total - vat, vat, total, replacesId,
    ],
  );
  return inserted.rows[0].id;
}

/**
 * The order's receipt, issued now if it has none. Called when an order is paid (inside the payment transaction) and
 * when a receipt is opened for an order paid before receipts existed. Billing details given at checkout make it a
 * full tax invoice from the start.
 */
export async function issueReceipt(client: Queryable, orderId: string, platform: PlatformIssuer): Promise<string> {
  const existing = await client.query<{ id: string }>(`SELECT id FROM tax_invoices WHERE order_id = $1 AND status = 'issued'`, [orderId]);
  if (existing.rows[0]) return existing.rows[0].id;
  const info = await client.query<{ billing_info: unknown }>('SELECT billing_info FROM orders WHERE id = $1', [orderId]);
  const billing = billingSchema.safeParse(info.rows[0]?.billing_info);
  return issueDocument(client, orderId, platform, billing.success ? billing.data : null, null);
}

@Injectable()
export class ReceiptsService {
  constructor(
    private readonly dbs: DbService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** The buyer's receipt for a paid (or since refunded) order. */
  async get(userId: string, orderId: string) {
    return this.dbs.transaction(async (_tx, client) => {
      const o = await this.lockOwnOrder(client, userId, orderId);
      const doc = await client.query(`SELECT id FROM tax_invoices WHERE order_id = $1 AND status = 'issued'`, [orderId]);
      if (!doc.rows[0]) {
        // Paid once is enough: an order refunded before receipts existed still gets one, marked refunded.
        if (!o.paid_at) throw notAvailable(o.status);
        await issueReceipt(client, orderId, this.config);
      }
      return this.view(client, orderId);
    });
  }

  /**
   * Turns the order's receipt into a full tax invoice made out to the buyer's company (or themselves): the receipt
   * in force is marked replaced and a new numbered document takes its place. Asking again with the same details
   * changes nothing; different details once a tax invoice exists are refused (the organiser has to correct it).
   */
  async requestTaxInvoice(userId: string, orderId: string, billing: Billing) {
    return this.dbs.transaction(async (_tx, client) => {
      const o = await this.lockOwnOrder(client, userId, orderId);
      if (!OPEN_STATUSES.includes(o.status) || !o.paid_at) throw notAvailable(o.status);
      await issueReceipt(client, orderId, this.config);
      const { rows } = await client.query(`SELECT * FROM tax_invoices WHERE order_id = $1 AND status = 'issued' FOR UPDATE`, [orderId]);
      const current = rows[0];
      if (current.buyer_tax_id) {
        const same = current.buyer_tax_id === billing.taxId && current.buyer_name === billing.name
          && current.buyer_address === billing.address && (current.buyer_branch ?? null) === billing.branch;
        if (same) return this.view(client, orderId);
        throw new ProblemException(409, 'TAX_INVOICE_EXISTS', 'A tax invoice has already been issued for this order', 'Ask the organiser to correct it.');
      }
      await client.query(`UPDATE tax_invoices SET status = 'replaced', cancelled_at = now() WHERE id = $1`, [current.id]);
      const id = await issueDocument(client, orderId, this.config, billing, current.id);
      await client.query('UPDATE orders SET billing_info = $2, updated_at = now() WHERE id = $1', [orderId, JSON.stringify(billing)]);
      await writeAudit(client, {
        actorId: userId, organizationId: o.organization_id, eventId: o.event_id, action: 'tax_invoice.request', entityType: 'tax_invoice', entityId: id,
        after: { replaces: current.invoice_no, taxId: billing.taxId },
      });
      return this.view(client, orderId);
    });
  }

  private async lockOwnOrder(client: Queryable, userId: string, orderId: string) {
    const { rows } = await client.query(
      'SELECT id, status, paid_at, buyer_user_id, organization_id, event_id FROM orders WHERE id = $1 FOR UPDATE',
      [orderId],
    );
    if (!rows[0] || rows[0].buyer_user_id !== userId) throw problems.notFound('Order');
    return rows[0];
  }

  private async view(client: Queryable, orderId: string) {
    const { rows } = await client.query(
      `SELECT o.*, e.slug AS event_slug, e.name_th AS event_name_th, e.name_en AS event_name_en, e.event_date::text AS event_date
         FROM orders o JOIN events e ON e.id = o.event_id WHERE o.id = $1`,
      [orderId],
    );
    const o = rows[0];
    const docs = await client.query(`SELECT * FROM tax_invoices WHERE order_id = $1 ORDER BY issued_at DESC, doc_seq DESC`, [orderId]);
    const d = docs.rows.find((x) => x.status === 'issued');
    const items = await client.query(
      `SELECT item_type, description, quantity, unit_price_satang, discount_satang, total_satang
         FROM order_items WHERE order_id = $1 ORDER BY item_type, description`,
      [orderId],
    );
    const refunded = Number(o.refunded_satang);
    return {
      order: {
        id: o.id as string,
        orderNo: o.order_no as string,
        status: o.status as string,
        paidAt: o.paid_at as Date,
        event: { slug: o.event_slug as string, name: { th: o.event_name_th as string, en: o.event_name_en as string | null }, eventDate: o.event_date as string },
        subtotalSatang: Number(o.subtotal_satang),
        discountSatang: Number(o.discount_satang),
        feeSatang: Number(o.fee_satang),
        totalSatang: Number(o.total_satang),
        refundedSatang: refunded,
      },
      items: items.rows.map((i) => ({
        type: i.item_type as string,
        description: i.description as string,
        quantity: i.quantity as number,
        unitPriceSatang: Number(i.unit_price_satang),
        discountSatang: Number(i.discount_satang),
        totalSatang: Number(i.total_satang),
      })),
      document: {
        id: d.id as string,
        number: d.invoice_no as string,
        type: d.doc_type as DocType,
        issuedAt: d.issued_at as Date,
        issuer: d.issuer_snapshot as Issuer,
        buyer: { name: d.buyer_name as string, taxId: d.buyer_tax_id as string | null, branch: d.buyer_branch as string | null, address: d.buyer_address as string },
        subtotalSatang: Number(d.subtotal_satang),
        vatSatang: Number(d.vat_satang),
        totalSatang: Number(d.total_satang),
      },
      /** Documents this one replaced, newest first. */
      replaced: docs.rows.filter((x) => x.status !== 'issued').map((x) => ({ number: x.invoice_no as string, type: x.doc_type as DocType, issuedAt: x.issued_at as Date })),
      /** Refunded orders keep their receipt, marked with what went back. */
      refund: refunded > 0 ? { status: o.status === 'refunded' ? ('full' as const) : ('partial' as const), amountSatang: refunded } : null,
      canRequestTaxInvoice: OPEN_STATUSES.includes(o.status) && !d.buyer_tax_id,
    };
  }
}

function notAvailable(status: string): ProblemException {
  if (status === 'refunded' || status === 'cancelled') {
    return new ProblemException(409, 'ORDER_REFUNDED', 'This order was refunded, so no new tax invoice can be issued for it');
  }
  return new ProblemException(409, 'RECEIPT_NOT_AVAILABLE', 'The receipt is issued once the order is paid', undefined, { orderStatus: status });
}
