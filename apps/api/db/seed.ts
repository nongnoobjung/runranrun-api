import { Pool } from 'pg';
import { addOrgMember, createEvent, RIVERSIDE_NIGHT_RUN, RIVERSIDE_ORGANIZER_EMAIL } from './fixtures';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: url });
  try {
    const exists = await pool.query<{ organization_id: string }>('SELECT organization_id FROM events WHERE slug = $1', [RIVERSIDE_NIGHT_RUN.slug]);
    let organizationId = exists.rows[0]?.organization_id;
    if (organizationId) {
      console.log(`${RIVERSIDE_NIGHT_RUN.slug} already seeded`);
    } else {
      const created = await createEvent(pool, RIVERSIDE_NIGHT_RUN);
      organizationId = created.organizationId;
      console.log(`seeded ${RIVERSIDE_NIGHT_RUN.slug}`, created);
    }
    await addOrgMember(pool, organizationId, RIVERSIDE_ORGANIZER_EMAIL, 'owner');
    console.log(`organizer login: ${RIVERSIDE_ORGANIZER_EMAIL} (owner of the organisation)`);
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
