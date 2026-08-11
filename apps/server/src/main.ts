import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { bodyLimit, isBodyLimit } from './config/bodyLimit';
import { assertDevAuthGateSafe } from './config/devAuthGate';
import { corsOrigin } from './config/cors';
import { loadSecretsFromKeyVault } from './config/secrets';

async function bootstrap() {
  // A no-op unless AZURE_KEY_VAULT_URI is set; populates process.env before anything else
  // reads it — see config/secrets.ts.
  await loadSecretsFromKeyVault();

  // Refuses to start rather than silently running an insecure dev bypass in
  // production — see config/devAuthGate.ts.
  assertDevAuthGateSafe(process.env);

  // `bodyParser: false` disables Nest's own JSON parser so the one registered below is the
  // ONLY one — `app.use(express.json({ limit }))` would instead stack a second parser in
  // front of Nest's, which stays at express's 100 kB default. The first parser to run wins,
  // so the limit that actually applied would be whichever of the two got there first, and
  // the dead one would be the more findable of the pair. See config/bodyLimit.ts.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  const limit = bodyLimit(process.env);
  app.useBodyParser('json', { limit });

  // Named origins, not `*` — see config/cors.ts.
  app.enableCors({ origin: corsOrigin(process.env) });

  const port = process.env.PORT ?? 3100;
  await app.listen(port);

  const configuredLimit = (process.env.CLOUD_BODY_LIMIT ?? '').trim();
  if (configuredLimit.length > 0 && !isBodyLimit(configuredLimit)) {
    // eslint-disable-next-line no-console
    console.warn(`CLOUD_BODY_LIMIT=${configuredLimit} is not a size; using ${limit} instead.`);
  }
  // eslint-disable-next-line no-console
  console.log(`@tm/server listening on http://localhost:${port} (body limit ${limit})`);
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start @tm/server:', error);
  process.exit(1);
});
