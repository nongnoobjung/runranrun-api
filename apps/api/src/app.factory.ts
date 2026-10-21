import 'reflect-metadata';
import multipart from '@fastify/multipart';
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
  // File uploads (KYC documents); each route sets its own size limit when it reads the parts.
  await app.register(multipart);
  app.setGlobalPrefix('v1');
  app.useGlobalFilters(new ProblemFilter());
  app.enableShutdownHooks();
  app.enableCors({ origin: config.PUBLIC_WEB_URL, credentials: true });
  return app;
}
