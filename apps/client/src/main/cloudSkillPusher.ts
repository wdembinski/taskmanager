/**
 * The desktop's push half of the library skills mirror (F7.11) — `GET /v1/skills` and the
 * per-id `PUT`/`DELETE /v1/skills/:id` pair `skillMirror.entity.ts` and `skills.service.ts`
 * answer, mirrored here rather than riding `SyncRequest.deltas`: an uncapped sync payload
 * already wedged the mirror once (`one-answer-wedges-the-mirror`), which is why skills get
 * their own bounded endpoint instead of a bigger delta.
 *
 * SHAPED LIKE `cloudAttachmentUploader.ts`
 * -----------------------------------
 * Fetch-only at its network edge, no Electron import, every dependency injected, constructed
 * INERT and {@link CloudSkillPusher.configure}d later — so a mocked `fetch` drives it whole
 * under vitest, and so `ipc.ts` can build it above the store and token getter it needs.
 *
 * CHANGED-ONLY
 * ------------
 * `sent` holds the fingerprint (`name`/`description`/`body`/`updatedAt`) of every skill this
 * process believes the cloud already has. A skill whose current fingerprint matches is not
 * sent again — library skills can run to tens of KiB each, and a scan after every edit must
 * not re-PUT the whole set to notice one line changed.
 *
 * `sent` starts empty, which would make the very first pass of a fresh process re-push
 * everything it owns even when the cloud already has it from a previous run. The first
 * {@link scan} instead seeds `sent` from `GET /v1/skills` before touching anything else, so a
 * restart costs one read rather than a PUT per skill. (Seeding failing — no token, the
 * network is down — leaves `sent` empty and is retried on the next scan; nothing is lost by
 * waiting one more pass to learn what is already up there.)
 *
 * A skill gone from {@link CloudSkillPusherDeps.listSkills} that `sent` still remembers is a
 * local delete, and earns exactly one `DELETE` — removed from `sent` once it succeeds, so a
 * later pass does not repeat it.
 *
 * 413 IS NOT A FAILURE TO RETRY
 * ------------------------------
 * A body over `SKILL_BODY_MAX` will be refused by the server every time nothing about it
 * changes, so the fingerprint that earned the 413 goes in `issueFingerprint` and this process
 * stops asking — exactly the sentinel `cloudAttachmentUploader.ts`'s `refused` set is for,
 * just keyed to a fingerprint rather than an id, because an edit that brings the body back
 * under budget must be allowed to try again. The issue itself (`{ id, bytes, message }`) is
 * recorded in `issues` and reported through {@link CloudSkillPusherDeps.onIssuesChanged}; a
 * later success (the skill was edited back under budget) or a delete clears both maps and
 * reports the change again.
 */
import type { CloudSettings } from '@shared/settings';
import { skillBodyBytes, skillTooLargeMessage, type Skill } from '@shared/skills';
import type { SkillsResponse } from '@protocol/wire';
import { logMain } from './log';

/** How many failures in a row end a pass — see `cloudAttachmentUploader.ts`'s own constant
 *  for the full reasoning; the number is the same for the same reason. */
const FAILURE_LIMIT = 3;

/** One skill the cloud refused for size — `{@link skillBodyBytes}`'s count, not the wire
 *  body's own byte length, so it matches what {@link skillTooLargeMessage} would say too. */
export interface SkillSyncIssue {
  id: string;
  bytes: number;
  message: string;
}

export interface CloudSkillPusherDeps {
  /** Read fresh on every pass, exactly as `CloudAttachmentUploader` reads it. */
  getSettings: () => CloudSettings;
  /** A bearer token for this push, or null when not signed in — counted as a failure. */
  getAccessToken: () => Promise<string | null>;
  /** `Store.getSkills` — every library skill this desktop owns, name-ordered. */
  listSkills: () => Skill[];
  /** A push or the seed read came back 401 — see `CloudPollerDeps.onAuthRejected`. Never
   *  called for a 403. */
  onAuthRejected?: () => void;
  /** `issues` changed shape — a skill newly refused for size, one that stopped being, or one
   *  that was deleted while it still carried an issue. */
  onIssuesChanged?: () => void;
  fetchImpl?: typeof fetch;
}

