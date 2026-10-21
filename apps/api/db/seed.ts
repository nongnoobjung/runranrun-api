import { Pool } from 'pg';
import { createEvent, RIVERSIDE_NIGHT_RUN } from './fixtures';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: url });
  try {
    const exists = await pool.query('SELECT 1 FROM events WHERE slug = $1', [RIVERSIDE_NIGHT_RUN.slug]);
    if (exists.rowCount) {
      console.log(`${RIVERSIDE_NIGHT_RUN.slug} already seeded`);
      return;
    }
    const created = await createEvent(pool, RIVERSIDE_NIGHT_RUN);
    console.log(`seeded ${RIVERSIDE_NIGHT_RUN.slug}`, created);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
