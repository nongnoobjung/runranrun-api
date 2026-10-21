import { createApp } from './app.factory';
import { loadConfig } from './config';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
}

void bootstrap();
