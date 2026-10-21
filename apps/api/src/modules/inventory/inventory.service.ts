import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { ProblemException } from '../../common/problem';

export interface RaceHold {
  raceId: string;
  quantity: number;
  priceTierId: string;
  priceSatang: number;
  tierName: string;
}

/**
 * Every counter change goes through a single conditional UPDATE, so two buyers can never both
 * take the last place: the second UPDATE simply matches no row.
 */
@Injectable()
export class InventoryService {
  async reserveRace(client: PoolClient, raceId: string, quantity: number): Promise<RaceHold> {
    const race = await client.query(
      `UPDATE races SET reserved = reserved + $2
        WHERE id = $1 AND is_active AND sold + reserved + $2 <= capacity
        RETURNING id`,
      [raceId, quantity],
    );
    if (race.rowCount === 0) {
      throw new ProblemException(409, 'SOLD_OUT', 'This race is full', undefined, { raceId });
    }

    // Cheapest open tier first; if Early bird cannot take the whole quantity, fall through to the next.
    const tiers = await client.query<{ id: string }>(
      `SELECT id FROM price_tiers
        WHERE race_id = $1 AND now() >= starts_at AND now() < ends_at
        ORDER BY starts_at, price_satang`,
      [raceId],
    );
    for (const tier of tiers.rows) {
      const taken = await client.query<{ id: string; price_satang: string; name: string }>(
        `UPDATE price_tiers SET reserved = reserved + $2
          WHERE id = $1 AND (quota IS NULL OR sold + reserved + $2 <= quota)
          RETURNING id, price_satang, name`,
        [tier.id, quantity],
      );
      if (taken.rowCount) {
        const row = taken.rows[0];
        return { raceId, quantity, priceTierId: row.id, priceSatang: Number(row.price_satang), tierName: row.name };
      }
    }
    throw new ProblemException(409, 'NO_PRICE_AVAILABLE', 'No price is on sale for this race right now', undefined, { raceId });
  }

  async reserveVariant(client: PoolClient, variantId: string, quantity: number): Promise<void> {
    const res = await client.query(
      `UPDATE product_variants SET reserved = reserved + $2
        WHERE id = $1 AND is_active AND (stock IS NULL OR sold + reserved + $2 <= stock)
        RETURNING id`,
      [variantId, quantity],
    );
    if (res.rowCount === 0) {
      throw new ProblemException(409, 'SIZE_SOLD_OUT', 'This size is sold out', undefined, { variantId });
    }
  }

  /** Moves held quantities from `reserved` to `sold`. Returns false if the session had nothing held. */
  async commitSession(client: PoolClient, sessionId: string): Promise<boolean> {
    const holds = await client.query(
      `UPDATE inventory_holds SET status = 'committed'
        WHERE checkout_session_id = $1 AND status = 'held'
        RETURNING race_id, product_variant_id, price_tier_id, quantity`,
      [sessionId],
    );
    if (holds.rowCount === 0) return false;
    for (const h of holds.rows) {
      if (h.race_id) {
        await client.query('UPDATE races SET reserved = reserved - $2, sold = sold + $2 WHERE id = $1', [h.race_id, h.quantity]);
      }
      if (h.price_tier_id) {
        await client.query('UPDATE price_tiers SET reserved = reserved - $2, sold = sold + $2 WHERE id = $1', [h.price_tier_id, h.quantity]);
      }
      if (h.product_variant_id) {
        await client.query('UPDATE product_variants SET reserved = reserved - $2, sold = sold + $2 WHERE id = $1', [h.product_variant_id, h.quantity]);
      }
    }
    return true;
  }

