/**
 * The handshake between an agent's own worktree and the OWNER card's attachment chips.
 *
 * An agent has no IPC channel to call `attachment:add` itself — it only has the
 * worktree `scheduler.ts` already told it is "the source of truth" for this run. So the
 * contract runs the other way: the agent drops files it wants attached under
 * `<worktree>/.vipper/attach/` (`scripts/ui-shots.mjs --attach` is the first producer, for
 * a step's own screenshot-vs-mockup comparison), and {@link ingestAttachOutbox} is what
 * reads that drop box once the run has settled successfully and turns it into real rows
 * under `addAttachments` — the exact same path a human's own file picker takes.
 *
 * **Attached to the OWNER, not the run.** A plan's step runs in its own worktree but the
 * shots it drops are about the card's own UI, not the step's — so they land on `ownerId`
 * (the card itself for a step, or the task's own id when it has no parent), exactly where a
 * human looking for "did the UI change" would check, rather than hidden on whichever step
 * happened to run `ui-shots.mjs` this time.
 *
 * **`verdicts.txt` is read, not attached.** An agent may drop one alongside the
 * screenshots — `@shared/visualSignOff`'s one-line-per-screen format — and this ingests it
 * into a comment on the owner card instead of a file chip, then removes it like every other
 * ingested entry.
 *
 * **A re-run replaces its own set.** `verdicts.txt`'s screen names are stable across runs
 * (the screenshot for `board-light` is always `board-light.png`), so before attaching this
 * batch, any of the owner's current attachments sharing a name with either the verdicts'
 * manifest or an incoming file is removed first. Without this, a retried or re-planned step
 * would pile up `board-light-2.png`, `board-light-3.png`, … on every run instead of showing
 * the latest shot.
 *
 * A file that failed to attach (too big, a name `attachmentName` could not resolve) is
 * left where it was and only logged, not deleted: the outbox is a step's own worktree, not
 * shared state, so there is nothing to clean up FOR — the next thing that happens to that
 * directory is the worktree itself going away.
 */
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  formatVisualSignOffComment,
  parseVisualVerdicts,
  VISUAL_VERDICTS_FILE,
  visualVerdictFileNames,
} from '@shared/visualSignOff';
import { addAttachments, deleteAttachmentFile } from './attachments';
import { logMain } from './log';
import type { Store } from './store';

/** Where a run drops files it wants attached to its own task, relative to its worktree. */
const OUTBOX_RELATIVE_DIR = ['.vipper', 'attach'];

export interface IngestAttachOutboxOptions {
  /** The owner card's project — `addComment`'s own key, separate from its task id. */
  projectId: string;
  /** The step's own title, named in the sign-off comment so a human knows which run it was. */
  stepTitle: string;
}

/**
 * Ingest whatever a settled run left in its worktree's attach outbox.
 *
 * Reads `<worktreePath>/.vipper/attach/`, hands every entry but `verdicts.txt` to
 * {@link addAttachments} under `ownerId`, and removes only the ones that landed — a failure
 * stays put, because the sentence logged for it is for a human reading logs, not a retry
 * this function will ever make itself. A missing outbox (the ordinary case: most runs
 * attach nothing) is silent.
 */
export async function ingestAttachOutbox(
  store: Store,
  root: string,
  ownerId: string,
  worktreePath: string,
  { projectId, stepTitle }: IngestAttachOutboxOptions,
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

  const hasVerdicts = entries.includes(VISUAL_VERDICTS_FILE);
  const verdicts = hasVerdicts
    ? parseVisualVerdicts(await readVerdictsFile(join(outboxDir, VISUAL_VERDICTS_FILE)))
    : [];
  const fileNames = entries.filter((name) => name !== VISUAL_VERDICTS_FILE);

  await replacePreviousSet(store, root, ownerId, [
    ...visualVerdictFileNames(verdicts),
    ...fileNames,
  ]);

  const paths = fileNames.map((name) => join(outboxDir, name));
  const { failed } = await addAttachments(store, root, ownerId, paths);
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

  if (hasVerdicts) {
    try {
      await rm(join(outboxDir, VISUAL_VERDICTS_FILE), { force: true });
    } catch (e) {
      logMain(`Could not remove the ingested verdicts file`, e);
    }
    store.addComment(projectId, ownerId, formatVisualSignOffComment(verdicts, stepTitle));
  }
}

/**
 * Remove every one of the owner's current attachments whose name is in `names` — the
 * verdicts' own manifest plus whatever is about to land — so this ingest replaces rather
 * than piles up on top of a previous one. Case-insensitive, matching `attachmentName`'s own
 * uniqueness rule.
 */
async function replacePreviousSet(
  store: Store,
  root: string,
  ownerId: string,
  names: readonly string[],
): Promise<void> {
  const toReplace = new Set(names.map((n) => n.toLowerCase()));
  if (toReplace.size === 0) return;
  for (const existing of store.attachmentsForTask(ownerId)) {
    if (!toReplace.has(existing.name.toLowerCase())) continue;
    const removed = store.deleteAttachment(existing.id);
    if (removed) await deleteAttachmentFile(root, removed);
  }
}

/** `verdicts.txt`'s bytes, or empty when it could not be read — logged, never thrown. */
async function readVerdictsFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    logMain(`Could not read the verdicts file ${path}`, e);
    return '';
  }
}
