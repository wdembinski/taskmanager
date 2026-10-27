import { describe, expect, it } from 'vitest';
import { RESULTS_BYTES_LIMIT } from '../cloudResults';
import {
  DIFF_COLLAPSE_LINES,
  DIFF_CONTEXT_MAX_LINES,
  DIFF_FILE_MAX_BYTES,
  DIFF_IMAGE_MAX_BYTES,
  DIFF_SUMMARY_MAX_FILES,
  REVIEW_QUEUE_MAX_ROWS,
  type DiffFileEntry,
  type DiffSummary,
  type ReviewQueue,
  type ReviewQueueItem,
  type ReviewQueuesSnapshot,
} from '@shared/review';
import { createReviewHandlers, type ReviewHandlersDeps } from './reviewHandlers';
import {
  AI_REVIEW_MAX_CHANGED_LINES,
  AI_REVIEW_MAX_FILES,
  AI_REVIEW_MAX_FINDINGS,
  AI_REVIEW_RESULT_MAX_BYTES,
  type AiFinding,
  type AiReviewOutput,
} from '@shared/aiReview';

describe('F6 review caps', () => {
  it.each([
    ['DIFF_FILE_MAX_BYTES', DIFF_FILE_MAX_BYTES],
    ['DIFF_IMAGE_MAX_BYTES', DIFF_IMAGE_MAX_BYTES],
    ['DIFF_SUMMARY_MAX_FILES', DIFF_SUMMARY_MAX_FILES],
    ['DIFF_COLLAPSE_LINES', DIFF_COLLAPSE_LINES],
    ['DIFF_CONTEXT_MAX_LINES', DIFF_CONTEXT_MAX_LINES],
  ])('%s stays below RESULTS_BYTES_LIMIT', (_name, cap) => {
    expect(cap).toBeLessThan(RESULTS_BYTES_LIMIT);
  });

  it('a summary at the file-count cap still fits under RESULTS_BYTES_LIMIT', () => {
    const files: DiffFileEntry[] = Array.from({ length: DIFF_SUMMARY_MAX_FILES }, (_v, i) => {
      const path = `src/${'a'.repeat(190)}/${String(i).padStart(6, '0')}.ts`;
      return {
        path,
        oldPath: path,
        status: 'modified',
        additions: 1,
        deletions: 1,
        binary: false,
        image: false,
        bytes: 100,
      };
    });
    const summary: DiffSummary = {
      diffId: 'abc123',
      baseRef: 'main',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      includesWorkingTree: false,
      files,
      truncated: false,
    };
    const bytes = Buffer.byteLength(JSON.stringify(summary), 'utf8');
    expect(bytes).toBeLessThan(RESULTS_BYTES_LIMIT);
  });
});

describe('F15 review queue caps', () => {
  /**
   * F15.14b: the web's `/reviews` reads `review:queues` over the relay, so its answer at the
   * row cap — `REVIEW_QUEUE_MAX_ROWS` rows in EACH of the three queues — has to fit one
   * result. Every string is at a realistic maximum; the snapshot goes through the real
   * `review:queues` handler with more rows than the cap, so `capQueues` (not exported) is what
   * cuts it down, exactly as the desktop would before answering.
   */
  it('a queue answer at the row cap still fits under RESULTS_BYTES_LIMIT', async () => {
    const queues: ReviewQueue[] = ['requested', 'mine', 'agent'];
    const row = (queue: ReviewQueue, i: number): ReviewQueueItem => {
      const n = String(i).padStart(6, '0');
      const repoPath = `${'group/'.repeat(30)}${'r'.repeat(14)}`.slice(0, 200);
      return {
        // The real PR shape (`gl-<repoId>-<n>`), padded well past any id a forge hands out.
        subjectId: `gl-${'9'.repeat(48)}-${queue}-${n}`,
        queue,
        subject: { kind: 'pr', provider: 'gitlab', repoId: 2 ** 31, repoPath, number: 999_999 },
        title: `${n} ${'t'.repeat(249)}`,
        author: 'a'.repeat(64),
        repoPath,
        ref: 'r'.repeat(128),
        headRef: 'h'.repeat(128),
        headSha: 'f'.repeat(40),
        draft: false,
        updatedAt: 1_800_000_000_000,
        projectId: '00000000-0000-0000-0000-000000000000',
        taskId: '00000000-0000-0000-0000-000000000000',
        draftCount: 999,
        viewedCount: 999,
        fileCount: 3000,
        additions: 999_999,
        deletions: 999_999,
        pipeline: 'running',
      };
    };
    const snapshot: ReviewQueuesSnapshot = {
      items: queues.flatMap((queue) =>
        Array.from({ length: REVIEW_QUEUE_MAX_ROWS + 25 }, (_v, i) => row(queue, i)),
      ),
      asOf: { requested: 1_800_000_000_000, mine: 1_800_000_000_000, agent: 1_800_000_000_000 },
      partial: [...queues],
    };
    const handlers = createReviewHandlers({
      queues: { open: () => snapshot },
    } as unknown as ReviewHandlersDeps);

    const answer = await handlers['review:queues']();

    for (const queue of queues) {
      expect(answer.items.filter((item) => item.queue === queue)).toHaveLength(
        REVIEW_QUEUE_MAX_ROWS,
      );
    }
    expect(answer.items[0].title).toHaveLength(256);
    const bytes = Buffer.byteLength(JSON.stringify(answer), 'utf8');
    expect(bytes).toBeLessThan(RESULTS_BYTES_LIMIT);
  });
});

describe('F16 AI review caps', () => {
  it('AI_REVIEW_RESULT_MAX_BYTES stays below RESULTS_BYTES_LIMIT', () => {
    expect(AI_REVIEW_RESULT_MAX_BYTES).toBeLessThan(RESULTS_BYTES_LIMIT);
  });

  it.each([
    ['AI_REVIEW_MAX_FINDINGS', AI_REVIEW_MAX_FINDINGS],
    ['AI_REVIEW_MAX_FILES', AI_REVIEW_MAX_FILES],
    ['AI_REVIEW_MAX_CHANGED_LINES', AI_REVIEW_MAX_CHANGED_LINES],
  ])('%s stays below RESULTS_BYTES_LIMIT', (_name, cap) => {
    expect(cap).toBeLessThan(RESULTS_BYTES_LIMIT);
  });

  // 1,500 chars, not 2,000: fifty 2,000-char bodies plus suggestions are 200,000 bytes on
  // their own — the cap itself, before a single key or path.
  it('an output at the findings cap still fits under AI_REVIEW_RESULT_MAX_BYTES', () => {
    const findings: AiFinding[] = Array.from({ length: AI_REVIEW_MAX_FINDINGS }, (_v, i) => ({
      path: `src/${'a'.repeat(100)}/${String(i).padStart(6, '0')}.ts`,
      side: 'new',
      startLine: 1,
      endLine: 2,
      severity: 'major',
      category: 'correctness',
      title: 't'.repeat(120),
      body: 'b'.repeat(1500),
      suggestion: 's'.repeat(1500),
    }));
    const output: AiReviewOutput = { summary: 'x'.repeat(2000), verdict: 'comment', findings };
    const bytes = Buffer.byteLength(JSON.stringify(output), 'utf8');
    expect(bytes).toBeLessThan(AI_REVIEW_RESULT_MAX_BYTES);
  });
});
