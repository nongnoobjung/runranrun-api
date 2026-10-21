import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { releaseChangeOrder } from '../changes/settle';
import { InventoryService } from './inventory.service';

/** Expires abandoned checkouts: returns places, expires unpaid orders and frees the runners' ID slots. */
@Injectable()
export class HoldReleaseService {
  private readonly logger = new Logger(HoldReleaseService.name);

  constructor(
    private readonly dbs: DbService,
    private readonly inventory: InventoryService,
  ) {}

  async releaseExpired(batchSize = 200): Promise<number> {
    let released = 0;
    for (;;) {
      const done = await this.dbs.transaction(async (_tx, client) => {
        const { rows } = await client.query<{ id: string }>(
          `SELECT id FROM checkout_sessions
            WHERE status = 'active' AND expires_at < now()
            ORDER BY expires_at
            LIMIT $1
            FOR UPDATE SKIP LOCKED`,
          [batchSize],
        );
        for (const { id } of rows) {
          await this.inventory.releaseSession(client, id);
          await client.query(`UPDATE checkout_sessions SET status = 'expired' WHERE id = $1`, [id]);
          const orders = await client.query<{ id: string }>(
            `UPDATE orders SET status = 'expired'
              WHERE checkout_session_id = $1 AND status = 'pending_payment'
              RETURNING id`,
            [id],
          );
          for (const order of orders.rows) {
            await client.query(
              `UPDATE registrations SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'order_expired'
                WHERE order_id = $1 AND status = 'pending'`,
              [order.id],
            );
            await client.query(
              'UPDATE coupon_redemptions SET voided_at = now() WHERE order_id = $1 AND voided_at IS NULL',
              [order.id],
            );
            await client.query(
              `UPDATE payments SET status = 'expired' WHERE order_id = $1 AND status = 'pending'`,
              [order.id],
            );
            await releaseChangeOrder(client, order.id);
          }
        }
        return rows.length;
      });
      released += done;
      if (done < batchSize) break;
    }
    if (released > 0) this.logger.log(`released ${released} expired checkout session(s)`);
    return released;
  }
}
