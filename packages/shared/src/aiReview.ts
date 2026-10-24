/**
 * F16 adds an AI reviewer: a headless Claude session reads a review subject's diff in a
 * read-only worktree at its head and answers with structured findings, which land in the F15
 * workspace as AI-marked drafts the human accepts, edits or dismisses
 * (`docs/plan/feature-roadmap/F16-ai-reviewer.md`). This module is the contract every later
 * F16 card builds on — the finding and output shapes, a review's record, and its caps.
 *
 * **Every relayed answer must fit under `RESULTS_BYTES_LIMIT`.** That limit lives in
 * `apps/client/src/main/cloudResults.ts` and these caps are checked against it by
 * `apps/client/src/main/review/caps.test.ts` (not imported here, since this package has no
 * dependency on `apps/client`).
 */

import type { DiffSide } from './review';

/** A subject with more changed lines than this is refused rather than reviewed. */
export const AI_REVIEW_MAX_CHANGED_LINES = 4000;
/** A subject touching more files than this is refused rather than reviewed. */
export const AI_REVIEW_MAX_FILES = 150;
/** At most this many findings are kept from one review; the rest are cut by severity. */
export const AI_REVIEW_MAX_FINDINGS = 50;
/** The raw `resultText` kept for debugging is capped at this many bytes. */
export const AI_REVIEW_RESULT_MAX_BYTES = 200_000;

/** Every finding severity, most severe first — the order findings past the cap are cut in. */
export const AI_FINDING_SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const;
/** How much a finding matters, from `blocker` down to `nit`. */
export type AiFindingSeverity = (typeof AI_FINDING_SEVERITIES)[number];

/** One thing the reviewer found, anchored to a line range on one side of one file. */
export interface AiFinding {
  path: string;
  side: DiffSide;
  startLine: number;
  endLine: number;
  severity: AiFindingSeverity;
  category?: string;
  title: string;
  body: string;
  /** Full replacement text for `startLine..endLine` on the NEW side. */
  suggestion?: string;
}

/** The reviewer's overall call on the subject. */
export type AiReviewVerdict = 'approve' | 'comment' | 'request-changes';

/** What the reviewer answers with. `verdict` is recorded and shown; F17 acts on it, F16 never does. */
export interface AiReviewOutput {
  summary: string;
  verdict: AiReviewVerdict;
  findings: AiFinding[];
}

/**
 * Where a review is in its life. The parked statuses mirror the gate that stopped it — the
 * gate is the only memory, so a limit or sign-in stop is parked there, never just recorded.
 */
export type AiReviewStatus =
  'queued' | 'running' | 'parked-limit' | 'parked-signin' | 'failed' | 'done' | 'cancelled';

/** Who asked for a review: a human's click, or automation (F17). */
export type AiReviewRequester = 'human' | 'automation';

/** A review's token usage — the same shape as a `result` event's `usage`. */
export interface AiReviewTokens {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/** One AI review of one subject at one head. `droppedCount` counts findings on unknown paths. */
export interface AiReview {
  id: string;
  subjectId: string;
  diffId: string;
  headSha: string;
  status: AiReviewStatus;
  parkReason: string | null;
  model: string;
  startedAt: number | null;
  finishedAt: number | null;
  costUsd: number | null;
  tokens: AiReviewTokens | null;
  summary: string | null;
  verdict: AiReviewVerdict | null;
  findingCount: number;
  droppedCount: number;
  error: string | null;
  requestedBy: AiReviewRequester;
}

/** Where a `review_drafts` row came from. Absent on `ReviewComment` means `'human'`. */
export type ReviewDraftOrigin = 'human' | 'ai';
