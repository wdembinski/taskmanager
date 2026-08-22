import { PROTOCOL_VERSION } from '@protocol/wire';
import type { BoardResponse, ClientInfo, CommandEnvelope, SyncRequest } from '@protocol/wire';
import type { CloudSettings } from '@shared/settings';
import type { JiraTestResult } from '@shared/ipc';

/**
 * "Test connection" for the cloud mirror — the same affordance the JIRA and GitLab panes
 * have, and for a better reason than symmetry.
 *
 * `cloudPoller` is deliberately silent: a failed tick is counted, backed off and retried,
 * never surfaced, because a poll loop that raises a dialog every 2.5s is unusable. The cost
 * is that EVERY misconfiguration looks identical from the app — nothing happens, and nothing
 * says why. Standing this service up hit four of them in a row (a server address that did
 * not resolve, a sign-in that stored no refresh token, an authentication scheme the identity
 * server rejects, and an account with no access) and not one produced a single visible
 * symptom beyond a board that stayed empty.
 *
 * So this walks the same chain the poller walks and reports the FIRST rung that fails, in
 * the user's terms. The stages are ordered so that each one only runs when the one before it
 * proved something, which is what makes the message specific enough to act on rather than
 * "connection failed".
 *
 * IT USED TO STOP ONE RUNG SHORT OF THE QUESTION PEOPLE ASK IT
 * -----------------------------------------------------------
 * The chain ended at `GET /v1/board` answering 200 and called that "Connected. The server
 * recognises this account." — which proves this machine can READ. Nothing a browser needs
 * from this machine is a read. A desktop becomes reachable from a browser by **writing**:
 * `POST /v1/sync` is what registers its presence, and `BoardResponse.clients` — built from
 * that presence — is the only reason a browser has a `targetClientId` to send a command to
 * at all. Between those two facts sit three failures that every one of them looked like
 * "Connected" here and "No desktop app has ever synced this account" in the browser:
 *
 *  1. **Cloud sync switched off.** The poller never runs, so nothing is ever mirrored and no
 *     presence is ever registered — while the address, the sign-in and the account access
 *     this probe tested are all perfect.
 *  2. **An account granted read but not write.** `IamAuthGuard` authorizes per HTTP method
 *     (`actionFor`: a GET is a read, everything else a write), so a grant with only `read`
 *     lets a board be fetched by both clients and rejects every `POST /v1/sync` with a 403 —
 *     forever, silently, on a backoff.
 *  3. **A server that took the sync and does not list the machine.** Presence is an in-memory
 *     map per server process, so a second replica answers a browser's board read from a
 *     presence map that never saw this desktop's sync.
 *
 * The ladder below therefore ends where the ticket does: *can a browser signed in to this
 * account see THIS machine and send it a command.* Anything short of that is a rung, not a
 * verdict.
 */
export interface CloudProbeDeps {
  settings: CloudSettings;
  /** The same accessor the poller uses; null when there is nothing to mint a token from. */
  getAccessToken: () => Promise<string | null>;
  /**
   * This machine's own `SyncRequest.clientId` — `store.loadCloudClientId()`, the id a browser
   * addresses a command to. The probe both registers it and then looks for it in the board's
   * `clients`, which is the whole point: an id that syncs and does not come back is a
   * different fault from one that never syncs.
   */
  clientId: string;
  /** What this machine calls itself — see `ClientInfo`. Sent so the probe's own sync writes
   *  the same identity columns a poll would, and so the verdict can name the machine. */
  clientInfo?: ClientInfo;
  /**
   * Commands the probe's sync collected, handed to the same drain the poller uses.
   *
   * `POST /v1/sync` LEASES what it hands out (`apps/server/src/mirror/commandQueue.ts`), so a
   * probe that quietly dropped a batch would delay a browser's click by a full five-minute
   * lease. Optional only because a test has no drain; `ipc.ts` always passes one.
   */
  onCommands?: (commands: CommandEnvelope[]) => void;
  /**
   * Why a bearer would be rejected, in the user's own words — `cloudToken.explain()`. Every
   * rejection this probe can hit is now a fact about a pasted token, never about the
   * server's own credentials, so this is what both 401 branches below say instead of a
   * generic sentence.
   */
  describeRejection?: () => string;
  fetchImpl?: typeof fetch;
}

