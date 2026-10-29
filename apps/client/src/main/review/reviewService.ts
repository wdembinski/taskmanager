/**
 * The desktop's answers to `review:list`, `review:add`, `review:update` and `review:delete`
 * (F6.8, `docs/plan/feature-roadmap/F6-in-app-code-review.md`) — everything a review comment
 * does once `DiffService` can locate a card's current diff.
 *
 * Three rules sit behind every method here:
 *
 *  - **An anchor is only ever validated against the diff the human is looking at RIGHT NOW.**
 *    `add` and an anchor-moving `update` both run through {@link ReviewService.anchorAt},
 *    which re-resolves the diff and refuses `stale` on a `diffId` mismatch — the same
 *    contract `DiffService.file` enforces for a read, extended to a write.
 *  - **A sent comment is history.** `update` and `delete` both refuse once `sentAt` is set;
 *    only the card itself, dying, ever removes one.
 *  - **`outdated` is never stored.** The excerpt a comment was created with is what the
 *    review message quotes; whether it still matches the code is a fact about the CURRENT
 *    diff, not the comment, so `list` recomputes it fresh on every call instead of trusting
 *    a column that would go stale the moment the agent touches the file again.
 *  - **An AI draft is the human's only once accepted.** `update` stamps the decision itself
 *    (`Date.now()`): `accept` sets `acceptedAt` and clears `dismissedAt`, `dismiss` sets
 *    `dismissedAt` and clears `acceptedAt`, `restore` clears `dismissedAt` — and a body edit
 *    on an AI draft accepts it, since editing is accepting. On a human draft a decision is a
 *    harmless no-op.
 *  - **`send` batches every sendable draft into one follow-up.** It reuses `list`'s `outdated`
 *    recompute, formats every draft {@link isSendableDraft} admits — unsent, not dismissed,
 *    and human or accepted — into one message via `formatReviewMessage`,
 *    and hands that to `chatWithAgent` — the same chat path a human types into, so a card
 *    running an approved plan has the message land on its live step rather than the card
 *    itself. Nothing is stamped `sentAt` until delivery actually succeeds.
 */
import {
  excerptFor,
  formatReviewMessage,
  isSendableDraft,
  markOutdated,
  type DiffStale,
  type ReviewAddResult,
  type ReviewAnchor,
  type ReviewComment,
  type ReviewCommentInput,
  type ReviewCommentPatch,
  type ReviewDeleteResult,
  type ReviewSendResult,
  type ReviewUpdateResult,
} from '@shared/review';
import type { ChatSendResult } from '@shared/model';
import type { Store } from '../store';
import type { DiffService } from './diffService';

export interface ReviewServiceDeps {
  store: Pick<
    Store,
    | 'getTask'
    | 'listReviewComments'
    | 'addReviewComment'
    | 'updateReviewComment'
    | 'deleteReviewComment'
    | 'markReviewSent'
  >;
  diffs: Pick<DiffService, 'filesFor' | 'summary'>;
  chat: (taskId: string, message: string) => ChatSendResult;
}

export class ReviewService {
  constructor(private readonly deps: ReviewServiceDeps) {}

  /**
   * Every draft and sent comment on `taskId`, `outdated` recomputed against the current
   * diff. A `filesFor` failure (a flaky git read on some unrelated file) answers the stored
   * comments unflagged rather than hiding them behind an error — recomputing `outdated` is
   * a bonus on top of a read, never a precondition for it.
   */
  async list(taskId: string): Promise<ReviewComment[]> {
    const comments = this.deps.store.listReviewComments(taskId);
    if (comments.length === 0) return comments;
    const paths = [...new Set(comments.map((c) => c.path))];
    let current: Awaited<ReturnType<ReviewServiceDeps['diffs']['filesFor']>>;
    try {
      current = await this.deps.diffs.filesFor(taskId, paths);
    } catch {
      return comments;
    }
    if (!current) return comments;
    return paths.reduce((acc, path) => {
      const entry = current.files.get(path);
      return entry ? markOutdated(acc, entry.file) : acc;
    }, comments);
  }

