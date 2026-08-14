/**
 * The desktop's two halves of the attachment byte channel, driven by a mocked `fetch` — the
 * same shape `cloudEventForwarder.test.ts` uses, and for the same reason: the module imports
 * no Electron and takes every dependency, so the whole thing runs here.
 *
 * What is worth pinning is the arithmetic of the gates rather than the HTTP: which rows are
 * pushed at all, that the cloud being off costs nothing, that a stamp is only written when
 * the cloud actually took the bytes, and that the one permanent refusal (`413`) is not asked
 * again — because every one of those is a decision that would otherwise be re-litigated by
 * whoever next reads the file.
 */
import { describe, expect, it, vi } from 'vitest';
import { CLOUD_BLOB_MAX_BYTES, type TaskAttachment } from '@shared/attachments';
import type { CloudSettings } from '@shared/settings';
import {
  CloudAttachmentUploader,
  fetchUploadBytes,
  qualifiesForCloud,
} from './cloudAttachmentUploader';

const settings = (over: Partial<CloudSettings> = {}): CloudSettings =>
  ({ enabled: true, baseUrl: 'https://api.example.test', ...over }) as CloudSettings;

const attachment = (over: Partial<TaskAttachment> = {}): TaskAttachment => ({
  id: 'a1',
  taskId: 't1',
  name: 'shot.png',
  fileName: 'shot.png',
  mimeType: 'image/png',
  size: 1024,
  createdAt: 1,
  cloudBlobAt: null,
  ...over,
});

/** A response object with just the surface these two call. */
const ok = (body: unknown): Response =>
  ({ ok: true, status: 200, statusText: 'OK', json: async () => body }) as Response;
const fail = (status: number): Response =>
  ({ ok: false, status, statusText: 'nope', json: async () => ({}) }) as Response;

interface Harness {
  uploader: CloudAttachmentUploader;
  fetchImpl: ReturnType<typeof vi.fn>;
  marked: Array<[string, number | null]>;
  rows: TaskAttachment[];
  /** Let the fire-and-forget pass run to completion. */
  settle: () => Promise<void>;
}

function makeUploader(
  rows: TaskAttachment[],
  over: {
    fetchImpl?: ReturnType<typeof vi.fn>;
    settings?: CloudSettings;
    readBytes?: (a: TaskAttachment) => Promise<Uint8Array>;
    token?: string | null;
  } = {},
): Harness {
  const fetchImpl = over.fetchImpl ?? vi.fn(async () => ok({ storedAt: 555, size: 4 }));
  const marked: Array<[string, number | null]> = [];
  const uploader = new CloudAttachmentUploader();
  uploader.configure({
    getSettings: () => over.settings ?? settings(),
    getAccessToken: async () => (over.token === undefined ? 'token' : over.token),
    listAttachments: () => rows,
    readBytes: over.readBytes ?? (async () => new Uint8Array([1, 2, 3, 4])),
    markUploaded: (id, at) => {
      marked.push([id, at]);
      const row = rows.find((r) => r.id === id);
      // The store would; this is what makes a second pass skip what the first one pushed.
      if (row) row.cloudBlobAt = at;
    },
    fetchImpl: fetchImpl as unknown as typeof fetch,
    // Never actually waits: the gap between files is real behaviour but nothing to sit
    // through, and a test that slept a second per row would be a test nobody runs.
    setTimeoutImpl: ((cb: () => void) => {
      cb();
      return 0;
    }) as unknown as typeof setTimeout,
  });
  return {
    uploader,
    fetchImpl,
    marked,
    rows,
    settle: async () => {
      // Several microtask turns: one pass is read → token → fetch → json → mark, per row.
      for (let i = 0; i < 40; i += 1) await Promise.resolve();
    },
  };
}

describe('qualifiesForCloud', () => {
  it('takes an image that is not up there yet', () => {
    expect(qualifiesForCloud(attachment())).toBe(true);
  });

  it('skips one that has already been pushed', () => {
    expect(qualifiesForCloud(attachment({ cloudBlobAt: 123 }))).toBe(false);
  });

  it('skips anything that is not an image', () => {
    // Not a taste call: the whole preview story on the web is `<img src>`, so a PDF up there
    // is a shared quota spent on something no browser will render.
    expect(qualifiesForCloud(attachment({ mimeType: 'application/pdf' }))).toBe(false);
    expect(qualifiesForCloud(attachment({ mimeType: null }))).toBe(false);
  });

  it('skips one over the cloud cap, which is far below the local one', () => {
    expect(qualifiesForCloud(attachment({ size: CLOUD_BLOB_MAX_BYTES + 1 }))).toBe(false);
    expect(qualifiesForCloud(attachment({ size: CLOUD_BLOB_MAX_BYTES }))).toBe(true);
    expect(qualifiesForCloud(attachment({ size: 0 }))).toBe(false);
  });
});

