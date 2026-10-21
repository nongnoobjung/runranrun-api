import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { migrate } from '../db/migrate';

/**
 * Creates a throwaway database on the server in TEST_DATABASE_ADMIN_URL (default: local Postgres),
 * applies the real migrations and points the tests at it. Uploaded files go to a temporary directory.
 */
export default async function globalSetup(): Promise<void> {
  const admin = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres@127.0.0.1:5432/postgres';
  const name = `kao_test_${Date.now()}_${process.pid}`;
  const client = new Client({ connectionString: admin });
  await client.connect();
  await client.query(`CREATE DATABASE ${name}`);
  await client.end();

  const url = new URL(admin);
  url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString();
  process.env.TEST_DATABASE_NAME = name;
  await migrate(process.env.DATABASE_URL, () => undefined);
  process.env.TEST_STORAGE_DIR = mkdtempSync(join(tmpdir(), 'kao-test-storage-'));
}
