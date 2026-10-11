/**
 * AutomationsView — the Automations tab (F1.15): every automation the account knows about,
 * with its trigger, its next run, its last outcome, and the controls that used to require
 * opening the editor for everything (enable, run now, delete). List and Week are two readings
 * of the same data — `WeekCalendar`'s `layoutWeek` versus this screen's own row-per-automation
 * — switched with a toggle rather than two tabs, because they answer two different questions
 * about the same automations rather than two different sets of them.
 *
 * `AutomationEditor` (F1.14) does the actual create/edit form; this screen only decides when
 * it is open and on which automation. New automations get a `null` automation, same
 * convention as `ProjectAdmin`'s `ProjectForm`.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Card,
  CardHeader,
  Caption1,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  MessageBar,
  MessageBarBody,
  Spinner,
  Subtitle2,
  Switch,
  Text,
  ToggleButton,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { AddRegular } from '@fluentui/react-icons';
import type { Automation, AutomationRun } from '@tm/shared/automation';
import { nextOccurrence } from '@tm/shared/automationSchedule';
import type { Project } from '@tm/shared/model';
import { PaneLoading } from '../PaneLoading';
import { type BadgeColor } from '../taskStatus';
import { useInitialLoad } from '../useInitialLoad';
import { useTransport } from '../transport';
import { AutomationEditor } from './AutomationEditor';
import { lastRunByAutomation, triggerLabel } from './automationsViewModel';
import { type OutcomeTone, outcomeTone } from './weekCalendarLayout';
import { NextRunsRail } from './NextRunsRail';
import { RunLogDrawer } from './RunLogDrawer';
import { WeekCalendar } from './WeekCalendar';

const useStyles = makeStyles({
  pane: { display: 'flex', flexDirection: 'column', gap: '16px', height: '100%', minHeight: 0 },
  toolbar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' },
  toggles: { display: 'flex', gap: '4px' },
  body: { display: 'flex', gap: '20px', flex: 1, minHeight: 0 },
  main: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    overflowY: 'auto',
  },
  rail: { flex: '0 0 280px', minWidth: 0 },
  list: { display: 'flex', flexDirection: 'column', gap: '8px' },
  card: { padding: '4px' },
  headerText: { display: 'flex', flexDirection: 'column', gap: '4px' },
  nameRow: { display: 'flex', alignItems: 'center', gap: '8px' },
  disabledName: { color: tokens.colorNeutralForeground3 },
  metaRow: { display: 'flex', alignItems: 'center', gap: '10px' },
  hint: { color: tokens.colorNeutralForeground3 },
  actions: { display: 'flex', alignItems: 'center', gap: '6px' },
});

/** `OutcomeTone` names a colour budget, not a Fluent prop — this is the one place that
 *  translates it to a `Badge` colour. `neutral` becomes `subtle` because Fluent's `Badge`
 *  has no colour named that. */
const TONE_BADGE_COLOR: Record<OutcomeTone, BadgeColor> = {
  brand: 'brand',
  warning: 'warning',
  danger: 'danger',
  neutral: 'subtle',
};

const OUTCOME_LABEL: Record<AutomationRun['status'], string> = {
  reserved: 'Reserved',
  started: 'Started',
  parked: 'Parked',
  refused: 'Refused',
  skipped: 'Skipped',
  duplicate: 'Duplicate',
  error: 'Error',
};

type AutomationsBoardView = 'list' | 'week';

/** `a`'s next scheduled firing, or `null` for a disabled automation, a tracker trigger, or an
 *  unresolvable time zone — none of those have one to show. */
function nextRunOf(a: Automation, now: number): number | null {
  if (!a.enabled || a.trigger.kind !== 'schedule') return null;
  try {
    return nextOccurrence(a.trigger.schedule, now, a.timeZone);
  } catch {
    return null;
  }
}

