/**
 * Static-markup coverage for `FileTree`'s optional viewed box: drawn only when the host
 * passes BOTH `viewed` and `onToggleViewed`, ticked only for `'viewed'`.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DiffFileEntry, ViewedStatus } from '@tm/shared/review';
import { FileTree, type FileTreeProps } from './FileTree';
import { buildFileTree } from './reviewView';

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

const nodes = buildFileTree([entry('src/a.ts'), entry('src/b.ts'), entry('README.md')]);
const viewed: Record<string, ViewedStatus> = {
  'src/a.ts': 'viewed',
  'src/b.ts': 'changed',
};

function render(over: Partial<FileTreeProps> = {}): string {
  return renderToStaticMarkup(
    <FileTree nodes={nodes} selectedPath={null} onSelectFile={() => {}} {...over} />,
  );
}

/** The `<input>` tag of the viewed box for `path`. */
function box(html: string, path: string): string {
  const match = new RegExp(`<input[^>]*aria-label="Viewed ${path}"[^>]*>`).exec(html);
  if (!match) throw new Error(`no viewed box for ${path}`);
  return match[0];
}

describe('FileTree viewed box', () => {
  it('is absent without the props, or with only one of them', () => {
    for (const html of [render(), render({ viewed }), render({ onToggleViewed: () => {} })]) {
      expect(html).not.toContain('type="checkbox"');
    }
  });

  it('is drawn per file with both props, ticked only for viewed', () => {
    const html = render({ viewed, onToggleViewed: () => {} });
    expect(html.match(/type="checkbox"/g)).toHaveLength(3);
    expect(box(html, 'src/a.ts')).toMatch(/\schecked/);
    expect(box(html, 'src/b.ts')).not.toMatch(/\schecked/);
    expect(box(html, 'README.md')).not.toMatch(/\schecked/);
  });

  it('titles a changed-since-viewed file', () => {
    const html = render({ viewed, onToggleViewed: () => {} });
    expect(html.match(/Changed since viewed/g)).toHaveLength(1);
  });
});
