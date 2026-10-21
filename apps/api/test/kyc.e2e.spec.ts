import { randomUUID } from 'node:crypto';
import { addOrgMember, setPlatformRole } from '../db/fixtures';
import { bootApp, call, login, TestContext } from './helpers';

/** Smallest bytes each driver of the type check recognises. */
const PDF = Buffer.from('%PDF-1.4\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
/** A tax ID with a correct check digit. */
const TAX_ID = '0105550123451';

const company = {
  legalName: 'บริษัท ริเวอร์ไซด์ รันเนอร์ส จำกัด',
  taxId: '0-1055-50123-45-1',
  isVatRegistered: true,
  contactPhone: '081-234-5678',
  address: { line1: '99 ถนนเจริญกรุง', subdistrict: 'บางรัก', district: 'บางรัก', province: 'กรุงเทพมหานคร', postcode: '10500' },
};

function multipart(fields: Record<string, string>, file?: { name: string; type: string; body: Buffer }) {
  const boundary = `----kao${randomUUID()}`;
  const parts: Buffer[] = Object.entries(fields).map(([k, v]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (file) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`),
      file.body,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('organiser sign-up and KYC', () => {
  let ctx: TestContext;
  let admin: string;

  beforeAll(async () => {
    ctx = await bootApp();
    const email = `admin-${randomUUID()}@kao.example`;
    await setPlatformRole(ctx.pool, email, 'admin');
    admin = (await login(ctx.app, email)).token;
  });
  afterAll(() => ctx.close());

  async function signUp(nameTh = 'ทีมสมัครเอง') {
    const owner = await login(ctx.app, `owner-${randomUUID()}@org.example`);
    const res = await call(ctx.app, 'POST', '/v1/org', { token: owner.token, body: { nameTh, nameEn: 'Self Signup Runners', contactEmail: 'Team@Org.example' } });
    expect(res.status).toBe(201);
    return { ...owner, orgId: res.body.id as string, base: `/v1/org/${res.body.id}`, body: res.body };
  }

  async function upload(token: string, orgId: string, fields: Record<string, string>, file?: { name: string; type: string; body: Buffer }) {
    const { payload, headers } = multipart(fields, file);
    const res = await ctx.app.inject({ method: 'POST', url: `/v1/org/${orgId}/kyc/documents`, headers: { ...headers, authorization: `Bearer ${token}` }, payload });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }

  async function download(url: string, token?: string) {
    const res = await ctx.app.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.statusCode, body: res.rawPayload, headers: res.headers };
  }

  it('lets a signed-in user open a team that waits for KYC, with themselves as owner', async () => {
    const { token, orgId, body } = await signUp();
    expect(body).toMatchObject({
      nameTh: 'ทีมสมัครเอง',
      nameEn: 'Self Signup Runners',
      slug: expect.stringMatching(/^self-signup-runners-[0-9a-f]{6}$/),
      status: 'pending_kyc',
      contactEmail: 'team@org.example',
      documents: [],
      bankAccount: null,
      readiness: [
        { key: 'company', ok: false },
        { key: 'id_card', ok: false },
        { key: 'bank_book', ok: false },
        { key: 'bank_account', ok: false },
      ],
    });
    expect((await call(ctx.app, 'GET', '/v1/org', { token })).body.items).toEqual([expect.objectContaining({ id: orgId, status: 'pending_kyc', role: 'owner' })]);
    const org = await ctx.pool.query('SELECT review_events FROM organizations WHERE id = $1', [orgId]);
    expect(org.rows[0].review_events).toBe(true);
    const audit = await ctx.pool.query(`SELECT 1 FROM audit_logs WHERE organization_id = $1 AND action = 'org.create'`, [orgId]);
    expect(audit.rowCount).toBe(1);

    expect((await call(ctx.app, 'POST', '/v1/org', { body: { nameTh: 'x' } })).status).toBe(401);
    expect((await call(ctx.app, 'POST', '/v1/org', { token, body: { nameTh: 'ทีม', contactEmail: 'not-an-email' } })).status).toBe(422);
    // At most three teams waiting for KYC per person.
    for (const n of [2, 3]) expect((await call(ctx.app, 'POST', '/v1/org', { token, body: { nameTh: `ทีมที่ ${n}`, contactEmail: 'a@b.example' } })).status).toBe(201);
    expect((await call(ctx.app, 'POST', '/v1/org', { token, body: { nameTh: 'ทีมที่ 4', contactEmail: 'a@b.example' } })).body.code).toBe('TOO_MANY_PENDING_TEAMS');
  });

  it('saves the company details, checks the tax ID, and locks the legal ones after KYC', async () => {
    const { token, orgId, base } = await signUp();
    const bad = await call(ctx.app, 'PATCH', `${base}/kyc`, { token, body: { ...company, taxId: '0105550123452' } });
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toEqual([expect.objectContaining({ path: 'taxId' })]);

    const saved = await call(ctx.app, 'PATCH', `${base}/kyc`, { token, body: company });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ legalName: company.legalName, taxId: TAX_ID, contactPhone: '0812345678', address: company.address, isVatRegistered: true });
    expect(saved.body.readiness[0]).toEqual({ key: 'company', ok: true });

    const adminMember = `member-${randomUUID()}@org.example`;
    await addOrgMember(ctx.pool, orgId, adminMember, 'admin');
    const member = await login(ctx.app, adminMember);
    expect((await call(ctx.app, 'GET', `${base}/kyc`, { token: member.token })).status).toBe(200);
    expect((await call(ctx.app, 'PATCH', `${base}/kyc`, { token: member.token, body: { contactPhone: '0899999999' } })).status).toBe(403);
    const outsider = await login(ctx.app);
    expect((await call(ctx.app, 'GET', `${base}/kyc`, { token: outsider.token })).status).toBe(404);

    expect((await call(ctx.app, 'POST', `/v1/admin/organizations/${orgId}/approve`, { token: admin })).status).toBe(200);
    const locked = await call(ctx.app, 'PATCH', `${base}/kyc`, { token, body: { taxId: '0105550123460' } });
    expect(locked.body).toMatchObject({ status: 409, code: 'KYC_LOCKED', field: 'taxId' });
    // Same values and contact details are fine.
    expect((await call(ctx.app, 'PATCH', `${base}/kyc`, { token, body: { taxId: TAX_ID, contactPhone: '0899999999' } })).body.contactPhone).toBe('0899999999');
  });

  it('accepts PDF, JPG and PNG up to 10 MB, judged by the bytes', async () => {
    const { token, orgId } = await signUp();
    const ok = await upload(token, orgId, { type: 'id_card' }, { name: '../บัตรประชาชน.pdf', type: 'application/pdf', body: PDF });
    expect(ok.status).toBe(201);
    expect(ok.body.documents).toEqual([
      expect.objectContaining({ type: 'id_card', fileName: 'บัตรประชาชน.pdf', contentType: 'application/pdf', sizeBytes: PDF.length, status: 'pending', rejectReason: null }),
    ]);
    expect(ok.body.readiness).toContainEqual({ key: 'id_card', ok: true });
    // The browser's content type and name do not decide: these bytes are a PNG.
    const png = await upload(token, orgId, { type: 'bank_book' }, { name: 'bank.pdf', type: 'application/pdf', body: PNG });
    expect(png.body.documents[0]).toMatchObject({ type: 'bank_book', fileName: 'bank.png', contentType: 'image/png' });

    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(5 * 1024 * 1024)]);
    const photo = await upload(token, orgId, { type: 'other' }, { name: 'photo.jpeg', type: 'image/jpeg', body: jpg });
    expect(photo.body.documents[0]).toMatchObject({ fileName: 'photo.jpg', contentType: 'image/jpeg', sizeBytes: jpg.length });

    const text = await upload(token, orgId, { type: 'other' }, { name: 'notes.pdf', type: 'application/pdf', body: Buffer.from('just text') });
    expect(text).toMatchObject({ status: 415, body: { code: 'UNSUPPORTED_FILE_TYPE' } });
    const big = Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]);
    expect(await upload(token, orgId, { type: 'other' }, { name: 'big.pdf', type: 'application/pdf', body: big })).toMatchObject({ status: 413, body: { code: 'FILE_TOO_LARGE' } });
    expect(await upload(token, orgId, { type: 'other' })).toMatchObject({ status: 422, body: { code: 'FILE_REQUIRED' } });
    expect((await upload(token, orgId, { type: 'passport' }, { name: 'a.pdf', type: 'application/pdf', body: PDF })).status).toBe(422);
    expect((await call(ctx.app, 'POST', `/v1/org/${orgId}/kyc/documents`, { token, body: { type: 'other' } })).body.code).toBe('UNSUPPORTED_MEDIA_TYPE');

    const staffEmail = `staff-${randomUUID()}@org.example`;
    await addOrgMember(ctx.pool, orgId, staffEmail, 'staff');
    const staff = await login(ctx.app, staffEmail);
    expect((await upload(staff.token, orgId, { type: 'other' }, { name: 'a.pdf', type: 'application/pdf', body: PDF })).status).toBe(403);
    const docs = await ctx.pool.query('SELECT count(*)::int AS n FROM organizer_kyc_documents WHERE organization_id = $1', [orgId]);
    expect(docs.rows[0].n).toBe(3);
  });

  it('serves documents only to the team’s owners and admins and to platform staff, never cached', async () => {
    const { token, orgId } = await signUp();
    const doc = (await upload(token, orgId, { type: 'id_card' }, { name: 'id.pdf', type: 'application/pdf', body: PDF })).body.documents[0];
    const url = `/v1/org/${orgId}/kyc/documents/${doc.id}/file`;

    const own = await download(url, token);
    expect(own.status).toBe(200);
    expect(own.body.equals(PDF)).toBe(true);
    expect(own.headers).toMatchObject({ 'content-type': 'application/pdf', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
    expect(own.headers['content-disposition']).toBe(`inline; filename*=UTF-8''id.pdf`);

    expect((await download(url)).status).toBe(401);
    expect((await download(url, (await login(ctx.app)).token)).status).toBe(404);
    const staffEmail = `staff-${randomUUID()}@org.example`;
    await addOrgMember(ctx.pool, orgId, staffEmail, 'staff');
    expect((await download(url, (await login(ctx.app, staffEmail)).token)).status).toBe(403);
    // Another team's owner cannot reach it through their own team either.
    const other = await signUp();
    expect((await download(`/v1/org/${other.orgId}/kyc/documents/${doc.id}/file`, other.token)).status).toBe(404);

    const adminUrl = `/v1/admin/organizations/${orgId}/documents/${doc.id}/file`;
    expect((await download(adminUrl, token)).status).toBe(403);
    const supportEmail = `support-${randomUUID()}@kao.example`;
    await setPlatformRole(ctx.pool, supportEmail, 'support');
    const support = await download(adminUrl, (await login(ctx.app, supportEmail)).token);
    expect(support.status).toBe(200);
    expect(support.body.equals(PDF)).toBe(true);

    const views = await ctx.pool.query(`SELECT action FROM audit_logs WHERE entity_id = $1 AND action LIKE '%view' ORDER BY created_at`, [doc.id]);
    expect(views.rows.map((r) => r.action)).toEqual(['kyc.document_view', 'admin.kyc_doc_view']);
  });

  it('lets the admin approve or send back each document, and the owner replace what was sent back', async () => {
    const { token, orgId, base } = await signUp();
    await upload(token, orgId, { type: 'id_card' }, { name: 'id.pdf', type: 'application/pdf', body: PDF });
    const kyc = await upload(token, orgId, { type: 'bank_book' }, { name: 'book.png', type: 'image/png', body: PNG });
    const [book, id] = kyc.body.documents;
    const docs = `/v1/admin/organizations/${orgId}/documents`;

    const supportEmail = `support-${randomUUID()}@kao.example`;
    await setPlatformRole(ctx.pool, supportEmail, 'support');
    const support = await login(ctx.app, supportEmail);
    expect((await call(ctx.app, 'POST', `${docs}/${id.id}/approve`, { token: support.token })).status).toBe(403);
    expect((await call(ctx.app, 'POST', `${docs}/${book.id}/reject`, { token: admin, body: { reason: '' } })).status).toBe(422);

    const rejected = await call(ctx.app, 'POST', `${docs}/${book.id}/reject`, { token: admin, body: { reason: 'ภาพไม่ชัด เห็นเลขบัญชีไม่ครบ' } });
    expect(rejected.status).toBe(200);
    expect(rejected.body.documents).toContainEqual(expect.objectContaining({ id: book.id, status: 'rejected', rejectReason: 'ภาพไม่ชัด เห็นเลขบัญชีไม่ครบ', reviewedAt: expect.any(String) }));
    const approved = await call(ctx.app, 'POST', `${docs}/${id.id}/approve`, { token: admin });
    expect(approved.body.documents).toContainEqual(expect.objectContaining({ id: id.id, status: 'approved', rejectReason: null }));
    expect((await call(ctx.app, 'POST', `${docs}/${randomUUID()}/approve`, { token: admin })).status).toBe(404);

    // The owner sees why, and the team is not ready until a new bank book is in.
    const mine = (await call(ctx.app, 'GET', `${base}/kyc`, { token })).body;
    expect(mine.documents).toContainEqual(expect.objectContaining({ id: book.id, status: 'rejected', rejectReason: 'ภาพไม่ชัด เห็นเลขบัญชีไม่ครบ' }));
    expect(mine.readiness).toContainEqual({ key: 'bank_book', ok: false });
    expect((await call(ctx.app, 'DELETE', `${base}/kyc/documents/${id.id}`, { token })).body.code).toBe('DOCUMENT_APPROVED');
    const removed = await call(ctx.app, 'DELETE', `${base}/kyc/documents/${book.id}`, { token });
    expect(removed.body.documents.map((d: { id: string }) => d.id)).toEqual([id.id]);
    expect((await download(`${base}/kyc/documents/${book.id}/file`, token)).status).toBe(404);
    const again = await upload(token, orgId, { type: 'bank_book' }, { name: 'book.pdf', type: 'application/pdf', body: PDF });
    expect(again.body.readiness).toContainEqual({ key: 'bank_book', ok: true });

    const audit = await ctx.pool.query(`SELECT action FROM audit_logs WHERE organization_id = $1 AND action LIKE 'admin.kyc_doc_%' ORDER BY created_at`, [orgId]);
    expect(audit.rows.map((r) => r.action)).toEqual(['admin.kyc_doc_reject', 'admin.kyc_doc_approve']);
    const list = await call(ctx.app, 'GET', '/v1/admin/organizations?status=pending_kyc', { token: admin });
    expect(list.body.items).toContainEqual(expect.objectContaining({ id: orgId, pendingDocs: 1 }));
  });

  it('takes the owner’s bank account unverified until the admin verifies it', async () => {
    const { token, orgId, base } = await signUp();
    const account = { bankCode: 'SCB', accountName: 'ทีมสมัครเอง', accountNumber: '111-2-33333-4' };
    const staffEmail = `staff-${randomUUID()}@org.example`;
    await addOrgMember(ctx.pool, orgId, staffEmail, 'admin');
    expect((await call(ctx.app, 'PUT', `${base}/bank-account`, { token: (await login(ctx.app, staffEmail)).token, body: account })).status).toBe(403);

    await call(ctx.app, 'PUT', `${base}/bank-account`, { token, body: { ...account, accountNumber: '9999999999' } });
    const submitted = await call(ctx.app, 'PUT', `${base}/bank-account`, { token, body: account });
    expect(submitted.status).toBe(200);
    expect(submitted.body).toMatchObject({
      bankAccount: null,
      submittedBankAccount: { bankCode: 'SCB', accountName: 'ทีมสมัครเอง', accountLast4: '3334', verified: false },
      readiness: expect.arrayContaining([{ key: 'bank_account', ok: true }]),
    });
    expect(JSON.stringify(submitted.body)).not.toContain('1112333334');

    // Payouts still need a verified account.
    const view = (await call(ctx.app, 'GET', `/v1/admin/organizations/${orgId}`, { token: admin })).body;
    expect(view).toMatchObject({ bankAccount: null, submittedBankAccount: { accountNumber: '1112333334', accountLast4: '3334' } });
    const supportEmail = `support-${randomUUID()}@kao.example`;
    await setPlatformRole(ctx.pool, supportEmail, 'support');
    const support = await login(ctx.app, supportEmail);
    expect((await call(ctx.app, 'GET', `/v1/admin/organizations/${orgId}`, { token: support.token })).body.submittedBankAccount.accountNumber).toBeNull();
    expect((await call(ctx.app, 'POST', `/v1/admin/organizations/${orgId}/bank-account/verify`, { token: support.token })).status).toBe(403);

    const verified = await call(ctx.app, 'POST', `/v1/admin/organizations/${orgId}/bank-account/verify`, { token: admin });
    expect(verified.status).toBe(200);
    expect(verified.body).toMatchObject({ bankAccount: { bankCode: 'SCB', accountLast4: '3334', verified: true }, submittedBankAccount: null });
    expect((await call(ctx.app, 'POST', `/v1/admin/organizations/${orgId}/bank-account/verify`, { token: admin })).body.code).toBe('NO_BANK_SUBMISSION');
    const mine = (await call(ctx.app, 'GET', `${base}/kyc`, { token })).body;
    expect(mine).toMatchObject({ bankAccount: { accountLast4: '3334', verified: true }, submittedBankAccount: null });
    const rows = await ctx.pool.query('SELECT verified_by, submitted_by FROM bank_accounts WHERE organization_id = $1', [orgId]);
    expect(rows.rows).toEqual([{ verified_by: expect.any(String), submitted_by: expect.any(String) }]);

    // A later submission waits beside the verified account; the admin recording one directly replaces it.
    await call(ctx.app, 'PUT', `${base}/bank-account`, { token, body: { ...account, accountNumber: '2222222222' } });
    const both = (await call(ctx.app, 'GET', `${base}/kyc`, { token })).body;
    expect(both).toMatchObject({ bankAccount: { accountLast4: '3334' }, submittedBankAccount: { accountLast4: '2222' } });
    await call(ctx.app, 'PUT', `/v1/admin/organizations/${orgId}/bank-account`, { token: admin, body: { ...account, accountNumber: '5555555555' } });
    expect((await call(ctx.app, 'GET', `${base}/kyc`, { token })).body).toMatchObject({ bankAccount: { accountLast4: '5555' }, submittedBankAccount: null });
  });
});
