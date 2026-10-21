import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppConfig, CONFIG } from '../../config';
import { ProblemException, problems } from '../../common/problem';
import { DbService } from '../../db/db.service';
import { InventoryService } from '../inventory/inventory.service';
import { paymentView } from '../orders/orders.service';
import { GatewayError, PAYMENT_GATEWAY, PaymentGateway, PaymentMethod } from './gateway';

/** Minutes of hold left after a QR code is issued, so the runner has time to scan and pay. */
const PAYMENT_GRACE_MINUTES = 10;

export interface CreatePaymentInput {
  method: PaymentMethod;
  cardToken?: string;
  bank?: string;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly dbs: DbService,
    private readonly inventory: InventoryService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async create(userId: string, orderId: string, input: CreatePaymentInput) {
    // Step 1: record the attempt in our DB first, so a crash after calling the gateway is traceable.
    const prepared = await this.dbs.transaction(async (_tx, client) => {
      const { rows } = await client.query(
        `SELECT id, order_no, buyer_user_id, status, total_satang, expires_at, checkout_session_id
           FROM orders WHERE id = $1 FOR UPDATE`,
        [orderId],
      );
      const order = rows[0];
      if (!order || order.buyer_user_id !== userId) throw problems.notFound('Order');
      if (order.status !== 'pending_payment' || order.expires_at <= new Date()) {
        throw new ProblemException(409, 'ORDER_NOT_PAYABLE', 'This order can no longer be paid', undefined, { orderStatus: order.status });
      }
      const open = await client.query(
        `SELECT * FROM payments WHERE order_id = $1 AND status = 'pending' AND method = $2
            AND (expires_at IS NULL OR expires_at > now()) ORDER BY created_at DESC LIMIT 1`,
        [orderId, input.method],
      );
      if (open.rows[0] && input.method !== 'card') return { existing: open.rows[0] };

      const payment = await client.query<{ id: string }>(
        `INSERT INTO payments (order_id, gateway, method, amount_satang, idempotency_key)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [orderId, this.gateway.name, input.method, order.total_satang, randomUUID()],
      );
      await this.inventory.extendSession(client, order.checkout_session_id, PAYMENT_GRACE_MINUTES);
      return { paymentId: payment.rows[0].id, orderNo: order.order_no as string, amount: Number(order.total_satang) };
    });
    if ('existing' in prepared) return paymentView(prepared.existing);

    // Step 2: call the gateway outside any DB transaction.
    try {
      const charge = await this.gateway.createCharge({
        paymentId: prepared.paymentId,
        orderNo: prepared.orderNo,
        amountSatang: prepared.amount,
        method: input.method,
        cardToken: input.cardToken,
        bank: input.bank,
        returnUri: `${this.config.PUBLIC_WEB_URL}/orders/${orderId}`,
      });
      const { rows } = await this.dbs.pool.query(
        `UPDATE payments SET gateway_charge_id = $2, gateway_payload = $3, qr_payload = $4, qr_image_url = $5,
                             authorize_uri = $6, expires_at = $7
          WHERE id = $1 RETURNING *`,
        [prepared.paymentId, charge.chargeId, JSON.stringify(charge.raw), charge.qrPayload ?? null,
          charge.qrImageUrl ?? null, charge.authorizeUri ?? null, charge.expiresAt ?? null],
      );
      // Card charges can succeed synchronously; the webhook will still arrive and is handled idempotently.
      return paymentView(rows[0]);
    } catch (err) {
      const message = err instanceof GatewayError ? err.message : 'gateway unreachable';
      this.logger.warn(`charge failed for payment ${prepared.paymentId}: ${message}`);
      await this.dbs.pool.query(
        `UPDATE payments SET status = 'failed', failure_message = $2 WHERE id = $1`,
        [prepared.paymentId, message],
      );
      throw new ProblemException(502, 'PAYMENT_GATEWAY_ERROR', 'The payment provider did not accept this payment', message);
    }
  }
}
