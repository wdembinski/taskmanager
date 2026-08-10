import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { assertDevAuthGateSafe } from './config/devAuthGate';
import { loadSecretsFromKeyVault } from './config/secrets';

async function bootstrap() {
  // A no-op unless AZURE_KEY_VAULT_URI is set; populates process.env before anything else
  // reads it — see config/secrets.ts.
  await loadSecretsFromKeyVault();

  // Refuses to start rather than silently running an insecure dev bypass in
  // production — see config/devAuthGate.ts.
  assertDevAuthGateSafe(process.env);

  const app = await NestFactory.create(AppModule);
  app.enableCors();

  const port = process.env.PORT ?? 3100;
  await app.listen(port);

  // eslint-disable-next-line no-console
  console.log(`@tm/server listening on http://localhost:${port}`);
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start @tm/server:', error);
  process.exit(1);
});
