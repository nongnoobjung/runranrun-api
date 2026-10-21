import { Controller, DynamicModule, Get, Global, Module, Provider } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AppConfig, CONFIG } from './config';
import { AuthGuard } from './common/auth';
import { IdempotencyService } from './common/idempotency.service';
import { createStorage, FILE_STORAGE } from './common/storage';
import { DbService } from './db/db.service';
import { CheckoutController } from './modules/checkout/checkout.controller';
import { CheckoutService } from './modules/checkout/checkout.service';
import { DevController } from './modules/dev/dev.controller';
import { EventsController } from './modules/events/events.controller';
import { MediaController } from './modules/events/media.controller';
import { EventsService } from './modules/events/events.service';
import { HoldReleaseService } from './modules/inventory/hold-release.service';
import { InventoryService } from './modules/inventory/inventory.service';
import { JobsService } from './modules/jobs/jobs.service';
import { MeController } from './modules/me/me.controller';
import { EMAIL_SENDER, FakeEmailSender } from './modules/notifications/email-sender';
import { NotificationsService } from './modules/notifications/notifications.service';
import { OrgAccessService } from './modules/org/org-access.service';
import { OrgController } from './modules/org/org.controller';
import { OrgBibsService } from './modules/org/org-bibs.service';
import { OrgBroadcastsService } from './modules/org/org-broadcasts.service';
import { OrgCouponsService } from './modules/org/org-coupons.service';
import { OrgEventsService } from './modules/org/org-events.service';
import { OrgFinanceService } from './modules/org/org-finance.service';
import { OrgEventImagesService } from './modules/org/org-event-images.service';
import { OrgKycService } from './modules/org/org-kyc.service';
import { OrgMembersService } from './modules/org/org-members.service';
import { OrgQuestionsService } from './modules/org/org-questions.service';
import { OrgRegistrationsService } from './modules/org/org-registrations.service';
import { OrgResultsService } from './modules/org/org-results.service';
import { OrdersController } from './modules/orders/orders.controller';
import { OrdersService } from './modules/orders/orders.service';
import { FakeGateway } from './modules/payments/fake.gateway';
import { PAYMENT_GATEWAY, PaymentGateway } from './modules/payments/gateway';
import { OmiseGateway } from './modules/payments/omise.gateway';
import { PaymentConfirmationService } from './modules/payments/payment-confirmation.service';
import { PaymentsService } from './modules/payments/payments.service';
import { RefundsService } from './modules/refunds/refunds.service';
import { ResultsController } from './modules/results/results.controller';
import { ResultsService } from './modules/results/results.service';
import { WaitlistService } from './modules/waitlist/waitlist.service';
import { ChangesService } from './modules/changes/changes.service';
import { ProfilesService } from './modules/profiles/profiles.service';
import { AdminController } from './modules/admin/admin.controller';
import { AdminService } from './modules/admin/admin.service';
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
      MediaController,
      ResultsController,
      CheckoutController,
      OrdersController,
      WebhooksController,
      MeController,
      OrgController,
      AdminController,
      ...(config.ENABLE_DEV_ENDPOINTS ? [DevController] : []),
    ];
    return {
      module: AppModule,
      imports: [JwtModule.register({ secret: config.JWT_SECRET, signOptions: { expiresIn: config.JWT_TTL_SECONDS } })],
      controllers,
      providers: [
        { provide: CONFIG, useValue: config },
        gateway,
        { provide: FILE_STORAGE, useFactory: () => createStorage(config) },
        DbService,
        AuthGuard,
        IdempotencyService,
        InventoryService,
        HoldReleaseService,
        EventsService,
        ResultsService,
        CheckoutService,
        OrdersService,
        PaymentsService,
        PaymentConfirmationService,
        JobsService,
        OrgAccessService,
        OrgEventsService,
        OrgCouponsService,
        OrgRegistrationsService,
        OrgMembersService,
        OrgKycService,
        OrgEventImagesService,
        OrgQuestionsService,
        { provide: EMAIL_SENDER, useClass: FakeEmailSender },
        NotificationsService,
        OrgBroadcastsService,
        OrgFinanceService,
        OrgResultsService,
        OrgBibsService,
        RefundsService,
        WaitlistService,
        ChangesService,
        ProfilesService,
        AdminService,
      ],
      exports: [CONFIG, DbService],
    };
  }
}
