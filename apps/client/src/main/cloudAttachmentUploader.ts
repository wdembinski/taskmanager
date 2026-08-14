/**
 * The desktop's HTTP edge for attachment BYTES — both directions, because both are the same
 * fact from the two ends: this machine holds the only copy of an attachment, and the cloud
 * holds a cache of it so a browser can look at it.
 *
 *  - {@link CloudAttachmentUploader} pushes qualifying attachments up
 *    (`PUT /v1/attachments/:id/blob`) and records `cloudBlobAt` when the cloud takes them.
 *  - {@link fetchUploadBytes} pulls a browser's parked file down (`GET /v1/uploads/:id`), for
 *    `attachment:addUploaded` to turn into a real attachment.
 *
 * WHAT "QUALIFYING" MEANS, AND WHY IT IS NOT EVERYTHING
 * ----------------------------------------------------
 * {@link qualifiesForCloud}: an image, under {@link CLOUD_BLOB_MAX_BYTES}, not already up.
 * Both halves are deliberate. The whole preview story on the web is `<img src>`, so a `.docx`
 * pushed up is a shared quota spent on something no browser will ever render — and the cap is
 * far below what an attachment may weigh locally precisely because a 30 MB screen recording
 * would cross an HTTPS request, be held whole in memory at both ends of it, and evict every
 * screenshot in the account to make room. The video is still attached, still opens on the
 * desktop, and simply has no thumbnail in a browser, which is what it had before any of this.
 *
 * SHAPED LIKE `cloudEventForwarder.ts`
 * -----------------------------------
 * Fetch-only at its network edge, no Electron import, every dependency injected, constructed
 * INERT and {@link CloudAttachmentUploader.configure}d later — so a mocked `fetch` drives it
 * whole under vitest, and so `ipc.ts` can build it above the store and token getter it needs.
 * It also shares that file's gate discipline: nothing happens at all unless `cloud.enabled`
 * and a base URL are set, read fresh on every pass rather than captured once.
 *
 * IT IS A CACHE, SO EVERY FAILURE IS CHEAP
 * ----------------------------------------
 * A push that fails leaves `cloudBlobAt` unset, which is the truth, and the next scan (the
 * next attachment change, or the next boot) tries again. There is no retry timer and no
 * persistence of failure, with one exception: a `413` means the cloud will never accept these
 * bytes — the account is over quota with nothing evictable, or the file is over the cap — so
 * the id goes in an in-memory sentinel and this process stops asking. A restart forgets that,
 * which costs one refused request per boot and is the right trade against a disk-backed
 * ledger of things that did not work.
 */
import {
  CLOUD_BLOB_MAX_BYTES,
  CLOUD_PREVIEW_MIME_PREFIX,
  type TaskAttachment,
  type UploadedAttachment,
} from '@shared/attachments';
import type { CloudSettings } from '@shared/settings';
import { BLOB_NAME_QUERY, BLOB_TYPE_QUERY, type BlobStored } from '@protocol/wire';
import { logMain } from './log';

/**
 * How long between two pushes in one pass.
 *
 * The boot backfill is the case this exists for: a profile that has been attaching
 * screenshots for a year hits its first cloud-enabled boot with hundreds of qualifying rows,
 * and pushing them back to back would be minutes of saturated uplink and a wall of writes at
 * the server, for a cache nobody is waiting on. One a second gets a working board's worth up
 * within a minute or two of a launch, unnoticed.
 *
 * A file the human attached a moment ago waits the same second, which is fine: the chip is
 * already on screen in both clients, and the only thing that arrives late is its thumbnail.
 */
export const UPLOAD_GAP_MS = 1_000;

/**
 * How many failures in a row end a pass.
 *
 * A pass is a walk over rows that all failed for the same reason nine times out of ten — the
 * network is down, the token will not mint, the account is over quota. Three is enough to
 * tell that from one file the disk could not read, and stopping means an offline desktop
 * spends three requests on a scan rather than one per attachment it owns.
 */