export async function testCloudConnection(deps: CloudProbeDeps): Promise<JiraTestResult> {
  const doFetch = deps.fetchImpl ?? fetch;
  const baseUrl = deps.settings.baseUrl.trim().replace(/\/+$/, '');

  if (!baseUrl) {
    return { ok: false, message: 'No server address set. Enter one, then test again.' };
  }

  // 1. Is anything there at all? /health is unauthenticated precisely so this can be asked
  //    without a token — a wrong or unreachable address stops here rather than looking like
  //    an authentication problem three rungs later.
  try {
    const health = await doFetch(`${baseUrl}/health`);
    if (!health.ok) {
      return {
        ok: false,
        message: `${baseUrl} answered ${health.status} — that address is reachable but is not a Task Manager server.`,
      };
    }
  } catch (e) {
    return {
      ok: false,
      message: `Could not reach ${baseUrl} — check the address. (${errorText(e)})`,
    };
  }

  // 2. Have we got a token? Distinguishes "nothing pasted" from "pasted and refused", which
  //    look the same from the board.
  const token = await deps.getAccessToken();
  if (!token) {
    return {
      ok: false,
      message: `The server is reachable, but ${describeRejection(deps)}`,
    };
  }

  // 3. The master switch, tested BEFORE anything is written and after everything that can be
  //    checked without writing. Both halves of that order matter. It is the one failure that
  //    leaves every later rung passing — the address is right, the account has access, and
  //    nothing is ever mirrored because the poller does not run — so a probe that skipped it
  //    would answer "Connected" to a machine no browser will ever see. And it is checked
  //    before the sync below because that sync REGISTERS PRESENCE: run it with the switch off
  //    and a browser would list this machine as connected for the next ninety seconds and
  //    queue commands to a client that is never going to poll for them.
  if (!deps.settings.enabled) {
    return {
      ok: false,
      message:
        'The server is reachable and you are signed in, but cloud sync is switched off — so ' +
        'nothing is mirrored and no browser can see this machine. Turn on "Enable cloud sync" ' +
        'above, press Save, then test again.',
    };
  }

  // 4. Can this machine WRITE? This is the request the poller actually makes, and the only
  //    one that registers this desktop's presence — a browser's command has nowhere to go
  //    until it has succeeded at least once. Empty deltas, no acks and no results, so it
  //    disturbs nothing: the ledger, the outbox and the stored cursor are all left alone.
  let syncCursor: string | null = null;
  try {
    const request: SyncRequest = {
      clientId: deps.clientId,
      // Not `store.loadCloudCursor()`: this response is discarded rather than saved, and the
      // server does not read the request's cursor on this route anyway (it answers with the
      // account's current rowversion). Sending the real one could only ever risk advancing a
      // cursor past rows the poller has not applied.
      cursor: null,
      // A probe is not a human at the keyboard. Claiming focus here would pull the whole
      // account onto the fast tier for one button press.
      focused: false,
      deltas: { tasks: [], projects: [], deletedTaskIds: [], deletedProjectIds: [] },
      ackedCommandIds: [],
      results: [],
      protocolVersion: PROTOCOL_VERSION,
      ...(deps.clientInfo ? { info: deps.clientInfo } : {}),
    };
    const sync = await doFetch(`${baseUrl}/v1/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(request),
    });
    if (!sync.ok) {
      if (sync.status === 401) return { ok: false, message: describeRejection(deps) };
      if (sync.status === 403) {
        return {
          ok: false,
          message:
            'Signed in, but this account may not write to its board — so nothing on this ' +
            'machine is ever mirrored and no browser can see it. Someone with vipper.iam ' +
            'access needs to grant you read AND write on your taskmanager resource.',
        };
      }
      return {
        ok: false,
        message: `The server answered ${sync.status} ${sync.statusText} when this machine tried to sync.`,
      };
    }
    const body = (await sync.json()) as { cursor?: string; commands?: CommandEnvelope[] };
    syncCursor = body.cursor ?? null;
    // Whatever that sync leased, the drain gets. See `onCommands`.
    if (body.commands && body.commands.length > 0) deps.onCommands?.(body.commands);
  } catch (e) {
    return { ok: false, message: `This machine could not sync. (${errorText(e)})` };
  }

  // 5. Can it be READ back, and — the question this whole probe exists for — does the server
  //    list this machine among the Clients a browser may drive? `?since=` is the cursor the
  //    sync just answered with, so this asks for the presence list and (almost) no rows: a
  //    mature board would otherwise send its whole first page to answer a yes/no question.
  try {
    const url = new URL(`${baseUrl}/v1/board`);
    if (syncCursor) url.searchParams.set('since', syncCursor);
    const board = await doFetch(url.toString(), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!board.ok) {
      if (board.status === 401) return { ok: false, message: describeRejection(deps) };
      if (board.status === 403) {
        return {
          ok: false,
          message:
            'This machine can sync, but this account may not read a board — so a browser ' +
            'signed in as you would see nothing. Someone with vipper.iam access needs to ' +
            'grant you read as well as write on your taskmanager resource.',
        };
      }
      return { ok: false, message: `The server answered ${board.status} ${board.statusText}.` };
    }

    const body = (await board.json()) as BoardResponse;
    const listed = (body.clients ?? []).some((client) => client.id === deps.clientId);
    if (!listed) {
      return {
        ok: false,
        message:
          'The server took this machine’s sync but does not list it as connected, so a ' +
          'browser will say no desktop app is polling. That is usually more than one copy of ' +
          'the server running — connected clients are held per server process, so a browser ' +
          'can be reading from one that never saw this machine.',
      };
    }
    return {
      ok: true,
      ...(deps.clientInfo?.name ? { displayName: deps.clientInfo.name } : {}),
      message: `Connected. The server lists this machine${
        deps.clientInfo?.name ? ` as “${deps.clientInfo.name}”` : ''
      }, so a browser signed in to the same account can open your board and drive it.`,
    };
  } catch (e) {
    return { ok: false, message: `The board request failed. (${errorText(e)})` };
  }
}

/**
 * Why a bearer was refused, or nothing was sent at all — routed through `deps.describeRejection`
 * so every rung says the same thing `cloudToken.explain()` would, rather than three sentences
 * hand-written here and left to drift from it. The fallback is only ever seen by a caller (a
 * test, mainly) that omits the dep — real usage always wires it to `cloudToken.explain()`,
 * which is a fact about a PASTED token now, never about the server's own credentials.
 */
function describeRejection(deps: CloudProbeDeps): string {
  return deps.describeRejection?.() ?? 'you are not signed in.';
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
