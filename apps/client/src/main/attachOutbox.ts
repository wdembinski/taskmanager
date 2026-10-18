/**
 * The handshake between an agent's own worktree and the card's attachment chips.
 *
 * An agent has no IPC channel to call `attachment:add` itself — it only has the
 * worktree `scheduler.ts` already told it is "the source of truth" for this run. So the
 * contract runs the other way: the agent drops files it wants attached under
 * `<worktree>/.vipper/attach/` (`scripts/ui-shots.mjs --attach` is the first producer, for
 * a step's own screenshot-vs-mockup comparison), and {@link ingestAttachOutbox} is what
 * reads that drop box once the run has settled successfully and turns it into real rows
 * under `addAttachments` — the exact same path a human's own file picker takes.
 *
 * A file that failed to attach (too big, a name `attachmentName` could not resolve) is
 * left where it was and only logged, not deleted: the outbox is a step's own worktree, not
 * shared state, so there is nothing to clean up FOR — the next thing that happens to that
 * directory is the worktree itself going away.
 */
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { addAttachments } from './attachments';
import { logMain } from './log';
import type { Store } from './store';

/** Where a run drops files it wants attached to its own task, relative to its worktree. */
const OUTBOX_RELATIVE_DIR = ['.vipper', 'attach'];

/**
 * Ingest whatever a settled run left in its worktree's attach outbox.
 *
 * Reads `<worktreePath>/.vipper/attach/`, hands every entry to {@link addAttachments} under
 * `taskId`, and removes only the ones that landed — a failure stays put, because the
 * sentence logged for it is for a human reading logs, not a retry this function will ever
 * make itself. A missing outbox (the ordinary case: most runs attach nothing) is silent.
 */
export async function ingestAttachOutbox(
  store: Store,
  root: string,
  taskId: string,
  worktreePath: string,
): Promise<void> {
  const outboxDir = join(worktreePath, ...OUTBOX_RELATIVE_DIR);
  let entries: string[];
  try {
    entries = await readdir(outboxDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      logMain(`Could not read the attach outbox ${outboxDir}`, e);
    }
    return;
  }
  if (entries.length === 0) return;

  const paths = entries.map((name) => join(outboxDir, name));
  const { failed } = await addAttachments(store, root, taskId, paths);
  const failedPaths = new Set(failed.map((f) => f.path));
  for (const f of failed) {
    logMain(`Could not ingest the attach-outbox file ${f.path}: ${f.reason}`);
  }

  for (const path of paths) {
    if (failedPaths.has(path)) continue;
    try {
      await rm(path, { force: true });
    } catch (e) {
      logMain(`Could not remove the ingested attach-outbox file ${path}`, e);
    }
  }
}