  /**
   * For a payment that arrives after its holds were released: take the places again directly as sold.
   * Returns false (and changes nothing, because the caller rolls back to a savepoint) if any place is gone.
   */
  async resellSession(client: PoolClient, sessionId: string): Promise<boolean> {
    const holds = await client.query(
      `SELECT race_id, product_variant_id, price_tier_id, quantity FROM inventory_holds
        WHERE checkout_session_id = $1 AND status = 'released'`,
      [sessionId],
    );
    for (const h of holds.rows) {
      if (h.race_id) {
        const r = await client.query(
          'UPDATE races SET sold = sold + $2 WHERE id = $1 AND sold + reserved + $2 <= capacity RETURNING id',
          [h.race_id, h.quantity],
        );
        if (r.rowCount === 0) return false;
      }
      if (h.product_variant_id) {
        const v = await client.query(
          'UPDATE product_variants SET sold = sold + $2 WHERE id = $1 AND (stock IS NULL OR sold + reserved + $2 <= stock) RETURNING id',
          [h.product_variant_id, h.quantity],
        );
        if (v.rowCount === 0) return false;
      }
      if (h.price_tier_id) {
        // The buyer keeps the price they were quoted even if the tier quota has since filled.
        await client.query(
          'UPDATE price_tiers SET sold = LEAST(sold + $2, COALESCE(quota - reserved, sold + $2)) WHERE id = $1',
          [h.price_tier_id, h.quantity],
        );
      }
    }
    await client.query(
      `UPDATE inventory_holds SET status = 'committed' WHERE checkout_session_id = $1 AND status = 'released'`,
      [sessionId],
    );
    return true;
  }

  async releaseSession(client: PoolClient, sessionId: string): Promise<void> {
    const holds = await client.query(
      `UPDATE inventory_holds SET status = 'released', released_at = now()
        WHERE checkout_session_id = $1 AND status = 'held'
        RETURNING race_id, product_variant_id, price_tier_id, quantity`,
      [sessionId],
    );
    for (const h of holds.rows) {
      if (h.race_id) await client.query('UPDATE races SET reserved = reserved - $2 WHERE id = $1', [h.race_id, h.quantity]);
      if (h.price_tier_id) await client.query('UPDATE price_tiers SET reserved = reserved - $2 WHERE id = $1', [h.price_tier_id, h.quantity]);
      if (h.product_variant_id) {
        await client.query('UPDATE product_variants SET reserved = reserved - $2 WHERE id = $1', [h.product_variant_id, h.quantity]);
      }
    }
  }

  /** Gives back only the shirt/add-on holds of a session, e.g. when the runner changes sizes. */
  async releaseVariantHolds(client: PoolClient, sessionId: string): Promise<void> {
    const holds = await client.query(
      `UPDATE inventory_holds SET status = 'released', released_at = now()
        WHERE checkout_session_id = $1 AND status = 'held' AND product_variant_id IS NOT NULL
        RETURNING product_variant_id, quantity`,
      [sessionId],
    );
    for (const h of holds.rows) {
      await client.query('UPDATE product_variants SET reserved = reserved - $2 WHERE id = $1', [h.product_variant_id, h.quantity]);
    }
    // Released variant holds are history, not something a late payment should try to re-sell.
    await client.query(
      `DELETE FROM inventory_holds WHERE checkout_session_id = $1 AND status = 'released' AND product_variant_id IS NOT NULL`,
      [sessionId],
    );
  }

  /** Pushes a session's expiry out (e.g. when a QR code is issued near the end of the hold). */
  async extendSession(client: PoolClient, sessionId: string, minutes: number): Promise<void> {
    await client.query(
      `UPDATE checkout_sessions SET expires_at = GREATEST(expires_at, now() + make_interval(mins => $2))
        WHERE id = $1 AND status = 'active'`,
      [sessionId, minutes],
    );
    await client.query(
      `UPDATE inventory_holds SET expires_at = GREATEST(expires_at, now() + make_interval(mins => $2))
        WHERE checkout_session_id = $1 AND status = 'held'`,
      [sessionId, minutes],
    );
    await client.query(
      `UPDATE orders SET expires_at = GREATEST(expires_at, now() + make_interval(mins => $2))
        WHERE checkout_session_id = $1 AND status = 'pending_payment'`,
      [sessionId, minutes],
    );
  }
}
