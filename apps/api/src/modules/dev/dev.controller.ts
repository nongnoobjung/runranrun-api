import { Body, Controller, Inject, Param, Post } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { z } from 'zod';
import { AppConfig, CONFIG } from '../../config';
import { ProblemException } from '../../common/problem';
import { parse } from '../../common/validation';
import { DbService } from '../../db/db.service';
import { HoldReleaseService } from '../inventory/hold-release.service';
import { FAKE_SIGNATURE_HEADER, fakeChargeCompleteBody, signFakeWebhook } from '../payments/fake.gateway';
import { PAYMENT_GATEWAY, PaymentGateway } from '../payments/gateway';
import { PaymentConfirmationService } from '../payments/payment-confirmation.service';

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
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** Stand-in for LINE / OTP login until the auth module lands. */
  @Post('login')
  async login(@Body() body: unknown) {
    const { email, displayName } = parse(z.object({ email: z.string().email(), displayName: z.string().max(80).optional() }), body);
    const { rows } = await this.dbs.pool.query<{ id: string }>(
      `INSERT INTO users (email, display_name) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET last_login_at = now()
       RETURNING id`,
      [email, displayName ?? null],
    );
    const accessToken = await this.jwt.signAsync({ sub: rows[0].id });
    return { userId: rows[0].id, accessToken, expiresIn: this.config.JWT_TTL_SECONDS };
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

  @Post('jobs/release-expired-holds')
  async releaseHolds() {
    return { released: await this.holds.releaseExpired() };
  }
}