describe('CloudAttachmentUploader', () => {
  it('pushes a qualifying attachment and records when the cloud took it', async () => {
    const h = makeUploader([attachment()]);
    h.uploader.scan();
    await h.settle();

    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/attachments/a1/blob');
    expect(url).toContain('name=shot.png');
    expect(url).toContain('type=image%2Fpng');
    expect(init.method).toBe('PUT');
    // Raw bytes, not JSON: the server reads this body itself under a byte counter.
    expect((init.headers as Record<string, string>)['content-type']).toBe(
      'application/octet-stream',
    );
    // The SERVER's timestamp, not ours — `storedAt` is when the bytes actually landed.
    expect(h.marked).toEqual([['a1', 555]]);
  });

  it('makes no request at all while cloud sync is off', async () => {
    const h = makeUploader([attachment()], { settings: settings({ enabled: false }) });
    h.uploader.scan();
    await h.settle();
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.marked).toEqual([]);
  });

  it('skips the rows that do not qualify', async () => {
    const h = makeUploader([
      attachment({ id: 'pdf', mimeType: 'application/pdf' }),
      attachment({ id: 'done', cloudBlobAt: 9 }),
      attachment({ id: 'big', size: CLOUD_BLOB_MAX_BYTES + 1 }),
      attachment({ id: 'yes' }),
    ]);
    h.uploader.scan();
    await h.settle();

    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(h.marked).toEqual([['yes', 555]]);
  });

  it('leaves a failed push unstamped, so the next scan tries again', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fail(503))
      .mockResolvedValue(ok({ storedAt: 777, size: 4 }));
    const h = makeUploader([attachment()], { fetchImpl });

    h.uploader.scan();
    await h.settle();
    expect(h.marked).toEqual([]);

    h.uploader.scan();
    await h.settle();
    expect(h.marked).toEqual([['a1', 777]]);
  });

  it('never asks again after a 413', async () => {
    // The one refusal that will still be true tomorrow: over the cap, or an account with no
    // room and nothing evictable. Everything else is worth retrying.
    const fetchImpl = vi.fn(async () => fail(413));
    const h = makeUploader([attachment()], { fetchImpl });

    h.uploader.scan();
    await h.settle();
    h.uploader.scan();
    await h.settle();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(h.marked).toEqual([]);
  });

  it('gives up on a pass after three failures in a row', async () => {
    // An offline desktop spends three requests on a scan, not one per attachment it owns.
    const fetchImpl = vi.fn(async () => fail(500));
    const rows = Array.from({ length: 10 }, (_, i) => attachment({ id: `a${i}` }));
    const h = makeUploader(rows, { fetchImpl });

    h.uploader.scan();
    await h.settle();

    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not push a file it cannot read', async () => {
    const h = makeUploader([attachment()], {
      readBytes: async () => {
        throw new Error('ENOENT');
      },
    });
    h.uploader.scan();
    await h.settle();
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.marked).toEqual([]);
  });

  it('does nothing once disposed', async () => {
    const h = makeUploader([attachment()]);
    h.uploader.dispose();
    h.uploader.scan();
    await h.settle();
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });
});

describe('fetchUploadBytes', () => {
  const deps = (fetchImpl: ReturnType<typeof vi.fn>, over: Partial<CloudSettings> = {}) => ({
    getSettings: () => settings(over),
    getAccessToken: async () => 'token',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

  it('fetches one parked upload by id', async () => {
    const bytes = new Uint8Array([7, 8, 9]);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer,
    }));
    const got = await fetchUploadBytes({ id: 'u1', fileName: 'a.png' }, deps(fetchImpl));

    expect(Array.from(got)).toEqual([7, 8, 9]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.test/v1/uploads/u1');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer token');
  });

  it('says so plainly when the ticket is gone', async () => {
    // A 404 here is an expired or already-reclaimed ticket, which is a sentence a human can
    // act on ("pick it again") rather than a status code.
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404, statusText: 'Not Found' }));
    await expect(
      fetchUploadBytes({ id: 'u1', fileName: 'a.png' }, deps(fetchImpl)),
    ).rejects.toThrow(/no longer in the cloud/);
  });

  it('refuses to try while cloud sync is off on this desktop', async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchUploadBytes({ id: 'u1', fileName: 'a.png' }, deps(fetchImpl, { enabled: false })),
    ).rejects.toThrow(/Cloud sync is off/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
