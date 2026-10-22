import { Body, Controller, Inject, Param, Post } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppConfig, CONFIG } from '../../config';
import { ProblemException } from '../../common/problem';
import { RateLimit } from '../../common/rate-limit';
import { parse } from '../../common/validation';
import { DbService } from '../../db/db.service';
import { HoldReleaseService } from '../inventory/hold-release.service';
import { FAKE_SIGNATURE_HEADER, fakeChargeCompleteBody, signFakeWebhook } from '../payments/fake.gateway';
import { PAYMENT_GATEWAY, PaymentGateway } from '../payments/gateway';
import { PaymentConfirmationService } from '../payments/payment-confirmation.service';
import { WaitingRoomService } from '../waiting-room/waiting-room.service';

/**
 * Development helpers. DevModule is only imported when ENABLE_DEV_ENDPOINTS=true,
 * which config refuses in production.
 */
@Controller('dev')
export class DevController {
  constructor(
    private readonly dbs: DbService,
    private readonly jwt: JwtService,
    private readonly holds: HoldReleaseService,
    private readonly confirmation: PaymentConfirmationService,
    private readonly waitingRoom: WaitingRoomService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** Stand-in for LINE / OTP login until the auth module lands. */
  @Post('login')
  @RateLimit('login')
  async login(@Body() body: unknown) {
    const { email, displayName } = parse(z.object({ email: z.string().email(), displayName: z.string().max(80).optional() }), body);
    const { rows } = await this.dbs.pool.query<{ id: string }>(
      `INSERT INTO users (email, display_name, last_login_at) VALUES ($1, $2, now())
       ON CONFLICT (email) DO UPDATE SET last_login_at = now()
       RETURNING id`,
      [email, displayName ?? null],
    );
    const accessToken = await this.jwt.signAsync({ sub: rows[0].id });
    return { userId: rows[0].id, accessToken, expiresIn: this.config.JWT_TTL_SECONDS };
  }

  /**
   * A new organiser team, as if it had signed up: waiting for KYC and with its events reviewed, unless told otherwise.
   * The owner (created if needed) can log in with /dev/login. Lets end-to-end tests run the admin flows on their own data.
   */
  @Post('organizations')
  async createOrganization(@Body() body: unknown) {
    const input = parse(
      z.object({
        nameTh: z.string().trim().min(1).max(120),
        ownerEmail: z.string().email(),
        status: z.enum(['pending_kyc', 'active']).default('pending_kyc'),
        reviewEvents: z.boolean().default(true),
      }),
      body,
    );
    const slug = `dev-${randomUUID().slice(0, 8)}`;
    const org = await this.dbs.pool.query<{ id: string }>(
      `INSERT INTO organizations (slug, name_th, contact_email, status, review_events) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [slug, input.nameTh, input.ownerEmail, input.status, input.reviewEvents],
    );
    const user = await this.dbs.pool.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
      [input.ownerEmail],
    );
    await this.dbs.pool.query(`INSERT INTO org_members (organization_id, user_id, role, accepted_at) VALUES ($1, $2, 'owner', now())`, [
      org.rows[0].id, user.rows[0].id,
    ]);
    return { id: org.rows[0].id, slug };
  }

  /** Simulates the gateway telling us a charge finished, through the same verification path as a real webhook. */
  @Post('fake-gateway/charges/:chargeId/complete')
  async completeCharge(@Param('chargeId') chargeId: string, @Body() body: unknown) {
    if (this.gateway.name !== 'fake') throw new ProblemException(409, 'NOT_FAKE_GATEWAY', 'Only available with PAYMENT_GATEWAY=fake');
    const { status } = parse(z.object({ status: z.enum(['successful', 'failed', 'expired']).default('successful') }), body ?? {});
    const raw = fakeChargeCompleteBody(chargeId, status);
    const event = await this.gateway.verifyWebhook(raw, { [FAKE_SIGNATURE_HEADER]: signFakeWebhook(raw, this.config.FAKE_GATEWAY_SECRET) });
    return { result: await this.confirmation.apply(this.gateway.name, event) };
  }

  /** Same as above, addressed by order: completes the order's latest pending charge. Used by the web app's dev tools. */
  @Post('orders/:orderId/complete-payment')
  async completeOrderPayment(@Param('orderId') orderId: string, @Body() body: unknown) {
    const { rows } = await this.dbs.pool.query<{ gateway_charge_id: string | null }>(
      `SELECT gateway_charge_id FROM payments WHERE order_id = $1 AND status = 'pending'
        ORDER BY created_at DESC LIMIT 1`,
      [parse(z.string().uuid(), orderId)],
    );
    const chargeId = rows[0]?.gateway_charge_id;
    if (!chargeId) throw new ProblemException(404, 'NO_PENDING_PAYMENT', 'This order has no pending payment');
    return this.completeCharge(chargeId, body);
  }

  /** Lets the next runners out of an event's waiting room now instead of waiting for the admission job. */
  @Post('events/:eventId/queue/admit')
  async admitQueue(@Param('eventId') eventId: string, @Body() body: unknown) {
    const { count } = parse(z.object({ count: z.number().int().min(1).max(10_000).default(10_000) }), body ?? {});
    return { admitted: await this.waitingRoom.admitNow(parse(z.string().uuid(), eventId), count) };
  }

  @Post('jobs/release-expired-holds')
  async releaseHolds() {
    return { released: await this.holds.releaseExpired() };
  }
}
