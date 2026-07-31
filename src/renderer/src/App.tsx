/**
 * App shell.
 *
 * A frameless window: a custom <TitleBar> (window drag handle + min/max/close)
 * sits flush at the very top, and under it a **vertical nav rail** on the left —
 * My Tasks, Projects, the running Board, Performance, the Attention inbox,
 * Settings, a hands-on Scratch run — beside the content region. The rail replaced
 * a horizontal tab strip, which cost every screen a band of height at the top,
 * where a board and a chat pane both want it most. A global usage-limit banner
 * (Phase 5) sits above the content; a Claude message bar appears only when
 * something is wrong; and a **status bar** runs the full width of the window at
 * the bottom — blue at rest, orange while anything is waiting on a human.
 *
 * The pattern to notice: components read request/response data via
 * `window.api.invoke(...)` and consume pushed updates via `window.api.on(...)`.
 * Those two are the whole UI↔engine vocabulary.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Caption1,
  CounterBadge,
  makeStyles,
  MessageBar,
  MessageBarBody,
  Spinner,
  Tab,
  TabList,
  Toast,
  ToastBody,
  ToastTitle,
  tokens,
  Tooltip,
  useToastController,
} from '@fluentui/react-components';
import {
  AlertRegular,
  DataTrendingRegular,
  PlayRegular,
  SettingsRegular,
  TaskListSquareLtrRegular,
} from '@fluentui/react-icons';
import type { AppInfo, ClaudeStatus } from '@shared/ipc';
import { describeUpdate, type UpdateState } from '@shared/update';
import { Attention } from './Attention';
import { LimitBanner } from './LimitBanner';
import { MyTasks } from './MyTasks';
import { currentSprintName } from './board/currentSprint';
import { SyncRings } from './SyncRings';
import type { ServiceSyncState } from '@shared/sync';
import { Performance } from './Performance';
import { Settings } from './Settings';
import { SessionRunner } from './SessionRunner';
import { TitleBar } from './TitleBar';
import { ACCENT, TOASTER_ID, fontPx } from './theme';
import type { AttentionItem } from '@shared/attention';

const useStyles = makeStyles({
  shell: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground2,
  },
  /** Nav rail + content, side by side under the title bar. */
  main: { display: 'flex', flex: 1, minHeight: 0 },
  /**
   * A vertical rail of icons rather than a row of tabs across the top: the tab strip
   * cost every screen a band of height at its most valuable point, and seven
   * destinations with familiar glyphs need no words. Each tab keeps its label as a
   * tooltip, which is also what a screen reader announces.
   */
  nav: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    // ~1.5× the width an icon-only tab takes on its own, so the rail is a deliberate
    // edge of the window rather than a thin strip of buttons.
    width: '84px',
    paddingTop: '8px',
    flexShrink: 0,
    // The same surface as the detail pane, so the window reads as content between two
    // lighter edges rather than as three unrelated panels.
    backgroundColor: tokens.colorNeutralBackground1,
    // Square TILES, not wide short buttons: at 84 wide and ~40 tall each tab was a
    // letterbox, and a rail of letterboxes reads as a toolbar rather than as the app's
    // primary navigation. Square is also what makes the glyph the whole target.
    '& button': {
      justifyContent: 'center',
      height: '84px',
      minWidth: '84px',
      borderRadius: tokens.borderRadiusMedium,
    },
    // Twice the 24px they started at. The tile grew with them, so the icon still sits in
    // the same share of its tab rather than crowding the edges.
    '& svg': { fontSize: '48px' },
  },
  /** No padding: each screen owns its own insets, so a pane can run to the window edge. */
  content: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    boxSizing: 'border-box',
  },
  /**
   * The banners are the only things that need breathing room of their own — and when
   * neither is showing (the normal case) the row collapses, so no screen pays for it.
   */
  banners: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '8px 12px 0',
    '&:empty': { display: 'none' },
  },
  body: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 },
  /**
   * Every screen but My Tasks is a document and wants a margin. My Tasks is a
   * two-panel workspace whose right pane runs to the window's edges, so it gets none
   * and lays out its own insets.
   */
  bodyPadded: { padding: '12px 16px' },
  /**
   * A status bar, in the editor's sense: the full width of the window (the nav rail
   * included), one line high, and **coloured** rather than bordered. Blue is the resting
   * state; it turns the app's own "wants you" orange the moment something is waiting on
   * a human, so the signal is visible from across a room even when the Attention screen
   * is not open.
   */
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '3px 12px',
    flexShrink: 0,
    backgroundColor: ACCENT.statusBlue,
    color: '#ffffff',
    // The bar is one line of small text on a saturated fill, which is exactly where
    // Fluent's default weight goes muddy. A touch more size and weight, stated once here
    // so every item in the bar gets it.
    fontSize: fontPx(12),
    fontWeight: 600,
  },
  /**
   * The attention fill. Near-black ink rather than white: white on this orange is ~2.2:1,
   * which is the "hard to read when it goes orange" complaint — #1b1b1b is ~8.6:1.
   */
  footerAttention: { backgroundColor: ACCENT.unread, color: ACCENT.unreadInk },
  /**
   * The live/dead dot, with a dark ring so it separates from BOTH fills it is ever drawn
   * on. The ring matters because a single colour cannot have good contrast against a
   * mid-blue and a bright orange at once.
   */
  dot: {
    width: '9px',
    height: '9px',
    borderRadius: '50%',
    flexShrink: 0,
    boxShadow: '0 0 0 1.5px rgba(0, 0, 0, 0.45)',
  },
  // NOT `colorPaletteGreenBackground3` (#0e700e), which was the bug: ~1.6:1 against the
  // bar's blue and ~3.2:1 against its orange — invisible on both.
  ok: { backgroundColor: ACCENT.liveGreen },
  bad: { backgroundColor: ACCENT.liveRed },
  grow: { flex: 1 },
  /**
   * The "a new version is waiting" item. It inherits the bar's own colour rather than
   * naming one, because the bar turns orange under attention and a fixed white would
   * vanish against it. Underlined so it reads as the one clickable thing down here.
   */
  update: {
    background: 'none',
    border: 'none',
    padding: 0,
    font: 'inherit',
    color: 'inherit',
    cursor: 'pointer',
    textDecoration: 'underline',
  },
});