  /** Add one draft comment, anchored against `input.diffId`. `stale` when that has moved on. */
  async add(input: ReviewCommentInput): Promise<ReviewAddResult> {
    const body = input.body.trim();
    if (!body) throw new Error('A review comment needs a body.');
    const anchored = await this.anchorAt(input.taskId, input.diffId, input.path, input);
    if ('status' in anchored) return anchored;
    const comment = this.deps.store.addReviewComment({
      taskId: input.taskId,
      diffId: input.diffId,
      path: input.path,
      ...(anchored.oldPath ? { oldPath: anchored.oldPath } : {}),
      side: input.side,
      line: input.line,
      ...(input.start ? { start: input.start } : {}),
      body,
      excerpt: anchored.excerpt,
    });
    if (!comment) throw new Error('That card is no longer in the app.');
    return { status: 'ok', comment };
  }

  /**
   * Edit a draft's body, move its anchor (re-quoting `excerpt`), record a decision on an AI
   * draft, or any mix of them. Refused `sent` once the comment has gone out in a review
   * message, or `stale` when an anchor move names a `diffId` the worktree has moved on from.
   */
  async update(taskId: string, id: string, patch: ReviewCommentPatch): Promise<ReviewUpdateResult> {
    if (!this.deps.store.getTask(taskId)) throw new Error('That card is no longer in the app.');
    const existing = this.deps.store.listReviewComments(taskId).find((c) => c.id === id);
    if (!existing) throw new Error('That comment is no longer there.');
    if (existing.sentAt !== null) return { status: 'sent', sentAt: existing.sentAt };

    let anchored: { excerpt: string; oldPath?: string } | undefined;
    if (patch.anchor) {
      const result = await this.anchorAt(taskId, patch.anchor.diffId, existing.path, patch.anchor);
      if ('status' in result) return result;
      anchored = result;
    }

    const body = patch.body !== undefined ? patch.body.trim() : undefined;
    if (body !== undefined && !body) throw new Error('A review comment needs a body.');

    const stamps = existing.origin === 'ai' ? decisionStamps(patch, Date.now()) : {};
    // A decision on a human draft changes nothing; answer it without touching the row.
    if (body === undefined && !patch.anchor && Object.keys(stamps).length === 0) {
      return { status: 'ok', comment: existing };
    }

    const updated = this.deps.store.updateReviewComment(id, {
      ...(body !== undefined ? { body } : {}),
      ...stamps,
      ...(patch.anchor
        ? {
            diffId: patch.anchor.diffId,
            side: patch.anchor.side,
            line: patch.anchor.line,
            start: patch.anchor.start ?? null,
            excerpt: anchored!.excerpt,
          }
        : {}),
    });
    if (updated) return { status: 'ok', comment: updated };

    // The store's own `sentAt IS NULL` guard refused the write: `review:send` stamped this
    // comment between our read above and this call. Answer `sent` rather than the generic
    // "gone" error, since it is still there — just no longer a draft.
    const settled = this.deps.store.listReviewComments(taskId).find((c) => c.id === id);
    if (settled?.sentAt != null) return { status: 'sent', sentAt: settled.sentAt };
    throw new Error('That comment is no longer there.');
  }

  /** Forget a draft. Refused `sent` once it has gone out in a review message. */
  async delete(taskId: string, id: string): Promise<ReviewDeleteResult> {
    if (!this.deps.store.getTask(taskId)) throw new Error('That card is no longer in the app.');
    const existing = this.deps.store.listReviewComments(taskId).find((c) => c.id === id);
    if (existing?.sentAt != null) return { status: 'sent', sentAt: existing.sentAt };
    this.deps.store.deleteReviewComment(id);
    return { status: 'ok' };
  }

