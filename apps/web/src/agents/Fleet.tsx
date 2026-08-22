/**
 * Fleet — cross-project view of the agent workforce (cloud as central control for projects,
 * step 6). The board's per-card spinner only ever shows one card on one project; this answers
 * the two questions that view cannot: which agent profiles exist at all, and where every
 * queued ticket currently stands, across every project the account has — the GitHub-Actions /
 * Copilot-dashboard piece of the ask.
 *
 * REST, not `Transport`: profiles and assignments have no IPC channel — `@tm/shared/agent`'s
 * own docstring explains why (they live on the server only, for ANY desktop serving the
 * project to claim on its next poll, not one open Client to relay a command to) — so this
 * polls `agentsApi.ts` directly the same way `ProjectsHub`/`TicketDetailPage` write over
 * `projectsApi.ts`, rather than `useTransport()` like `Performance`/`Attention` in `@tm/ui`.
 * The loading/retry/collapsible-drilldown shape below still follows those two: the DATA being
 * cross-project is the same problem regardless of which transport reaches it.
 */
import { useCallback, useEffect, useState } from 'react';
import { Body1, Caption1, Text, makeStyles, tokens } from '@fluentui/react-components';
import { ChevronDownRegular, ChevronRightRegular } from '@fluentui/react-icons';
import type { AgentProfile, Assignment, AssignmentStatus } from '@tm/shared/agent';
import { PERMISSION_MODE_LABELS } from '@tm/shared/session';
import { PaneLoading } from '@tm/ui/PaneLoading';
import { useInitialLoad } from '@tm/ui/useInitialLoad';
import type { CloudBoardState } from '../board/cloudBoardStore';
import { listAgentProfiles, listAssignments } from './agentsApi';
import { AssignmentStatusBadge } from './AssignmentStatusBadge';
import type { ProjectsApiDeps } from '../projects/projectsApi';

/** Refresh cadence for the queue view. Assignments change on the order of a desktop's own
 *  poll (seconds, not the per-second usage telemetry `Performance` ticks), so a slower,
 *  plain interval is enough — no push event exists for this resource. */
const POLL_MS = 5000;

const STATUS_ORDER: AssignmentStatus[] = ['queued', 'claimed', 'running', 'done', 'failed'];

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    minHeight: 0,
    overflowY: 'auto',
    paddingRight: '4px',
  },
  header: { display: 'flex', alignItems: 'center', gap: '10px' },
  section: { display: 'flex', flexDirection: 'column', gap: '8px' },
  sectionTitle: { fontSize: '12px', fontWeight: 600, color: tokens.colorNeutralForeground2 },
  tiles: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
    gap: '10px',
  },
  tile: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: '10px 12px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  tileValue: { fontSize: '20px', fontWeight: 700, fontVariantNumeric: 'tabular-nums' },
  tileLabel: {
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
    textTransform: 'uppercase',
    letterSpacing: '0.03em',
  },
  profiles: { display: 'flex', flexDirection: 'column', gap: '6px' },
  profile: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '10px 12px',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  profileName: { fontWeight: 600, flex: 1, minWidth: 0 },
  profileMeta: { color: tokens.colorNeutralForeground3, whiteSpace: 'nowrap' },
  project: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    paddingBottom: '8px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  projectHead: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    cursor: 'pointer',
    background: 'none',
    border: 'none',
    padding: 0,
    textAlign: 'left',
    color: 'inherit',
    width: '100%',
  },
  chevron: { display: 'flex', alignItems: 'center', color: tokens.colorNeutralForeground3 },
  projectName: { fontSize: '13px', fontWeight: 600, flex: 1, minWidth: 0 },
  projectCount: { color: tokens.colorNeutralForeground3, fontSize: '12px' },
  rows: { display: 'flex', flexDirection: 'column', gap: '6px', paddingLeft: '22px' },
  row: {
    display: 'grid',
    gridTemplateColumns: '1fr auto auto',
    gap: '4px 10px',
    alignItems: 'center',
    fontSize: '13px',
  },
  rowLabel: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rowMeta: {
    color: tokens.colorNeutralForeground3,
    fontSize: '12px',
    whiteSpace: 'nowrap',
  },
  empty: { color: tokens.colorNeutralForeground3, padding: '24px 0', textAlign: 'center' },
});

