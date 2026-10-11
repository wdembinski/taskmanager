/**
 * RunLogDrawer — one automation's run history (F1.15): what fired, what it did about it, and
 * why when it didn't. `RUN_REFUSAL_MESSAGE` (`@tm/shared/scheduler`) is the same sentence the
 * scheduler itself shows for a manual Start refusal, so a `refused`/`parked` run reads
 * identically here and on the card it tried to start.
 *
 * `onOpenTask` is the same host-decides callback `TaskDetail`/`TaskAgentPanel` already use —
 * this component only fires it with the run's `taskId`; the host owns what "open" means.
 */
import {
  Badge,
  Button,
  Caption1,
  DrawerBody,
  DrawerHeader,
  DrawerHeaderTitle,
  OverlayDrawer,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { DismissRegular } from '@fluentui/react-icons';
import type { Automation, AutomationRun } from '@tm/shared/automation';
import { RUN_REFUSAL_MESSAGE } from '@tm/shared/scheduler';
import { type BadgeColor } from '../taskStatus';
import { type OutcomeTone, outcomeTone } from './weekCalendarLayout';

const TONE_BADGE_COLOR: Record<OutcomeTone, BadgeColor> = {
  brand: 'brand',
  warning: 'warning',
  danger: 'danger',
  neutral: 'subtle',
};

const KIND_LABEL: Record<AutomationRun['kind'], string> = {
  scheduled: 'Scheduled',
  'catch-up': 'Catch-up',
  manual: 'Manual',
  tracker: 'Tracker',
};

const useStyles = makeStyles({
  surface: { minWidth: '380px' },
  list: { display: 'flex', flexDirection: 'column', gap: '12px' },
  row: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    padding: '10px',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  top: { display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'space-between' },
  badges: { display: 'flex', alignItems: 'center', gap: '6px' },
  hint: { color: tokens.colorNeutralForeground3 },
  message: { color: tokens.colorPaletteYellowForeground1 },
});

export interface RunLogDrawerProps {
  /** `null` closes the drawer — the open automation otherwise. */
  automation: Automation | null;
  /** This automation's runs — caller's to filter (`AutomationsView` already does). */
  runs: AutomationRun[];
  onClose: () => void;
  onOpenTask?: (taskId: string) => void;
}

export function RunLogDrawer({
  automation,
  runs,
  onClose,
  onOpenTask,
}: RunLogDrawerProps): JSX.Element {
  const styles = useStyles();
  const sorted = [...runs].sort((a, b) => b.at - a.at);

  return (
    <OverlayDrawer
      open={automation !== null}
      position="end"
      size="medium"
      onOpenChange={(_e, d) => !d.open && onClose()}
    >
      <DrawerHeader>
        <DrawerHeaderTitle
          action={
            <Button
              appearance="subtle"
              icon={<DismissRegular />}
              aria-label="Close"
              onClick={onClose}
            />
          }
        >
          {automation ? `${automation.name} — Run log` : ''}
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody className={styles.surface}>
        {sorted.length === 0 ? (
          <Caption1 className={styles.hint}>No runs recorded yet.</Caption1>
        ) : (
          <div className={styles.list}>
            {sorted.map((run) => {
              const taskId = run.taskId;
              return (
                <div key={run.id} className={styles.row}>
                  <div className={styles.top}>
                    <div className={styles.badges}>
                      <Badge appearance="tint" color={TONE_BADGE_COLOR[outcomeTone(run.status)]}>
                        {run.status}
                      </Badge>
                      <Caption1 className={styles.hint}>{KIND_LABEL[run.kind]}</Caption1>
                    </div>
                    <Caption1 className={styles.hint}>{new Date(run.at).toLocaleString()}</Caption1>
                  </div>

                  {run.refusal && (
                    <Text className={styles.message}>{RUN_REFUSAL_MESSAGE[run.refusal]}</Text>
                  )}

                  {run.skippedCount > 0 && (
                    <Caption1 className={styles.hint}>
                      {run.skippedCount} earlier occurrence{run.skippedCount === 1 ? '' : 's'}{' '}
                      skipped
                    </Caption1>
                  )}

                  {run.note && <Caption1>{run.note}</Caption1>}

                  {taskId && (
                    <div>
                      <Button size="small" onClick={() => onOpenTask?.(taskId)}>
                        Open card
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </DrawerBody>
    </OverlayDrawer>
  );
}
