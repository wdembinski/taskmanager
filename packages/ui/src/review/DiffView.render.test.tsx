/**
 * Static-markup coverage for `DiffView`'s optional per-file "Viewed" box in each file header:
 * drawn only when the host passes BOTH `viewed` and `onToggleViewed`, ticked only for
 * `'viewed'` — `FileTree`'s own contract, which the Changes pane relies on by passing neither.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DiffFileEntry, DiffSummary, ViewedStatus } from '@tm/shared/review';
import { DiffView, type DiffViewProps } from './DiffView';

function entry(path: string): DiffFileEntry {
  return {
    path,
    status: 'modified',
    additions: 1,
    deletions: 0,
    binary: false,
    image: false,
    bytes: 10,
  };
}

const summary: DiffSummary = {
  diffId: 'd1',
  baseRef: 'development',
  baseSha: 'base000',
  headSha: 'head000',
  includesWorkingTree: false,
  files: [entry('src/a.ts'), entry('src/b.ts'), entry('README.md')],
  truncated: false,
};

const viewed: Record<string, ViewedStatus> = {
  'src/a.ts': 'viewed',
  'src/b.ts': 'changed',
};

function render(over: Partial<DiffViewProps> = {}): string {
  const noop = (): void => {};
  return renderToStaticMarkup(
    <DiffView
      taskId="t1"
      diffId="d1"
      summary={summary}
      files={{}}
      expanded={[]}
      selectedPath={null}
      comments={[]}
      editor={null}
      canComment={false}
      onToggleExpanded={noop}
      onClickLine={noop}
      onEditDraft={noop}
      onSave={noop}
      onCancel={noop}
      onEdit={noop}
      onDelete={noop}
      {...over}
    />,
  );
}

/** The `<input>` tag of the header box for `path`. */
function box(html: string, path: string): string {
  const match = new RegExp(`<input[^>]*aria-label="Viewed ${path}"[^>]*>`).exec(html);
  if (!match) throw new Error(`no viewed box for ${path}`);
  return match[0];
}

describe('DiffView viewed box', () => {
  it('is absent without the props, or with only one of them', () => {
    for (const html of [render(), render({ viewed }), render({ onToggleViewed: () => {} })]) {
      expect(html).not.toContain('type="checkbox"');
      expect(html).not.toContain('data-diff-viewed');
    }
  });

  it('is drawn in every file header with both props, ticked only for viewed', () => {
    const html = render({ viewed, onToggleViewed: () => {} });
    expect(html.match(/type="checkbox"/g)).toHaveLength(3);
    expect(box(html, 'src/a.ts')).toMatch(/\schecked/);
    expect(box(html, 'src/a.ts')).toContain('data-diff-viewed="viewed"');
    expect(box(html, 'src/b.ts')).not.toMatch(/\schecked/);
    expect(box(html, 'src/b.ts')).toContain('data-diff-viewed="changed"');
    expect(box(html, 'README.md')).not.toMatch(/\schecked/);
    expect(html.match(/>Viewed</g)).toHaveLength(3);
    expect(html.match(/Changed since viewed/g)).toHaveLength(1);
  });
});
