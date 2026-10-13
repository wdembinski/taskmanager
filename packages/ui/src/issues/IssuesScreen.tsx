/**
 * IssuesScreen (F5.8) — browse a tracker's open issues and hand one to an agent without first
 * making it appear on the board.
 *
 * Wiring only over `issueBrowserState`'s pure reducer (F5.7): every state transition it allows
 * for — picking a provider, searching, filtering by label, paging, selecting an issue, editing
 * a hand-off draft — is a direct call into that module. This file owns only the IPC calls, the
 * `seq` race guard around them (the same shape as `activity/ActivityFeed.tsx`'s own load),
 * the drafts↔localStorage bridge `issueBrowserState.ts` hands off to F5.8, and the hand-off
 * panel's project/model/mode pickers — reused from `agentPickers.ts`/`ModelField.tsx`, exactly
 * as `AssignAgentDialog` renders them.
 *
 * "Add to board" and "Hand to agent" are wired here as plain `issues:import` /
 * `task:assignAgent` calls — F5.9 replaces this with a tested pure `handOffSteps` module that
 * adds refusal-aware messaging and a toast; this step is the screen those steps will plug into.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Option,
  Tab,
  TabList,
  Textarea,
  Title3,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { agentProjectsOf } from '@tm/shared/agentProjects';
import {
  ISSUE_PROVIDERS,
  type IssueProviderId,
  type IssueQuery,
  type IssueSummary,
} from '@tm/shared/issues';
import type { Project } from '@tm/shared/model';
import { PERMISSION_MODE_LABELS } from '@tm/shared/session';
import type { ClaudeModel, PermissionMode } from '@tm/shared/session';
import type { AppSettings } from '@tm/shared/settings';
import { DEFAULT_PERMISSION_MODE, modeForPickedProject, PERMISSION_MODES } from '../agentPickers';
import { relativeAge } from '../gitGraphView';
import { cardModelFromOption, PROJECT_DEFAULT, projectDefaultLabel } from '../modelChoice';
import { ModelField } from '../ModelField';
import { PaneLoading } from '../PaneLoading';
import { useTransport } from '../transport';
import { useInitialLoad } from '../useInitialLoad';
import {
  EMPTY_ISSUE_BROWSER,
  editDraft,
  forgetIssueDraft,
  issueQueryFor,
  loadStarted,
  pageArrived,
  pageFailed,
  parseDrafts,
  promptFor,
  selectIssue,
  selectProvider,
  serializeDrafts,
  setLabels,
  setSearch,
  toggleLabel,
  visibleFacetLabels,
  type IssueBrowserState,
} from './issueBrowserState';
import { handOffAvailability } from './issueHandOff';

/** How long to wait after the last keystroke before spending a fresh `issues:list` call on it
 *  — GitHub search is 30 req/min (F5's own design doc), so typing must not fire one per key. */
const SEARCH_DEBOUNCE_MS = 400;

const PROVIDER_LABEL: Record<IssueProviderId, string> = {
  jira: 'JIRA',
  github: 'GitHub',
  gitlab: 'GitLab',
};

const DRAFTS_STORAGE_KEY = 'tm.issues.drafts';

/** Best-effort read — a disabled/unavailable `localStorage` (private browsing, quota) means
 *  no drafts rather than a broken screen. */
function loadStoredDrafts(): Readonly<Record<string, string>> {
  try {
    return parseDrafts(localStorage.getItem(DRAFTS_STORAGE_KEY));
  } catch {
    return {};
  }
}

