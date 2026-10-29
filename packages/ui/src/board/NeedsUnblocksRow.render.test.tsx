/**
 * Proves the needs/unblocks row is the ONE line v10-7e draws: a single element, glyph and
 * words side by side, nothing block-level inside it that could stack. No DOM testing library
 * in this package, so the row is rendered to static markup and read as a string, the same way
 * `LinkModeSwitch.render.test.tsx` reads its pill.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { describe, expect, it } from 'vitest';
import { NeedsUnblocksRow } from './NeedsUnblocksRow';
import type { LinkChips } from './linkChips';

function render(chips: LinkChips): string {
  const html = renderToStaticMarkup(
    <FluentProvider theme={webLightTheme}>
      <NeedsUnblocksRow chips={chips} />
    </FluentProvider>,
  );
  return html.replace(/<!-- -->/g, '');
}

/** The row's own markup, from its opening tag to the end of the provider's content. */
function row(html: string): string {
  const at = html.indexOf('data-link-chips=""');
  expect(at).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf('<', at));
}

const text = (html: string) => html.replace(/<[^>]+>/g, '');

const BOTH: LinkChips = {
  needs: [{ key: 'TM-71', tone: 'releasing' }],
  unblocks: [{ key: 'TM-72' }],
};

describe('NeedsUnblocksRow', () => {
  it('is exactly one element', () => {
    expect(render(BOTH).match(/data-link-chips=""/g)).toHaveLength(1);
  });

  it('says both halves on it', () => {
    const t = text(row(render(BOTH)));
    expect(t).toContain('needs TM-71');
    expect(t).toContain('unblocks TM-72');
  });

  it('holds no block children that could stack', () => {
    const r = row(render(BOTH));
    // The provider's own wrapper is a <div> that closes after the row; nothing opens inside.
    expect(r).not.toContain('<div');
  });

  it('keeps the glyph inside the same element as the needs text', () => {
    const r = row(render(BOTH));
    const svg = r.indexOf('<svg');
    expect(svg).toBeGreaterThan(-1);
    expect(svg).toBeLessThan(r.indexOf('needs'));
    // The row's opening span is the only one still open where the glyph sits.
    const before = r.slice(0, svg);
    const opened = (before.match(/<span/g) ?? []).length;
    const closed = (before.match(/<\/span>/g) ?? []).length;
    expect(opened - closed).toBe(1);
  });

  it('marks the releasing key with its own class', () => {
    const r = row(render(BOTH));
    const releasing = /<span class="([^"]+)">TM-71<\/span>/.exec(r)?.[1];
    const plain = /<span class="([^"]+)"[^>]*>unblocks TM-72<\/span>/.exec(r)?.[1];
    expect(releasing).toBeTruthy();
    expect(plain).toBeTruthy();
    expect(releasing).not.toEqual(plain);

    const waiting = render({ needs: [{ key: 'TM-71', tone: 'waiting' }], unblocks: [] });
    expect(waiting).not.toMatch(new RegExp(`class="${releasing}"`));
  });

  it('renders one element for needs alone and for unblocks alone', () => {
    const needsOnly = render({ needs: [{ key: 'TM-71', tone: 'waiting' }], unblocks: [] });
    expect(needsOnly.match(/data-link-chips=""/g)).toHaveLength(1);
    expect(text(needsOnly)).toContain('needs TM-71');
    expect(text(needsOnly)).not.toContain('unblocks');

    const unblocksOnly = render({ needs: [], unblocks: [{ key: 'TM-72' }] });
    expect(unblocksOnly.match(/data-link-chips=""/g)).toHaveLength(1);
    expect(text(unblocksOnly)).toContain('unblocks TM-72');
    expect(text(unblocksOnly)).not.toContain('needs');
  });

  it('renders nothing when there is nothing to say', () => {
    expect(render({ needs: [], unblocks: [] })).not.toContain('data-link-chips');
  });
});
