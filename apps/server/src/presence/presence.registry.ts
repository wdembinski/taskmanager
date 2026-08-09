import { Injectable } from '@nestjs/common';
import { PRESENCE_TTL_MS } from '@tm/protocol/cadence';
import type { PresenceBeat as CadenceSession, PresenceSource } from '@tm/protocol/cadence';

/** One session's last-known focus state, as reported by its own beat. */
export interface PresenceBeat {
  kind: PresenceSource;
  focused: boolean;
  /** Epoch ms this beat was received. */
  at: number;
}

/**
 * The server's in-memory presence map — `Map<accountId, Map<sessionId, PresenceBeat>>` —
 * deliberately not a SQL table: a write on every poll at the active tier's 2.5s cadence
 * would be exactly the write-amplification docs/plan/README.md's cost estimate ruled out.
 * A session here is whatever the caller identifies itself by on the wire — a desktop
 * Client's `clientId`, or a web tab's own generated id — never a database row.
 *
 * There is no background sweep timer: expired entries are dropped the next time
 * {@link PresenceRegistry.sessions} reads that account, which happens on every poll anyway,
 * so a timer would only duplicate work already happening on the request path.
 */
@Injectable()
export class PresenceRegistry {
  private readonly accounts = new Map<string, Map<string, PresenceBeat>>();

  /** Records or overwrites one session's latest beat. */
  record(accountId: string, sessionId: string, beat: PresenceBeat): void {
    let sessions = this.accounts.get(accountId);
    if (!sessions) {
      sessions = new Map();
      this.accounts.set(accountId, sessions);
    }
    sessions.set(sessionId, beat);
  }

  /**
   * This account's live sessions as {@link resolveCadence}'s own input shape, sweeping out
   * anything older than {@link PRESENCE_TTL_MS} first. An account with no sessions left
   * (never seen, or every session just aged out) is dropped from the outer map too, so a
   * long-idle account doesn't sit in memory forever.
   */
  sessions(accountId: string, now: number): CadenceSession[] {
    const sessions = this.accounts.get(accountId);
    if (!sessions) return [];

    const live: CadenceSession[] = [];
    for (const [sessionId, beat] of sessions) {
      if (now - beat.at > PRESENCE_TTL_MS) {
        sessions.delete(sessionId);
        continue;
      }
      live.push({ clientId: sessionId, source: beat.kind, focused: beat.focused, lastSeen: beat.at });
    }

    if (sessions.size === 0) this.accounts.delete(accountId);
    return live;
  }
}
