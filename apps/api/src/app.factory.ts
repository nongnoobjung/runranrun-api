import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { ProblemFilter } from './common/problem';
import { AppConfig } from './config';
import { PaymentGateway } from './modules/payments/gateway';

export async function createApp(config: AppConfig, overrides: { gateway?: PaymentGateway } = {}): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(config, overrides),
    new FastifyAdapter({ trustProxy: true, bodyLimit: 1_000_000 }),
    // rawBody keeps the exact webhook bytes for signature checks.
    { rawBody: true, logger: config.NODE_ENV === 'test' ? ['error'] : ['log', 'warn', 'error'] },
  );
  app.setGlobalPrefix('v1');
  app.useGlobalFilters(new ProblemFilter());
  app.enableShutdownHooks();
  app.enableCors({ origin: config.PUBLIC_WEB_URL, credentials: true });
  return app;
}