  /**
   * Batch every sendable draft on `taskId` into one follow-up and send it down `deps.chat` — the
   * same path a human's own chat message takes, so a card running an approved plan has the
   * message land on its live step rather than the card itself.
   *
   * Refuses `unknown-task` when the card is gone; `landed`/`conflicted`/`no-branch` when
   * `diffs.summary` cannot resolve a diff to put in the message's header; `nothing-to-send`
   * when no draft is sendable — every one has already gone out (the double-send case), or
   * all that is left are dismissed or unaccepted AI drafts; `empty-message` as a guard
   * if `formatReviewMessage` still comes back `''`; and whatever `deps.chat` itself refuses
   * with — in every refusal, nothing is stamped.
   */
  async send(taskId: string, note?: string): Promise<ReviewSendResult> {
    if (!this.deps.store.getTask(taskId)) {
      return { status: 'refused', taskId, reason: 'unknown-task' };
    }

    const listed = await this.list(taskId);

    const summary = await this.deps.diffs.summary(taskId);
    if (summary.status !== 'ok') {
      return { status: 'refused', taskId, reason: summary.status };
    }

    const drafts = this.deps.store
      .listReviewComments(taskId)
      .filter(isSendableDraft)
      .map((c) => {
        const current = listed.find((l) => l.id === c.id);
        return current ? { ...c, outdated: current.outdated } : c;
      });
    if (drafts.length === 0) {
      return { status: 'refused', taskId, reason: 'nothing-to-send' };
    }

    const message = formatReviewMessage(drafts, summary.summary, note);
    if (!message) {
      return { status: 'refused', taskId, reason: 'empty-message' };
    }

    const delivery = this.deps.chat(taskId, message);
    if (delivery.status === 'refused') return delivery;

    const stamped = this.deps.store.markReviewSent(
      taskId,
      drafts.map((c) => c.id),
      Date.now(),
    );
    return { ...delivery, comments: stamped };
  }

  /**
   * The one anchor check `add` and an anchor-moving `update` share: resolve `path`'s
   * current patch and compare `diffId` against it, exactly as `DiffService.current` does
   * for a read. A mismatch or an unresolved diff (landed/conflicted/no-branch) returns
   * `DiffStale` — `currentDiffId: ''` for the latter, since there is no diff to move to.
   * A path the current diff does not have, or one too large to have hunks, is the
   * caller's mistake rather than data to hand back, so those throw; so does an anchor that
   * does not resolve to any text in the current file.
   */
  private async anchorAt(
    taskId: string,
    diffId: string,
    path: string,
    anchor: ReviewAnchor,
  ): Promise<{ excerpt: string; oldPath?: string } | DiffStale> {
    const current = await this.deps.diffs.filesFor(taskId, [path]);
    if (!current || current.diffId !== diffId) {
      return { status: 'stale', diffId, currentDiffId: current?.diffId ?? '' };
    }
    const entry = current.files.get(path);
    if (!entry) throw new Error(`${path} is not part of this card's changes.`);
    if (entry.file.tooLarge) {
      throw new Error(`${path}'s patch is too large to anchor a comment to.`);
    }
    const excerpt = excerptFor(entry.file, anchor);
    if (excerpt === null) throw new Error(`That line is no longer part of ${path}'s diff.`);
    return { excerpt, ...(entry.oldPath ? { oldPath: entry.oldPath } : {}) };
  }
}

/**
 * The `acceptedAt`/`dismissedAt` writes an AI draft's patch implies. A body edit accepts;
 * an explicit `decision` is applied after it, so `{ body, decision: 'dismiss' }` dismisses.
 */
function decisionStamps(
  patch: ReviewCommentPatch,
  now: number,
): { acceptedAt?: number | null; dismissedAt?: number | null } {
  const stamps: { acceptedAt?: number | null; dismissedAt?: number | null } = {};
  if (patch.body !== undefined) Object.assign(stamps, { acceptedAt: now, dismissedAt: null });
  switch (patch.decision) {
    case 'accept':
      Object.assign(stamps, { acceptedAt: now, dismissedAt: null });
      break;
    case 'dismiss':
      Object.assign(stamps, { acceptedAt: null, dismissedAt: now });
      break;
    case 'restore':
      stamps.dismissedAt = null;
      break;
  }
  return stamps;
}
