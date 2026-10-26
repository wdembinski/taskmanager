/**
 * Proves the board header's `Links:` pill (v9-7): it names the current mode, opening it lists
 * Off / Focus / All as radio items with the current one checked, and a pick reaches
 * `onChange`. No DOM testing library in this package, so the menu is rendered already open
 * and in place (`open`, `inline`), and the pick goes through `linkModeMenuChange` — the very
 * handler the `Menu` is given.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { describe, expect, it, vi } from 'vitest';
import { LinkModeSwitch, linkModeMenuChange } from './LinkModeSwitch';
import type { LinkMode } from './linkMode';

function render(mode: LinkMode, open = false): string {
  return renderToStaticMarkup(
    <FluentProvider theme={webLightTheme}>
      <LinkModeSwitch mode={mode} onChange={() => {}} open={open} inline />
    </FluentProvider>,
  );
}

/** The `menuitemradio` elements, as label → aria-checked. */
function radios(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<div[^>]*role="menuitemradio"[^>]*>.*?<\/div>/g)) {
    const checked = /aria-checked="(\w+)"/.exec(m[0])?.[1] ?? '';
    const label = m[0].replace(/<[^>]+>/g, '').trim();
    out[label] = checked;
  }
  return out;
}

describe('LinkModeSwitch', () => {
  it.each([
    ['off', 'Links: Off'],
    ['focus', 'Links: Focus'],
    ['all', 'Links: All'],
  ] as const)('names the current mode on the pill (%s)', (mode, text) => {
    const html = render(mode);
    expect(html.replace(/<!-- -->/g, '')).toContain(text);
    expect(html).toContain(`data-link-mode="${mode}"`);
  });

  it('is one pill, not three segment buttons', () => {
    const html = render('focus');
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).not.toContain('menuitemradio');
  });

  it('lists Off, Focus and All when open, the current one checked', () => {
    const items = radios(render('focus', true));
    expect(Object.keys(items)).toEqual(['Off', 'Focus', 'All']);
    expect(items).toEqual({ Off: 'false', Focus: 'true', All: 'false' });
  });

  it('calls onChange with the mode picked', () => {
    const onChange = vi.fn();
    const handler = linkModeMenuChange(onChange);
    handler({} as never, { name: 'links', checkedItems: ['all'] });
    expect(onChange).toHaveBeenCalledWith('all');
    handler({} as never, { name: 'links', checkedItems: ['off'] });
    expect(onChange).toHaveBeenLastCalledWith('off');
  });

  it('ignores anything that is not a mode', () => {
    const onChange = vi.fn();
    linkModeMenuChange(onChange)({} as never, { name: 'links', checkedItems: [] });
    linkModeMenuChange(onChange)({} as never, { name: 'links', checkedItems: ['sideways'] });
    expect(onChange).not.toHaveBeenCalled();
  });
});
