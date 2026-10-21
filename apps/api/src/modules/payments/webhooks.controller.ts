import { Controller, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { ProblemException } from '../../common/problem';
import { InvalidWebhookError, PAYMENT_GATEWAY, PaymentGateway } from './gateway';
import { PaymentConfirmationService } from './payment-confirmation.service';

@Controller('webhooks/payments')
export class WebhooksController {
  constructor(
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly confirmation: PaymentConfirmationService,
  ) {}

  /** Gateways retry on non-2xx, so anything we have already handled still answers 200. */
  @Post(':gateway')
  @HttpCode(200)
  async receive(@Param('gateway') name: string, @Req() req: FastifyRequest & { rawBody?: Buffer }) {
    if (name !== this.gateway.name) throw new ProblemException(404, 'NOT_FOUND', 'Unknown payment gateway');
    const raw = req.rawBody?.toString('utf8');
    if (!raw) throw new ProblemException(400, 'EMPTY_BODY', 'Webhook body is empty');
    let event;
    try {
      event = await this.gateway.verifyWebhook(raw, req.headers);
    } catch (err) {
      if (err instanceof InvalidWebhookError) throw new ProblemException(401, 'INVALID_WEBHOOK', 'Webhook could not be verified');
      throw err;
    }
    const result = await this.confirmation.apply(this.gateway.name, event);
    return { received: true, result };
  }
}
