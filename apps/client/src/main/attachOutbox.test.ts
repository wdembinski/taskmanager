/**
 * The two things worth a suite for {@link ingestAttachOutbox}: it turns files an agent
 * dropped in its own worktree into real attachment rows, and it tells the outbox and the
 * `userData` attachment store apart — `root` is where the bytes land, `worktreePath` is only
 * where they are read FROM.
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TaskAttachment } from '@shared/attachments';
import { ingestAttachOutbox } from './attachOutbox';
import type { Store } from './store';

let root: string;
let worktreePath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'attach-outbox-root-'));
  worktreePath = await mkdtemp(join(tmpdir(), 'attach-outbox-worktree-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(worktreePath, { recursive: true, force: true });
});

function fakeStore(): Store & { attachments: TaskAttachment[] } {
  const attachments: TaskAttachment[] = [];
  let nextId = 1;
  const store = {
    attachments,
    attachmentsForTask: (taskId: string) => attachments.filter((a) => a.taskId === taskId),
    addAttachment: (input: Omit<TaskAttachment, 'id' | 'createdAt'>) => {
      const row: TaskAttachment = { ...input, id: `a${nextId++}`, createdAt: Date.now() };
      attachments.push(row);
      return row;
    },
  } as unknown as Store & { attachments: TaskAttachment[] };
  return store;
}

const outboxDir = (worktree: string) => join(worktree, '.vipper', 'attach');

describe('ingestAttachOutbox', () => {
  it('does nothing when the worktree never created an outbox', async () => {
    const store = fakeStore();
    await expect(ingestAttachOutbox(store, root, 'task-1', worktreePath)).resolves.toBeUndefined();
    expect(store.attachments).toEqual([]);
  });

  it('attaches every file dropped in the outbox and removes it from the worktree', async () => {
    const store = fakeStore();
    await mkdir(outboxDir(worktreePath), { recursive: true });
    await writeFile(join(outboxDir(worktreePath), 'board.png'), 'bytes-1');
    await writeFile(join(outboxDir(worktreePath), 'board-mockup.png'), 'bytes-2');

    await ingestAttachOutbox(store, root, 'task-1', worktreePath);

    expect(store.attachments.map((a) => a.fileName).sort()).toEqual([
      'board-mockup.png',
      'board.png',
    ]);
    expect(store.attachments.every((a) => a.taskId === 'task-1')).toBe(true);
    await expect(readdir(outboxDir(worktreePath))).resolves.toEqual([]);
  });

  it('leaves a file that failed to attach in place and logs it rather than throwing', async () => {
    const store = fakeStore();
    // A directory is the easiest way to make `addAttachments` refuse an entry — it fails
    // `info.isFile()` the same way a locked or vanished file would.
    await mkdir(join(outboxDir(worktreePath), 'not-a-file'), { recursive: true });

    await expect(ingestAttachOutbox(store, root, 'task-1', worktreePath)).resolves.toBeUndefined();

    expect(store.attachments).toEqual([]);
    await expect(readdir(outboxDir(worktreePath))).resolves.toEqual(['not-a-file']);
  });

  it('keeps what landed when one of several files fails', async () => {
    const store = fakeStore();
    await mkdir(outboxDir(worktreePath), { recursive: true });
    await writeFile(join(outboxDir(worktreePath), 'good.png'), 'ok');
    await mkdir(join(outboxDir(worktreePath), 'bad-dir'), { recursive: true });

    await ingestAttachOutbox(store, root, 'task-1', worktreePath);

    expect(store.attachments.map((a) => a.fileName)).toEqual(['good.png']);
    await expect(readdir(outboxDir(worktreePath))).resolves.toEqual(['bad-dir']);
  });
});
