import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, PoolClient } from 'pg';
import { AppConfig, CONFIG } from '../config';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;

@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool: Pool;
  readonly db: Db;

  constructor(@Inject(CONFIG) config: AppConfig) {
    this.pool = new Pool({ connectionString: config.DATABASE_URL, max: config.DATABASE_POOL_SIZE });
    this.db = drizzle(this.pool, { schema });
  }

  /** Runs fn inside one transaction on a dedicated client; rolls back on any throw. */
  async transaction<T>(fn: (tx: Db, client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(drizzle(client, { schema }), client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
