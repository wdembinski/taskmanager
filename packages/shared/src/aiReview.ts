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
 *
 * A finished run is settled by three pure functions, none of which ever throws.
 * `parseFindings` takes the reply's LAST closed ```json block and nothing else from it.
 * `validateFindings` checks that value against the diff it reviewed: a bad envelope is
 * `ok: false` (what earns the session one repair turn), while a bad finding is only dropped
 * and counted — as is one on a path the diff does not touch. A range that does not resolve in
 * the hunks becomes a file-level finding, and past `AI_REVIEW_MAX_FINDINGS` the least severe
 * are cut. `findingToDraft` maps each survivor onto a `review_drafts` row with `origin: 'ai'`.
 */

import { excerptFor } from './review';
import type { DiffFile, DiffSide, DiffSummary } from './review';

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

/** Why an AI review was refused before anything was spent. Checked in this order. */
export type AiReviewRefusalCode =
  | 'shutting-down'
  | 'unknown-subject'
  | 'no-capability'
  | 'too-large'
  | 'duplicate'
  | 'already-reviewed'
  | 'card-running'
  | 'sandbox-unsupported';

/** A refused start: no review row is created. `reason` is shown as the button's tooltip. */
export interface AiReviewRefusal {
  refused: AiReviewRefusalCode;
  reason: string;
}

/** Whether `aiReview:start`'s answer is a refusal rather than the review row it started. */
export function isAiReviewRefusal(value: AiReview | AiReviewRefusal): value is AiReviewRefusal {
  return 'refused' in value;
}

/** Where a `review_drafts` row came from. Absent on `ReviewComment` means `'human'`. */
export type ReviewDraftOrigin = 'human' | 'ai';

/** What `parseFindings` read out of a reply: the last json block's value, unchecked. */
export type ParsedFindings = { ok: true; value: unknown } | { ok: false; error: string };

const JSON_FENCE_OPEN = /^```json\s*$/i;
const FENCE_OPEN = /^```/;
const FENCE_CLOSE = /^```\s*$/;

/**
 * The value of the LAST closed ```json block in `resultText` (info string `json`, any case).
 * Bare or other-language fences are skipped whole, and a fence still open at the end is
 * ignored. An earlier block is never a fallback: a broken last block is an error.
 */
export function parseFindings(resultText: string): ParsedFindings {
  let last: string | null = null;
  let open: { json: boolean; lines: string[] } | null = null;
  for (const raw of resultText.split('\n')) {
    const text = raw.replace(/\r$/, '').trim();
    if (open === null) {
      if (FENCE_OPEN.test(text)) open = { json: JSON_FENCE_OPEN.test(text), lines: [] };
    } else if (FENCE_CLOSE.test(text)) {
      if (open.json) last = open.lines.join('\n');
      open = null;
    } else {
      open.lines.push(raw);
    }
  }
  if (last === null) return { ok: false, error: 'no ```json block in the reply' };
  try {
    return { ok: true, value: JSON.parse(last) as unknown };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `the last \`\`\`json block is not valid JSON: ${message}` };
  }
}

/** A finding that survived validation, with its path resolved against the diff. */
export interface ValidatedFinding extends AiFinding {
  /** The rename's old path, when the finding's file was renamed. */
  oldPath?: string;
  /** The range does not resolve in the hunks, so the finding is anchored to the file. */
  fileLevel: boolean;
  /** The quoted range from the hunks; `''` when `fileLevel`. */
  excerpt: string;
}

/**
 * `validateFindings`'s answer. `ok` is about the envelope only — an `ok: true` result can
 * still carry `errors` for findings it dropped. `cut` counts findings past the cap, which are
 * not counted in `dropped`.
 */
export interface FindingsValidation {
  ok: boolean;
  summary: string | null;
  verdict: AiReviewVerdict | null;
  findings: ValidatedFinding[];
  dropped: number;
  cut: number;
  errors: string[];
}

