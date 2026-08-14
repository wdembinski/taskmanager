/**
 * The seam where a browser's bytes become a file on this machine's disk.
 *
 * Two things are worth a suite, and the second is the reason this file exists at all:
 *
 * 1. One temp directory per upload, so two files called `shot.png` picked in one gesture
 *    both survive to `addAttachments` rather than one overwriting the other.
 * 2. **A hostile `fileName` cannot choose a path.** It is a string from another machine that
 *    reaches the desktop over the network, and the two writes it feeds are checked
 *    separately: the temp write here (which must stay inside the directory `mkdtemp` just
 *    made) and the `userData` write, which is `attachmentName`'s job and is asserted here
 *    against the name this hands it — because "the next function sanitizes it" is exactly
 *    the kind of claim that stops being true without any test failing.
 */
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachmentName } from '@shared/attachments';
import { collectUploads, uploadTempName } from './uploadedAttachments';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'uploads-test-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const bytesFor = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('uploadTempName', () => {
  it('keeps the name a human recognizes', () => {
    // Spaces, parentheses and accents all survive: this name becomes the row's `fileName`,
    // which is what the chip shows. Sanitizing it to `[A-Za-z0-9._-]` is `attachmentName`'s
    // job, one write later, and doing it here too would only lose the label.
    expect(uploadTempName('Screenshot 2026-08-03 at 11.04 (1).png')).toBe(
      'Screenshot 2026-08-03 at 11.04 (1).png',
    );
    expect(uploadTempName('café brûlé.png')).toBe('café brûlé.png');
  });

  it('strips directories from a name that tries to be a path', () => {
    expect(uploadTempName('../../evil.exe')).toBe('evil.exe');
    expect(uploadTempName('..\\..\\Windows\\System32\\evil.dll')).toBe('evil.dll');
    expect(uploadTempName('/etc/passwd')).toBe('passwd');
    expect(uploadTempName('C:\\Windows\\win.ini')).toBe('win.ini');
  });

  it('falls back for a name that is nothing but path syntax', () => {
    for (const hostile of ['..', '.', '', '/', '\\', '...']) {
      expect(uploadTempName(hostile)).toBe('file');
    }
  });

  it('drops what Windows will not open', () => {
    // `:` is an NTFS alternate data stream and the rest simply fail at open(). A name that
    // was only those characters lands on the fallback rather than on an empty string.
    expect(uploadTempName('a<b>c:d"e|f?g*h.png')).toBe('abcdefgh.png');
    expect(uploadTempName('shot.png.')).toBe('shot.png');
    expect(uploadTempName('shot.png  ')).toBe('shot.png');
    expect(uploadTempName('<>:"|?*')).toBe('file');
  });

  it('caps the length without eating the extension', () => {
    const long = `${'a'.repeat(400)}.png`;
    const capped = uploadTempName(long);
    expect(capped.length).toBeLessThanOrEqual(120);
    expect(capped.endsWith('.png')).toBe(true);
  });
});

describe('collectUploads', () => {
  it('writes each upload into a directory of its own', async () => {
    const collected = await collectUploads(
      [
        { id: 'u1', fileName: 'shot.png' },
        { id: 'u2', fileName: 'shot.png' },
      ],
      async (upload) => bytesFor(upload.id),
      { tempRoot: root },
    );

    // Same name, both intact: `addAttachments` reads the name off the path with `basename`,
    // so the names have to collide — and the directories are what makes that harmless.
    expect(collected.paths.map((p) => basename(p))).toEqual(['shot.png', 'shot.png']);
    expect(dirname(collected.paths[0])).not.toBe(dirname(collected.paths[1]));
    expect(await readFile(collected.paths[0], 'utf8')).toBe('u1');
    expect(await readFile(collected.paths[1], 'utf8')).toBe('u2');
    expect(collected.failed).toEqual([]);

    await collected.cleanup();
    expect(await readdir(root)).toEqual([]);
  });

  it('keeps a hostile fileName inside the directory it was given', async () => {
    const hostile = [
      '../../../../evil.exe',
      '..\\..\\..\\..\\evil.exe',
      '/etc/cron.d/evil',
      'C:\\Windows\\System32\\evil.dll',
      '..',
    ];
    const collected = await collectUploads(
      hostile.map((fileName, i) => ({ id: `u${i}`, fileName })),
      async () => bytesFor('x'),
      { tempRoot: root },
    );

    expect(collected.failed).toEqual([]);
    expect(collected.paths).toHaveLength(hostile.length);
    for (const path of collected.paths) {
      // Inside the root, and exactly one directory deep — no `..` survived to walk out of it.
      const step = relative(resolve(root), resolve(path));
      expect(step.startsWith('..')).toBe(false);
      expect(step.split(sep)).toHaveLength(2);
      // A file, not a directory: `..` naming the temp directory itself would have been the
      // interesting failure here.
      expect((await stat(path)).isFile()).toBe(true);
    }

    // And the boundary the profile actually depends on: whatever name this produced,
    // `attachmentName` — which is what `addAttachments` runs before writing under
    // `userData` — reduces it to one segment of the narrow character class.
    for (const path of collected.paths) {
      const name = attachmentName(basename(path), []);
      expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(name.includes('..')).toBe(false);
    }

    await collected.cleanup();
  });

  it('reports the ones that never arrived and keeps the rest', async () => {
    const collected = await collectUploads(
      [
        { id: 'good', fileName: 'a.png' },
        { id: 'gone', fileName: 'b.png' },
        { id: 'also-good', fileName: 'c.png' },
      ],
      async (upload) => {
        if (upload.id === 'gone') throw new Error('the upload expired');
        return bytesFor(upload.id);
      },
      { tempRoot: root },
    );

    // Four of five, not none of five: the contract `addAttachments` already has.
    expect(collected.paths.map((p) => basename(p))).toEqual(['a.png', 'c.png']);
    expect(collected.failed).toEqual([{ path: 'b.png', reason: 'the upload expired' }]);
    await collected.cleanup();
  });

  it('sweeps its temp directories even when nothing landed', async () => {
    const collected = await collectUploads(
      [{ id: 'u1', fileName: 'a.png' }],
      async () => {
        throw new Error('nope');
      },
      { tempRoot: root },
    );
    expect(collected.paths).toEqual([]);
    await collected.cleanup();
    expect(await readdir(root)).toEqual([]);
  });
});
