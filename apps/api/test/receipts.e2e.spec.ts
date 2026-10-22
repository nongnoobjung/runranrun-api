import { randomUUID } from 'node:crypto';
import { addOrgMember, createEvent } from '../db/fixtures';
import { DbService } from '../src/db/db.service';
import { issueReceipt } from '../src/modules/receipts/receipts.service';
import { AppConfig, CONFIG } from '../src/config';
import { bootApp, buyer, call, login, runner, sendFakeWebhook, TestContext, uniqueSlug } from './helpers';

/** A valid Thai tax ID (the 13th digit is the checksum) built from 12 random digits. */
function taxId(): string {
  const body = `0${String(Math.floor(Math.random() * 1e11)).padStart(11, '0')}`;
  const sum = [...body].reduce((s, d, i) => s + Number(d) * (13 - i), 0);
  return `${body}${(11 - (sum % 11)) % 10}`;
}

const thisYear = Number(new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: 'Asia/Bangkok' }).format(new Date()));
const billing = () => ({ name: 'บริษัท วิ่งดี จำกัด', taxId: taxId(), branch: '00000', address: '99 ถนนพระราม 4 แขวงสีลม เขตบางรัก กรุงเทพมหานคร 10500' });

describe('receipts and tax invoices', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await bootApp();
  });
  afterAll(() => ctx.close());

  /** A 10K at ฿500 under its own organiser; with `tax` the organiser has a legal name and tax ID (and maybe VAT). */
  async function orgEvent(tax?: { vat: boolean }) {
    const created = await createEvent(
      ctx.pool,
      {
        slug: uniqueSlug(),
        nameTh: 'งานใบเสร็จ',
        nameEn: 'Receipt Run',
        eventDate: '2027-03-01',
        races: [{ code: '10K', nameTh: 'มินิ', distanceKm: 10, capacity: 100, bibStart: 1, bibEnd: 100, tiers: [{ name: 'ปกติ', priceSatang: 50_000 }] }],
      },
      uniqueSlug('org'),
    );
    if (tax) {
      await ctx.pool.query(
        `UPDATE organizations SET legal_name = 'บริษัท ริเวอร์ไซด์ สปอร์ต จำกัด', tax_id = $2, is_vat_registered = $3,
                address = '{"line1": "1 ถนนเจริญกรุง", "subdistrict": "บางรัก", "district": "บางรัก", "province": "กรุงเทพมหานคร", "postcode": "10500"}'
          WHERE id = $1`,
        [created.organizationId, taxId(), tax.vat],
      );
    }
    const email = `owner-${randomUUID()}@org.example`;
    await addOrgMember(ctx.pool, created.organizationId, email, 'owner');
    const owner = await login(ctx.app, email);
    return { ...created, raceId: created.raceIds['10K'], ownerToken: owner.token, base: `/v1/org/${created.organizationId}/events/${created.eventId}` };
  }

  /** An order for one place; paid through the fake gateway unless `pay` is false. */
  async function order(ev: Awaited<ReturnType<typeof orgEvent>>, opts: { billing?: unknown; pay?: boolean } = {}) {
    const me = await login(ctx.app);
    const session = await call(ctx.app, 'POST', '/v1/checkout/sessions', { token: me.token, body: { eventId: ev.eventId, races: [{ raceId: ev.raceId, quantity: 1 }] } });
    const created = await call(ctx.app, 'POST', '/v1/orders', {
      token: me.token,
      headers: { 'idempotency-key': randomUUID() },
      body: { checkoutSessionId: session.body.id, buyer, billing: opts.billing, participants: [{ raceId: ev.raceId, isSelf: true, runner: runner() }] },
    });
    if (created.status !== 201) return { ...me, orderId: '', created, webhook: undefined };
    const payment = await call(ctx.app, 'POST', `/v1/orders/${created.body.id}/payments`, { token: me.token, headers: { 'idempotency-key': randomUUID() }, body: { method: 'promptpay' } });
    const charge = await ctx.pool.query('SELECT gateway_charge_id FROM payments WHERE id = $1', [payment.body.id]);
    const webhook = () => sendFakeWebhook(ctx.app, charge.rows[0].gateway_charge_id);
    if (opts.pay !== false) await webhook();
    return { ...me, orderId: created.body.id as string, created, webhook };
  }

  const receipt = (token: string, orderId: string) => call(ctx.app, 'GET', `/v1/orders/${orderId}/receipt`, { token });
  const request = (token: string, orderId: string, body: unknown) => call(ctx.app, 'POST', `/v1/orders/${orderId}/tax-invoice`, { token, body });

  it('issues a plain receipt from the platform for an organiser without tax details', async () => {
    const ev = await orgEvent();
    const o = await order(ev);
    const res = await receipt(o.token, o.orderId);
    expect(res.status).toBe(200);
    expect(res.body.document).toMatchObject({
      type: 'receipt', subtotalSatang: 51_000, vatSatang: 0, totalSatang: 51_000,
      issuer: { kind: 'platform', vatRegistered: false, onBehalfOf: 'Riverside Sports' },
      buyer: { name: buyer.name, taxId: null },
    });
    expect(res.body.document.number).toMatch(new RegExp(`^RC${thisYear}-\\d{6}$`));
    expect(res.body.order).toMatchObject({ orderNo: expect.any(String), status: 'paid', totalSatang: 51_000, event: { name: { th: 'งานใบเสร็จ', en: 'Receipt Run' } } });
    expect(res.body.items.map((i: any) => i.type)).toEqual(['race', 'fee']);
    expect(res.body).toMatchObject({ refund: null, canRequestTaxInvoice: true, replaced: [] });
    // Opening it again shows the same document.
    expect((await receipt(o.token, o.orderId)).body.document.id).toBe(res.body.document.id);
    expect((await receipt((await login(ctx.app)).token, o.orderId)).status).toBe(404);
  });

  it("numbers each VAT-registered organiser's documents from 1 and works out the VAT inside the price", async () => {
    const ev = await orgEvent({ vat: true });
    const a = await order(ev);
    const b = await order(ev);
    const ra = (await receipt(a.token, a.orderId)).body.document;
    const rb = (await receipt(b.token, b.orderId)).body.document;
    expect([ra.number, rb.number]).toEqual([`RC${thisYear}-000001`, `RC${thisYear}-000002`]);
    // ฿510 including 7% VAT: 510 × 7 / 107 = 33.36
    expect(ra).toMatchObject({ type: 'abbreviated_tax_invoice', subtotalSatang: 47_664, vatSatang: 3_336, totalSatang: 51_000 });
    expect(ra.issuer).toMatchObject({ kind: 'organizer', name: 'บริษัท ริเวอร์ไซด์ สปอร์ต จำกัด', branch: '00000', vatRegistered: true, onBehalfOf: null });
    expect(ra.issuer.address).toBe('1 ถนนเจริญกรุง บางรัก บางรัก กรุงเทพมหานคร 10500');
  });

  it('keeps numbers unique and gap-free when many payments arrive at once, and a rollback gives its number back', async () => {
    const ev = await orgEvent({ vat: false });
    const orders = [];
    for (let i = 0; i < 12; i += 1) orders.push(await order(ev, { pay: false }));
    await Promise.all(orders.map((o) => o.webhook!()));
    const seqs = async () =>
      (await ctx.pool.query<{ doc_seq: number }>('SELECT doc_seq FROM tax_invoices WHERE issuer_org_id = $1 ORDER BY doc_seq', [ev.organizationId])).rows.map((r) => r.doc_seq);
    expect(await seqs()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    // A document issued in a transaction that then fails leaves no hole behind.
    const client = await ctx.app.get(DbService).pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE tax_invoices SET status = 'cancelled' WHERE order_id = $1`, [orders[0].orderId]);
      await issueReceipt(client, orders[0].orderId, ctx.app.get<AppConfig>(CONFIG));
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    await order(ev);
    expect(await seqs()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  });

  it('makes a full tax invoice at once from billing details given at checkout', async () => {
    const ev = await orgEvent({ vat: true });
    const details = billing();
    const o = await order(ev, { billing: details });
    const doc = (await receipt(o.token, o.orderId)).body;
    expect(doc.document).toMatchObject({ type: 'tax_invoice', buyer: { name: details.name, taxId: details.taxId, branch: '00000', address: details.address } });
    expect(doc.canRequestTaxInvoice).toBe(false);

    const bad = await order(ev, { billing: { ...details, taxId: '1234567890123' } });
    expect(bad.created.status).toBe(422);
  });

  it('checks a tax invoice request and replaces the receipt with a new numbered document', async () => {
    const ev = await orgEvent({ vat: true });
    const o = await order(ev);
    const first = (await receipt(o.token, o.orderId)).body.document;
    const details = billing();

    const invalid = [
      { ...details, taxId: '12345' },
      { ...details, taxId: `${details.taxId.slice(0, 12)}${(Number(details.taxId[12]) + 1) % 10}` },
      { ...details, branch: '1' },
      { ...details, address: 'สั้น' },
      { ...details, name: '' },
    ];
    for (const body of invalid) expect((await request(o.token, o.orderId, body)).status).toBe(422);
    expect((await request((await login(ctx.app)).token, o.orderId, details)).status).toBe(404);
    const pending = await order(ev, { pay: false });
    expect((await request(pending.token, pending.orderId, details)).body.code).toBe('RECEIPT_NOT_AVAILABLE');

    // Spaces and dashes in the tax ID are fine; a person has no branch.
    const done = await request(o.token, o.orderId, { ...details, taxId: details.taxId.replace(/^(\d)(\d{4})/, '$1-$2 '), branch: null });
    expect(done.status).toBe(201);
    expect(done.body.document).toMatchObject({ type: 'tax_invoice', buyer: { name: details.name, taxId: details.taxId, branch: null } });
    expect(done.body.document.number).not.toBe(first.number);
    expect(done.body.replaced).toEqual([{ number: first.number, type: 'abbreviated_tax_invoice', issuedAt: expect.any(String) }]);
    expect(done.body.canRequestTaxInvoice).toBe(false);
    const statuses = await ctx.pool.query('SELECT status FROM tax_invoices WHERE order_id = $1 ORDER BY doc_seq', [o.orderId]);
    expect(statuses.rows.map((r) => r.status)).toEqual(['replaced', 'issued']);

    // The same details again change nothing; different ones need the organiser.
    const again = await request(o.token, o.orderId, { ...details, branch: null });
    expect(again.body.document.number).toBe(done.body.document.number);
    expect((await request(o.token, o.orderId, { ...details, name: 'บริษัท อื่น จำกัด' })).body.code).toBe('TAX_INVOICE_EXISTS');
    const audit = await ctx.pool.query(`SELECT action FROM audit_logs WHERE entity_id = $1`, [done.body.document.id]);
    expect(audit.rows.map((a) => a.action)).toEqual(['tax_invoice.request']);
  });

  it('prints buyer details on a plain receipt when the issuer cannot charge VAT', async () => {
    const ev = await orgEvent({ vat: false });
    const o = await order(ev);
    const details = billing();
    const done = await request(o.token, o.orderId, details);
    expect(done.body.document).toMatchObject({ type: 'receipt', vatSatang: 0, buyer: { taxId: details.taxId } });
  });

  it('marks refunded orders on their receipt and issues no tax invoice for them', async () => {
    const ev = await orgEvent({ vat: true });
    const o = await order(ev);
    const reg = await ctx.pool.query('SELECT id FROM registrations WHERE order_id = $1', [o.orderId]);
    const cancel = await call(ctx.app, 'POST', `${ev.base}/registrations/${reg.rows[0].id}/cancel`, { token: ev.ownerToken, body: { refundSatang: 50_000, reason: 'งานเลื่อน' } });
    expect(cancel.status).toBe(201);
    const res = await receipt(o.token, o.orderId);
    expect(res.body.order.status).toBe('refunded');
    expect(res.body.refund).toEqual({ status: 'full', amountSatang: 50_000 });
    expect(res.body.canRequestTaxInvoice).toBe(false);
    expect((await request(o.token, o.orderId, billing())).body.code).toBe('ORDER_REFUNDED');
  });

  it('issues a receipt on first view for an order paid before receipts existed', async () => {
    const ev = await orgEvent();
    const o = await order(ev);
    await ctx.pool.query('DELETE FROM tax_invoices WHERE order_id = $1', [o.orderId]);
    const res = await receipt(o.token, o.orderId);
    expect(res.status).toBe(200);
    expect(res.body.document.type).toBe('receipt');
  });
});
