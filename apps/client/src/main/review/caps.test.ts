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
