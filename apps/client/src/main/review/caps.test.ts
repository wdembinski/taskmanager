import { describe, expect, it } from 'vitest';
import { RESULTS_BYTES_LIMIT } from '../cloudResults';
import {
  DIFF_COLLAPSE_LINES,
  DIFF_CONTEXT_MAX_LINES,
  DIFF_FILE_MAX_BYTES,
  DIFF_IMAGE_MAX_BYTES,
  DIFF_SUMMARY_MAX_FILES,
  type DiffFileEntry,
  type DiffSummary,
} from '@shared/review';
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