function saveStoredDrafts(drafts: Readonly<Record<string, string>>): void {
  try {
    localStorage.setItem(DRAFTS_STORAGE_KEY, serializeDrafts(drafts));
  } catch {
    // Best-effort only — a draft failing to persist is not worth a broken screen over.
  }
}

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    height: '100%',
    gap: '8px',
  },
  toolbar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' },
  search: { minWidth: '220px', flex: 1 },
  picker: { minWidth: '160px' },
  chips: { display: 'flex', flexWrap: 'wrap', gap: '4px' },
  chip: { cursor: 'pointer' },
  body: { display: 'flex', flex: 1, minHeight: 0, gap: '12px' },
  list: {
    display: 'flex',
    flexDirection: 'column',
    width: '340px',
    flexShrink: 0,
    overflowY: 'auto',
    gap: '4px',
  },
  row: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    padding: '8px',
    borderRadius: tokens.borderRadiusMedium,
    border: 'none',
    background: 'none',
    textAlign: 'left',
    font: 'inherit',
    color: 'inherit',
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  rowSelected: { backgroundColor: tokens.colorNeutralBackground1Selected },
  rowTitleLine: { display: 'flex', alignItems: 'baseline', gap: '6px' },
  rowKey: { color: tokens.colorNeutralForeground3, flexShrink: 0 },
  rowTitle: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  rowMeta: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
  muted: { color: tokens.colorNeutralForeground3 },
  empty: { padding: '24px 4px', color: tokens.colorNeutralForeground3, textAlign: 'center' },
  detail: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    flex: 1,
    minWidth: 0,
    overflowY: 'auto',
  },
  detailHead: { display: 'flex', flexDirection: 'column', gap: '4px' },
  link: { color: tokens.colorBrandForegroundLink, textDecoration: 'none' },
  panel: { display: 'flex', flexDirection: 'column', gap: '8px', maxWidth: '520px' },
  row2: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'start' },
  grow: { flex: 1, minWidth: '180px' },
  actions: { display: 'flex', gap: '8px' },
});

export interface IssuesScreenProps {
  /** Opens an on-board issue's card. Omitted hides the Open button. */
  onOpenTask?: (taskId: string) => void;
}

