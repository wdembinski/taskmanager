/**
 * The desktop's half of "cloud as central control for projects" step 5: "desktop is
 * the worker". A queued `Assignment` (`@shared/agent`) is a ticket waiting for SOME
 * desktop serving its project to pick it up — this class is the thing that does the
 * picking up, on the same self-scheduling `setTimeout` shape as `cloudBoardPuller.ts`
 * (that file's own header explains why a fixed `setInterval` is wrong here, and why a
 * poller with its own clock lives beside `CloudPoller`/`CloudBoardPuller` rather than
 * bolted onto either).
 *
 * A SEPARATE POLLER, NOT A CHANGE TO `Scheduler` ITSELF
 * --------------------------------------------------------
 * `Scheduler` is event/callback driven — a task change, a run event, a chain
 * reconsideration — never a clock of its own; nothing else in it polls anything. This
 * class supplies exactly the one new capability the step needs (noticing a queued
 * assignment exists at all) and then hands off to `Scheduler`'s own existing public
 * entry point, `runTask(taskId)`, which is the same call a human clicking Start makes
 * — the run it produces goes through the exact same `sessionManager`/`chainRunner`
 * path either way. Extending `Scheduler`'s own file with a poll loop would mean
 * threading HTTP, auth and cloud settings through an already enormous class for a
 * capability that is, start to finish, "call a method that already exists."
 *
 * ONE ASSIGNMENT DOES NOT BLOCK ANOTHER
 * ---------------------------------------
 * A `claim` that wins the race but whose `runTask` call is refused (the scheduler is
 * already running that ticket, its project has no local copy yet, the usage-limit gate
 * is up, …) is left `claimed` on the server and simply skipped here — a later tick, or
 * a later boot, gets another chance once whatever blocked it clears. Nothing here
 * retries synchronously or gives up on the rest of the batch.
 */
import { CADENCE_MS, nextPollDelayMs } from '@protocol/cadence';
import type { Assignment } from '@shared/agent';
import { ownsTickets } from '@shared/model';
import type { CloudSettings } from '@shared/settings';
import type { FocusSignal } from './cloudPoller';
import { logMain } from './log';
import type { Store } from './store';

export interface AssignmentPollerDeps {
  store: Store;
  focus: FocusSignal;
  /** Read fresh on every (re)schedule and every tick, exactly like `CloudBoardPuller`. */
  getSettings: () => CloudSettings;
  /** A bearer access token for this tick, or null when not signed in — the tick then
   *  fails like any other network error (counted, backed off, retried next time). */
  getAccessToken: () => Promise<string | null>;
  /** Wraps one tick so the status bar can watch it, exactly as `CloudBoardPuller` does. */
  runTracked: <T>(run: () => Promise<T>) => Promise<T>;
  /**
   * Starts a session for one ticket through the scheduler's existing
   * `sessionManager`/`chainRunner` path — in production this is `Scheduler.runTask`
   * itself, unmodified. Returns the new run's id, or `null` if the scheduler refused
   * (already running, no local project, the limit/sign-in gate is up, …), which this
   * poller treats as "try again another tick," not an error.
   */
  runTask: (taskId: string) => { runId: string } | null;
  fetchImpl?: typeof fetch;
  random?: () => number;
}

function jsonHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

export class AssignmentPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private disposed = false;
  private consecutiveFailures = 0;
  private lastPollAt = 0;
  private readonly unsubscribeFocus: () => void;

  constructor(private readonly deps: AssignmentPollerDeps) {
    this.unsubscribeFocus = deps.focus.onChange(() => this.onFocusChange());
  }

  /** (Re)arm from current settings. No-op while cloud sync is off or has no server to poll. */
  reschedule(): void {
    this.clearTimer();
    if (this.disposed) return;
    const settings = this.deps.getSettings();
    if (!settings.enabled || !settings.baseUrl.trim()) return;
    this.arm(this.computeDelay(settings));
  }

  /** Same immediacy rule as `CloudBoardPuller.onFocusChange` — see its own docstring. */
  private onFocusChange(): void {
    if (!this.timer || this.disposed) return;
    const settings = this.deps.getSettings();
    if (!settings.enabled || !settings.baseUrl.trim()) return;
    const sinceLastPoll = Date.now() - this.lastPollAt;
    this.arm(Math.max(0, CADENCE_MS.active - sinceLastPoll));
  }

  private computeDelay(settings: CloudSettings): number {
    const serverIntervalMs = this.deps.focus.isFocused()
      ? settings.activeIntervalMs
      : settings.idleIntervalMs;
    return nextPollDelayMs({
      serverIntervalMs,
      localFocused: this.deps.focus.isFocused(),
      consecutiveFailures: this.consecutiveFailures,
      jitterRatio: settings.jitterRatio,
      random: this.deps.random ?? Math.random,
    });
  }

  private arm(delayMs: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** One request/response round trip. Exposed for tests; the timer calls it. */
  async tick(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    this.lastPollAt = Date.now();
    try {
      await this.deps.runTracked(() => this.send());
      this.consecutiveFailures = 0;
    } catch (e) {
      this.consecutiveFailures += 1;
      logMain('assignment poll failed', e);
    } finally {
      this.running = false;
      this.reschedule();
    }
  }

  private async send(): Promise<void> {
    const settings = this.deps.getSettings();
    if (!settings.enabled || !settings.baseUrl.trim()) return;

    const token = await this.deps.getAccessToken();
    if (!token) throw new Error('Not signed in to vipper.iam.');

    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const url = new URL('/v1/assignments', settings.baseUrl);
    url.searchParams.set('status', 'queued');
    const res = await fetchImpl(url.toString(), { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`assignment poll failed (${res.status} ${res.statusText})`);
    const queued = (await res.json()) as Assignment[];
    if (queued.length === 0) return;

    // "Projects it serves": the ticket projects this desktop already has locally — a
    // queued row for a project pulled down by some OTHER desktop is none of this one's
    // business, and claiming it would strand it on a machine with no local copy of the
    // ticket to run.
    const servedProjectIds = new Set(
      this.deps.store
        .listProjects()
        .filter((project) => ownsTickets(project))
        .map((project) => project.id),
    );
    const clientId = this.deps.store.loadCloudClientId();

    for (const assignment of queued) {
      if (!servedProjectIds.has(assignment.projectId)) continue;
      if (!this.deps.store.getTask(assignment.ticketId)) continue; // not pulled down yet

      const claimRes = await fetchImpl(
        new URL(`/v1/assignments/${assignment.id}/claim`, settings.baseUrl).toString(),
        { method: 'POST', headers: jsonHeaders(token), body: JSON.stringify({ clientId }) },
      );
      if (!claimRes.ok) continue; // lost the race to another desktop — not an error

      const outcome = this.deps.runTask(assignment.ticketId);
      if (!outcome) continue; // the scheduler refused; leave it claimed for a later tick

      await fetchImpl(
        new URL(`/v1/assignments/${assignment.id}/complete`, settings.baseUrl).toString(),
        {
          method: 'POST',
          headers: jsonHeaders(token),
          body: JSON.stringify({ status: 'running', clientId, runId: outcome.runId }),
        },
      ).catch((e) => logMain('assignment: reporting running failed', e));
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.unsubscribeFocus();
  }
}