const AI_REVIEW_VERDICTS: readonly AiReviewVerdict[] = ['approve', 'comment', 'request-changes'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isLine(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function refused(error: string): FindingsValidation {
  return {
    ok: false,
    summary: null,
    verdict: null,
    findings: [],
    dropped: 0,
    cut: 0,
    errors: [error],
  };
}

/** The finding's own fields, checked — or the reason it is dropped. Extra keys are ignored. */
function checkFinding(raw: unknown): AiFinding | string {
  if (!isRecord(raw)) return 'not an object';
  const { path, side, startLine, endLine, severity, category, title, body, suggestion } = raw;
  if (!isText(path)) return 'path must be a non-empty string';
  if (side !== 'old' && side !== 'new') return "side must be 'old' or 'new'";
  if (!isLine(startLine) || !isLine(endLine)) {
    return 'startLine and endLine must be positive integers';
  }
  if (startLine > endLine) return `inverted range ${startLine}–${endLine}`;
  if (!(AI_FINDING_SEVERITIES as readonly unknown[]).includes(severity)) {
    return `unknown severity ${JSON.stringify(severity)}`;
  }
  if (!isText(title)) return 'title must be a non-empty string';
  if (!isText(body)) return 'body must be a non-empty string';
  if (category != null && typeof category !== 'string') return 'category must be a string';
  if (suggestion != null && typeof suggestion !== 'string') return 'suggestion must be a string';
  return {
    path,
    side,
    startLine,
    endLine,
    severity: severity as AiFindingSeverity,
    title,
    body,
    ...(category != null ? { category } : {}),
    ...(suggestion != null ? { suggestion } : {}),
  };
}

/**
 * Checks a parsed reply against the diff it reviewed, never throwing. A finding's `path` may
 * name a file or a rename's old path (normalised to the new one, `oldPath` carried), with any
 * leading `./` or `/` stripped; a path not in `summary` is dropped. Its range is quoted from
 * `filesByPath` (keyed by entry `path`) via `excerptFor`; when it does not resolve — or the
 * file is binary, too large, or missing from the map — the finding is kept as file-level,
 * since no file length is available to tell "outside the hunks" from "outside the file".
 */
export function validateFindings(
  output: unknown,
  summary: DiffSummary,
  filesByPath: ReadonlyMap<string, DiffFile>,
): FindingsValidation {
  try {
    if (!isRecord(output)) return refused('the reply is not a JSON object');
    if (!isText(output.summary)) return refused('summary must be a non-empty string');
    const verdict = output.verdict as AiReviewVerdict;
    if (!AI_REVIEW_VERDICTS.includes(verdict)) {
      return refused(`verdict must be one of ${AI_REVIEW_VERDICTS.join(', ')}`);
    }
    if (!Array.isArray(output.findings)) return refused('findings must be an array');

    const errors: string[] = [];
    const kept: ValidatedFinding[] = [];
    output.findings.forEach((raw, index) => {
      const checked = checkFinding(raw);
      if (typeof checked === 'string') {
        errors.push(`finding ${index}: ${checked}`);
        return;
      }
      const wanted = checked.path.replace(/^\.?\//, '');
      const entry =
        summary.files.find((f) => f.path === wanted) ??
        summary.files.find((f) => f.oldPath === wanted);
      if (!entry) {
        errors.push(`finding ${index}: unknown path ${checked.path}`);
        return;
      }
      const file = entry.binary ? undefined : filesByPath.get(entry.path);
      const { side, startLine, endLine } = checked;
      const excerpt =
        file && !file.tooLarge
          ? excerptFor(file, {
              side,
              line: endLine,
              start: startLine === endLine ? undefined : { side, line: startLine },
            })
          : null;
      kept.push({
        ...checked,
        path: entry.path,
        ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
        fileLevel: excerpt === null,
        excerpt: excerpt ?? '',
      });
    });

    let findings = kept;
    let cut = 0;
    if (kept.length > AI_REVIEW_MAX_FINDINGS) {
      const rank = (f: AiFinding) => AI_FINDING_SEVERITIES.indexOf(f.severity);
      // Array.prototype.sort is stable, so the original order holds within a rank.
      findings = [...kept].sort((a, b) => rank(a) - rank(b)).slice(0, AI_REVIEW_MAX_FINDINGS);
      cut = kept.length - findings.length;
    }
    return {
      ok: true,
      summary: output.summary,
      verdict,
      findings,
      dropped: errors.length,
      cut,
      errors,
    };
  } catch (err) {
    return refused(`validation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * What the store needs to insert one AI draft into `review_drafts` — everything but the `id`
 * and timestamps it assigns. Keyed by `subjectId`, so it is its own shape, not a
 * `ReviewComment` (which still carries `taskId`).
 */
export interface AiDraftInput {
  subjectId: string;
  diffId: string;
  path: string;
  oldPath?: string;
  side: DiffSide;
  line: number;
  start?: { side: DiffSide; line: number };
  body: string;
  excerpt: string;
  origin: 'ai';
  aiReviewId: string;
  severity: AiFindingSeverity;
  /** Kept verbatim as structured data; F18 formats it per forge. */
  suggestion: string | null;
  acceptedAt: null;
  dismissedAt: null;
  fileLevel: boolean;
}

/**
 * One validated finding as a draft row. The body is the bold title (and ` · category`), a
 * blank line, then the finding's own body. An inline range anchors on its end line with a
 * `start`; a file-level finding anchors on its start line, quotes nothing, and names the
 * range it could not anchor at the front of the body.
 */
export function findingToDraft(
  finding: ValidatedFinding,
  review: Pick<AiReview, 'id' | 'subjectId' | 'diffId'>,
): AiDraftInput {
  const { side, startLine, endLine, fileLevel } = finding;
  const heading = `**${finding.title}**${finding.category ? ` · ${finding.category}` : ''}`;
  const range = startLine === endLine ? `Line ${startLine}` : `Lines ${startLine}–${endLine}`;
  const prefix = fileLevel ? `${range} (${side} side, outside the diff): ` : '';
  return {
    subjectId: review.subjectId,
    diffId: review.diffId,
    path: finding.path,
    ...(finding.oldPath ? { oldPath: finding.oldPath } : {}),
    side,
    line: fileLevel ? startLine : endLine,
    ...(!fileLevel && startLine !== endLine ? { start: { side, line: startLine } } : {}),
    body: `${prefix}${heading}\n\n${finding.body}`,
    excerpt: fileLevel ? '' : finding.excerpt,
    origin: 'ai',
    aiReviewId: review.id,
    severity: finding.severity,
    suggestion: finding.suggestion ?? null,
    acceptedAt: null,
    dismissedAt: null,
    fileLevel,
  };
}
