import { Inject, Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { AppConfig, CONFIG } from '../../config';
import { encryptPii } from '../../common/crypto';
import { ProblemException, problems } from '../../common/problem';
import { FILE_STORAGE, FileStorage } from '../../common/storage';
import { StoredFile } from '../../common/upload';
import { DbService } from '../../db/db.service';
import { bankSchema } from '../refunds/refunds.service';
import { writeAudit } from './org-access.service';

export const KYC_DOC_TYPES = ['company_certificate', 'vat_registration', 'id_card', 'bank_book', 'other'] as const;
export type KycDocType = (typeof KYC_DOC_TYPES)[number];

/** Documents every team sends before the admin approves it; the company certificate and VAT form only apply to companies. */
const REQUIRED_DOCS: KycDocType[] = ['id_card', 'bank_book'];
export const KYC_MAX_BYTES = 10 * 1024 * 1024;
const MAX_DOCUMENTS = 20;
/** A user can have this many teams waiting for KYC at once, so sign-up cannot be used to flood the admin queue. */
const MAX_PENDING_TEAMS = 3;

/** What the bytes are, judged from the file itself rather than the name or the type the browser sent. */
const SIGNATURES: { type: string; ext: string; magic: number[] }[] = [
  { type: 'application/pdf', ext: 'pdf', magic: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { type: 'image/png', ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: 'image/jpeg', ext: 'jpg', magic: [0xff, 0xd8, 0xff] },
];

export function sniffFileType(body: Buffer): { type: string; ext: string } | null {
  return SIGNATURES.find((s) => body.length >= s.magic.length && s.magic.every((b, i) => body[i] === b)) ?? null;
}

/** Thai tax / citizen IDs end in a mod-11 check digit. */
export function validTaxId(id: string): boolean {
  if (!/^\d{13}$/.test(id)) return false;
  const sum = [...id.slice(0, 12)].reduce((s, d, i) => s + Number(d) * (13 - i), 0);
  return (11 - (sum % 11)) % 10 === Number(id[12]);
}

const phone = z.string().trim().transform((v) => v.replace(/[\s-]/g, '')).pipe(z.string().regex(/^0\d{8,9}$/, 'Thai phone number'));
const email = z.string().trim().toLowerCase().email().max(254);

export const createOrgSchema = z.object({
  nameTh: z.string().trim().min(2).max(120),
  nameEn: z.string().trim().max(120).optional(),
  contactEmail: email,
  contactPhone: phone.optional(),
});

const addressSchema = z.object({
  line1: z.string().trim().min(1).max(200),
  subdistrict: z.string().trim().max(100).default(''),
  district: z.string().trim().min(1).max(100),
  province: z.string().trim().min(1).max(100),
  postcode: z.string().trim().regex(/^\d{5}$/, '5 digits'),
});

export const companySchema = z
  .object({
    nameTh: z.string().trim().min(2).max(120),
    nameEn: z.string().trim().max(120).nullable(),
    legalName: z.string().trim().min(2).max(200),
    taxId: z
      .string()
      .trim()
      .transform((v) => v.replace(/[\s-]/g, ''))
      .pipe(z.string().refine(validTaxId, 'A valid 13-digit tax ID')),
    isVatRegistered: z.boolean(),
    contactEmail: email,
    contactPhone: phone,
    address: addressSchema,
  })
  .partial();

export const docTypeSchema = z.enum(KYC_DOC_TYPES);
export const orgBankSchema = bankSchema.extend({ branch: z.string().trim().max(100).optional() });

/** Fields that identify who passed KYC; they stay as checked once the team is approved. */
const LOCKED_AFTER_KYC = { legalName: 'legal_name', taxId: 'tax_id', isVatRegistered: 'is_vat_registered' } as const;

const COLUMNS = {
  nameTh: 'name_th', nameEn: 'name_en', legalName: 'legal_name', taxId: 'tax_id', isVatRegistered: 'is_vat_registered',
  contactEmail: 'contact_email', contactPhone: 'contact_phone', address: 'address',
} as const satisfies Record<keyof z.infer<typeof companySchema>, string>;

/**
 * An organiser's own side of KYC: opening a team, the company details, the documents the platform checks and the
 * account payouts go to. The platform admin approves it (AdminService). Every change is written to audit_logs.
 */
@Injectable()
export class OrgKycService {
  constructor(
    private readonly dbs: DbService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** A new team, waiting for KYC and with its events reviewed, owned by the caller. */
  async create(userId: string, input: z.infer<typeof createOrgSchema>) {
    return this.dbs.transaction(async (_tx, client) => {
      // One sign-up at a time per user, so the count below cannot be raced past.
      await client.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
      const pending = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM org_members m JOIN organizations o ON o.id = m.organization_id
          WHERE m.user_id = $1 AND m.role = 'owner' AND o.status = 'pending_kyc'`,
        [userId],
      );
      if (pending.rows[0].n >= MAX_PENDING_TEAMS) {
        throw new ProblemException(409, 'TOO_MANY_PENDING_TEAMS', `You already have ${MAX_PENDING_TEAMS} teams waiting for KYC`);
      }
      const { rows } = await client.query<{ id: string; slug: string }>(
        `INSERT INTO organizations (slug, name_th, name_en, contact_email, contact_phone, status, review_events)
         VALUES ($1, $2, $3, $4, $5, 'pending_kyc', true) RETURNING id, slug`,
        [slugFor(input.nameEn), input.nameTh, input.nameEn || null, input.contactEmail, input.contactPhone ?? null],
      );
      const org = rows[0];
      await client.query(`INSERT INTO org_members (organization_id, user_id, role, accepted_at) VALUES ($1, $2, 'owner', now())`, [org.id, userId]);
      await writeAudit(client, { actorId: userId, organizationId: org.id, action: 'org.create', entityType: 'organization', entityId: org.id, after: input });
      return this.get(org.id, client);
    });
  }

  /** The team's KYC as its members see it: details, documents, payout account and what is still missing. */
  async get(orgId: string, db: Pick<PoolClient, 'query'> = this.dbs.pool) {
    const { rows } = await db.query('SELECT * FROM organizations WHERE id = $1', [orgId]);
    const o = rows[0];
    if (!o) throw problems.notFound('Organization');
    const [docs, banks] = await Promise.all([
      db.query(
        `SELECT id, doc_type, file_name, content_type, size_bytes, status, reject_reason, reviewed_at, created_at
           FROM organizer_kyc_documents WHERE organization_id = $1 ORDER BY created_at DESC`,
        [orgId],
      ),
      db.query(
        `SELECT bank_code, account_name, account_number_last4, branch, verified_at, created_at FROM bank_accounts
          WHERE organization_id = $1 AND (is_default OR verified_at IS NULL) ORDER BY created_at DESC`,
        [orgId],
      ),
    ]);
    const documents = docs.rows.map(documentView);
    const verified = banks.rows.find((b) => b.verified_at);
    const submitted = banks.rows.find((b) => !b.verified_at);
    const has = (type: KycDocType) => documents.some((d) => d.type === type && d.status !== 'rejected');
    return {
      id: o.id as string,
      slug: o.slug as string,
      nameTh: o.name_th as string,
      nameEn: o.name_en as string | null,
      status: o.status as 'pending_kyc' | 'active' | 'suspended',
      statusNote: o.status_note as string | null,
      kycApprovedAt: o.kyc_approved_at as Date | null,
      legalName: o.legal_name as string | null,
      taxId: o.tax_id as string | null,
      isVatRegistered: o.is_vat_registered as boolean,
      contactEmail: o.contact_email as string | null,
      contactPhone: o.contact_phone as string | null,
      address: o.address as z.infer<typeof addressSchema> | null,
      documents,
      bankAccount: verified ? bankView(verified) : null,
      submittedBankAccount: submitted ? bankView(submitted) : null,
      readiness: [
        { key: 'company', ok: Boolean(o.legal_name && o.tax_id && o.contact_email && o.contact_phone && o.address) },
        ...REQUIRED_DOCS.map((t) => ({ key: t, ok: has(t) })),
        { key: 'bank_account', ok: Boolean(verified || submitted) },
      ],
    };
  }

  async updateCompany(userId: string, orgId: string, input: z.infer<typeof companySchema>) {
    return this.dbs.transaction(async (_tx, client) => {
      const { rows } = await client.query('SELECT * FROM organizations WHERE id = $1 FOR UPDATE', [orgId]);
      const before = rows[0];
      if (before.status !== 'pending_kyc') {
        for (const [field, column] of Object.entries(LOCKED_AFTER_KYC)) {
          const next = input[field as keyof typeof LOCKED_AFTER_KYC];
          if (next !== undefined && next !== before[column]) {
            throw new ProblemException(409, 'KYC_LOCKED', 'The legal name and tax details were checked for KYC; ask the platform to change them', undefined, { field });
          }
        }
      }
      const entries = Object.entries(input).filter(([, v]) => v !== undefined) as [keyof typeof COLUMNS, unknown][];
      if (entries.length) {
        const sets = entries.map(([k], i) => `${COLUMNS[k]} = $${i + 2}`);
        await client.query(`UPDATE organizations SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, [
          orgId, ...entries.map(([k, v]) => (k === 'address' ? JSON.stringify(v) : k === 'nameEn' ? v || null : v)),
        ]);
        await writeAudit(client, {
          actorId: userId, organizationId: orgId, action: 'kyc.company_update', entityType: 'organization', entityId: orgId,
          before: Object.fromEntries(entries.map(([k]) => [k, before[COLUMNS[k]]])), after: input,
        });
      }
      return this.get(orgId, client);
    });
  }

  /** Stores the file privately and adds it to the team's documents, waiting for the admin. */
  async upload(userId: string, orgId: string, type: KycDocType, file: { body: Buffer; fileName: string }) {
    const kind = sniffFileType(file.body);
    if (!kind) throw new ProblemException(415, 'UNSUPPORTED_FILE_TYPE', 'Upload a PDF, JPG or PNG file');
    if (file.body.length > KYC_MAX_BYTES) throw new ProblemException(413, 'FILE_TOO_LARGE', 'Files can be at most 10 MB');
    if (file.body.length === 0) throw new ProblemException(422, 'EMPTY_FILE', 'The file is empty');
    const id = randomUUID();
    const key = `kyc/${orgId}/${id}.${kind.ext}`;
    const fileName = cleanFileName(file.fileName, kind.ext);
    await this.storage.put(key, file.body, kind.type);
    try {
      return await this.dbs.transaction(async (_tx, client) => {
        await client.query('SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE', [orgId]);
        const count = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM organizer_kyc_documents WHERE organization_id = $1', [orgId]);
        if (count.rows[0].n >= MAX_DOCUMENTS) {
          throw new ProblemException(409, 'TOO_MANY_DOCUMENTS', `A team can keep at most ${MAX_DOCUMENTS} documents; delete old ones first`);
        }
        await client.query(
          `INSERT INTO organizer_kyc_documents (id, organization_id, doc_type, file_key, file_name, content_type, size_bytes, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [id, orgId, type, key, fileName, kind.type, file.body.length, userId],
        );
        await writeAudit(client, {
          actorId: userId, organizationId: orgId, action: 'kyc.document_upload', entityType: 'kyc_document', entityId: id,
          after: { type, fileName, contentType: kind.type, sizeBytes: file.body.length },
        });
        return this.get(orgId, client);
      });
    } catch (err) {
      await this.storage.delete(key);
      throw err;
    }
  }

  /** Removes a document the admin has not approved (a wrong file, or one sent back). */
  async deleteDocument(userId: string, orgId: string, docId: string) {
    let key = '';
    const result = await this.dbs.transaction(async (_tx, client) => {
      const { rows } = await client.query(
        'SELECT doc_type, file_key, file_name, status FROM organizer_kyc_documents WHERE id = $1 AND organization_id = $2 FOR UPDATE',
        [docId, orgId],
      );
      const doc = rows[0];
      if (!doc) throw problems.notFound('Document');
      if (doc.status === 'approved') throw new ProblemException(409, 'DOCUMENT_APPROVED', 'An approved document stays on file');
      await client.query('DELETE FROM organizer_kyc_documents WHERE id = $1', [docId]);
      await writeAudit(client, {
        actorId: userId, organizationId: orgId, action: 'kyc.document_delete', entityType: 'kyc_document', entityId: docId,
        before: { type: doc.doc_type, fileName: doc.file_name, status: doc.status },
      });
      key = doc.file_key;
      return this.get(orgId, client);
    });
    await this.storage.delete(key);
    return result;
  }

  /**
   * The document's bytes, for the team's owners and admins or platform staff; callers check who is asking first.
   * Every view is audited, the way revealing a runner's ID number is.
   */
  async file(actorId: string, orgId: string, docId: string, action: string): Promise<StoredFile> {
    const { rows } = await this.dbs.pool.query(
      'SELECT file_key, file_name, content_type FROM organizer_kyc_documents WHERE id = $1 AND organization_id = $2',
      [docId, orgId],
    );
    const doc = rows[0];
    if (!doc) throw problems.notFound('Document');
    const body = await this.storage.get(doc.file_key);
    if (!body) throw problems.notFound('File');
    await writeAudit(this.dbs.pool, { actorId, organizationId: orgId, action, entityType: 'kyc_document', entityId: docId });
    return { body, contentType: doc.content_type ?? 'application/octet-stream', fileName: doc.file_name ?? 'document' };
  }

  /** The owner's payout account; it waits unverified until the admin checks it against the bank book. Replaces an earlier submission. */
  async submitBankAccount(userId: string, orgId: string, input: z.infer<typeof orgBankSchema>) {
    return this.dbs.transaction(async (_tx, client) => {
      await client.query('SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE', [orgId]);
      await client.query('DELETE FROM bank_accounts WHERE organization_id = $1 AND verified_at IS NULL', [orgId]);
      await client.query(
        `INSERT INTO bank_accounts (organization_id, bank_code, account_name, account_number_enc, account_number_last4, branch, submitted_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          orgId, input.bankCode, input.accountName, encryptPii(input.accountNumber, this.config.PII_ENCRYPTION_KEY),
          input.accountNumber.slice(-4), input.branch ?? null, userId,
        ],
      );
      await writeAudit(client, {
        actorId: userId, organizationId: orgId, action: 'kyc.bank_submit', entityType: 'organization', entityId: orgId,
        after: { bankCode: input.bankCode, accountLast4: input.accountNumber.slice(-4) },
      });
      return this.get(orgId, client);
    });
  }
}

export function documentView(d: Record<string, any>) {
  return {
    id: d.id as string,
    type: d.doc_type as KycDocType,
    fileName: d.file_name as string | null,
    contentType: d.content_type as string | null,
    sizeBytes: d.size_bytes as number | null,
    status: d.status as 'pending' | 'approved' | 'rejected',
    rejectReason: d.reject_reason as string | null,
    reviewedAt: d.reviewed_at as Date | null,
    createdAt: d.created_at as Date,
  };
}

function bankView(b: Record<string, any>) {
  return {
    bankCode: b.bank_code as string,
    accountName: b.account_name as string,
    accountLast4: b.account_number_last4 as string,
    branch: b.branch as string | null,
    verified: b.verified_at !== null,
    submittedAt: b.created_at as Date,
  };
}

/** `Riverside Runners` → `riverside-runners-3f9a1c`; Thai-only names get `team-3f9a1c`. */
function slugFor(nameEn: string | undefined): string {
  const base = (nameEn ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `${base || 'team'}-${randomBytes(3).toString('hex')}`;
}

/** Keeps the name readable in a download header: no paths or control characters, and the extension the bytes really have. */
function cleanFileName(name: string, ext: string): string {
  const base = name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f"]/g, '').replace(/\.[^.]*$/, '').trim().slice(0, 100);
  return `${base || 'document'}.${ext}`;
}
