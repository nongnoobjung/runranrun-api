import { rmSync } from 'node:fs';
import { Client } from 'pg';

export default async function globalTeardown(): Promise<void> {
  if (process.env.TEST_STORAGE_DIR) rmSync(process.env.TEST_STORAGE_DIR, { recursive: true, force: true });
  const name = process.env.TEST_DATABASE_NAME;
  if (!name || process.env.KEEP_TEST_DB === '1') return;
  const client = new Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres@127.0.0.1:5432/postgres' });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await client.end();
}