/** `name`/`description`/`body`/`updatedAt` — the fields that change `PUT`'s wire body and
 *  therefore the only ones worth comparing. `id` is not part of it: it is the map key this
 *  is compared under, and `createdAt` never changes after a skill is made. */
function fingerprintOf(skill: Skill): string {
  return JSON.stringify([skill.name, skill.description, skill.body, skill.updatedAt]);
}

type PushAction = { kind: 'push'; skill: Skill } | { kind: 'delete'; id: string };

export class CloudSkillPusher {
  private deps: CloudSkillPusherDeps | null = null;
  private disposed = false;
  private running = false;
  /** A scan asked for while one was running, so the pass that finishes starts another. */
  private rescan = false;
  /** Whether `GET /v1/skills` has seeded {@link sent} yet this process — see the header. */
  private seeded = false;
  /** id → fingerprint of every skill this process believes the cloud currently holds. */
  private readonly sent = new Map<string, string>();
  /** id → the fingerprint that earned a 413, so an edit (a changed fingerprint) is still
   *  worth trying again even though the id itself keeps failing. */
  private readonly issueFingerprint = new Map<string, string>();
  /** id → the issue itself, for whoever reads {@link listIssues}. */
  private readonly issues = new Map<string, SkillSyncIssue>();

  /** Supply the dependencies. Until this is called, {@link scan} is a no-op. */
  configure(deps: CloudSkillPusherDeps): void {
    this.deps = deps;
  }

  /** Skills currently refused for size, newest-recorded order is not promised. */
  listIssues(): SkillSyncIssue[] {
    return [...this.issues.values()];
  }

  /**
   * Look at the library and push whatever the cloud is missing or behind on.
   *
   * Fire-and-forget by contract, the same as `CloudAttachmentUploader.scan`: every caller —
   * boot, a future `skill:save`/`skill:delete` handler, the cloud poller's own tick — is on
   * the engine's own path and may not wait for a network round trip.
   */
  scan(): void {
    if (this.disposed || !this.deps) return;
    if (this.running) {
      this.rescan = true;
      return;
    }
    void this.run();
  }

  dispose(): void {
    this.disposed = true;
    this.deps = null;
  }

  /** One pass. Never throws — it is only ever reached fire-and-forget. */
  private async run(): Promise<void> {
    this.running = true;
    try {
      do {
        this.rescan = false;
        await this.pass();
      } while (this.rescan && !this.disposed);
    } catch (e) {
      logMain('cloud skill push pass failed', e);
    } finally {
      this.running = false;
    }
  }

  private async pass(): Promise<void> {
    const deps = this.deps;
    if (!deps || this.disposed) return;

    const settings = deps.getSettings();
    if (!settings.enabled || !settings.baseUrl.trim()) return;

    if (!this.seeded) {
      const ok = await this.seed(deps, settings);
      if (!ok || this.disposed) return;
    }

    const current = deps.listSkills();
    const currentIds = new Set(current.map((s) => s.id));

    const toPush = current.filter((skill) => {
      const fp = fingerprintOf(skill);
      if (this.sent.get(skill.id) === fp) return false;
      if (this.issueFingerprint.get(skill.id) === fp) return false;
      return true;
    });
    const toDelete = [...this.sent.keys()].filter((id) => !currentIds.has(id));

    // An id that still carries an issue but is gone locally was never successfully mirrored
    // in the first place (a 413 never lands), so there is nothing on the server to delete —
    // just drop the bookkeeping so it does not sit in memory forever.
    for (const id of [...this.issueFingerprint.keys()]) {
      if (!currentIds.has(id)) this.clearIssue(id, deps);
    }

    const actions: PushAction[] = [
      ...toPush.map((skill): PushAction => ({ kind: 'push', skill })),
      ...toDelete.map((id): PushAction => ({ kind: 'delete', id })),
    ];
    if (actions.length === 0) return;

    let failures = 0;
    for (const action of actions) {
      if (this.disposed) return;
      const ok =
        action.kind === 'push'
          ? await this.pushOne(deps, settings, action.skill)
          : await this.deleteOne(deps, settings, action.id);
      failures = ok ? 0 : failures + 1;
      if (failures >= FAILURE_LIMIT) {
        logMain(`Stopped pushing skills to the cloud after ${failures} failures in a row`);
        return;
      }
    }
  }

