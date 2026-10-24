/**
 * The grouped Settings page both hosts draw (v10 mockup `v10-19-settings-light.svg`): a
 * "Settings" title, a 220px nav of grouped sections down the left, and a scrolling content
 * column after a divider. The page owns the chrome only — which sections exist, which one is
 * open and what each pane holds stay with the host, because the desktop and the web do not
 * share their panes' state.
 *
 * The nav is still one Fluent `TabList vertical`, not a hand-rolled list: that keeps
 * `role="tab"`, arrow-key roving between items, `aria-label="Settings sections"` and the
 * shot harness's `tab:NAME` sentinel exactly as the old flat list had them. The group
 * headings sit between the `Tab`s as plain, non-focusable text, so arrowing skips them.
 *
 * Every colour is a theme token (F13.18): the mockup's selected fill is
 * `colorBrandBackground2`, its selected ink `colorBrandForeground1`, its group headings
 * `colorNeutralForeground3` and its nav/content divider `colorNeutralStroke3`.
 */
import {
  Caption1,
  Caption1Strong,
  Tab,
  TabList,
  makeStyles,
  mergeClasses,
  tabClassNames,
  tokens,
  type SelectTabData,
  type SelectTabEvent,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular,
  Board20Regular,
  Bot20Regular,
  Color20Regular,
  Flash20Regular,
  Flow20Regular,
  Folder20Regular,
  Key20Regular,
  Keyboard20Regular,
  Laptop20Regular,
  Lightbulb20Regular,
  People20Regular,
  PlugConnected20Regular,
  Server20Regular,
  Settings20Regular,
  TextBulletList20Regular,
  type FluentIcon,
} from '@fluentui/react-icons';
import type { ReactNode } from 'react';
import { GlassPane } from '../shell/GlassPane';

/**
 * The nav icon for every section either host has. The first six are the mockup's own
 * `<path>` data matched against `@fluentui/react-icons` (so Appearance is `Color`, the
 * palette, and Execution target is `Server` — not the guesses a name suggests); the rest have
 * no item in the mockup and use the closest Fluent glyph by meaning.
 */
export const SETTINGS_NAV_ICONS = {
  integrations: PlugConnected20Regular,
  agentsAndModels: Bot20Regular,
  tokens: Key20Regular,
  appearance: Color20Regular,
  shortcuts: Keyboard20Regular,
  executionTarget: Server20Regular,
  people: People20Regular,
  updates: ArrowSync20Regular,
  general: Settings20Regular,
  board: Board20Regular,
  features: Flash20Regular,
  skills: Lightbulb20Regular,
  workflows: Flow20Regular,
  promptTemplates: TextBulletList20Regular,
  projects: Folder20Regular,
  desktopOnly: Laptop20Regular,
} satisfies Record<string, FluentIcon>;

export interface SettingsNavItem {
  id: string;
  title: string;
  icon: FluentIcon;
}

export interface SettingsNavGroup {
  heading: string;
  items: SettingsNavItem[];
}

