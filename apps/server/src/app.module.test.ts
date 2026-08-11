import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { AppModule } from './app.module';

/**
 * Guards the ordering bug that crash-looped the first real deployment.
 *
 * `buildMssqlConnectionOptions()` used to be called inside the `@Module` decorator's object
 * literal, which JavaScript evaluates when this module is IMPORTED — before `main.ts`'s
 * `bootstrap()` runs, and therefore before `loadSecretsFromKeyVault()` has put `DB_PASSWORD`
 * into `process.env`. The connection was built with the local-dev fallback password, Azure
 * SQL refused the login, and the container restarted forever.
 *
 * Every existing test passed throughout, because locally the password is already in the
 * environment before anything imports anything. The only way to catch it is to assert that
 * the options are produced by a FACTORY — something called later — rather than by a value
 * computed at import time. That is what this does: it changes the environment AFTER the
 * module has been imported, and requires the factory to see the change.
 */
describe('AppModule', () => {
  /**
   * The TypeORM options factory registered by `forRootAsync`, wherever it sits.
   * `TypeOrmModule.forRootAsync` returns a DynamicModule whose real providers live one level
   * down, inside its own `imports` — hence the recursion rather than a single pass.
   */
  function findOptionsFactory(node: unknown = null, depth = 0): () => Record<string, unknown> {
    const children: unknown[] =
      depth === 0
        ? ((Reflect.getMetadata('imports', AppModule) as unknown[]) ?? [])
        : ((node as { imports?: unknown[] })?.imports ?? []);

    for (const child of children) {
      for (const provider of (child as { providers?: unknown[] })?.providers ?? []) {
        const factory = (provider as { useFactory?: () => unknown })?.useFactory;
        if (typeof factory !== 'function') continue;
        try {
          const produced = factory() as Record<string, unknown>;
          if (produced && produced.type === 'mssql')
            return factory as () => Record<string, unknown>;
        } catch {
          // A factory that needs injected arguments is not the one we are looking for.
        }
      }
      if (depth < 4) {
        try {
          return findOptionsFactory(child, depth + 1);
        } catch {
          // Not down this branch; keep looking.
        }
      }
    }
    throw new Error('No TypeORM options factory found — was forRootAsync replaced by forRoot?');
  }

  it('reads the database password when the factory runs, not when the module is imported', () => {
    const factory = findOptionsFactory();
    const before = process.env.DB_PASSWORD;
    try {
      // Set AFTER the import at the top of this file has already happened.
      process.env.DB_PASSWORD = 'secret-that-arrived-late';
      expect(factory().password).toBe('secret-that-arrived-late');
    } finally {
      if (before === undefined) delete process.env.DB_PASSWORD;
      else process.env.DB_PASSWORD = before;
    }
  });

  it('still carries the entities and keeps synchronize off', () => {
    const options = findOptionsFactory()();

    expect(options.synchronize).toBe(false);
    expect((options.entities as unknown[]).length).toBe(5);
  });
});