/**
 * Phase 17 removed the Projects and Board screens. Both were the pre-My-Tasks way of
 * driving work — a project list and a per-project plan board — and everything they did is
 * now done from a card: a repo is an *agent project* (Settings → Agents), and the work
 * lives on the personal board.
 *
 * The ENGINE's notion of a project stays exactly where it is. Projects are how runs are
 * queued, how concurrency is bounded and where a worktree is cut; the personal board is
 * itself a project. Only the two screens are gone.
 */
type TabId = 'mytasks' | 'performance' | 'attention' | 'settings' | 'scratch';

/** The rail, in order. The label is the tooltip and the accessible name. */
const NAV: Array<{ id: TabId; label: string; icon: JSX.Element }> = [
  { id: 'mytasks', label: 'My Tasks', icon: <TaskListSquareLtrRegular /> },
  { id: 'performance', label: 'Performance', icon: <DataTrendingRegular /> },
  { id: 'attention', label: 'Attention', icon: <AlertRegular /> },
  { id: 'settings', label: 'Settings', icon: <SettingsRegular /> },
  { id: 'scratch', label: 'Scratch run', icon: <PlayRegular /> },
];

/** What each kind of ask is called in a toast — short, because a toast is one glance. */
const TOAST_TITLE: Record<AttentionItem['kind'], string> = {
  permission: 'Permission needed',
  question: 'The agent has a question',
  'agent-question': 'The agent is asking you to choose',
  'plan-approval': 'A plan is ready to approve',
  'merge-conflict': 'Merge conflict',
  'task-failed': 'A run failed',
  proposal: 'A proposal needs a decision',
};