const FAILURE_LIMIT = 3;

export interface CloudAttachmentUploaderDeps {
  /** Read fresh on every pass, exactly as `CloudEventForwarder` reads it on every flush. */
  getSettings: () => CloudSettings;
  /** A bearer token for this push, or null when not signed in — counted as a failure. */
  getAccessToken: () => Promise<string | null>;
  /** `Store.listAttachments` — the whole board's, filtered here by {@link qualifiesForCloud}. */
  listAttachments: () => TaskAttachment[];
  /** This machine's copy of one attachment's bytes. Throws if the file is gone. */
  readBytes: (attachment: TaskAttachment) => Promise<Uint8Array>;
  /** `Store.markAttachmentUploaded`. */
  markUploaded: (id: string, at: number | null) => void;
  /**
   * One row's `cloudBlobAt` changed. `ipc.ts` passes `pushAttachments`, so a browser learns
   * a thumbnail is now available over the `attachment:changed` it already listens to — there
   * is no second channel for this, and no poll that would have found it.
   */
  onUploaded?: () => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Injected so a test does not have to wait out {@link UPLOAD_GAP_MS} per file. */
  setTimeoutImpl?: typeof setTimeout;
}

/**
 * Whether these bytes are worth a place in the cloud's cache — see the header for the
 * argument. Pure, and exported because it is the one rule here worth pinning without a
 * network.
 *
 * `mimeType` is null for a suffix nothing recognized, and a file nothing recognizes is not an
 * image; `size` is the row's, which is what was actually written.
 */
export function qualifiesForCloud(attachment: TaskAttachment): boolean {
  if (attachment.cloudBlobAt) return false;
  if (!attachment.mimeType?.startsWith(CLOUD_PREVIEW_MIME_PREFIX)) return false;
  return attachment.size > 0 && attachment.size <= CLOUD_BLOB_MAX_BYTES;
}

export class CloudAttachmentUploader {
  private deps: CloudAttachmentUploaderDeps | null = null;
  private disposed = false;
  private running = false;
  /** Ids the cloud has refused outright — see the header on why this is memory, not a column. */
  private readonly refused = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** A scan asked for while one was running, so the pass that finishes starts another. */
  private rescan = false;

  /** Supply the dependencies. Until this is called, {@link scan} is a no-op. */
  configure(deps: CloudAttachmentUploaderDeps): void {
    this.deps = deps;
  }

