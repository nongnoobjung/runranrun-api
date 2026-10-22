import { Body, Controller, Get, Headers, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuthGuard, AuthUser, CurrentUser } from '../../common/auth';
import { IdempotencyService } from '../../common/idempotency.service';
import { RateLimit, RateLimitService } from '../../common/rate-limit';
import { parse, uuidSchema } from '../../common/validation';
import { MAX_RUNNERS_PER_ORDER } from '../checkout/checkout.service';
import { PaymentsService } from '../payments/payments.service';
import { orderConsentSchema } from '../privacy/privacy.service';
import { billingSchema, ReceiptsService } from '../receipts/receipts.service';
import { OrdersService } from './orders.service';
import { phone, profileChoice, requireIdDoc, runnerOrProfileSchema } from './runner.schema';

const createOrderSchema = z.object({
  checkoutSessionId: z.string().uuid(),
  couponCode: z.string().trim().min(2).max(40).optional(),
  buyer: z.object({ name: z.string().trim().min(1).max(120), email: z.string().email(), phone }),
  /** Asks for a full tax invoice made out to these details once the order is paid. */
  billing: billingSchema.optional(),
  participants: z
    .array(
      z
        .object({
          raceId: z.string().uuid(),
          shirtVariantId: z.string().uuid().optional(),
          isSelf: z.boolean().optional(),
          runner: runnerOrProfileSchema,
          answers: z.record(z.unknown()).optional(),
          ...profileChoice,
        })
        .superRefine(requireIdDoc),
    )
    .min(1)
    .max(MAX_RUNNERS_PER_ORDER)
    .refine((ps) => ps.filter((p) => p.isSelf).length <= 1, 'Only one runner can be marked as yourself'),
  consents: orderConsentSchema.optional(),
});

const createPaymentSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('promptpay') }),
  z.object({ method: z.literal('card'), cardToken: z.string().min(5) }),
  z.object({ method: z.literal('mobile_banking'), bank: z.string().regex(/^mobile_banking_[a-z]+$/) }),
]);

@Controller('orders')
@UseGuards(AuthGuard)
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly payments: PaymentsService,
    private readonly receipts: ReceiptsService,
    private readonly idempotency: IdempotencyService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Post()
  @RateLimit('order')
  async create(
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parse(createOrderSchema, body);
    const context = { ip: this.rateLimit.clientIp(req), userAgent: req.headers['user-agent'] ?? null };
    const result = await this.idempotency.run('POST /orders', user.id, key, input, async () => ({
      status: 201,
      body: await this.orders.create(user.id, key!, input, context),
    }));
    reply.status(result.status);
    return result.body;
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.orders.get(user.id, parse(uuidSchema, id));
  }

  /** The order's receipt or tax invoice, issued on payment. */
  @Get(':id/receipt')
  receipt(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.receipts.get(user.id, parse(uuidSchema, id));
  }

  /** Replaces the receipt with a full tax invoice made out to the buyer's details. */
  @Post(':id/tax-invoice')
  @RateLimit('order')
  taxInvoice(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    return this.receipts.requestTaxInvoice(user.id, parse(uuidSchema, id), parse(billingSchema, body));
  }

  @Post(':id/payments')
  @RateLimit('payment')
  async pay(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const orderId = parse(uuidSchema, id);
    const input = parse(createPaymentSchema, body);
    const result = await this.idempotency.run(`POST /orders/${orderId}/payments`, user.id, key, input, async () => ({
      status: 201,
      body: await this.payments.create(user.id, orderId, input),
    }));
    reply.status(result.status);
    return result.body;
  }
}
