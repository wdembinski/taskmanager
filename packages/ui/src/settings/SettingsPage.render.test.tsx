/**
 * Static-markup coverage for the grouped Settings page — same harness as
 * `Sidebar.render.test.tsx`: no DOM testing library in this package (see
 * `TaskSteps.render.test.tsx`), so the click is proven through `settingsTabSelectHandler`,
 * the exact function the `TabList` is given, rather than a fired event.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SelectTabData, SelectTabEvent } from '@fluentui/react-components';
import {
  SETTINGS_NAV_ICONS,
  SettingsPage,
  SettingsRow,
  SettingsSectionHeader,
  settingsTabSelectHandler,
  type SettingsNavGroup,
} from './SettingsPage';

const groups: SettingsNavGroup[] = [
  {
    heading: 'Workspace',
    items: [
      { id: 'general', title: 'General', icon: SETTINGS_NAV_ICONS.general },
      { id: 'board', title: 'Board', icon: SETTINGS_NAV_ICONS.board },
    ],
  },
  {
    heading: 'Connections',
    items: [
      { id: 'integrations', title: 'Integrations', icon: SETTINGS_NAV_ICONS.integrations },
      { id: 'agents', title: 'Agents and models', icon: SETTINGS_NAV_ICONS.agentsAndModels },
    ],
  },
  {
    heading: 'This machine',
    items: [
      { id: 'appearance', title: 'Appearance', icon: SETTINGS_NAV_ICONS.appearance },
      { id: 'shortcuts', title: 'Shortcuts', icon: SETTINGS_NAV_ICONS.shortcuts },
    ],
  },
];

const allItems = groups.flatMap((g) => g.items);

function render(selected = 'board', onSelect: (id: string) => void = () => {}): string {
  return renderToStaticMarkup(
    <SettingsPage groups={groups} selected={selected} onSelect={onSelect}>
      <p>Pane body</p>
    </SettingsPage>,
  );
}

/** The markup of the nav's `TabList` alone, from its opening tag to the content column. */
function navMarkup(markup: string): string {
  const start = markup.indexOf('aria-label="Settings sections"');
  expect(start).toBeGreaterThan(-1);
  const end = markup.indexOf('Pane body', start);
  expect(end).toBeGreaterThan(start);
  return markup.slice(markup.lastIndexOf('<', start), end);
}

describe('SettingsPage', () => {
  it('renders the page title', () => {
    expect(render()).toMatch(/<h1[^>]*>Settings<\/h1>/);
  });

  it('renders the three group headings in order', () => {
    const nav = navMarkup(render());
    const at = ['>Workspace<', '>Connections<', '>This machine<'].map((h) => nav.indexOf(h));
    expect(at.every((i) => i > -1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('draws each heading above its own items, not after them', () => {
    const nav = navMarkup(render());
    expect(nav.indexOf('>Connections<')).toBeGreaterThan(nav.indexOf('>Board<'));
    expect(nav.indexOf('>Connections<')).toBeLessThan(nav.indexOf('>Integrations<'));
  });

  it('renders every item as a role="tab" inside the Settings sections tablist', () => {
    const markup = render();
    expect(markup).toMatch(
      /role="tablist"[^>]*aria-label="Settings sections"|aria-label="Settings sections"[^>]*role="tablist"/,
    );
    const nav = navMarkup(markup);
    expect(nav.match(/role="tab"/g)).toHaveLength(allItems.length);
    for (const item of allItems) {
      expect(nav).toMatch(new RegExp(`role="tab"(?:(?!</button>)[\\s\\S])*>${item.title}<`));
    }
  });

  it('keeps the headings out of the tab order', () => {
    const nav = navMarkup(render());
    expect(nav).not.toMatch(/role="tab"[^>]*>(?:(?!<\/button>)[\s\S])*Workspace/);
  });

  it('marks only the selected tab aria-selected="true"', () => {
    const markup = render('integrations');
    expect(markup.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(markup).toMatch(/aria-selected="true"(?:(?!<\/button>)[\s\S])*>Integrations</);
  });

  it('calls onSelect with the clicked tab’s id', () => {
    const onSelect = vi.fn();
    settingsTabSelectHandler(onSelect)(
      {} as SelectTabEvent,
      { value: 'shortcuts' } as SelectTabData,
    );
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('shortcuts');
  });

  it('renders the open pane in the content column', () => {
    expect(render()).toContain('<p>Pane body</p>');
  });
});

describe('SettingsRow', () => {
  it('ties the label to its control when htmlFor is given', () => {
    const markup = renderToStaticMarkup(
      <SettingsRow label="Font size" htmlFor="font-size">
        <input id="font-size" />
      </SettingsRow>,
    );
    expect(markup).toMatch(/<label[^>]*for="font-size"[^>]*>Font size<\/label>/);
  });

  it('gives a wide row a different value column than a normal one', () => {
    const cls = (wide: boolean) =>
      /^<div class="([^"]*)"/.exec(
        renderToStaticMarkup(
          <SettingsRow label="L" wide={wide}>
            v
          </SettingsRow>,
        ),
      )?.[1];
    expect(cls(false)).toBeTruthy();
    expect(cls(true)).not.toBe(cls(false));
  });
});

describe('SettingsSectionHeader', () => {
  it('renders the title, and the caption only when one is given', () => {
    const withCaption = renderToStaticMarkup(
      <SettingsSectionHeader title="Integrations" caption="Trackers and hosts" />,
    );
    expect(withCaption).toMatch(/<h2[^>]*>Integrations<\/h2>/);
    expect(withCaption).toContain('Trackers and hosts');

    const bare = renderToStaticMarkup(<SettingsSectionHeader title="Integrations" />);
    expect(bare).not.toContain('Trackers and hosts');
  });
});