  /** `GET /v1/skills` once, so a fresh process does not re-push what the cloud already has —
   *  see the header. Resolves false on any failure, leaving {@link seeded} unset so the next
   *  scan tries again. */
  private async seed(deps: CloudSkillPusherDeps, settings: CloudSettings): Promise<boolean> {
    try {
      const token = await deps.getAccessToken();
      if (!token) throw new Error('No cloud token available.');

      const fetchImpl = deps.fetchImpl ?? fetch;
      const res = await fetchImpl(`${settings.baseUrl.replace(/\/+$/, '')}/v1/skills`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        if (res.status === 401) deps.onAuthRejected?.();
        throw new Error(`cloud skill seed read failed (${res.status} ${res.statusText})`);
      }

      const body = (await res.json()) as SkillsResponse;
      for (const skill of body.skills) {
        this.sent.set(skill.id, fingerprintOf(skill));
      }
      this.seeded = true;
      return true;
    } catch (e) {
      logMain('Could not read the cloud skill mirror to seed the pusher', e);
      return false;
    }
  }

  /** Push one skill. Resolves true when the cloud took it. */
  private async pushOne(
    deps: CloudSkillPusherDeps,
    settings: CloudSettings,
    skill: Skill,
  ): Promise<boolean> {
    const fingerprint = fingerprintOf(skill);
    try {
      const token = await deps.getAccessToken();
      if (!token) throw new Error('No cloud token available.');

      const fetchImpl = deps.fetchImpl ?? fetch;
      const url = `${settings.baseUrl.replace(/\/+$/, '')}/v1/skills/${encodeURIComponent(skill.id)}`;
      const res = await fetchImpl(url, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(skill),
      });
      if (!res.ok) {
        if (res.status === 401) deps.onAuthRejected?.();
        if (res.status === 413) {
          const bytes = skillBodyBytes(skill.body);
          const message = await readIssueMessage(res, bytes);
          this.issueFingerprint.set(skill.id, fingerprint);
          this.issues.set(skill.id, { id: skill.id, bytes, message });
          this.sent.delete(skill.id);
          deps.onIssuesChanged?.();
        }
        throw new Error(`cloud skill push failed (${res.status} ${res.statusText})`);
      }

      this.sent.set(skill.id, fingerprint);
      this.clearIssue(skill.id, deps);
      return true;
    } catch (e) {
      logMain(`Could not push the skill ${skill.name} to the cloud`, e);
      return false;
    }
  }

  /** Delete one skill the cloud no longer needs a copy of. Resolves true when it took it. */
  private async deleteOne(
    deps: CloudSkillPusherDeps,
    settings: CloudSettings,
    id: string,
  ): Promise<boolean> {
    try {
      const token = await deps.getAccessToken();
      if (!token) throw new Error('No cloud token available.');

      const fetchImpl = deps.fetchImpl ?? fetch;
      const url = `${settings.baseUrl.replace(/\/+$/, '')}/v1/skills/${encodeURIComponent(id)}`;
      const res = await fetchImpl(url, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        if (res.status === 401) deps.onAuthRejected?.();
        throw new Error(`cloud skill delete failed (${res.status} ${res.statusText})`);
      }

      this.sent.delete(id);
      this.clearIssue(id, deps);
      return true;
    } catch (e) {
      logMain(`Could not delete the skill ${id} from the cloud`, e);
      return false;
    }
  }

  /** Drop `id`'s issue, if it has one, and report the change. A no-op (and no report) for an
   *  id that never had one, so a plain successful push does not fire `onIssuesChanged` for
   *  nothing. */
  private clearIssue(id: string, deps: CloudSkillPusherDeps): void {
    this.issueFingerprint.delete(id);
    if (this.issues.delete(id)) deps.onIssuesChanged?.();
  }
}

/** The sentence to record for a 413: the response body's own `message` when it has one,
 *  otherwise {@link skillTooLargeMessage} — the same fallback the server itself falls back
 *  to nothing further than, since `skillTooLargeMessage` is what it used to word that body in
 *  the first place. Never throws: a response that is not JSON, or JSON with no `message`,
 *  just falls back. */
async function readIssueMessage(res: Response, bytes: number): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown };
    if (typeof body?.message === 'string' && body.message) return body.message;
  } catch {
    // Not JSON, or already consumed — fall back below.
  }
  return skillTooLargeMessage(bytes);
}