  /**
   * Look at the board and push whatever is missing from the cloud.
   *
   * The one entry point, for both the boot backfill and a file just attached: "what is up
   * there" is a question with one answer, and a second path that knew about only the newest
   * row would silently skip anything a failure left behind. Fire-and-forget by contract —
   * every caller is on the engine's own path (`ipc.ts`'s attachment handlers, and boot), and
   * none of them may wait for a network round trip.
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
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
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
      logMain('cloud attachment upload pass failed', e);
    } finally {
      this.running = false;
    }
  }

  private async pass(): Promise<void> {
    const deps = this.deps;
    if (!deps || this.disposed) return;

    const settings = deps.getSettings();
    if (!settings.enabled || !settings.baseUrl.trim()) return;

    const pending = deps
      .listAttachments()
      .filter((a) => qualifiesForCloud(a) && !this.refused.has(a.id));
    if (pending.length === 0) return;

    let failures = 0;
    let first = true;
    for (const attachment of pending) {
      if (this.disposed) return;
      // Between files, never before the first: a single new screenshot should not wait a
      // second for a queue it is alone in.
      if (!first) await this.wait(UPLOAD_GAP_MS);
      first = false;
      const ok = await this.pushOne(deps, settings, attachment);
      failures = ok ? 0 : failures + 1;
      if (failures >= FAILURE_LIMIT) {
        logMain(`Stopped pushing attachments to the cloud after ${failures} failures in a row`);
        return;
      }
    }
  }

  /** Push one attachment's bytes. Resolves true when the cloud took them. */
  private async pushOne(
    deps: CloudAttachmentUploaderDeps,
    settings: CloudSettings,
    attachment: TaskAttachment,
  ): Promise<boolean> {
    try {
      const bytes = await deps.readBytes(attachment);
      // Re-checked against what was actually read, not against the row: `size` is what the
      // file weighed when it was attached, and the server counts bytes rather than trusting
      // a header. Spending the request to be told so would be spending it to learn nothing.
      if (bytes.byteLength === 0 || bytes.byteLength > CLOUD_BLOB_MAX_BYTES) {
        this.refused.add(attachment.id);
        return false;
      }

      const token = await deps.getAccessToken();
      if (!token) throw new Error('Not signed in to vipper.iam.');

      const url = new URL(
        `${settings.baseUrl.replace(/\/+$/, '')}/v1/attachments/${encodeURIComponent(
          attachment.id,
        )}/blob`,
      );
      url.searchParams.set(BLOB_NAME_QUERY, attachment.fileName);
      if (attachment.mimeType) url.searchParams.set(BLOB_TYPE_QUERY, attachment.mimeType);

      const fetchImpl = deps.fetchImpl ?? fetch;
      const res = await fetchImpl(url.toString(), {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          // Raw, and it has to stay raw: the server reads this body itself under a byte
          // counter, with no parser registered for this type. See `apps/server`'s
          // `rawBody.ts`, which says at length what a global body parser would do to it.
          'content-type': 'application/octet-stream',
        },
        body: bytes,
      });
      if (!res.ok) {
        // The one refusal that will still be true tomorrow: over the cap, or an account with
        // no room and nothing evictable. Anything else is worth trying again.
        if (res.status === 413) this.refused.add(attachment.id);
        throw new Error(`cloud attachment push failed (${res.status} ${res.statusText})`);
      }

      const body = (await res.json()) as BlobStored;
      const storedAt =
        typeof body?.storedAt === 'number' ? body.storedAt : (deps.now ?? Date.now)();
      deps.markUploaded(attachment.id, storedAt);
      deps.onUploaded?.();
      return true;
    } catch (e) {
      logMain(`Could not push the attachment ${attachment.name} to the cloud`, e);
      return false;
    }
  }

  private wait(ms: number): Promise<void> {
    const timer = this.deps?.setTimeoutImpl ?? setTimeout;
    return new Promise<void>((resolve) => {
      this.timer = timer(() => {
        this.timer = null;
        resolve();
      }, ms);
    });
  }
}

/**
 * Collect one file a browser parked in the cloud — the other direction, and a plain function
 * because there is nothing to schedule: it runs inside the `attachment:addUploaded` handler,
 * which is already a call somebody is waiting on.
 *
 * Throws rather than returning null, so `collectUploads` reports it against that file's name
 * and the other files in the same gesture still land. An expired or already-reclaimed ticket
 * is a 404 and reads as exactly that.
 */
export async function fetchUploadBytes(
  upload: UploadedAttachment,
  deps: {
    getSettings: () => CloudSettings;
    getAccessToken: () => Promise<string | null>;
    fetchImpl?: typeof fetch;
  },
): Promise<Uint8Array> {
  const settings = deps.getSettings();
  if (!settings.enabled || !settings.baseUrl.trim()) {
    throw new Error('Cloud sync is off on this desktop, so it cannot collect uploaded files.');
  }
  const token = await deps.getAccessToken();
  if (!token) throw new Error('Not signed in to vipper.iam.');

  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await fetchImpl(
    `${settings.baseUrl.replace(/\/+$/, '')}/v1/uploads/${encodeURIComponent(upload.id)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (res.status === 404) {
    throw new Error('the upload is no longer in the cloud — it expired or was already taken');
  }
  if (!res.ok) throw new Error(`the cloud refused it (${res.status} ${res.statusText})`);

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error('the cloud returned an empty file');
  return bytes;
}
