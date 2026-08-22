/**
 * "Assign to an agent" on the ticket-detail page — the phase-5 queue's own entry point,
 * distinct from the board's `AssignAgentDialog` (which delegates a card to a desktop-local
 * agent project, synchronously, with no queue — see that file's docstring). This queues the
 * ticket against a named profile and leaves it for ANY desktop serving the project to claim
 * on its next poll (`apps/client/src/main/assignmentPoller.ts`), which is what makes this the
 * cloud's own assign action rather than one open desktop's.
 *
 * Independent of `TicketDetailPage`'s form/Save: an assignment is a separate resource from
 * the ticket itself, so this loads and refreshes on its own rather than folding into that
 * page's `FormState`/dirty-check.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Body1,
  Button,
  Caption1,
  Dropdown,
  Field,
  MessageBar,
  MessageBarBody,
  Option,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { AgentProfile, Assignment } from '@tm/shared/agent';
import type { Task } from '@tm/shared/model';
import { createAssignment, listAgentProfiles, listAssignments } from './agentsApi';
import { AssignmentStatusBadge } from './AssignmentStatusBadge';
import type { ProjectsApiDeps } from '../projects/projectsApi';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '12px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  title: { fontSize: '13px', fontWeight: 600 },
  row: { display: 'flex', gap: '8px', alignItems: 'end', flexWrap: 'wrap' },
  dropdown: { minWidth: '200px' },
  current: { display: 'flex', alignItems: 'center', gap: '8px' },
  hint: { color: tokens.colorNeutralForeground3 },
});

/** A claim/run in progress still owns the ticket — queuing another agent on top of it would
 *  just race the one already working it. `done`/`failed` are terminal, so those free the
 *  ticket up to be queued again. */
const ACTIVE_STATUSES = new Set(['queued', 'claimed', 'running']);

export interface AssignAgentSectionProps {
  task: Task;
  apiDeps: ProjectsApiDeps;
}

export function AssignAgentSection({ task, apiDeps }: AssignAgentSectionProps): JSX.Element {
  const styles = useStyles();
  const [profiles, setProfiles] = useState<AgentProfile[] | null>(null);
  const [latest, setLatest] = useState<Assignment | null>(null);
  const [profileId, setProfileId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [p, a] = await Promise.all([
      listAgentProfiles(apiDeps),
      listAssignments(apiDeps, { projectId: task.projectId }),
    ]);
    setProfiles(p);
    const forTicket = a
      .filter((x) => x.ticketId === task.id)
      .sort((x, y) => y.createdAt - x.createdAt);
    setLatest(forTicket[0] ?? null);
    setProfileId((current) => current || (p[0]?.id ?? ''));
  }, [apiDeps, task.projectId, task.id]);

  useEffect(() => {
    setError(null);
    load().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    // Re-load whenever a DIFFERENT ticket is shown, not on every re-render of this one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  const assign = async (): Promise<void> => {
    if (!profileId) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createAssignment(apiDeps, {
        projectId: task.projectId,
        ticketId: task.id,
        profileId,
      });
      setLatest(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const active = latest && ACTIVE_STATUSES.has(latest.status) ? latest : null;

  return (
    <div className={styles.root}>
      <span className={styles.title}>Agent</span>

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      {active && (
        <div className={styles.current}>
          <Caption1>
            Queued for {profiles?.find((p) => p.id === active.profileId)?.name ?? 'an agent'}
          </Caption1>
          <AssignmentStatusBadge status={active.status} />
        </div>
      )}

      {profiles === null ? (
        <Caption1 className={styles.hint}>Loading agent profiles…</Caption1>
      ) : profiles.length === 0 ? (
        <Body1 className={styles.hint}>
          No agent profiles yet. Add one in the desktop app&rsquo;s Settings.
        </Body1>
      ) : (
        <div className={styles.row}>
          <Field label={active ? 'Queue another agent' : 'Profile'}>
            <Dropdown
              className={styles.dropdown}
              value={profiles.find((p) => p.id === profileId)?.name ?? ''}
              selectedOptions={profileId ? [profileId] : []}
              onOptionSelect={(_e, d) => d.optionValue && setProfileId(d.optionValue)}
            >
              {profiles.map((p) => (
                <Option key={p.id} value={p.id} text={p.name}>
                  {p.name}
                </Option>
              ))}
            </Dropdown>
          </Field>
          <Button appearance="primary" disabled={busy || !profileId} onClick={() => void assign()}>
            {busy ? 'Queuing…' : 'Queue for agent'}
          </Button>
        </div>
      )}
    </div>
  );
}
