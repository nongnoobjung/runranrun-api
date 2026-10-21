import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const MIGRATIONS_DIR = join(__dirname, 'migrations');

/** Applies every db/migrations/*.sql file not yet recorded in schema_migrations, in name order. */
export async function migrate(databaseUrl: string, log: (msg: string) => void = console.log): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  migrate(url).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