export interface FleetProps {
  state: CloudBoardState;
  apiDeps: ProjectsApiDeps;
}

interface FleetData {
  profiles: AgentProfile[];
  assignments: Assignment[];
}

export function Fleet({ state, apiDeps }: FleetProps): JSX.Element {
  const styles = useStyles();
  const [data, setData] = useState<FleetData | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    const [profiles, assignments] = await Promise.all([
      listAgentProfiles(apiDeps),
      listAssignments(apiDeps),
    ]);
    setData({ profiles, assignments });
  }, [apiDeps]);

  const initial = useInitialLoad(refresh);

  useEffect(() => {
    const id = setInterval(() => void refresh().catch(() => undefined), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  if (!data) {
    return <PaneLoading label="Loading fleet…" error={initial.error} onRetry={initial.retry} />;
  }

  const { profiles, assignments } = data;
  const counts: Record<AssignmentStatus, number> = {
    queued: 0,
    claimed: 0,
    running: 0,
    done: 0,
    failed: 0,
  };
  for (const a of assignments) counts[a.status]++;

  const byProject = new Map<string, Assignment[]>();
  for (const a of assignments) {
    const list = byProject.get(a.projectId) ?? [];
    list.push(a);
    byProject.set(a.projectId, list);
  }
  const projectGroups = [...byProject.entries()]
    .map(([projectId, list]) => ({
      projectId,
      label: state.projects[projectId]?.name ?? projectId,
      assignments: list.slice().sort((a, b) => b.createdAt - a.createdAt),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Text size={500} weight="semibold">
          Fleet
        </Text>
      </div>

      <div className={styles.section}>
        <span className={styles.sectionTitle}>Assignment queue</span>
        <div className={styles.tiles}>
          {STATUS_ORDER.map((status) => (
            <div key={status} className={styles.tile}>
              <span className={styles.tileValue}>{counts[status]}</span>
              <span className={styles.tileLabel}>{status}</span>
            </div>
          ))}
        </div>
      </div>

      <div className={styles.section}>
        <span className={styles.sectionTitle}>Agent profiles ({profiles.length})</span>
        {profiles.length === 0 ? (
          <Body1 className={styles.empty}>
            No agent profiles yet. Add one in the desktop app&rsquo;s Settings.
          </Body1>
        ) : (
          <div className={styles.profiles}>
            {profiles.map((p) => (
              <div key={p.id} className={styles.profile}>
                <span className={styles.profileName}>{p.name}</span>
                <Caption1 className={styles.profileMeta}>
                  {p.model} · {PERMISSION_MODE_LABELS[p.permissionMode]}
                  {p.defaultProjectId &&
                    ` · ${state.projects[p.defaultProjectId]?.name ?? p.defaultProjectId}`}
                </Caption1>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={styles.section}>
        <span className={styles.sectionTitle}>By project</span>
        {projectGroups.length === 0 ? (
          <div className={styles.empty}>No assignments queued yet.</div>
        ) : (
          projectGroups.map((group) => {
            const expanded = !collapsed.has(group.projectId);
            return (
              <div key={group.projectId} className={styles.project}>
                <button
                  className={styles.projectHead}
                  onClick={() => toggle(group.projectId)}
                  aria-expanded={expanded}
                >
                  <span className={styles.chevron}>
                    {expanded ? <ChevronDownRegular /> : <ChevronRightRegular />}
                  </span>
                  <span className={styles.projectName}>{group.label}</span>
                  <span className={styles.projectCount}>{group.assignments.length}</span>
                </button>
                {expanded && (
                  <div className={styles.rows}>
                    {group.assignments.map((a) => {
                      const ticket = state.tasks[a.ticketId];
                      const profile = profiles.find((p) => p.id === a.profileId);
                      return (
                        <div key={a.id} className={styles.row}>
                          <span className={styles.rowLabel} title={ticket?.title ?? a.ticketId}>
                            {ticket ? (ticket.ticketKey ?? ticket.title) : a.ticketId}
                          </span>
                          <Caption1 className={styles.rowMeta}>
                            {profile?.name ?? a.profileId}
                          </Caption1>
                          <AssignmentStatusBadge status={a.status} />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
