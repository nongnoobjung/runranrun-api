import { Pool } from 'pg';
import { seedRiversideContent } from './seed-content';
import { createStorage } from '../src/common/storage';
import { addOrgMember, createEvent, RIVERSIDE_NIGHT_RUN, RIVERSIDE_ORGANIZER_EMAIL, setPlatformRole } from './fixtures';

const ADMIN_EMAIL = 'admin@kao.example';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: url });
  try {
    const exists = await pool.query<{ id: string; organization_id: string }>('SELECT id, organization_id FROM events WHERE slug = $1', [RIVERSIDE_NIGHT_RUN.slug]);
    let organizationId = exists.rows[0]?.organization_id;
    let eventId = exists.rows[0]?.id;
    if (organizationId) {
      console.log(`${RIVERSIDE_NIGHT_RUN.slug} already seeded`);
    } else {
      const created = await createEvent(pool, RIVERSIDE_NIGHT_RUN);
      organizationId = created.organizationId;
      eventId = created.eventId;
      console.log(`seeded ${RIVERSIDE_NIGHT_RUN.slug}`, created);
    }
    // Images go where the API keeps files (the same STORAGE_* settings as the API's .env).
    const storage = createStorage({ STORAGE_DRIVER: 'local', STORAGE_LOCAL_DIR: process.env.STORAGE_LOCAL_DIR || 'storage' });
    if (await seedRiversideContent(pool, storage, eventId)) console.log('event page: Thai and English description, rules, cover and gallery');
    // Company and VAT details, so paid orders get the organiser's own tax invoices (receipts.service.ts).
    const company = await pool.query(
      `UPDATE organizations SET legal_name = 'บริษัท ริเวอร์ไซด์ สปอร์ต จำกัด', tax_id = '0105556123453', is_vat_registered = true,
              address = '{"line1": "88 ถนนเจริญกรุง", "subdistrict": "บางรัก", "district": "บางรัก", "province": "กรุงเทพมหานคร", "postcode": "10500"}'
        WHERE id = $1 AND legal_name IS NULL`,
      [organizationId],
    );
    if (company.rowCount) console.log('organiser company details: VAT registered, issues its own tax invoices');
    await addOrgMember(pool, organizationId, RIVERSIDE_ORGANIZER_EMAIL, 'owner');
    console.log(`organizer login: ${RIVERSIDE_ORGANIZER_EMAIL} (owner of the organisation)`);
    await setPlatformRole(pool, ADMIN_EMAIL, 'superadmin');
    console.log(`admin login: ${ADMIN_EMAIL} (platform superadmin, /admin on the web)`);
    // A second organiser still waiting for KYC, so the admin review queue has something in it locally.
    const pending = await pool.query<{ id: string }>(
      `INSERT INTO organizations (slug, name_th, name_en, legal_name, tax_id, contact_email, contact_phone, status)
       VALUES ('mountain-trail-club', 'ชมรมเทรลภูเขา', 'Mountain Trail Club', 'บริษัท เมาน์เทน เทรล จำกัด', '0105561234567',
               'hello@mountain.example', '053-123-456', 'pending_kyc')
       ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug RETURNING id`,
    );
    await addOrgMember(pool, pending.rows[0].id, 'organizer@mountain.example', 'owner');
    console.log('organiser waiting for KYC: organizer@mountain.example (Mountain Trail Club)');
    // A sample platform commission for local development; real rates are set per organiser by the platform.
    const fee = await pool.query(
      `INSERT INTO platform_fees (organization_id, percent_bps)
       SELECT NULL, 300 WHERE NOT EXISTS (SELECT 1 FROM platform_fees WHERE organization_id IS NULL)
       RETURNING id`,
    );
    if (fee.rowCount) console.log('default platform fee: 3% of sales (development sample)');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
