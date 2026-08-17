/**
 * The mobile shell — deliberately NOT `@tm/ui/shell/AppShell`.
 *
 * That shell is a left rail plus a bottom status bar, built for a window wide enough to
 * hold both without either stealing space a phone doesn't have. A phone gets the opposite
 * arrangement: a compact top bar carrying the one line of ambient state every screen wants
 * (title, which desktop is being driven, whether it's reachable, sign out), and a full-width
 * bottom TAB bar — thumb reach, not mouse hover — for the five destinations. Structurally
 * this is `apps/web`'s `AppShell`/`NavRail`/`StatusBar` triad turned ninety degrees, which is
 * exactly why it can't just import them: threading "which edge is the nav on" through that
 * shared shell would be the dozen-optional-props fork the plan's step 2 ruled out in the
 * other direction (docs/plan/README.md, Phase 27, "Forked — mobile writes its own").
 *
 * The small atoms it DOES reuse — `StatusDot`, the destination list's shape — are shared for
 * the same reason a colour is shared: two dots for "is the desktop reachable" would drift the
 * moment one host's got recoloured for contrast and the other didn't.
 */
import {
  Caption1,
  Subtitle2,
  Tab,
  TabList,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { ReactNode } from 'react';
import type { NavRailItem } from '@tm/ui/shell/NavRail';
import { StatusDot } from '@tm/ui/shell/StatusBar';
import { fontPx } from '@tm/ui/theme';

const useStyles = makeStyles({
  /**
   * `100dvh` rather than `100vh`: the dynamic viewport unit shrinks when the mobile browser
   * chrome (address bar, PWA nav gesture strip) is on screen, so the shell's bottom tab bar
   * stays above it instead of being pushed off under a `100vh` that assumed the chrome gone.
   */
  shell: {
    display: 'flex',
    flexDirection: 'column',
    height: '100dvh',
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground2,
  },
  topBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    flexShrink: 0,
    padding: '8px 12px',
    // The one other edge a phone can put content under — a notch or a status bar — the tab
    // bar's own `env()` below covers the other.
    paddingTop: 'max(8px, env(safe-area-inset-top))',
    backgroundColor: tokens.colorNeutralBackground1,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  title: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  status: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexShrink: 0,
    minWidth: 0,
  },
  statusLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '120px',
  },
  signOutButton: {
    background: 'none',
    border: 'none',
    padding: '0 4px',
    font: 'inherit',
    color: 'inherit',
    cursor: 'pointer',
    textDecoration: 'underline',
    flexShrink: 0,
    // A link this small is still a tap target — the touch area grows even though the text
    // painted inside it does not.
    minHeight: '44px',
    minWidth: '44px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  banners: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '8px 12px 0',
    '&:empty': { display: 'none' },
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
  },
  tabBar: {
    display: 'flex',
    flexShrink: 0,
    backgroundColor: tokens.colorNeutralBackground1,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    // The gesture bar / nav buttons a fullscreen PWA sits above on Android.
    paddingBottom: 'env(safe-area-inset-bottom)',
  },
  tab: {
    flex: 1,
    minHeight: '44px',
    justifyContent: 'center',
  },
  /** See `NavRail.unavailable` — same reasoning, dimmed rather than removed. */
  tabUnavailable: {
    flex: 1,
    minHeight: '44px',
    justifyContent: 'center',
    opacity: 0.4,
    cursor: 'default',
  },
  smallCaption: { fontSize: fontPx(11) },
});

export interface MobileShellProps {
  /** The current screen's name, in the top bar. */
  title: string;
  /** True when a desktop Client is reachable — colours the sync dot, same question `StatusDot` answers on the web. */
  online: boolean;
  /** The line under/beside the title: a `ClientPicker`, an offline note, or nothing yet. */
  status: ReactNode;
  onSignOut: () => void;
  /** Above the content, below the top bar — outage/skew banners, same slot `AppShell.banners` is. */
  banners?: ReactNode;
  nav: readonly NavRailItem[];
  selected: string;
  onSelect: (id: string) => void;
  children: ReactNode;
}

export function MobileShell({
  title,
  online,
  status,
  onSignOut,
  banners,
  nav,
  selected,
  onSelect,
  children,
}: MobileShellProps): JSX.Element {
  const styles = useStyles();
  return (
    <div className={styles.shell}>
      <div className={styles.topBar}>
        <Subtitle2 className={styles.title}>{title}</Subtitle2>
        <div className={styles.status}>
          <StatusDot ok={online} />
          <Caption1 className={`${styles.statusLabel} ${styles.smallCaption}`}>{status}</Caption1>
        </div>
        <Caption1 className={styles.smallCaption}>
          <button type="button" className={styles.signOutButton} onClick={onSignOut}>
            Sign out
          </button>
        </Caption1>
      </div>

      <div className={styles.banners}>{banners}</div>

      <div className={styles.body}>{children}</div>

      <TabList
        selectedValue={selected}
        onTabSelect={(_e, d) => {
          const id = String(d.value);
          // Same refusal `NavRail` makes, and for the same reason: a disabled `<button>`
          // fires no pointer events, so the tooltip explaining WHY never opens.
          if (nav.find((item) => item.id === id)?.unavailable) return;
          onSelect(id);
        }}
        className={styles.tabBar}
      >
        {nav.map((item) => (
          <Tooltip
            key={item.id}
            content={item.unavailable ? `${item.label} — ${item.unavailable}` : item.label}
            relationship="label"
            positioning="above"
          >
            <Tab
              value={item.id}
              icon={item.icon}
              aria-disabled={item.unavailable ? true : undefined}
              className={item.unavailable ? styles.tabUnavailable : styles.tab}
            >
              {item.label}
            </Tab>
          </Tooltip>
        ))}
      </TabList>
    </div>
  );
}
