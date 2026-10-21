import { Controller, DynamicModule, Get, Global, Module, Provider } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AppConfig, CONFIG } from './config';
import { AuthGuard } from './common/auth';
import { IdempotencyService } from './common/idempotency.service';
import { DbService } from './db/db.service';
import { CheckoutController } from './modules/checkout/checkout.controller';
import { CheckoutService } from './modules/checkout/checkout.service';
import { DevController } from './modules/dev/dev.controller';
import { EventsController } from './modules/events/events.controller';
import { EventsService } from './modules/events/events.service';
import { HoldReleaseService } from './modules/inventory/hold-release.service';
import { InventoryService } from './modules/inventory/inventory.service';
import { JobsService } from './modules/jobs/jobs.service';
import { MeController } from './modules/me/me.controller';
import { OrdersController } from './modules/orders/orders.controller';
import { OrdersService } from './modules/orders/orders.service';
import { FakeGateway } from './modules/payments/fake.gateway';
import { PAYMENT_GATEWAY, PaymentGateway } from './modules/payments/gateway';
import { OmiseGateway } from './modules/payments/omise.gateway';
import { PaymentConfirmationService } from './modules/payments/payment-confirmation.service';
import { PaymentsService } from './modules/payments/payments.service';
import { WebhooksController } from './modules/payments/webhooks.controller';

@Controller('health')
class HealthController {
  constructor(private readonly dbs: DbService) {}

  @Get()
  async health() {
    await this.dbs.pool.query('SELECT 1');
    return { ok: true };
  }
}

@Global()
@Module({})
export class AppModule {
  static forRoot(config: AppConfig, overrides: { gateway?: PaymentGateway } = {}): DynamicModule {
    const gateway: Provider = {
      provide: PAYMENT_GATEWAY,
      useFactory: () =>
        overrides.gateway ??
        (config.PAYMENT_GATEWAY === 'omise' ? new OmiseGateway(config.OMISE_SECRET_KEY!) : new FakeGateway(config.FAKE_GATEWAY_SECRET)),
    };
    const controllers = [
      HealthController,
      EventsController,
      CheckoutController,
      OrdersController,
      WebhooksController,
      MeController,
      ...(config.ENABLE_DEV_ENDPOINTS ? [DevController] : []),
    ];
    return {
      module: AppModule,
      imports: [JwtModule.register({ secret: config.JWT_SECRET, signOptions: { expiresIn: config.JWT_TTL_SECONDS } })],
      controllers,
      providers: [
        { provide: CONFIG, useValue: config },
        gateway,
        DbService,
        AuthGuard,
        IdempotencyService,
        InventoryService,
        HoldReleaseService,
        EventsService,
        CheckoutService,
        OrdersService,
        PaymentsService,
        PaymentConfirmationService,
        JobsService,
      ],
      exports: [CONFIG, DbService],
    };
  }
}
