/**
 * The two surfaces `issueView.ts`'s `layout` puts a ticket in, on the Tickets screen
 * (F13.13): `IssuePeek`, a slide-in panel beside the list, and `IssueFullPage`, which
 * replaces the list entirely. Each takes the same `TaskDetailHost` element as `children` —
 * both panes show the identical pane, just framed differently — so `Projects.tsx` builds it
 * once and hands it to whichever of the two is showing.
 *
 * Both sit on `GlassPane` (`shell/GlassPane.tsx`), per F13's restraint rule that glass means
 * *panes* — matching the attached peek and full-screen mockups. `IssuePeek` keeps the 40%
 * flex basis and `minWidth: 0` rules `boardLayout.right` already applies to the board's own
 * detail pane — reimplemented here rather than imported, since `GlassPane` must win the
 * background (its own near-opaque/`backdrop-filter` pair), and a caller's `className` wins
 * over `GlassPane`'s own styles for any property both declare.
 */
import type { ReactNode } from 'react';
import { Button, Text, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { ArrowLeftRegular, ArrowMaximizeRegular, DismissRegular } from '@fluentui/react-icons';
import { GlassPane } from '../shell/GlassPane';

const useStyles = makeStyles({
  peek: {
    flex: '0 0 40%',
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    overflow: 'hidden',
    animationName: {
      from: { opacity: 0, transform: 'translateX(12px)' },
      to: { opacity: 1, transform: 'translateX(0)' },
    },
    animationDuration: '160ms',
    animationTimingFunction: 'ease-out',
    '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
  },
  peekHeader: {
    flex: '0 0 auto',
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    padding: '6px',
  },
  // Takes the header's free width so the two icons stay pinned right, and lets the crumb
  // itself shrink to an ellipsis rather than push them out.
  peekCrumb: { flex: 1, minWidth: 0, paddingLeft: '10px', paddingRight: '6px' },
  peekKey: { marginRight: '10px' },
  peekBody: { flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' },
  full: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    overflow: 'hidden',
  },
  crumbRow: {
    flex: '0 0 auto',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '10px 16px',
  },
  crumbBack: { flexShrink: 0 },
  crumbText: {
    color: `var(--tm-text-muted, ${tokens.colorNeutralForeground3})`,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  fullBody: { flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' },
});

export interface IssuePeekProps {
  /** The project/milestone/epic breadcrumb (`issueBreadcrumb`), same as `IssueFullPage`'s. */
  breadcrumb: readonly string[];
  /** The ticket's own key (`TM-71`, or a tracker's `ENG-1`), drawn ahead of the crumbs. */
  ticketKey?: string;
  /** The peek header's "Open full screen" icon button — dispatches `expand`. */
  onExpand: () => void;
  /** The peek header's "Close" icon button — dispatches `close`. */
  onClose: () => void;
  /** The `TaskDetailHost` element to show inside — identical to `IssueFullPage`'s. */
  children: ReactNode;
}

/** The peek: a `GlassPane` beside the list, matching the attached peek mockup's two
 *  top-right icons, with the key and breadcrumb to their left. */
export function IssuePeek({
  breadcrumb,
  ticketKey,
  onExpand,
  onClose,
  children,
}: IssuePeekProps): JSX.Element {
  const styles = useStyles();
  return (
    <GlassPane className={styles.peek}>
      <div className={styles.peekHeader}>
        <Text className={mergeClasses(styles.crumbText, styles.peekCrumb)} data-issue-breadcrumb>
          {ticketKey && <span className={styles.peekKey}>{ticketKey}</span>}
          {breadcrumb.join(' › ')}
        </Text>
        <Button
          appearance="subtle"
          size="small"
          icon={<ArrowMaximizeRegular />}
          title="Open full screen (Enter)"
          aria-label="Open full screen"
          onClick={onExpand}
        />
        <Button
          appearance="subtle"
          size="small"
          icon={<DismissRegular />}
          title="Close (Esc)"
          aria-label="Close"
          onClick={onClose}
        />
      </div>
      <div className={styles.peekBody}>{children}</div>
    </GlassPane>
  );
}

export interface IssueFullPageProps {
  /** The project/milestone/epic breadcrumb (`issueBreadcrumb`) — already resolved, so this
   *  component only joins and renders it. */
  breadcrumb: readonly string[];
  /** The breadcrumb row's "Back to list" button — dispatches `escape`. */
  onBack: () => void;
  /** The `TaskDetailHost` element to show inside — identical to `IssuePeek`'s. */
  children: ReactNode;
}

/** The full-screen page: the list and picker columns are not rendered at all while this is
 *  showing — just the breadcrumb row above the same detail pane the peek shows. */
export function IssueFullPage({ breadcrumb, onBack, children }: IssueFullPageProps): JSX.Element {
  const styles = useStyles();
  return (
    <GlassPane className={styles.full}>
      <div className={styles.crumbRow}>
        <Button
          className={styles.crumbBack}
          appearance="subtle"
          size="small"
          icon={<ArrowLeftRegular />}
          onClick={onBack}
        >
          Back to list
        </Button>
        <Text className={styles.crumbText} data-issue-breadcrumb>
          {breadcrumb.join(' › ')}
        </Text>
      </div>
      <div className={styles.fullBody}>{children}</div>
    </GlassPane>
  );
}