export function IssuesScreen({ onOpenTask }: IssuesScreenProps): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();

  const [state, setState] = useState<IssueBrowserState>(() => ({
    ...EMPTY_ISSUE_BROWSER,
    drafts: loadStoredDrafts(),
  }));
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [searchDraft, setSearchDraft] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // The hand-off panel's own pickers — unpersisted, and reset whenever the selected issue
  // changes, the same way `AssignAgentDialog` reseeds on a fresh open.
  const [handOffProjectId, setHandOffProjectId] = useState('');
  const [handOffModel, setHandOffModel] = useState<ClaudeModel | null>(null);
  const [handOffMode, setHandOffMode] = useState<PermissionMode>(DEFAULT_PERMISSION_MODE);

  const issued = useRef(0);

  const loadSeed = useCallback(
    () =>
      Promise.all([
        transport.invoke('settings:get').then(setSettings),
        transport.invoke('project:list').then((list) => setProjects(list.map((p) => p.project))),
      ]),
    [transport],
  );
  const initial = useInitialLoad(loadSeed);

  const runLoad = useCallback(
    (query: IssueQuery, seq: number, append: boolean) => {
      setState((prev) => loadStarted(prev, seq, { append }));
      transport.invoke('issues:list', query).then(
        (page) => setState((prev) => pageArrived(prev, seq, page, { append })),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          setState((prev) => pageFailed(prev, seq, message));
        },
      );
    },
    [transport],
  );

  // Auto-select the first connected provider once settings have loaded and nothing is picked.
  useEffect(() => {
    if (!settings || state.provider !== null) return;
    const first = ISSUE_PROVIDERS.find((p) => settings[p].enabled);
    if (first) setState((prev) => selectProvider(prev, first));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  // The search box types faster than the tracker should be asked to answer — see
  // SEARCH_DEBOUNCE_MS. Resyncs whenever the committed search changes from elsewhere (a
  // provider switch clears it).
  useEffect(() => {
    setSearchDraft(state.search);
  }, [state.search]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setState((prev) => setSearch(prev, searchDraft));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchDraft]);

  // A fresh (first-page) load whenever the query provider/search/labels change. Paging
  // ("load more") is fired separately, below.
  const queryKey = JSON.stringify(issueQueryFor(state, null));
  useEffect(() => {
    const query = issueQueryFor(state, null);
    if (!query) return;
    const seq = ++issued.current;
    runLoad(query, seq, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, runLoad]);

  useEffect(() => {
    saveStoredDrafts(state.drafts);
  }, [state.drafts]);

  useEffect(() => {
    setHandOffProjectId('');
    setHandOffModel(null);
    setHandOffMode(DEFAULT_PERMISSION_MODE);
    setActionError(null);
  }, [state.selectedKey]);

  const loadMore = useCallback(() => {
    const query = issueQueryFor(state, state.nextCursor);
    if (!query) return;
    const seq = ++issued.current;
    runLoad(query, seq, true);
  }, [runLoad, state]);

  const agentProjects = useMemo(() => agentProjectsOf(projects), [projects]);

  function pickHandOffProject(id: string): void {
    setHandOffProjectId(id);
    setHandOffMode((current) => modeForPickedProject(agentProjects, id, current));
  }

  function patchOnBoard(key: string, taskId: string): void {
    setState((prev) => ({
      ...prev,
      items: prev.items.map((item) =>
        item.key === key ? { ...item, onBoardTaskId: taskId } : item,
      ),
    }));
  }

  async function addToBoard(issue: IssueSummary): Promise<void> {
    setActionBusy(true);
    setActionError(null);
    try {
      const task = await transport.invoke('issues:import', issue.provider, issue.key);
      patchOnBoard(issue.key, task.id);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(false);
    }
  }

  async function handToAgent(issue: IssueSummary): Promise<void> {
    if (!handOffProjectId) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const task = await transport.invoke('issues:import', issue.provider, issue.key);
      const assigned = await transport.invoke('task:assignAgent', task.id, {
        agentProjectId: handOffProjectId,
        mode: handOffMode,
        model: handOffModel ?? undefined,
        notes: promptFor(state, issue).trim() || undefined,
        start: true,
      });
      patchOnBoard(issue.key, assigned.id);
      setState((prev) => forgetIssueDraft(prev, issue));
      onOpenTask?.(assigned.id);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(false);
    }
  }

  if (!settings) {
    return (
      <PaneLoading
        label="Loading issues…"
        error={initial.error}
        onRetry={initial.retry}
        shape="rows"
      />
    );
  }

  const connected = ISSUE_PROVIDERS.filter((p) => settings[p].enabled);
  const selected = state.items.find((i) => i.key === state.selectedKey) ?? null;
  const facets = visibleFacetLabels(state);

  return (
    <div className={styles.root}>
      <Title3>Issues</Title3>

      {/* `settings` landed (the early return above only guards that), but `project:list`
          can still have failed alongside it — surfaced here rather than silently leaving
          the hand-off panel starved of agent projects. */}
      {initial.error && (
        <MessageBar intent="error">
          <MessageBarBody>{initial.error}</MessageBarBody>
        </MessageBar>
      )}

      {connected.length === 0 ? (
        <MessageBar intent="info">
          <MessageBarBody>
            No tracker is connected. Enable JIRA, GitHub or GitLab in Settings to browse its open
            issues here.
          </MessageBarBody>
        </MessageBar>
      ) : (
        <>
          <TabList
            selectedValue={state.provider ?? undefined}
            onTabSelect={(_e, data) =>
              setState((prev) => selectProvider(prev, data.value as IssueProviderId))
            }
          >
            {connected.map((p) => (
              <Tab key={p} value={p}>
                {PROVIDER_LABEL[p]}
              </Tab>
            ))}
          </TabList>

          <div className={styles.toolbar}>
            <Input
              className={styles.search}
              placeholder="Search issues…"
              value={searchDraft}
              onChange={(_e, d) => setSearchDraft(d.value)}
            />
            <Dropdown
              className={styles.picker}
              multiselect
              placeholder="Labels"
              value={state.selectedLabels.join(', ')}
              selectedOptions={[...state.selectedLabels]}
              onOptionSelect={(_e, data) =>
                setState((prev) => setLabels(prev, data.selectedOptions))
              }
            >
              {facets.map((label) => (
                <Option key={label} value={label}>
                  {label}
                </Option>
              ))}
            </Dropdown>
          </div>

          {/* The selected labels always show as chips here — a filter must never hide the
              fact that it is filtering, even once a later page's own facets omit it. */}
          {state.selectedLabels.length > 0 && (
            <div className={styles.chips}>
              {state.selectedLabels.map((label) => (
                <Badge
                  key={label}
                  className={styles.chip}
                  appearance="tint"
                  color="brand"
                  onClick={() => setState((prev) => toggleLabel(prev, label))}
                  title="Remove this filter"
                >
                  {label} ×
                </Badge>
              ))}
            </div>
          )}

          {state.error && (
            <MessageBar intent="error">
              <MessageBarBody>{state.error}</MessageBarBody>
            </MessageBar>
          )}

          <div className={styles.body}>
            <div className={styles.list}>
              {state.items.length === 0 && !state.loading ? (
                <Body1 className={styles.empty}>No open issues match this filter.</Body1>
              ) : (
                state.items.map((issue) => (
                  <button
                    key={issue.key}
                    type="button"
                    className={mergeClasses(
                      styles.row,
                      issue.key === state.selectedKey && styles.rowSelected,
                    )}
                    onClick={() => setState((prev) => selectIssue(prev, issue.key))}
                  >
                    <div className={styles.rowTitleLine}>
                      <Caption1 className={styles.rowKey}>{issue.key}</Caption1>
                      <Body1 className={styles.rowTitle}>{issue.title}</Body1>
                    </div>
                    <div className={styles.rowMeta}>
                      <Badge appearance="outline" size="small">
                        {issue.state}
                      </Badge>
                      {issue.onBoardTaskId !== null && (
                        <Badge appearance="tint" color="success" size="small">
                          On board
                        </Badge>
                      )}
                      <Caption1 className={styles.muted}>
                        {relativeAge(issue.updatedAt, Date.now())}
                      </Caption1>
                    </div>
                  </button>
                ))
              )}
              {state.loading && <Body1 className={styles.empty}>Loading…</Body1>}
              {state.nextCursor && !state.loading && (
                <Button size="small" appearance="subtle" onClick={loadMore}>
                  Load more
                </Button>
              )}
            </div>

            <div className={styles.detail}>
              {!selected ? (
                <Body1 className={styles.muted}>Select an issue to see its details.</Body1>
              ) : (
                <IssueDetail
                  issue={selected}
                  projects={projects}
                  agentProjects={agentProjects}
                  state={state}
                  onEditDraft={(text) => setState((prev) => editDraft(prev, selected, text))}
                  handOffProjectId={handOffProjectId}
                  onPickProject={pickHandOffProject}
                  handOffModel={handOffModel}
                  onPickModel={setHandOffModel}
                  handOffMode={handOffMode}
                  onPickMode={setHandOffMode}
                  onOpenTask={onOpenTask}
                  actionBusy={actionBusy}
                  actionError={actionError}
                  onAddToBoard={() => void addToBoard(selected)}
                  onHandToAgent={() => void handToAgent(selected)}
                />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

interface IssueDetailProps {
  issue: IssueSummary;
  projects: Project[];
  agentProjects: Project[];
  state: IssueBrowserState;
  onEditDraft: (text: string) => void;
  handOffProjectId: string;
  onPickProject: (id: string) => void;
  handOffModel: ClaudeModel | null;
  onPickModel: (model: ClaudeModel | null) => void;
  handOffMode: PermissionMode;
  onPickMode: (mode: PermissionMode) => void;
  onOpenTask?: (taskId: string) => void;
  actionBusy: boolean;
  actionError: string | null;
  onAddToBoard: () => void;
  onHandToAgent: () => void;
}

function IssueDetail({
  issue,
  projects,
  agentProjects,
  state,
  onEditDraft,
  handOffProjectId,
  onPickProject,
  handOffModel,
  onPickModel,
  handOffMode,
  onPickMode,
  onOpenTask,
  actionBusy,
  actionError,
  onAddToBoard,
  onHandToAgent,
}: IssueDetailProps): JSX.Element {
  const styles = useStyles();
  const availability = handOffAvailability(issue, projects);
  const selectedProject = agentProjects.find((p) => p.id === handOffProjectId) ?? null;

  return (
    <>
      <div className={styles.detailHead}>
        <div className={styles.rowTitleLine}>
          <Caption1 className={styles.rowKey}>{issue.key}</Caption1>
          <Body1>{issue.title}</Body1>
        </div>
        <div className={styles.rowMeta}>
          <a className={styles.link} href={issue.url} target="_blank" rel="noreferrer">
            Open in tracker
          </a>
          <Badge appearance="outline" size="small">
            {issue.state}
          </Badge>
          {issue.type && (
            <Badge appearance="outline" size="small">
              {issue.type}
            </Badge>
          )}
          {issue.assignee && (
            <Caption1 className={styles.muted}>Assigned: {issue.assignee}</Caption1>
          )}
        </div>
        {issue.labels.length > 0 && (
          <div className={styles.chips}>
            {issue.labels.map((label) => (
              <Badge key={label} appearance="tint" size="small">
                {label}
              </Badge>
            ))}
          </div>
        )}
      </div>

      {actionError && (
        <MessageBar intent="error">
          <MessageBarBody>{actionError}</MessageBarBody>
        </MessageBar>
      )}

      {availability.kind === 'on-board' ? (
        <div className={styles.actions}>
          <Badge appearance="tint" color="success">
            On board
          </Badge>
          {onOpenTask && (
            <Button size="small" onClick={() => onOpenTask(availability.taskId)}>
              Open
            </Button>
          )}
        </div>
      ) : (
        <div className={styles.panel}>
          <Field label="Prompt" hint="Handed to the agent, and recorded on the card's timeline.">
            <Textarea
              value={promptFor(state, issue)}
              resize="vertical"
              onChange={(_e, d) => onEditDraft(d.value)}
            />
          </Field>

          {availability.kind === 'no-agent-projects' ? (
            <MessageBar intent="warning">
              <MessageBarBody>{availability.message}</MessageBarBody>
            </MessageBar>
          ) : (
            <>
              <Field label="Agent project" required>
                <Dropdown
                  value={selectedProject?.name ?? ''}
                  selectedOptions={handOffProjectId ? [handOffProjectId] : []}
                  onOptionSelect={(_e, d) => d.optionValue && onPickProject(d.optionValue)}
                >
                  {agentProjects.map((p) => (
                    <Option key={p.id} value={p.id} text={p.name}>
                      {p.name}
                    </Option>
                  ))}
                </Dropdown>
              </Field>
              <div className={styles.row2}>
                <ModelField
                  label="Steps execution model"
                  className={styles.grow}
                  hint={handOffModel ? 'Overrides the project.' : undefined}
                  value={handOffModel ?? PROJECT_DEFAULT}
                  onChange={(v) => onPickModel(cardModelFromOption(v))}
                  sentinel={{ value: PROJECT_DEFAULT, label: projectDefaultLabel(selectedProject) }}
                />
                <Field label="Permission mode" className={styles.grow}>
                  <Dropdown
                    value={PERMISSION_MODE_LABELS[handOffMode]}
                    selectedOptions={[handOffMode]}
                    onOptionSelect={(_e, d) =>
                      d.optionValue && onPickMode(d.optionValue as PermissionMode)
                    }
                  >
                    {PERMISSION_MODES.map((m) => (
                      <Option key={m} value={m} text={PERMISSION_MODE_LABELS[m]}>
                        {PERMISSION_MODE_LABELS[m]}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              </div>
            </>
          )}

          <div className={styles.actions}>
            <Button appearance="secondary" disabled={actionBusy} onClick={onAddToBoard}>
              Add to board
            </Button>
            {availability.kind === 'available' && (
              <Button
                appearance="primary"
                disabled={actionBusy || !handOffProjectId}
                onClick={onHandToAgent}
              >
                {actionBusy ? 'Starting…' : 'Hand to agent'}
              </Button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
