/**
 * The seam where a clipboard's bytes become a file on this machine's disk — the paste-side
 * twin of `uploadedAttachments.test.ts`, covering the two things worth a suite here:
 *
 * 1. One temp directory per pasted file, the same rule and the same reason as an upload.
 * 2. The refusals: a file over `MAX_PASTE_BYTES`, and a batch over `MAX_PASTE_FILES`, both
 *    with a sentence rather than a crash, and both leaving nothing behind to sweep.
 */
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_PASTE_BYTES } from '@shared/attachments';
import { MAX_PASTE_FILES, stagePastedFiles, sweepPasteTemp } from './pastedAttachments';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'paste-test-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const bytesFor = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('stagePastedFiles', () => {
  it('writes each file into a temp directory of its own', async () => {
    const paths = await stagePastedFiles(
      [
        { fileName: 'image.png', mimeType: 'image/png', bytes: bytesFor('one') },
        { fileName: 'image.png', mimeType: 'image/png', bytes: bytesFor('two') },
      ],
      { root },
    );

    expect(paths).toHaveLength(2);
    // Same source name for both — the directory, not the name, is what keeps them apart.
    expect(dirname(paths[0])).not.toBe(dirname(paths[1]));
    expect(await readFile(paths[0], 'utf8')).toBe('one');
    expect(await readFile(paths[1], 'utf8')).toBe('two');
  });

  it("names the file with pastedFileName's stamp, not the clipboard's own name", async () => {
    const [path] = await stagePastedFiles(
      [{ fileName: 'image.png', mimeType: 'image/png', bytes: bytesFor('x') }],
      { root },
    );
    // Chromium calls every clipboard bitmap "image.png"; the on-disk name must not be that.
    expect(basename(path)).not.toBe('image.png');
    expect(basename(path)).toMatch(/^pasted-\d{8}-\d{6}\.png$/);
  });

  it('runs the name through the same sanitizer an upload uses', async () => {
    // No MIME type and no extension on the original name: `pastedFileName` falls back to
    // `.bin`, and whatever comes out still has to survive `uploadTempName`.
    const [path] = await stagePastedFiles(
      [{ fileName: 'clipboard', mimeType: null, bytes: bytesFor('x') }],
      { root },
    );
    expect(basename(path)).toMatch(/^pasted-\d{8}-\d{6}\.bin$/);
  });

  it('creates the root when it does not exist yet', async () => {
    const freshRoot = join(root, 'not-there-yet');
    const [path] = await stagePastedFiles(
      [{ fileName: 'a.png', mimeType: 'image/png', bytes: bytesFor('x') }],
      { root: freshRoot },
    );
    expect(await readFile(path, 'utf8')).toBe('x');
  });

  it('refuses a file over MAX_PASTE_BYTES and leaves nothing written', async () => {
    const tooBig = new Uint8Array(MAX_PASTE_BYTES + 1);
    await expect(
      stagePastedFiles([{ fileName: 'huge.png', mimeType: 'image/png', bytes: tooBig }], {
        root,
      }),
    ).rejects.toThrow(/huge\.png.*larger than 25 MB/);
    expect(await readdir(root)).toEqual([]);
  });

  it('cleans up files already written when a later one in the batch is refused', async () => {
    const tooBig = new Uint8Array(MAX_PASTE_BYTES + 1);
    await expect(
      stagePastedFiles(
        [
          { fileName: 'a.png', mimeType: 'image/png', bytes: bytesFor('ok') },
          { fileName: 'b.png', mimeType: 'image/png', bytes: tooBig },
        ],
        { root },
      ),
    ).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });

  it('refuses a batch over MAX_PASTE_FILES before writing anything', async () => {
    const files = Array.from({ length: MAX_PASTE_FILES + 1 }, (_, i) => ({
      fileName: `${i}.png`,
      mimeType: 'image/png',
      bytes: bytesFor('x'),
    }));
    await expect(stagePastedFiles(files, { root })).rejects.toThrow(
      `Paste at most ${MAX_PASTE_FILES} files at a time.`,
    );
    expect(await readdir(root)).toEqual([]);
  });
});

describe('sweepPasteTemp', () => {
  it('removes the whole root, staged files and all', async () => {
    await stagePastedFiles([{ fileName: 'a.png', mimeType: 'image/png', bytes: bytesFor('x') }], {
      root,
    });
    await sweepPasteTemp(root);
    await expect(stat(root)).rejects.toThrow();
  });

  it('does not throw when the root was never created', async () => {
    await expect(sweepPasteTemp(join(root, 'never-existed'))).resolves.toBeUndefined();
  });
});
