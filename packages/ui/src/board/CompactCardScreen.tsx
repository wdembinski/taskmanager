/**
 * The compact shell's full-screen card route (F3.7) — `TaskDetail`'s sections drawn one at a
 * time behind a top `TabList`, standing in for the wide pane's own split-screen band plus
 * conversation, which does not fit a phone at all.
 *
 * ## Design decisions fixed here (do not re-derive in later edits)
 *
 * - **Back + title bar, always drawn** — even for an id this tab has no row for yet
 *   (`task` is `null`): the Back control is the only way off this screen when there is
 *   nothing else to show, so it cannot be conditioned on `task` the way the tabs below it
 *   are.
 * - **The tabs are absent for an unknown id.** A `TabList` over sections of a card that
 *   cannot be shown is not a real choice, and `TaskDetail` is never mounted at all in that
 *   case — there is nothing for it to show a section of.
 * - **One sentence for the empty state**, not `TaskDetail`'s own empty-pane icon: that icon
 *   reads "nothing is selected yet", which is true on the wide board's pane but false here —
 *   a compact card route always NAMES a card, so the honest sentence is "this one could not
 *   be found", not an invitation to pick one.
 * - **Every `TaskDetail` prop but `task` and `section` passes straight through** — this
 *   screen draws no section content of its own; it is the tab strip in front of the one pane
 *   that already knows how to draw each section (`TaskDetail`'s own `section` prop, F3.7).
 */
import {
  Button,
  Caption1,
  Tab,
  TabList,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { ChevronLeftRegular } from '@fluentui/react-icons';
import { CARD_SECTIONS, type CardSection } from '../layout/compactRoute';
import { useGlassStyles } from '../shell/GlassPane';
import { TaskDetail, type TaskDetailProps } from '../TaskDetail';

const SECTION_LABEL: Record<CardSection, string> = {
  chat: 'Chat',
  steps: 'Steps',
  changes: 'Changes',
  details: 'Details',
};

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
  titleBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    flexShrink: 0,
    // Edge-to-edge, not a floating pane — overrides `glass.pane`'s rounded corners, the
    // same override `BottomTabBar` makes for the same reason.
    borderRadius: 0,
  },
  title: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    paddingRight: '8px',
  },
  tabs: { flexShrink: 0, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  tab: { minWidth: '44px', minHeight: '44px' },
  body: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
  empty: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
  },
});

export interface CompactCardScreenProps extends Omit<TaskDetailProps, 'section'> {
  /** Which tab is showing. `undefined` task or not, this always has a value — the tab strip
   *  itself is just not drawn for an unknown card. */
  section: CardSection;
  onSectionChange: (section: CardSection) => void;
  onBack: () => void;
}

export function CompactCardScreen({
  task,
  section,
  onSectionChange,
  onBack,
  ...detailProps
}: CompactCardScreenProps): JSX.Element {
  const styles = useStyles();
  const glass = useGlassStyles();
  return (
    <div className={styles.root}>
      <div className={mergeClasses(glass.pane, styles.titleBar)}>
        <Button
          appearance="transparent"
          icon={<ChevronLeftRegular />}
          onClick={onBack}
          aria-label="Back"
        />
        <Caption1 className={styles.title}>{task ? task.title : 'Card not found'}</Caption1>
      </div>
      {task ? (
        <>
          <TabList
            className={styles.tabs}
            selectedValue={section}
            onTabSelect={(_e, data) => onSectionChange(data.value as CardSection)}
          >
            {CARD_SECTIONS.map((s) => (
              <Tab key={s} value={s} className={styles.tab}>
                {SECTION_LABEL[s]}
              </Tab>
            ))}
          </TabList>
          <div className={styles.body}>
            <TaskDetail task={task} section={section} {...detailProps} />
          </div>
        </>
      ) : (
        <Caption1 className={styles.empty}>
          This card could not be found — it may have been removed, or has not synced to this tab
          yet.
        </Caption1>
      )}
    </div>
  );
}