const useStyles = makeStyles({
  /** The tinted canvas the card stands on: the mockup's 10px top/right/bottom inset, and none
   *  on the left, where the card meets the nav rail (x=52). Hosts give this tab no shell
   *  padding, so this is the only inset. */
  page: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    boxSizing: 'border-box',
    padding: '10px 10px 10px 0',
  },
  /** The one `GlassPane` holding the title, nav and pane. */
  card: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    boxSizing: 'border-box',
    padding: `${tokens.spacingVerticalXXL} 28px 0 ${tokens.spacingHorizontalXL}`,
  },
  /** `Title3`'s size and weight, set here so the page owns its own inset (x=80 in the mockup,
   *  8px inside the nav's left edge, level with the group headings). */
  title: {
    margin: 0,
    paddingLeft: tokens.spacingHorizontalS,
    fontFamily: tokens.fontFamilyBase,
    fontSize: tokens.fontSizeBase500,
    lineHeight: tokens.lineHeightBase500,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
  },
  body: {
    display: 'flex',
    flex: 1,
    minHeight: 0,
    marginTop: tokens.spacingVerticalXL,
  },
  nav: {
    width: '220px',
    flexShrink: 0,
    overflowY: 'auto',
    paddingBottom: tokens.spacingVerticalL,
    rowGap: tokens.spacingVerticalXXS,
  },
  heading: {
    display: 'block',
    padding: `0 ${tokens.spacingHorizontalS} ${tokens.spacingVerticalXS}`,
    color: tokens.colorNeutralForeground3,
  },
  /** Every heading after the first opens a new group: the mockup's ~20px gap above it. */
  headingLater: { marginTop: tokens.spacingVerticalXL },
  tab: {
    minHeight: '28px',
    padding: `0 ${tokens.spacingHorizontalMNudge}`,
    borderRadius: tokens.borderRadiusMedium,
    justifyContent: 'flex-start',
    // The mockup draws no underline/side bar on the selected item — the fill is the cue —
    // so Fluent's indicator (`::after`) and its hover twin (`::before`) are cleared.
    '::after': { backgroundColor: tokens.colorTransparentBackground },
    '::before': { backgroundColor: tokens.colorTransparentBackground },
    // The mockup's 12.5px labels; Fluent's small tab would otherwise draw ~14px.
    [`& .${tabClassNames.content}`]: { fontSize: '12.5px' },
  },
  tabSelected: {
    backgroundColor: tokens.colorBrandBackground2,
    ':hover': { backgroundColor: tokens.colorBrandBackground2Hover },
    ':active': { backgroundColor: tokens.colorBrandBackground2Pressed },
    [`& .${tabClassNames.icon}, &:hover .${tabClassNames.icon}, &:active .${tabClassNames.icon}`]: {
      color: tokens.colorBrandForeground1,
    },
    [`& .${tabClassNames.content}, &:hover .${tabClassNames.content}, &:active .${tabClassNames.content}`]:
      { color: tokens.colorBrandForeground1, fontWeight: tokens.fontWeightSemibold },
  },
  /** Starts after the mockup's 44px: 16px to the divider, 28px past it. Scrolls on its own so
   *  the title and the nav stay put under a long pane. */
  content: {
    flex: 1,
    minWidth: 0,
    overflowY: 'auto',
    marginLeft: tokens.spacingHorizontalL,
    paddingLeft: '28px',
    paddingRight: tokens.spacingHorizontalS,
    paddingBottom: tokens.spacingVerticalXXL,
    borderLeft: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke3}`,
  },
  row: {
    display: 'grid',
    gridTemplateColumns: '200px minmax(0, 360px)',
    columnGap: tokens.spacingHorizontalL,
    alignItems: 'center',
    padding: `${tokens.spacingVerticalS} 0`,
  },
  rowWide: { gridTemplateColumns: '200px minmax(0, 640px)' },
  rowLabel: { color: tokens.colorNeutralForeground2 },
  rowValue: { minWidth: 0 },
  sectionHeader: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: tokens.spacingVerticalXXS,
    marginBottom: tokens.spacingVerticalL,
  },
  sectionTitle: {
    margin: 0,
    fontFamily: tokens.fontFamilyBase,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
  },
  sectionCaption: { color: tokens.colorNeutralForeground3 },
});

/**
 * The `TabList`'s select handler, apart from the component so a test can drive it: this
 * package has no DOM testing library to fire a real click through (see
 * `TaskSteps.render.test.tsx`'s header), and this is everything a click does.
 */
export function settingsTabSelectHandler(
  onSelect: (id: string) => void,
): (event: SelectTabEvent, data: SelectTabData) => void {
  return (_event, data) => onSelect(String(data.value));
}

export interface SettingsPageProps {
  groups: SettingsNavGroup[];
  /** The open section's id; a value no item carries simply leaves no tab selected. */
  selected: string;
  onSelect: (id: string) => void;
  /** The open section's pane. */
  children: ReactNode;
}

export function SettingsPage({ groups, selected, onSelect, children }: SettingsPageProps) {
  const styles = useStyles();
  return (
    <div className={styles.page}>
      <GlassPane className={styles.card}>
        <h1 className={styles.title}>Settings</h1>
        <div className={styles.body}>
          <TabList
            vertical
            size="small"
            aria-label="Settings sections"
            selectedValue={selected}
            onTabSelect={settingsTabSelectHandler(onSelect)}
            className={styles.nav}
          >
            {groups.flatMap((group, index) => [
              <Caption1Strong
                key={`heading:${group.heading}`}
                role="presentation"
                className={mergeClasses(styles.heading, index > 0 && styles.headingLater)}
              >
                {group.heading}
              </Caption1Strong>,
              ...group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <Tab
                    key={item.id}
                    value={item.id}
                    icon={<Icon />}
                    className={mergeClasses(styles.tab, item.id === selected && styles.tabSelected)}
                  >
                    {item.title}
                  </Tab>
                );
              }),
            ])}
          </TabList>
          <div className={styles.content}>{children}</div>
        </div>
      </GlassPane>
    </div>
  );
}

export interface SettingsRowProps {
  label: ReactNode;
  /** Ties the label to its control for a screen reader, when the value is one input. */
  htmlFor?: string;
  /** Tables and editors get 640px for the value column instead of 360px. */
  wide?: boolean;
  children: ReactNode;
}

/** One label/value line of a pane: a 200px label column and a capped value column, so no
 *  input runs the full width of the window. */
export function SettingsRow({ label, htmlFor, wide, children }: SettingsRowProps) {
  const styles = useStyles();
  return (
    <div className={mergeClasses(styles.row, wide && styles.rowWide)}>
      {htmlFor ? (
        <label htmlFor={htmlFor} className={styles.rowLabel}>
          {label}
        </label>
      ) : (
        <span className={styles.rowLabel}>{label}</span>
      )}
      <div className={styles.rowValue}>{children}</div>
    </div>
  );
}

export interface SettingsSectionHeaderProps {
  title: string;
  caption?: ReactNode;
}

/** A pane's own title (16px semibold, the mockup's "Members") and its optional caption line. */
export function SettingsSectionHeader({ title, caption }: SettingsSectionHeaderProps) {
  const styles = useStyles();
  return (
    <div className={styles.sectionHeader}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      {caption !== undefined && <Caption1 className={styles.sectionCaption}>{caption}</Caption1>}
    </div>
  );
}
