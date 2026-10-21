import { Injectable, Logger } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DbService } from '../../db/db.service';
import { assignNextBib } from '../bibs/next-bib';
import { settleChangeOrder } from '../changes/settle';
import { InventoryService } from '../inventory/inventory.service';
import { VerifiedWebhook } from './gateway';

export type ConfirmationResult =
  | 'duplicate'
  | 'ignored'
  | 'unknown_charge'
  | 'confirmed'
  | 'already_paid'
  | 'late_confirmed'
  | 'late_sold_out_refund'
  | 'payment_failed';

/**
 * Applies a verified gateway event exactly once. The webhook row is inserted first under a
 * unique (gateway, event_id) key; a redelivered event finds the row already processed and stops.
 */
@Injectable()
export class PaymentConfirmationService {
  private readonly logger = new Logger(PaymentConfirmationService.name);

  constructor(
    private readonly dbs: DbService,
    private readonly inventory: InventoryService,
  ) {}

  async apply(gateway: string, event: VerifiedWebhook): Promise<ConfirmationResult> {
    const result = await this.dbs.transaction(async (_tx, client) => {
      const inserted = await client.query<{ id: string; processed_at: Date | null }>(
        `INSERT INTO webhook_events (gateway, event_id, event_type, signature_ok, payload)
         VALUES ($1, $2, $3, true, $4)
         ON CONFLICT (gateway, event_id) DO UPDATE SET attempts = webhook_events.attempts + 1
         RETURNING id, processed_at`,
        [gateway, event.eventId, event.eventType, JSON.stringify(event.payload)],
      );
      const hook = inserted.rows[0];
      if (hook.processed_at) return 'duplicate' as const;

      const outcome = await this.applyOutcome(client, gateway, event);
      await client.query('UPDATE webhook_events SET processed_at = now() WHERE id = $1', [hook.id]);
      return outcome;
    });
    this.logger.log(`${gateway} ${event.eventType} ${event.eventId}: ${result}`);
    return result;
  }

  private async applyOutcome(client: PoolClient, gateway: string, event: VerifiedWebhook): Promise<ConfirmationResult> {
    if (event.outcome === 'ignored' || !event.chargeId) return 'ignored';

    const { rows } = await client.query(
      'SELECT id, order_id, status FROM payments WHERE gateway = $1 AND gateway_charge_id = $2 FOR UPDATE',
      [gateway, event.chargeId],
    );
    const payment = rows[0];
    if (!payment) return 'unknown_charge';
    await client.query('UPDATE webhook_events SET payment_id = $3 WHERE gateway = $1 AND event_id = $2', [gateway, event.eventId, payment.id]);

    if (event.outcome !== 'succeeded') {
      await client.query(
        `UPDATE payments SET status = $2, failure_message = $3 WHERE id = $1 AND status = 'pending'`,
        [payment.id, event.outcome === 'expired' ? 'expired' : 'failed', event.eventType],
      );
      return 'payment_failed';
    }

    const order = (
      await client.query(
        'SELECT id, status, checkout_session_id, coupon_id FROM orders WHERE id = $1 FOR UPDATE',
        [payment.order_id],
      )
    ).rows[0];

    if (order.status === 'paid') {
      if (payment.status === 'succeeded') return 'already_paid';
      // A second charge was paid for an order that is already paid (e.g. QR scanned twice).
      // Only one payment per order may be 'succeeded', so this one is parked as 'authorized' until refunded.
      await client.query(
        `UPDATE payments SET status = 'authorized', failure_message = 'duplicate_payment' WHERE id = $1`,
        [payment.id],
      );
      await this.requestRefund(client, order.id, payment.id, 'duplicate_payment');
      return 'already_paid';
    }

    await client.query(`UPDATE payments SET status = 'succeeded', succeeded_at = now() WHERE id = $1`, [payment.id]);

    if (order.status === 'pending_payment') {
      await this.inventory.commitSession(client, order.checkout_session_id);
      await this.markPaid(client, order.id, order.checkout_session_id, payment.id);
      return 'confirmed';
    }

    // The order expired or was cancelled before the money arrived. Try to take the places again.
    await client.query('SAVEPOINT late_payment');
    try {
      const ok = await this.inventory.resellSession(client, order.checkout_session_id);
      if (!ok) throw new Error('sold out');
      await client.query(
        `UPDATE registrations SET status = 'pending', cancelled_at = NULL, cancel_reason = NULL
          WHERE order_id = $1 AND status = 'cancelled' AND cancel_reason IN ('order_expired', 'checkout_cancelled')`,
        [order.id],
      );
      await client.query('UPDATE coupon_redemptions SET voided_at = NULL WHERE order_id = $1', [order.id]);
      await this.markPaid(client, order.id, order.checkout_session_id, payment.id);
      await client.query('RELEASE SAVEPOINT late_payment');
      return 'late_confirmed';
    } catch {
      // Sold out meanwhile, or the runner has since registered again: keep the order closed and refund.
      await client.query('ROLLBACK TO SAVEPOINT late_payment');
      await this.requestRefund(client, order.id, payment.id, 'late_payment_sold_out');
      return 'late_sold_out_refund';
    }
  }

  private async markPaid(client: PoolClient, orderId: string, sessionId: string, paymentId: string): Promise<void> {
    await client.query(`UPDATE orders SET status = 'paid', paid_at = now() WHERE id = $1`, [orderId]);
    await client.query(`UPDATE checkout_sessions SET status = 'converted' WHERE id = $1`, [sessionId]);
    await client.query(
      `UPDATE coupons SET used_count = used_count + 1
        WHERE id = (SELECT coupon_id FROM orders WHERE id = $1)`,
      [orderId],
    );
    const regs = await client.query<{ id: string; race_id: string; event_id: string }>(
      `UPDATE registrations SET status = 'confirmed', confirmed_at = now()
        WHERE order_id = $1 AND status = 'pending'
        RETURNING id, race_id, event_id`,
      [orderId],
    );
    // Races numbered by hand, or whose range is used up, are left for the organiser to number.
    for (const reg of regs.rows) await assignNextBib(client, { id: reg.id, raceId: reg.race_id, eventId: reg.event_id }, true);
    // A checkout claimed from a waitlist offer: the runner is off the queue.
    await client.query(
      `UPDATE waitlist_entries w SET status = 'converted',
              registration_id = (SELECT r.id FROM registrations r WHERE r.order_id = $1 AND r.race_id = w.race_id ORDER BY r.registration_no LIMIT 1)
        WHERE w.checkout_session_id = $2 AND w.status = 'offered'`,
      [orderId, sessionId],
    );
    // A transfer fee or race change order: the change happens now, or the money goes back if it no longer can.
    if ((await settleChangeOrder(client, orderId)) === 'refund') await this.requestRefund(client, orderId, paymentId, 'change_not_possible');
  }

  private async requestRefund(client: PoolClient, orderId: string, paymentId: string, reason: string): Promise<void> {
    const amount = await client.query<{ amount_satang: string }>('SELECT amount_satang FROM payments WHERE id = $1', [paymentId]);
    await client.query(
      `INSERT INTO refunds (order_id, payment_id, status, amount_satang, reason, release_inventory)
       VALUES ($1, $2, 'approved', $3, $4, false)`,
      [orderId, paymentId, amount.rows[0].amount_satang, reason],
    );
    this.logger.warn(`refund queued for order ${orderId}: ${reason}`);
  }
}
