import { Body, Controller, Get, Headers, Param, Post, Res, UseGuards } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { z } from 'zod';
import { AuthGuard, AuthUser, CurrentUser } from '../../common/auth';
import { IdempotencyService } from '../../common/idempotency.service';
import { RateLimit } from '../../common/rate-limit';
import { parse, uuidSchema } from '../../common/validation';
import { MAX_RUNNERS_PER_ORDER } from '../checkout/checkout.service';
import { PaymentsService } from '../payments/payments.service';
import { OrdersService } from './orders.service';
import { phone, profileChoice, requireIdDoc, runnerOrProfileSchema } from './runner.schema';

const createOrderSchema = z.object({
  checkoutSessionId: z.string().uuid(),
  couponCode: z.string().trim().min(2).max(40).optional(),
  buyer: z.object({ name: z.string().trim().min(1).max(120), email: z.string().email(), phone }),
  billing: z.record(z.unknown()).optional(),
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
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post()
  @RateLimit('order')
  async create(
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parse(createOrderSchema, body);
    const result = await this.idempotency.run('POST /orders', user.id, key, input, async () => ({
      status: 201,
      body: await this.orders.create(user.id, key!, input),
    }));
    reply.status(result.status);
    return result.body;
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.orders.get(user.id, parse(uuidSchema, id));
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
