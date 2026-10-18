/**
 * The things worth a suite for {@link ingestAttachOutbox}: it turns files an agent dropped
 * in its own worktree into real attachment rows on the OWNER it is given, it tells the
 * outbox and the `userData` attachment store apart — `root` is where the bytes land,
 * `worktreePath` is only where they are read FROM — and it reads `verdicts.txt` into a
 * sign-off comment instead of attaching it, replacing whatever a previous ingest left.
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

interface Comment {
  projectId: string;
  taskId: string;
  body: string;
}

function fakeStore(): Store & { attachments: TaskAttachment[]; comments: Comment[] } {
  const attachments: TaskAttachment[] = [];
  const comments: Comment[] = [];
  let nextId = 1;
  const store = {
    attachments,
    comments,
    attachmentsForTask: (taskId: string) => attachments.filter((a) => a.taskId === taskId),
    addAttachment: (input: Omit<TaskAttachment, 'id' | 'createdAt'>) => {
      const row: TaskAttachment = { ...input, id: `a${nextId++}`, createdAt: Date.now() };
      attachments.push(row);
      return row;
    },
    deleteAttachment: (id: string) => {
      const index = attachments.findIndex((a) => a.id === id);
      if (index === -1) return undefined;
      return attachments.splice(index, 1)[0];
    },
    addComment: (projectId: string, taskId: string, body: string) => {
      comments.push({ projectId, taskId, body });
      return undefined;
    },
  } as unknown as Store & { attachments: TaskAttachment[]; comments: Comment[] };
  return store;
}

const outboxDir = (worktree: string) => join(worktree, '.vipper', 'attach');
const options = { projectId: 'p1', stepTitle: 'Screenshot the board' };

describe('ingestAttachOutbox', () => {
  it('does nothing when the worktree never created an outbox', async () => {
    const store = fakeStore();
    await expect(
      ingestAttachOutbox(store, root, 'card-1', worktreePath, options),
    ).resolves.toBeUndefined();
    expect(store.attachments).toEqual([]);
  });

  it('attaches every file dropped in the outbox to the OWNER id, and removes it from the worktree', async () => {
    const store = fakeStore();
    await mkdir(outboxDir(worktreePath), { recursive: true });
    await writeFile(join(outboxDir(worktreePath), 'board.png'), 'bytes-1');
    await writeFile(join(outboxDir(worktreePath), 'board-mockup.png'), 'bytes-2');

    await ingestAttachOutbox(store, root, 'card-1', worktreePath, options);

    expect(store.attachments.map((a) => a.fileName).sort()).toEqual([
      'board-mockup.png',
      'board.png',
    ]);
    // The owner, not whatever step's worktree this outbox belonged to.
    expect(store.attachments.every((a) => a.taskId === 'card-1')).toBe(true);
    await expect(readdir(outboxDir(worktreePath))).resolves.toEqual([]);
  });

  it('leaves a file that failed to attach in place and logs it rather than throwing', async () => {
    const store = fakeStore();
    // A directory is the easiest way to make `addAttachments` refuse an entry — it fails
    // `info.isFile()` the same way a locked or vanished file would.
    await mkdir(join(outboxDir(worktreePath), 'not-a-file'), { recursive: true });

    await expect(
      ingestAttachOutbox(store, root, 'card-1', worktreePath, options),
    ).resolves.toBeUndefined();

    expect(store.attachments).toEqual([]);
    await expect(readdir(outboxDir(worktreePath))).resolves.toEqual(['not-a-file']);
  });

  it('keeps what landed when one of several files fails', async () => {
    const store = fakeStore();
    await mkdir(outboxDir(worktreePath), { recursive: true });
    await writeFile(join(outboxDir(worktreePath), 'good.png'), 'ok');
    await mkdir(join(outboxDir(worktreePath), 'bad-dir'), { recursive: true });

    await ingestAttachOutbox(store, root, 'card-1', worktreePath, options);

    expect(store.attachments.map((a) => a.fileName)).toEqual(['good.png']);
    await expect(readdir(outboxDir(worktreePath))).resolves.toEqual(['bad-dir']);
  });

  describe('verdicts.txt', () => {
    it('is skipped as an attachment, and posts a sign-off comment on the owner', async () => {
      const store = fakeStore();
      await mkdir(outboxDir(worktreePath), { recursive: true });
      await writeFile(join(outboxDir(worktreePath), 'board-light.png'), 'bytes');
      await writeFile(
        join(outboxDir(worktreePath), 'verdicts.txt'),
        'board-light: mismatch - header colour drifted',
      );

      await ingestAttachOutbox(store, root, 'card-1', worktreePath, options);

      expect(store.attachments.map((a) => a.fileName)).toEqual(['board-light.png']);
      expect(store.comments).toHaveLength(1);
      expect(store.comments[0]).toMatchObject({ projectId: 'p1', taskId: 'card-1' });
      expect(store.comments[0].body).toContain('Screenshot the board');
      expect(store.comments[0].body).toContain('board-light: header colour drifted');
      await expect(readdir(outboxDir(worktreePath))).resolves.toEqual([]);
    });

    it('posts no comment at all when nothing dropped a verdicts file', async () => {
      const store = fakeStore();
      await mkdir(outboxDir(worktreePath), { recursive: true });
      await writeFile(join(outboxDir(worktreePath), 'board-light.png'), 'bytes');

      await ingestAttachOutbox(store, root, 'card-1', worktreePath, options);

      expect(store.comments).toEqual([]);
    });
  });

  describe('replacing the previous set', () => {
    it('removes a prior attachment sharing an incoming name instead of suffixing the new one', async () => {
      const store = fakeStore();
      store.addAttachment({
        taskId: 'card-1',
        name: 'board-light.png',
        fileName: 'board-light.png',
        mimeType: 'image/png',
        size: 1,
      });
      await mkdir(outboxDir(worktreePath), { recursive: true });
      await writeFile(join(outboxDir(worktreePath), 'board-light.png'), 'fresh-bytes');

      await ingestAttachOutbox(store, root, 'card-1', worktreePath, options);

      expect(store.attachments).toHaveLength(1);
      expect(store.attachments[0].name).toBe('board-light.png');
    });

    it("removes a screen named in the verdicts' manifest even when this run no longer produced it", async () => {
      const store = fakeStore();
      store.addAttachment({
        taskId: 'card-1',
        name: 'board-dark.png',
        fileName: 'board-dark.png',
        mimeType: 'image/png',
        size: 1,
      });
      await mkdir(outboxDir(worktreePath), { recursive: true });
      await writeFile(join(outboxDir(worktreePath), 'board-light.png'), 'bytes');
      // This run only screenshots board-light, but its verdicts still name board-dark —
      // the stale shot from a previous run must not linger on the card.
      await writeFile(
        join(outboxDir(worktreePath), 'verdicts.txt'),
        'board-light: ok\nboard-dark: ok',
      );

      await ingestAttachOutbox(store, root, 'card-1', worktreePath, options);

      expect(store.attachments.map((a) => a.name)).toEqual(['board-light.png']);
    });

    it('never touches an attachment that belongs to a different task', async () => {
      const store = fakeStore();
      store.addAttachment({
        taskId: 'step-1',
        name: 'board-light.png',
        fileName: 'board-light.png',
        mimeType: 'image/png',
        size: 1,
      });
      await mkdir(outboxDir(worktreePath), { recursive: true });
      await writeFile(join(outboxDir(worktreePath), 'board-light.png'), 'bytes');

      await ingestAttachOutbox(store, root, 'card-1', worktreePath, options);

      expect(store.attachments.filter((a) => a.taskId === 'step-1')).toHaveLength(1);
      expect(store.attachments.filter((a) => a.taskId === 'card-1')).toHaveLength(1);
    });
  });
});
