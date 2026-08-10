import { Controller, Get } from '@nestjs/common';

/**
 * The container platform's "is this replica alive" probe.
 *
 * Two deliberate choices, both of which the rest of this server does the other way:
 *
 * **Unguarded.** Every other route carries `@UseGuards(IamAuthGuard)`, so a probe against
 * one answers 401 — and a 401 is a *reachable* server, which is exactly what a liveness
 * probe is asking about, but Container Apps reads it as unhealthy and restarts the replica
 * forever. There is nothing here worth authenticating: the response names no account and
 * reads nothing.
 *
 * **Outside `/v1`.** `/v1` is the wire contract `@tm/protocol` versions and clients code
 * against. This is an operational endpoint for the platform, not part of that contract, and
 * it must never be versioned out from under a probe URL baked into infrastructure.
 *
 * It deliberately does **no database work**. A liveness probe that touches the DB turns a
 * database blip into a rolling restart of every replica — the app is fine, and restarting
 * it does not fix the database. `vipper.iam`'s own health endpoint stays green while its
 * DB is resuming from pause for the same reason.
 */
@Controller('health')
export class HealthController {
  @Get()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
