import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DbService } from '../db/db.service';
import { ProblemException } from './problem';

export interface StoredResponse<T> {
  status: number;
  body: T;
}

/**
 * Stores the first response for (scope, user, key) so a retried POST returns the same result
 * instead of creating a second order or charge.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly dbs: DbService) {}

  async run<T>(
    scope: string,
    userId: string,
    key: string | undefined,
    request: unknown,
    handler: () => Promise<StoredResponse<T>>,
  ): Promise<StoredResponse<T>> {
    if (!key || key.length < 8 || key.length > 128) {
      throw new ProblemException(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (8–128 characters)');
    }
    const fullScope = `${scope}:${userId}`;
    const requestHash = createHash('sha256').update(JSON.stringify(request ?? null)).digest('hex');
    const pool = this.dbs.pool;

    const inserted = await pool.query(
      `INSERT INTO idempotency_keys (key, user_id, scope, request_hash, locked_until)
       VALUES ($1, $2, $3, $4, now() + interval '60 seconds')
       ON CONFLICT (scope, key) DO NOTHING
       RETURNING key`,
      [key, userId, fullScope, requestHash],
    );

    if (inserted.rowCount === 0) {
      const { rows } = await pool.query<{
        request_hash: string;
        response_status: number | null;
        response_body: T;
        locked_until: Date | null;
      }>(
        `SELECT request_hash, response_status, response_body, locked_until
           FROM idempotency_keys WHERE scope = $1 AND key = $2`,
        [fullScope, key],
      );
      const row = rows[0];
      if (row.request_hash !== requestHash) {
        throw new ProblemException(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was used for a different request');
      }
      if (row.response_status !== null) {
        return { status: row.response_status, body: row.response_body };
      }
      throw new ProblemException(409, 'IDEMPOTENCY_IN_PROGRESS', 'The same request is still being processed');
    }

    try {
      const result = await handler();
      await pool.query(
        `UPDATE idempotency_keys SET response_status = $3, response_body = $4, locked_until = NULL
          WHERE scope = $1 AND key = $2`,
        [fullScope, key, result.status, JSON.stringify(result.body)],
      );
      return result;
    } catch (err) {
      // Failed attempts are not cached, so the client can fix the input and retry with the same key.
      await pool.query('DELETE FROM idempotency_keys WHERE scope = $1 AND key = $2', [fullScope, key]);
      throw err;
    }
  }
}