export function AutomationsView(): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();

  const [automations, setAutomations] = useState<Automation[] | null>(null);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [view, setView] = useState<AutomationsBoardView>('list');
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ open: boolean; automation: Automation | null }>({
    open: false,
    automation: null,
  });
  const [deleting, setDeleting] = useState<Automation | null>(null);
  const [viewingRuns, setViewingRuns] = useState<Automation | null>(null);

  const seed = useCallback(async () => {
    const [allAutomations, allRuns, allProjects] = await Promise.all([
      transport.invoke('automation:list'),
      transport.invoke('automation:runs', null, 500),
      transport.invoke('project:list'),
    ]);
    setAutomations(allAutomations);
    setRuns(allRuns);
    setProjects(allProjects.map((p) => p.project));
  }, [transport]);
  const initial = useInitialLoad(seed);

  useEffect(() => transport.on('automations:changed', setAutomations), [transport]);

  const lastRun = lastRunByAutomation(runs);

  async function setEnabled(automation: Automation, enabled: boolean): Promise<void> {
    setBusyId(automation.id);
    setError(null);
    try {
      await transport.invoke('automation:setEnabled', automation.id, enabled);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function runNow(automation: Automation): Promise<void> {
    setBusyId(automation.id);
    setError(null);
    try {
      const run = await transport.invoke('automation:runNow', automation.id);
      setRuns((prev) => [run, ...prev]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(automation: Automation): Promise<void> {
    setBusyId(automation.id);
    setError(null);
    try {
      await transport.invoke('automation:delete', automation.id);
      setDeleting(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  if (automations === null) {
    return (
      <PaneLoading
        label="Loading automations…"
        error={initial.error}
        onRetry={initial.retry}
        shape="rows"
      />
    );
  }

  const now = Date.now();
  const defaultTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <div className={styles.pane}>
      <div className={styles.toolbar}>
        <Subtitle2>Automations</Subtitle2>
        <div className={styles.toggles}>
          <ToggleButton
            size="small"
            appearance="subtle"
            checked={view === 'list'}
            onClick={() => setView('list')}
          >
            List
          </ToggleButton>
          <ToggleButton
            size="small"
            appearance="subtle"
            checked={view === 'week'}
            onClick={() => setView('week')}
          >
            Week
          </ToggleButton>
        </div>
        <Button
          appearance="primary"
          icon={<AddRegular />}
          onClick={() => setEditing({ open: true, automation: null })}
        >
          New automation
        </Button>
      </div>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.body}>
        <div className={styles.main}>
          {view === 'week' ? (
            <WeekCalendar
              automations={automations}
              runs={runs}
              now={now}
              viewTz={defaultTimeZone}
            />
          ) : automations.length === 0 ? (
            <Body1 className={styles.hint}>
              No automations yet — add one to start a card on a schedule or a tracker event.
            </Body1>
          ) : (
            <div className={styles.list}>
              {automations.map((automation) => {
                const last = lastRun.get(automation.id) ?? null;
                const nextAt = nextRunOf(automation, now);
                const busy = busyId === automation.id;
                return (
                  <Card key={automation.id} className={styles.card}>
                    <CardHeader
                      header={
                        <div className={styles.headerText}>
                          <div className={styles.nameRow}>
                            <Text
                              weight="semibold"
                              className={automation.enabled ? undefined : styles.disabledName}
                            >
                              {automation.name}
                            </Text>
                            {last && (
                              <Badge
                                appearance="tint"
                                color={TONE_BADGE_COLOR[outcomeTone(last.status)]}
                              >
                                {OUTCOME_LABEL[last.status]}
                              </Badge>
                            )}
                          </div>
                          <div className={styles.metaRow}>
                            <Caption1 className={styles.hint}>{triggerLabel(automation)}</Caption1>
                            {nextAt && (
                              <Caption1 className={styles.hint}>
                                Next: {new Date(nextAt).toLocaleString()}
                              </Caption1>
                            )}
                          </div>
                        </div>
                      }
                      action={
                        <div className={styles.actions}>
                          <Switch
                            checked={automation.enabled}
                            disabled={busy}
                            label={automation.enabled ? 'Enabled' : 'Disabled'}
                            onChange={(_e, d) => void setEnabled(automation, Boolean(d.checked))}
                          />
                          <Button
                            size="small"
                            disabled={busy}
                            onClick={() => void runNow(automation)}
                          >
                            {busy ? <Spinner size="tiny" /> : 'Run now'}
                          </Button>
                          <Button
                            size="small"
                            onClick={() => setEditing({ open: true, automation })}
                          >
                            Edit
                          </Button>
                          <Button size="small" onClick={() => setViewingRuns(automation)}>
                            Runs
                          </Button>
                          <Button size="small" onClick={() => setDeleting(automation)}>
                            Delete
                          </Button>
                        </div>
                      }
                    />
                  </Card>
                );
              })}
            </div>
          )}
        </div>
        <div className={styles.rail}>
          <NextRunsRail automations={automations} now={now} />
        </div>
      </div>

      <AutomationEditor
        open={editing.open}
        automation={editing.automation}
        projects={projects}
        defaultTimeZone={defaultTimeZone}
        onSave={async (automation) => {
          await transport.invoke('automation:save', automation);
        }}
        onDismiss={() => setEditing({ open: false, automation: null })}
      />

      <Dialog open={deleting !== null} onOpenChange={(_e, d) => !d.open && setDeleting(null)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Delete this automation?</DialogTitle>
            <DialogContent>
              <Text>
                <b>{deleting?.name}</b> stops firing immediately. Its past runs stay in the run log;
                this cannot be undone.
              </Text>
            </DialogContent>
            <DialogActions>
              <Button
                appearance="secondary"
                disabled={busyId !== null}
                onClick={() => setDeleting(null)}
              >
                Cancel
              </Button>
              <Button
                appearance="primary"
                disabled={busyId !== null}
                icon={busyId === deleting?.id ? <Spinner size="tiny" /> : undefined}
                onClick={() => deleting && void remove(deleting)}
              >
                {busyId === deleting?.id ? 'Deleting…' : 'Delete'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <RunLogDrawer
        automation={viewingRuns}
        runs={viewingRuns ? runs.filter((r) => r.automationId === viewingRuns.id) : []}
        onClose={() => setViewingRuns(null)}
      />
    </div>
  );
}
