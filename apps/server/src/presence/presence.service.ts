import { Injectable, Logger } from '@nestjs/common';
import { resolveCadence } from '@tm/protocol/cadence';
import type { CadenceDirective, CadenceTier } from '@tm/protocol/cadence';
import type { ClientPresence } from '@tm/protocol/wire';
import { PresenceRegistry, type PresenceBeat } from './presence.registry';

/**
 * Turns a raw {@link PresenceRegistry} beat into the `CadenceDirective` every mirror route
 * hands back (`POST /v1/sync`, `GET /v1/board`, `POST /v1/presence`) — the one place that
 * calls `resolveCadence` from `@tm/protocol`, so the three routes can't drift on how they
 * read the presence map.
 */
@Injectable()
export class PresenceService {
  private readonly logger = new Logger('CadenceTransition');
  private readonly lastTier = new Map<string, CadenceTier>();

  constructor(private readonly registry: PresenceRegistry) {}

  /** Records one session's beat, then resolves the account's cadence as of that same instant. */
  beat(accountId: string, sessionId: string, beat: PresenceBeat): CadenceDirective {
    this.registry.record(accountId, sessionId, beat);
    return this.cadence(accountId, beat.at);
  }

  /** Resolves the account's cadence without recording a beat — for a caller that sent none. */
  cadence(accountId: string, now: number): CadenceDirective {
    const directive = resolveCadence(this.registry.sessions(accountId, now), now);
    this.logTransition(accountId, directive);
    return directive;
  }

  /**
   * The desktop Clients (never web sessions — see `ClientPresence`'s own docstring) live on
   * this account right now, most recently seen first. Backs `GET /v1/board`'s `clients`
   * field: apps/web reads this to pick a `targetClientId` for `POST /v1/commands` and to
   * decide whether the "no Client has polled recently" banner is honest to show.
   */
  clients(accountId: string, now: number): ClientPresence[] {
    return this.registry
      .sessions(accountId, now)
      .filter((session) => session.source === 'client')
      .map((session) => ({ id: session.clientId, lastSeen: session.lastSeen }))
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /**
   * One line per actual tier change — `account`/`from`/`to`/`reason`, the shape the
   * verification phase (step 12 of this plan) reads back to measure transitions. Repeated
   * polls at a steady tier log nothing, so this stays quiet at the active tier's 2.5s cadence.
   */
  private logTransition(accountId: string, directive: CadenceDirective): void {
    const from = this.lastTier.get(accountId);
    if (from === directive.tier) return;

    this.lastTier.set(accountId, directive.tier);
    this.logger.log(
      `account=${accountId} from=${from ?? 'none'} to=${directive.tier} reason=${directive.reason}`,
    );
  }
}
