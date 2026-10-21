import { Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { ProblemException, problems } from '../../common/problem';
import { InventoryService, RaceHold } from '../inventory/inventory.service';

export const MAX_RUNNERS_PER_ORDER = 10;

export interface CreateSessionInput {
  eventId: string;
  races: { raceId: string; quantity: number }[];
  variants: { variantId: string; quantity: number }[];
}

export interface SessionItems {
  races: { raceId: string; code: string; quantity: number; priceTierId: string; tierName: string; priceSatang: number }[];
  variants: { variantId: string; label: string; productId: string; quantity: number; unitPriceSatang: number }[];
}

@Injectable()
export class CheckoutService {
  constructor(
    private readonly dbs: DbService,
    private readonly inventory: InventoryService,
  ) {}

  async create(userId: string, input: CreateSessionInput) {
    const races = mergeQuantities(input.races.map((r) => [r.raceId, r.quantity]));
    const variants = mergeQuantities(input.variants.map((v) => [v.variantId, v.quantity]));
    const runners = [...races.values()].reduce((s, q) => s + q, 0);
    if (runners < 1 || runners > MAX_RUNNERS_PER_ORDER) {
      throw problems.validation(`Choose between 1 and ${MAX_RUNNERS_PER_ORDER} runners per order`);
    }

    const { rows: eventRows } = await this.dbs.pool.query(
      `SELECT id, status, hold_minutes, registration_opens_at, registration_closes_at FROM events WHERE id = $1`,
      [input.eventId],
    );
    const event = eventRows[0];
    if (!event || event.status !== 'published') throw problems.notFound('Event');
    const now = new Date();
    if ((event.registration_opens_at && now < event.registration_opens_at) || (event.registration_closes_at && now >= event.registration_closes_at)) {
      throw new ProblemException(409, 'REGISTRATION_CLOSED', 'Registration is not open for this event');
    }

    const raceInfo = await this.dbs.pool.query<{ id: string; code: string }>(
      'SELECT id, code FROM races WHERE event_id = $1 AND id = ANY($2::uuid[])',
      [event.id, [...races.keys()]],
    );
    if (raceInfo.rowCount !== races.size) throw problems.validation('One of the races does not belong to this event');
    const raceCode = new Map(raceInfo.rows.map((r) => [r.id, r.code]));

    const variantInfo = variants.size
      ? await this.dbs.pool.query<{ id: string; label: string; product_id: string; unit_price: string }>(
          `SELECT v.id, v.label, v.product_id,
                  CASE WHEN p.included_in_race THEN 0 ELSE p.price_satang END + v.price_delta_satang AS unit_price
             FROM product_variants v JOIN products p ON p.id = v.product_id
            WHERE p.event_id = $1 AND v.id = ANY($2::uuid[])`,
          [event.id, [...variants.keys()]],
        )
      : { rows: [], rowCount: 0 };
    if (variantInfo.rows.length !== variants.size) throw problems.validation('One of the items does not belong to this event');

    return this.dbs.transaction(async (_tx, client) => {
      const session = await client.query<{ id: string; expires_at: Date }>(
        `INSERT INTO checkout_sessions (event_id, user_id, items, expires_at)
         VALUES ($1, $2, '{}', now() + make_interval(mins => $3))
         RETURNING id, expires_at`,
        [event.id, userId, event.hold_minutes],
      );
      const { id: sessionId, expires_at: expiresAt } = session.rows[0];

      // Lock rows in a fixed order so two sessions touching the same races cannot deadlock.
      const holds: RaceHold[] = [];
      for (const [raceId, quantity] of [...races.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const hold = await this.inventory.reserveRace(client, raceId, quantity);
        holds.push(hold);
        await client.query(
          `INSERT INTO inventory_holds (checkout_session_id, race_id, price_tier_id, quantity, expires_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [sessionId, raceId, hold.priceTierId, quantity, expiresAt],
        );
      }
      for (const [variantId, quantity] of [...variants.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        await this.inventory.reserveVariant(client, variantId, quantity);
        await client.query(
          `INSERT INTO inventory_holds (checkout_session_id, product_variant_id, quantity, expires_at)
           VALUES ($1, $2, $3, $4)`,
          [sessionId, variantId, quantity, expiresAt],
        );
      }

      const items: SessionItems = {
        races: holds.map((h) => ({
          raceId: h.raceId,
          code: raceCode.get(h.raceId)!,
          quantity: h.quantity,
          priceTierId: h.priceTierId,
          tierName: h.tierName,
          priceSatang: h.priceSatang,
        })),
        variants: variantInfo.rows.map((v) => ({
          variantId: v.id,
          label: v.label,
          productId: v.product_id,
          quantity: variants.get(v.id)!,
          unitPriceSatang: Number(v.unit_price),
        })),
      };
      await client.query('UPDATE checkout_sessions SET items = $2 WHERE id = $1', [sessionId, JSON.stringify(items)]);
      return { id: sessionId, eventId: event.id, status: 'active', expiresAt, items };
    });
  }

  async get(userId: string, sessionId: string) {
    const { rows } = await this.dbs.pool.query(
      `SELECT id, event_id, user_id, status, items, expires_at FROM checkout_sessions WHERE id = $1`,
      [sessionId],
    );
    const s = rows[0];
    if (!s || s.user_id !== userId) throw problems.notFound('Checkout session');
    const status = s.status === 'active' && s.expires_at < new Date() ? 'expired' : s.status;
    return { id: s.id, eventId: s.event_id, status, expiresAt: s.expires_at, items: s.items as SessionItems };
  }

  async cancel(userId: string, sessionId: string): Promise<void> {
    await this.dbs.transaction(async (_tx, client) => {
      const { rows } = await client.query(
        'SELECT user_id, status FROM checkout_sessions WHERE id = $1 FOR UPDATE',
        [sessionId],
      );
      const s = rows[0];
      if (!s || s.user_id !== userId) throw problems.notFound('Checkout session');
      if (s.status !== 'active') return;
      const paidOrPaying = await client.query(
        `SELECT 1 FROM payments p JOIN orders o ON o.id = p.order_id
          WHERE o.checkout_session_id = $1 AND p.status IN ('pending', 'succeeded') LIMIT 1`,
        [sessionId],
      );
      if (paidOrPaying.rowCount) {
        throw new ProblemException(409, 'PAYMENT_IN_PROGRESS', 'A payment has already started for this checkout');
      }
      await this.inventory.releaseSession(client, sessionId);
      await client.query(`UPDATE checkout_sessions SET status = 'abandoned' WHERE id = $1`, [sessionId]);
      const orders = await client.query<{ id: string }>(
        `UPDATE orders SET status = 'cancelled', cancelled_at = now()
          WHERE checkout_session_id = $1 AND status = 'pending_payment' RETURNING id`,
        [sessionId],
      );
      for (const o of orders.rows) {
        await client.query(
          `UPDATE registrations SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'checkout_cancelled'
            WHERE order_id = $1 AND status = 'pending'`,
          [o.id],
        );
        await client.query('UPDATE coupon_redemptions SET voided_at = now() WHERE order_id = $1 AND voided_at IS NULL', [o.id]);
      }
    });
  }
}

function mergeQuantities(pairs: [string, number][]): Map<string, number> {
  const map = new Map<string, number>();
  for (const [id, q] of pairs) map.set(id, (map.get(id) ?? 0) + q);
  return map;
}
