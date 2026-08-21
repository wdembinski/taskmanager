/**
 * The rules `attachFiles.ts` cannot get wrong without a paste silently breaking:
 *
 * - a text-only paste must read as NO files, or every ordinary paste into a description
 *   would be swallowed;
 * - the host branch is the same one/only test `attachFilesToTask` needs — whichever of
 *   `attachFiles` / `pathForFile` the fake transport offers is the one path taken; and
 * - a file that already has a path on disk must never be read into memory, since that is
 *   the whole reason `attachment:add` takes paths rather than bytes.
 *
 * No jsdom here (see `AttachmentStrip.test.ts`), so a paste's `DataTransfer` is faked as a
 * plain object carrying just the one property `clipboardFiles` reads — the same technique
 * `isFileDrag`'s and `isChainLinkDrag`'s tests fake `types` with.
 */
import { describe, expect, it, vi } from 'vitest';
import type { PastedAttachment, TaskAttachment } from '@tm/shared/attachments';
import type { Transport } from './transport';
import { attachFilesToTask, clipboardFiles } from './attachFiles';

function fakeDataTransfer(files: File[]): DataTransfer {
  return { files } as unknown as DataTransfer;
}

function file(name: string, bytes: number[] = [1, 2, 3], type = 'image/png'): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

function attachment(id: string, taskId: string, name: string): TaskAttachment {
  return { id, taskId, name, fileName: name, mimeType: null, size: 3, createdAt: 0 };
}

describe('clipboardFiles', () => {
  it('is empty for a text-only paste, so ordinary typing is left alone', () => {
    expect(clipboardFiles(fakeDataTransfer([]))).toEqual([]);
  });

  it('is empty when there is no clipboard data at all', () => {
    expect(clipboardFiles(null)).toEqual([]);
  });

  it('reads whatever files a paste carried, in order', () => {
    const a = file('a.png');
    const b = file('b.png');
    expect(clipboardFiles(fakeDataTransfer([a, b]))).toEqual([a, b]);
  });
});

describe('attachFilesToTask', () => {
  it('does nothing for an empty file list', async () => {
    const invoke = vi.fn();
    const transport = { invoke, pathForFile: vi.fn() } as unknown as Transport;
    expect(await attachFilesToTask(transport, 't1', [])).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('takes the browser branch whenever attachFiles exists, bytes and all', async () => {
    const attachFiles = vi.fn(async () => [attachment('a1', 't1', 'shot.png')]);
    const invoke = vi.fn();
    const pathForFile = vi.fn();
    const transport = { invoke, pathForFile, attachFiles } as unknown as Transport;
    const f = file('shot.png');

    const result = await attachFilesToTask(transport, 't1', [f]);

    expect(attachFiles).toHaveBeenCalledWith('t1', [f]);
    expect(result).toEqual([attachment('a1', 't1', 'shot.png')]);
    // The desktop route is not touched at all when the browser one is taken.
    expect(pathForFile).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('takes the desktop (path) branch when attachFiles is absent', async () => {
    const f = file('shot.png');
    const pathForFile = vi.fn(() => 'C:\\pics\\shot.png');
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'attachment:add') return [attachment('a1', 't1', 'shot.png')];
      throw new Error(`unexpected channel ${channel}`);
    });
    const transport = { invoke, pathForFile } as unknown as Transport;

    const result = await attachFilesToTask(transport, 't1', [f]);

    expect(pathForFile).toHaveBeenCalledWith(f);
    expect(invoke).toHaveBeenCalledWith('attachment:add', 't1', ['C:\\pics\\shot.png']);
    expect(result).toEqual([attachment('a1', 't1', 'shot.png')]);
  });

  it('never reads a path-backed file into memory', async () => {
    const f = file('shot.png');
    const readBytes = vi.spyOn(f, 'arrayBuffer');
    const pathForFile = vi.fn(() => 'C:\\pics\\shot.png');
    const invoke = vi.fn(async () => [attachment('a1', 't1', 'shot.png')]);
    const transport = { invoke, pathForFile } as unknown as Transport;

    await attachFilesToTask(transport, 't1', [f]);

    expect(readBytes).not.toHaveBeenCalled();
  });

  it('stages a pathless file, then makes one attachment:add call with the staged path', async () => {
    const f = file('pasted.png', [9, 9, 9], 'image/png');
    const pathForFile = vi.fn(() => '');
    const stagePasted = vi.fn(async (files: PastedAttachment[]) => {
      expect(files).toHaveLength(1);
      expect(files[0].fileName).toBe('pasted.png');
      expect(files[0].mimeType).toBe('image/png');
      expect(Array.from(files[0].bytes)).toEqual([9, 9, 9]);
      return ['/tmp/vipper-paste/pasted.png'];
    });
    const addAttachment = vi.fn(async () => [attachment('a1', 't1', 'pasted.png')]);
    const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
      if (channel === 'attachment:stagePasted') return stagePasted(args[0] as PastedAttachment[]);
      if (channel === 'attachment:add') return addAttachment();
      throw new Error(`unexpected channel ${channel}`);
    });
    const transport = { invoke, pathForFile } as unknown as Transport;

    const result = await attachFilesToTask(transport, 't1', [f]);

    expect(stagePasted).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('attachment:add', 't1', ['/tmp/vipper-paste/pasted.png']);
    // One `attachment:add` call, not one per file — the stage and the add each ran once.
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result).toEqual([attachment('a1', 't1', 'pasted.png')]);
  });

  it('keeps the original order when path-backed and pathless files are mixed', async () => {
    const withPath = file('kept.png');
    const pathless1 = file('paste1.png');
    const pathless2 = file('paste2.png');
    const pathForFile = vi.fn((f: File) => (f === withPath ? 'C:\\pics\\kept.png' : ''));
    const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
      if (channel === 'attachment:stagePasted') {
        const files = args[0] as PastedAttachment[];
        return files.map((_, i) => `/tmp/staged-${i}.png`);
      }
      if (channel === 'attachment:add') return [];
      throw new Error(`unexpected channel ${channel}`);
    });
    const transport = { invoke, pathForFile } as unknown as Transport;

    await attachFilesToTask(transport, 't1', [pathless1, withPath, pathless2]);

    expect(invoke).toHaveBeenCalledWith('attachment:add', 't1', [
      '/tmp/staged-0.png',
      'C:\\pics\\kept.png',
      '/tmp/staged-1.png',
    ]);
  });
});