export function App(): JSX.Element {
  const styles = useStyles();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);
  const [tab, setTab] = useState<TabId>('mytasks');
  // How many tasks are waiting on a human, shown as a badge on the Attention tab.
  const [attentionCount, setAttentionCount] = useState(0);
  const { dispatchToast } = useToastController(TOASTER_ID);
  /**
   * Raise a toast for an incoming ask, if toasts are on.
   *
   * The switch is read at dispatch time rather than held in state because this fires from
   * inside a subscription that is set up once — a captured value would go stale the
   * moment the setting changed, and the toast that ignored your preference would be the
   * one you noticed.
   */
  const notify = useCallback(
    (item: AttentionItem) => {
      void window.api
        .invoke('settings:get')
        .then((settings) => {
          if (!settings.toastsEnabled) return;
          dispatchToast(
            <Toast>
              <ToastTitle>{TOAST_TITLE[item.kind] ?? 'Something needs you'}</ToastTitle>
              <ToastBody>{item.taskTitle}</ToastBody>
            </Toast>,
            { intent: item.kind === 'task-failed' ? 'error' : 'warning', timeout: 6000 },
          );
        })
        .catch(() => undefined);
    },
    [dispatchToast],
  );
  // Auto-update: only its final state earns a place in the status bar (a downloaded
  // build waiting for a restart). Progress lives in Settings, where it was asked for.
  const [update, setUpdate] = useState<UpdateState | null>(null);
  /**
   * The sprint the board is filtered to, said once here instead of on every card.
   *
   * The shell reads it rather than the board pushing it up: this way the bar is right
   * even while another tab is open, and the board keeps knowing nothing about the shell.
   * Null whenever the filter is off or the cards disagree — see `currentSprintName`.
   */
  const [sprint, setSprint] = useState<string | null>(null);

  /**
   * How fresh each tracker's mirror is, for the status bar's countdown rings. Held by the
   * shell rather than the board for the same reason `sprint` is: the bar stays right while
   * another tab is open, and it is the shell that owns the bar.
   */
  const [syncStates, setSyncStates] = useState<ServiceSyncState[]>([]);

  // Set when the app shell itself can't reach the engine — the clearest possible signal
  // that nothing else on screen will load either.
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([
      window.api.invoke('app:getInfo').then(setInfo),
      window.api.invoke('claude:getStatus').then(setClaude),
      window.api.invoke('attention:list').then((items) => setAttentionCount(items.length)),
      window.api.invoke('update:get').then(setUpdate),
      window.api.invoke('sync:state').then(setSyncStates),
    ]).catch((e: unknown) => setBootError(e instanceof Error ? e.message : String(e)));

    /** Recompute the footer's sprint from the settings flag and the board's cards. */
    const readSprint = async (): Promise<void> => {
      const [settings, tasks] = await Promise.all([
        window.api.invoke('settings:get'),
        window.api.invoke('board:tasks'),
      ]);
      setSprint(settings.jira.currentSprintOnly ? currentSprintName(tasks) : null);
    };
    void readSprint().catch(() => setSprint(null));

    const offNew = window.api.on('attention:new', (item) => {
      setAttentionCount((n) => n + 1);
      // A toast is the only part of this that can reach you while you are looking at
      // another screen — the ring and the badge both need the board to be visible. It
      // says which card, because "something needs you" with six cards open is a riddle.
      notify(item);
    });
    const offResolved = window.api.on('attention:resolved', () =>
      setAttentionCount((n) => Math.max(0, n - 1)),
    );
    const offUpdate = window.api.on('update:changed', setUpdate);
    // Fires when a sync starts, finishes or fails — the ring's own countdown between those
    // moments is a local timer inside `SyncRings`, so this is only the resets.
    const offSync = window.api.on('sync:changed', setSyncStates);
    // Both signals matter: a sync replaces the board (the sprint's cards may change),
    // and the engine can rewrite settings behind the UI's back.
    const offTasks = window.api.on('project:tasksChanged', () => void readSprint());
    const offSettings = window.api.on('settings:changed', () => void readSprint());
    return () => {
      offNew();
      offResolved();
      offUpdate();
      offSync();
      offTasks();
      offSettings();
    };
  }, []);

  const claudeOk = claude?.installed && claude?.authenticated && !claude?.apiKeyDetected;

  return (
    <div className={styles.shell}>
      <TitleBar />

      <div className={styles.main}>
        <TabList
          vertical
          size="large"
          className={styles.nav}
          selectedValue={tab}
          onTabSelect={(_e, d) => setTab(d.value as TabId)}
        >
          {NAV.map((item) => (
            <Tooltip key={item.id} content={item.label} relationship="label" positioning="after">
              <Tab value={item.id} icon={item.icon}>
                {/* The only label left: a count that means "someone is waiting on you". */}
                {item.id === 'attention' && attentionCount > 0 && (
                  <CounterBadge
                    count={attentionCount}
                    color="danger"
                    size="small"
                    appearance="filled"
                  />
                )}
              </Tab>
            </Tooltip>
          ))}
        </TabList>

        <div className={styles.content}>
          <div className={styles.banners}>
            {/* The engine is unreachable — every tab below will be empty, so say why once,
                at the top, rather than leaving the user to guess from seven spinners. */}
            {bootError && (
              <MessageBar intent="error">
                <MessageBarBody>
                  Can&apos;t reach the app&apos;s backend, so nothing will load: {bootError}
                </MessageBarBody>
              </MessageBar>
            )}

            {/* Surface a Claude problem prominently; when all is well the footer suffices. */}
            {claude && !claudeOk && (
              <MessageBar intent="warning">
                <MessageBarBody>{claude.message}</MessageBarBody>
              </MessageBar>
            )}

            {/* Global usage-limit gate (Phase 5): a countdown while work is parked. */}
            <LimitBanner />
          </div>

          <div className={tab === 'mytasks' ? styles.body : `${styles.body} ${styles.bodyPadded}`}>
            {tab === 'mytasks' ? (
              <MyTasks />
            ) : tab === 'performance' ? (
              <Performance />
            ) : tab === 'attention' ? (
              <Attention />
            ) : tab === 'settings' ? (
              <Settings />
            ) : (
              <SessionRunner />
            )}
          </div>
        </div>
      </div>

      {/* Status bar: Claude readiness + app info, the full width of the window. */}
      <div
        className={
          attentionCount > 0 ? `${styles.footer} ${styles.footerAttention}` : styles.footer
        }
      >
        {claude ? (
          <>
            <span className={`${styles.dot} ${claudeOk ? styles.ok : styles.bad}`} />
            <Caption1>
              {claude.installed
                ? `Claude ${claude.version ?? '?'}${claude.authenticated ? ' · logged in' : ' · not logged in'}`
                : 'Claude CLI not found'}
              {claude.apiKeyDetected && ' · ANTHROPIC_API_KEY set'}
            </Caption1>
          </>
        ) : bootError ? (
          <>
            <span className={`${styles.dot} ${styles.bad}`} />
            <Caption1>Backend unavailable</Caption1>
          </>
        ) : (
          <Spinner label="Checking Claude…" labelPosition="after" size="tiny" />
        )}
        {attentionCount > 0 && <Caption1>· {attentionCount} waiting on you</Caption1>}
        {/* No colour of its own: the bar turns orange under attention, and a fixed
            white would go unreadable exactly then. */}
        {sprint && <Caption1>· {sprint}</Caption1>}
        <span className={styles.grow} />
        {/* A downloaded update installs itself on the next quit either way; this is
            simply the offer to have it now, and the only notice the user ever gets. */}
        {update?.status === 'downloaded' && (
          <Caption1>
            <button
              type="button"
              className={styles.update}
              title="Restart now to finish installing. Otherwise it applies the next time you quit."
              onClick={() => void window.api.invoke('update:install')}
            >
              Update {update.version ?? ''} ready — restart
            </button>
          </Caption1>
        )}
        {/* A failure used to be shown nowhere at all, which is how three releases' worth of
            refused installs went unnoticed. Still not a dialog — one line that points at the
            place where the actual reason is written down. */}
        {update?.status === 'error' && (
          <Caption1>
            <button
              type="button"
              className={styles.update}
              title={describeUpdate(update)}
              onClick={() => setTab('settings')}
            >
              Update failed — see Settings
            </button>
          </Caption1>
        )}
        {/* How stale each mirror is, and how long until the next pull. On the right, beside
            the version: it is ambient state, not something that wants a decision. */}
        <SyncRings states={syncStates} />
        {info && (
          <Caption1>
            v{info.version} · electron {info.electron} · node {info.node}
          </Caption1>
        )}
      </div>
    </div>
  );
}
