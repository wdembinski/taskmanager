/**
 * Static-markup coverage for `FileTree`'s optional viewed box: drawn only when the host
 * passes BOTH `viewed` and `onToggleViewed`, ticked only for `'viewed'`. Plus the selected
 * leaf's `data-selected` marker, and the workspace's compacted `buildDirGroups` labels.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DiffFileEntry, ViewedStatus } from '@tm/shared/review';
import { FileTree, type FileTreeProps } from './FileTree';
import { buildFileTree } from './reviewView';
import { buildDirGroups } from './reviewWorkspaceModel';

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

describe('FileTree selection', () => {
  it('marks only the selected leaf, and only once', () => {
    const html = render({ selectedPath: 'src/b.ts' });
    expect(html.match(/data-selected=""/g)).toHaveLength(1);
    // The marker sits on the leaf's own layout row, the one holding the selected file's name.
    const row = /<div[^>]*data-selected=""[^>]*>[\s\S]*?title="([^"]+)"/.exec(html);
    expect(row?.[1]).toBe('src/b.ts');
  });

  it('marks nothing with no selection', () => {
    expect(render()).not.toContain('data-selected');
  });
});

describe('FileTree with buildDirGroups', () => {
  it('labels each group with its whole directory path', () => {
    const html = renderToStaticMarkup(
      <FileTree
        nodes={buildDirGroups([
          entry('src/upload/retry.ts'),
          entry('src/upload/send.ts'),
          entry('src/net/link.ts'),
          entry('test/retry.test.ts'),
        ])}
        selectedPath="src/upload/retry.ts"
        onSelectFile={() => {}}
      />,
    );
    expect(html).toContain('>src/upload<');
    expect(html).toContain('>src/net<');
    expect(html).toContain('>test<');
    expect(html).not.toContain('>upload<');
    expect(html.match(/data-selected=""/g)).toHaveLength(1);
  });
});
