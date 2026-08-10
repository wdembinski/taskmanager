/**
 * The path arithmetic, held to two rules: what a suffix means, and the promise that a
 * name cannot leave its task's directory.
 *
 * The second is the one worth a test file. Every caller today passes a name the store
 * sanitized, so the escape cases below are unreachable through the app as it stands —
 * which is exactly why they are pinned here: the day a later phase builds a path out of
 * something a human typed, this test is what says whether that was safe.
 *
 * `sep`/`join` rather than literal `\` or `/`: this runs on Windows and on Linux CI, and a
 * hard-coded separator would make the test assert the platform instead of the rule.
 */
import { describe, expect, it } from 'vitest';
import { join, sep } from 'node:path';
import {
  attachmentDir,
  attachmentFile,
  attachmentsRoot,
  mimeForExtension,
} from './attachmentPaths';

const ROOT = join('C:', 'profile');
const TASK = '11111111-2222-3333-4444-555555555555';

describe('attachmentsRoot / attachmentDir / attachmentFile', () => {
  it('nests root → attachments → task → file', () => {
    expect(attachmentsRoot(ROOT)).toBe(join(ROOT, 'attachments'));
    expect(attachmentDir(ROOT, TASK)).toBe(join(ROOT, 'attachments', TASK));
    expect(attachmentFile(ROOT, TASK, 'shot.png')).toBe(
      join(ROOT, 'attachments', TASK, 'shot.png'),
    );
  });

  it('leaves a name the store already produced exactly as it is', () => {
    // Idempotence is what lets the module sanitize defensively without changing any
    // honest path — a dedupe suffix, a dotfile and a long stem all survive the round trip.
    for (const name of ['shot-2.png', '.gitignore', 'a'.repeat(60) + '.png', '_con.txt']) {
      expect(attachmentFile(ROOT, TASK, name)).toBe(join(attachmentDir(ROOT, TASK), name));
    }
  });

  it('keeps a name inside its task directory whatever it says', () => {
    const dir = attachmentDir(ROOT, TASK);
    const escapes = [
      '..',
      '../..',
      `..${sep}..${sep}evil.exe`,
      '../../../Windows/System32/calc.exe',
      '..\\..\\Windows\\win.ini',
      'C:\\Windows\\win.ini',
      '/etc/passwd',
      'sub/dir/shot.png',
      '',
      '.',
    ];
    for (const name of escapes) {
      const path = attachmentFile(ROOT, TASK, name);
      expect(path.startsWith(dir + sep), `${name} escaped to ${path}`).toBe(true);
      // One segment past the directory, always: nothing nested, nothing above.
      expect(path.slice(dir.length + 1)).not.toContain(sep);
    }
  });

  it('keeps a task id inside the attachments root, too', () => {
    const root = attachmentsRoot(ROOT);
    for (const id of ['..', `..${sep}..`, '/etc', '']) {
      const dir = attachmentDir(ROOT, id);
      expect(dir.startsWith(root + sep), `${id} escaped to ${dir}`).toBe(true);
      expect(dir.slice(root.length + 1)).not.toContain(sep);
    }
  });
});

describe('mimeForExtension', () => {
  it('maps the types the pane previews', () => {
    expect(mimeForExtension('shot.png')).toBe('image/png');
    expect(mimeForExtension('photo.jpg')).toBe('image/jpeg');
    expect(mimeForExtension('photo.jpeg')).toBe('image/jpeg');
    expect(mimeForExtension('anim.gif')).toBe('image/gif');
    expect(mimeForExtension('icon.svg')).toBe('image/svg+xml');
  });

  it('maps the documents and text a ticket carries', () => {
    expect(mimeForExtension('spec.pdf')).toBe('application/pdf');
    expect(mimeForExtension('rows.csv')).toBe('text/csv');
    expect(mimeForExtension('trace.log')).toBe('text/plain');
    expect(mimeForExtension('payload.json')).toBe('application/json');
    expect(mimeForExtension('capture.mp4')).toBe('video/mp4');
  });

  it('ignores case in the suffix', () => {
    expect(mimeForExtension('SHOT.PNG')).toBe('image/png');
    expect(mimeForExtension('Report.PdF')).toBe('application/pdf');
  });

  it('reads only the last suffix', () => {
    expect(mimeForExtension('archive.tar.gz')).toBe(null);
    expect(mimeForExtension('report.pdf.png')).toBe('image/png');
  });

  it('answers null for an unknown extension', () => {
    expect(mimeForExtension('data.qqq')).toBe(null);
    expect(mimeForExtension('notes.')).toBe(null);
  });

  it('answers null when there is no extension at all', () => {
    expect(mimeForExtension('LICENSE')).toBe(null);
    expect(mimeForExtension('')).toBe(null);
    // A leading dot is a dotfile, not a suffix — the same rule attachmentName splits by.
    expect(mimeForExtension('.gitignore')).toBe(null);
  });

  it('looks at the file, not the directory it came from', () => {
    expect(mimeForExtension(join('C:', 'notes.png', 'LICENSE'))).toBe(null);
    expect(mimeForExtension('/home/me/pics/shot.png')).toBe('image/png');
  });
});
