import { describe, expect, it } from 'vitest';
import { fileHolds, globMatches, overlappingFiles } from './fileOverlap';
import { PERSONAL_PROJECT_ID, type Task } from './model';

const task = (over: Partial<Task> & { id: string }): Task => ({
  projectId: PERSONAL_PROJECT_ID,
  phase: '',
  title: over.id,
  status: 'pending',
  sessionId: null,
  order: 0,
  dependsOn: [],
  source: 'adhoc',
  isContract: false,
  isScaffold: false,
  ...over,
});

const none = new Set<string>();

describe('globMatches', () => {
  it('lets * stay inside one directory and ** cross them', () => {
    expect(globMatches('src/*.ts', 'src/a.ts')).toBe(true);
    expect(globMatches('src/*.ts', 'src/deep/a.ts')).toBe(false);
    expect(globMatches('src/**', 'src/deep/a.ts')).toBe(true);
    expect(globMatches('src/**/a.ts', 'src/deep/er/a.ts')).toBe(true);
    expect(globMatches('src/**/a.ts', 'src/a.ts')).toBe(true);
  });

  it('matches ? to one character other than /', () => {
    expect(globMatches('src/?.ts', 'src/a.ts')).toBe(true);
    expect(globMatches('src/?.ts', 'src/ab.ts')).toBe(false);
    expect(globMatches('src?a.ts', 'src/a.ts')).toBe(false);
  });

  it('treats a dot literally', () => {
    expect(globMatches('src/*.ts', 'src/axts')).toBe(false);
  });
});

describe('overlappingFiles', () => {
  it('finds an exact match, and returns my entries only', () => {
    expect(overlappingFiles(['src/a.ts', 'src/b.ts'], ['src/b.ts', 'src/z.ts'])).toEqual([
      'src/b.ts',
    ]);
  });

  it('is empty when nothing overlaps, or either side has no files', () => {
    expect(overlappingFiles(['src/a.ts'], ['src/b.ts'])).toEqual([]);
    expect(overlappingFiles([], ['src/b.ts'])).toEqual([]);
    expect(overlappingFiles(['src/a.ts'], null)).toEqual([]);
    expect(overlappingFiles(undefined, ['src/a.ts'])).toEqual([]);
  });

  it('matches a glob on either side against a path', () => {
    expect(overlappingFiles(['src/main/*.ts'], ['src/main/ipc.ts'])).toEqual(['src/main/*.ts']);
    expect(overlappingFiles(['src/main/ipc.ts'], ['src/main/*.ts'])).toEqual(['src/main/ipc.ts']);
    expect(overlappingFiles(['src/main/*.ts'], ['src/main/deep/ipc.ts'])).toEqual([]);
    expect(overlappingFiles(['src/**'], ['src/main/deep/ipc.ts'])).toEqual(['src/**']);
  });

  it('holds two globs whose literal prefixes nest, and not two that diverge', () => {
    expect(overlappingFiles(['src/**'], ['src/main/*.ts'])).toEqual(['src/**']);
    expect(overlappingFiles(['src/main/*.ts'], ['src/main/*.tsx'])).toEqual(['src/main/*.ts']);
    expect(overlappingFiles(['src/main/*.ts'], ['src/renderer/*.ts'])).toEqual([]);
  });

  it('compares case- and slash-normalised paths', () => {
    expect(overlappingFiles(['Apps\\Client\\Store.ts'], ['./apps/client/store.ts'])).toEqual([
      'Apps\\Client\\Store.ts',
    ]);
  });
});

describe('fileHolds', () => {
  const live = (id: string, files: string[], over: Partial<Task> = {}): Task =>
    task({ id, plannedFiles: files, status: 'running', preRunStatus: 'in-progress', ...over });

  it('holds a card whose files overlap a running card in the same project', () => {
    const holds = fileHolds(
      [live('a', ['src/a.ts']), task({ id: 'b', plannedFiles: ['src/a.ts', 'src/b.ts'] })],
      none,
      none,
    );
    expect(holds.get('b')).toEqual({ byTaskId: 'a', files: ['src/a.ts'] });
    expect(holds.has('a')).toBe(false);
  });

  it('counts a card in the live-run set as running', () => {
    const holds = fileHolds(
      [
        task({ id: 'a', plannedFiles: ['src/a.ts'] }),
        task({ id: 'b', plannedFiles: ['src/a.ts'] }),
      ],
      new Set(['a']),
      none,
    );
    expect(holds.get('b')?.byTaskId).toBe('a');
  });

  it('never holds a card with no files, nor holds against a card with none', () => {
    const holds = fileHolds(
      [
        live('a', ['src/a.ts']),
        task({ id: 'b' }),
        task({ id: 'c', plannedFiles: [] }),
        live('d', []),
        task({ id: 'e', plannedFiles: null }),
      ],
      none,
      none,
    );
    expect(holds.size).toBe(0);
  });

  it('never holds across projects', () => {
    const holds = fileHolds(
      [
        live('a', ['src/a.ts'], { projectId: 'A' }),
        task({ id: 'b', projectId: 'B', plannedFiles: ['src/a.ts'] }),
      ],
      none,
      none,
    );
    expect(holds.size).toBe(0);
  });

  it('lets a card in review with an open PR hold its files', () => {
    const cards = [
      task({ id: 'rev', status: 'in-review', plannedFiles: ['src/a.ts'] }),
      task({ id: 'b', plannedFiles: ['src/a.ts'] }),
    ];
    expect(fileHolds(cards, none, new Set(['rev'])).get('b')?.byTaskId).toBe('rev');
    expect(fileHolds(cards, none, none).size).toBe(0);
  });

  it("lets a live step hold its parent's files", () => {
    const holds = fileHolds(
      [
        task({ id: 'parent', status: 'in-progress', plannedFiles: ['src/a.ts'] }),
        task({ id: 'step', parentTaskId: 'parent', plannedFiles: ['src/zzz.ts'] }),
        task({ id: 'b', plannedFiles: ['src/a.ts'] }),
      ],
      new Set(['step']),
      none,
    );
    expect(holds.get('b')?.byTaskId).toBe('parent');
    expect(holds.has('step')).toBe(false);
  });

  it('frees the files once the card has landed', () => {
    const holds = fileHolds(
      [
        task({ id: 'a', status: 'done', landedAt: 1, plannedFiles: ['src/a.ts'] }),
        task({ id: 'b', plannedFiles: ['src/a.ts'] }),
      ],
      none,
      none,
    );
    expect(holds.size).toBe(0);
  });
});
