/**
 * Workflow Builder settings screen (F8.9) — list, edit, import and export the library of
 * reusable workflow documents, backed by `workflowBuilderState.ts`'s pure library/baseline/draft
 * triple so nothing reaches `workflow:save`/`workflow:import`/etc until the human actually asks
 * for it. Structured like `SkillsSection.tsx`: a picker on the left, the open draft's editor on
 * the right, both sharing the same `apply`/`saved` plumbing.
 *
 * `canUseFileSystem` gates the native-picker half of import/export only — unlike
 * `SkillsSection`, where the whole Import menu is host-only, a workflow's "Paste JSON…" has a
 * pure local fallback (`importFromText`), so a transport without `workflow:import`/`export`
 * (apps/web) still offers it; only **File…** and **Export** disappear.
 */
import { useCallback, useState } from 'react';
import {
  Body1,
  Button,
  Caption1,
  Card,
  CardHeader,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  makeStyles,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  Option,
  SpinButton,
  Switch,
  Text,
  Textarea,
  tokens,
} from '@fluentui/react-components';
import {
  AddRegular,
  ArrowDownRegular,
  ArrowImportRegular,
  ArrowUpRegular,
  BotRegular,
  DismissRegular,
  DocumentArrowUpRegular,
  WindowConsoleRegular,
} from '@fluentui/react-icons';
import { PERMISSION_MODE_LABELS, type PermissionMode } from '@tm/shared/session';
import type { AgentStep, GateStep } from '@tm/shared/workflow';
import { PERMISSION_MODES } from './agentPickers';
import { cardModelFromOption, projectDefaultLabel, PROJECT_DEFAULT } from './modelChoice';
import { ModelField } from './ModelField';
import { PaneLoading } from './PaneLoading';
import { SkillPicker } from './SkillPicker';
import { useInitialLoad } from './useInitialLoad';
import { useSkillOptions, type SkillOptionsState } from './useSkillOptions';
import { useTransport } from './transport';
import {
  addStep,
  applyDelete,
  applyImportResult,
  applySaveResult,
  cancelPendingSelection,
  canSave,
  confirmPendingSelection,
  discardDraft,
  dismissImportIssues,
  duplicateWorkflow,
  editStep,
  editWorkflow,
  importFromText,
  isDirty,
  moveStep,
  openWorkflowBuilder,
  previewJson,
  reloadLibrary,
  removeStep,
  retryFromOptions,
  selectWorkflow,
  setGateOnFail,
  setRetryOnText,
  setStepMode,
  setStepModel,
  setStepSkillRefs,
  startNew,
  stepIssues,
  type WorkflowBuilderState,
} from './workflowBuilderState';

/** What every field setter in this file calls to fold a state transform back in — always
 *  through the functional-updater form, so a handler built from a stale render's `editor`
 *  (e.g. one captured inside a step's own closure) never clobbers a change made since. */
type Apply = (updater: (state: WorkflowBuilderState) => WorkflowBuilderState) => void;

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '16px' },
  hint: { color: tokens.colorNeutralForeground3 },
  layout: { display: 'flex', gap: '16px', minHeight: 0 },
  left: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    width: '280px',
    flexShrink: 0,
    overflowY: 'auto',
  },
  listMenuRow: { display: 'flex', gap: '8px' },
  row: { padding: '4px', cursor: 'pointer' },
  rowSelected: { border: `1px solid ${tokens.colorBrandStroke1}` },
  rowHeader: { display: 'flex', flexDirection: 'column', gap: '2px' },
  right: { display: 'flex', flexDirection: 'column', gap: '16px', flex: 1, minWidth: 0 },
  steps: { display: 'flex', flexDirection: 'column', gap: '12px' },
  stepCard: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px' },
  stepHeader: { display: 'flex', alignItems: 'center', gap: '8px' },
  index: { color: tokens.colorNeutralForeground3, flexShrink: 0 },
  kindIcon: { color: tokens.colorNeutralForeground3, flexShrink: 0, fontSize: '16px' },
  stepTitle: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
  stepActions: { display: 'flex', gap: '4px', flexShrink: 0 },
  fields: { display: 'flex', flexDirection: 'column', gap: '8px' },
  fieldsRow: { display: 'flex', alignItems: 'flex-end', gap: '8px', flexWrap: 'wrap' },
  mono: { fontFamily: 'ui-monospace, Consolas, monospace' },
  addRow: { display: 'flex', gap: '8px' },
  toolbar: { display: 'flex', alignItems: 'center', gap: '8px' },
  error: { color: tokens.colorPaletteRedForeground1 },
  saved: { color: tokens.colorPaletteGreenForeground1 },
  preview: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: '12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  previewBody: {
    fontFamily: 'ui-monospace, Consolas, monospace',
    whiteSpace: 'pre-wrap',
    margin: 0,
    maxHeight: '320px',
    overflowY: 'auto',
  },
});

export interface WorkflowBuilderProps {
  /** Whether the host can open native file dialogs and write to disk — `false` hides
   *  **File…** and **Export** (both host-only channels a browser transport cannot answer)
   *  but keeps **Paste JSON…**, which falls back to {@link importFromText} locally.
   *  Defaults to `true` (desktop). */
  canUseFileSystem?: boolean;
}

export function WorkflowBuilder({ canUseFileSystem = true }: WorkflowBuilderProps): JSX.Element {
  const styles = useStyles();
  const transport = useTransport();
  const skillOptions = useSkillOptions(null);

  const [loaded, setLoaded] = useState(false);
  const [editor, setEditor] = useState<WorkflowBuilderState>(() => openWorkflowBuilder([]));
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteBusy, setPasteBusy] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const load = useCallback(async () => {
    const list = await transport.invoke('workflow:list');
    setEditor((prev) => reloadLibrary(prev, list));
    setLoaded(true);
  }, [transport]);

  const initial = useInitialLoad(load);

  // Any edit, selection switch or discard invalidates the "Saved." confirmation — only a
  // successful `workflow:save` sets it back to true.
  const apply: Apply = (updater) => {
    setEditor(updater);
    setSaved(false);
  };

  async function save(): Promise<void> {
    if (!editor.draft) return;
    setSaving(true);
    try {
      const result = await transport.invoke('workflow:save', editor.draft);
      setEditor((prev) => applySaveResult(prev, result));
      if (result.ok) setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  async function deleteWorkflow(): Promise<void> {
    const id = editor.draft?.id;
    if (!id) return;
    setDeleting(true);
    try {
      const ok = await transport.invoke('workflow:delete', id);
      if (ok) apply((prev) => applyDelete(prev, id));
    } finally {
      setDeleting(false);
      setDeleteConfirmOpen(false);
    }
  }

  async function exportWorkflow(): Promise<void> {
    const id = editor.draft?.id;
    if (!id) return;
    setExporting(true);
    try {
      await transport.invoke('workflow:export', id);
    } finally {
      setExporting(false);
    }
  }

  async function importFile(): Promise<void> {
    setImporting(true);
    try {
      const result = await transport.invoke('workflow:import', { source: 'file' });
      apply((prev) => applyImportResult(prev, result));
    } finally {
      setImporting(false);
    }
  }

  async function importPastedText(): Promise<void> {
    if (!pasteText.trim()) return;
    if (!canUseFileSystem) {
      apply((prev) => importFromText(prev, pasteText));
      setPasteOpen(false);
      setPasteText('');
      return;
    }
    setPasteBusy(true);
    try {
      const result = await transport.invoke('workflow:import', { source: 'text', text: pasteText });
      apply((prev) => applyImportResult(prev, result));
      setPasteOpen(false);
      setPasteText('');
    } finally {
      setPasteBusy(false);
    }
  }

  if (!loaded) {
    return (
      <PaneLoading
        label="Loading workflows…"
        error={initial.error}
        onRetry={initial.retry}
        shape="rows"
      />
    );
  }

  const draft = editor.draft;
  const selection = editor.selection;
  const issuesByStep = stepIssues(editor);
  const generalIssues = issuesByStep.general ?? [];

  return (
    <div className={styles.root}>
      <Body1 className={styles.hint}>
        A reusable, ordered recipe of steps a card can run — an agent step hands a brief to Claude,
        a gate step runs a command and can send a failing run back to an earlier agent step for
        another attempt.
      </Body1>

      {editor.importIssues && (
        <MessageBar intent="error">
          <MessageBarBody>
            {editor.importIssues.map((issue, i) => (
              <div key={i}>{issue}</div>
            ))}
          </MessageBarBody>
          <MessageBarActions>
            <Button
              size="small"
              appearance="subtle"
              onClick={() => apply((p) => dismissImportIssues(p))}
            >
              Dismiss
            </Button>
          </MessageBarActions>
        </MessageBar>
      )}

      <div className={styles.layout}>
        <div className={styles.left}>
          <div className={styles.listMenuRow}>
            <Button icon={<AddRegular />} onClick={() => apply((p) => startNew(p))}>
              New
            </Button>
            <Menu>
              <MenuTrigger disableButtonEnhancement>
                <Button icon={<ArrowImportRegular />} disabled={importing}>
                  Import
                </Button>
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  {canUseFileSystem && (
                    <MenuItem icon={<DocumentArrowUpRegular />} onClick={() => void importFile()}>
                      File…
                    </MenuItem>
                  )}
                  <MenuItem onClick={() => setPasteOpen(true)}>Paste JSON…</MenuItem>
                </MenuList>
              </MenuPopover>
            </Menu>
          </div>

          {editor.library.length === 0 && (
            <Caption1 className={styles.hint}>No workflows yet.</Caption1>
          )}
          {editor.library.map((wf) => (
            <Card
              key={wf.id}
              className={
                selection?.kind === 'library' && selection.id === wf.id
                  ? `${styles.row} ${styles.rowSelected}`
                  : styles.row
              }
              onClick={() => apply((p) => selectWorkflow(p, wf.id))}
              selected={selection?.kind === 'library' && selection.id === wf.id}
            >
              <CardHeader
                header={
                  <div className={styles.rowHeader}>
                    <Text weight="semibold">{wf.name}</Text>
                    <Caption1 className={styles.hint}>
                      {wf.steps.length} step{wf.steps.length === 1 ? '' : 's'}
                    </Caption1>
                  </div>
                }
              />
            </Card>
          ))}
        </div>

        <div className={styles.right}>
          {!draft && (
            <Body1 className={styles.hint}>
              Select a workflow on the left, or start a new one.
            </Body1>
          )}

          {draft && (
            <>
              <Field label="Name">
                <Input
                  value={draft.name}
                  placeholder="My workflow"
                  onChange={(_e, d) => apply((p) => editWorkflow(p, { name: d.value }))}
                />
              </Field>

              <div className={styles.steps}>
                {draft.steps.map((step, i) => {
                  const issues = issuesByStep[step.id] ?? [];
                  return (
                    <Card
                      key={step.id}
                      className={styles.stepCard}
                      draggable
                      onDragStart={() => setDragIndex(i)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => {
                        if (dragIndex !== null && dragIndex !== i) {
                          apply((p) => moveStep(p, dragIndex, i));
                        }
                        setDragIndex(null);
                      }}
                    >
                      <div className={styles.stepHeader}>
                        <Caption1 className={styles.index}>{i + 1}.</Caption1>
                        {step.kind === 'agent' ? (
                          <BotRegular className={styles.kindIcon} aria-label="Agent step" />
                        ) : (
                          <WindowConsoleRegular
                            className={styles.kindIcon}
                            aria-label="Gate step"
                          />
                        )}
                        <Text className={styles.stepTitle} weight="semibold">
                          {step.title || 'Untitled step'}
                        </Text>
                        <div className={styles.stepActions}>
                          <Button
                            size="small"
                            appearance="subtle"
                            icon={<ArrowUpRegular />}
                            title="Move up"
                            disabled={i === 0}
                            onClick={() => apply((p) => moveStep(p, i, i - 1))}
                          />
                          <Button
                            size="small"
                            appearance="subtle"
                            icon={<ArrowDownRegular />}
                            title="Move down"
                            disabled={i === draft.steps.length - 1}
                            onClick={() => apply((p) => moveStep(p, i, i + 1))}
                          />
                          <Button
                            size="small"
                            appearance="subtle"
                            icon={<DismissRegular />}
                            title="Remove step"
                            onClick={() => apply((p) => removeStep(p, step.id))}
                          />
                        </div>
                      </div>

                      {step.kind === 'agent' ? (
                        <AgentEditorFields step={step} skillOptions={skillOptions} apply={apply} />
                      ) : (
                        <GateEditorFields step={step} editor={editor} apply={apply} />
                      )}

                      {issues.length > 0 && (
                        <div>
                          {issues.map((issue, k) => (
                            <Caption1 key={k} className={styles.error}>
                              {issue}
                            </Caption1>
                          ))}
                        </div>
                      )}
                    </Card>
                  );
                })}
              </div>

              <div className={styles.addRow}>
                <Button appearance="secondary" onClick={() => apply((p) => addStep(p, 'agent'))}>
                  Add agent step
                </Button>
                <Button appearance="secondary" onClick={() => apply((p) => addStep(p, 'gate'))}>
                  Add gate step
                </Button>
              </div>

              {generalIssues.length > 0 && (
                <MessageBar intent="error">
                  <MessageBarBody>
                    {generalIssues.map((issue, i) => (
                      <div key={i}>{issue}</div>
                    ))}
                  </MessageBarBody>
                </MessageBar>
              )}

              <div className={styles.toolbar}>
                <Button
                  appearance="primary"
                  disabled={!canSave(editor) || saving}
                  onClick={() => void save()}
                >
                  Save
                </Button>
                <Button
                  appearance="secondary"
                  disabled={!isDirty(editor)}
                  onClick={() => apply((p) => discardDraft(p))}
                >
                  Discard
                </Button>
                {draft.id && (
                  <Button
                    appearance="secondary"
                    onClick={() => apply((p) => duplicateWorkflow(p, draft.id!))}
                  >
                    Duplicate
                  </Button>
                )}
                <Button
                  appearance="secondary"
                  disabled={!draft.id || deleting}
                  onClick={() => setDeleteConfirmOpen(true)}
                >
                  Delete
                </Button>
                {canUseFileSystem && (
                  <Button
                    appearance="secondary"
                    disabled={!draft.id || exporting}
                    onClick={() => void exportWorkflow()}
                  >
                    Export
                  </Button>
                )}
                {saved && <Caption1 className={styles.saved}>Saved.</Caption1>}
              </div>

              <div>
                <Button size="small" appearance="subtle" onClick={() => setPreviewOpen((v) => !v)}>
                  {previewOpen ? 'Hide JSON preview' : 'Show JSON preview'}
                </Button>
                {previewOpen && (
                  <div className={styles.preview}>
                    <pre className={styles.previewBody}>{previewJson(editor)}</pre>
                    <div>
                      <Button
                        size="small"
                        appearance="secondary"
                        onClick={() => void navigator.clipboard.writeText(previewJson(editor))}
                      >
                        Copy
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {editor.pendingSelection && (
        <Dialog open onOpenChange={(_e, d) => !d.open && apply((p) => cancelPendingSelection(p))}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Discard unsaved changes?</DialogTitle>
              <DialogContent>
                <Body1>
                  This workflow has unsaved changes. Switching to another one will discard them.
                </Body1>
              </DialogContent>
              <DialogActions>
                <Button
                  appearance="secondary"
                  onClick={() => apply((p) => cancelPendingSelection(p))}
                >
                  Cancel
                </Button>
                <Button
                  appearance="primary"
                  onClick={() => apply((p) => confirmPendingSelection(p))}
                >
                  Discard changes
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}

      {deleteConfirmOpen && (
        <Dialog open onOpenChange={(_e, d) => !d.open && setDeleteConfirmOpen(false)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Delete this workflow?</DialogTitle>
              <DialogContent>
                <Body1>
                  This cannot be undone. A card already run from it keeps its own steps.
                </Body1>
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setDeleteConfirmOpen(false)}>
                  Cancel
                </Button>
                <Button
                  appearance="primary"
                  disabled={deleting}
                  onClick={() => void deleteWorkflow()}
                >
                  Delete
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}

      {pasteOpen && (
        <Dialog open onOpenChange={(_e, d) => !d.open && !pasteBusy && setPasteOpen(false)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Paste a workflow document</DialogTitle>
              <DialogContent>
                <Textarea
                  className={styles.mono}
                  value={pasteText}
                  resize="vertical"
                  textarea={{ rows: 16 }}
                  placeholder={'{\n  "version": 1,\n  "name": "My workflow",\n  "steps": [...]\n}'}
                  onChange={(_e, d) => setPasteText(d.value)}
                />
              </DialogContent>
              <DialogActions>
                <Button
                  appearance="secondary"
                  disabled={pasteBusy}
                  onClick={() => setPasteOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  appearance="primary"
                  disabled={pasteBusy || !pasteText.trim()}
                  onClick={() => void importPastedText()}
                >
                  Import
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}
    </div>
  );
}

interface AgentEditorFieldsProps {
  step: AgentStep;
  skillOptions: SkillOptionsState;
  apply: Apply;
}

/** An agent step's own fields: title, brief, the skills it carries, and overrides for the
 *  project's own model/mode — each override a project-default sentinel until the human
 *  actually picks one. */
function AgentEditorFields({ step, skillOptions, apply }: AgentEditorFieldsProps): JSX.Element {
  const styles = useStyles();
  return (
    <div className={styles.fields}>
      <Field label="Title">
        <Input
          value={step.title}
          onChange={(_e, d) => apply((p) => editStep(p, step.id, { title: d.value }))}
        />
      </Field>
      <Field label="Brief">
        <Textarea
          value={step.brief}
          resize="vertical"
          textarea={{ rows: 4 }}
          placeholder="What this step's run should do…"
          onChange={(_e, d) => apply((p) => editStep(p, step.id, { brief: d.value }))}
        />
      </Field>
      <div className={styles.fieldsRow}>
        <SkillPicker
          options={skillOptions.options}
          own={step.skillRefs ?? []}
          loading={skillOptions.loading}
          onChange={(nextOwn) =>
            apply((p) => setStepSkillRefs(p, step.id, nextOwn.length > 0 ? nextOwn : null))
          }
        />
        <ModelField
          label="Model"
          value={step.model ?? PROJECT_DEFAULT}
          onChange={(v) => apply((p) => setStepModel(p, step.id, cardModelFromOption(v)))}
          sentinel={{ value: PROJECT_DEFAULT, label: projectDefaultLabel(null) }}
        />
        <Field label="Mode">
          <Dropdown
            value={step.mode ? PERMISSION_MODE_LABELS[step.mode] : projectDefaultLabel(null)}
            selectedOptions={[step.mode ?? PROJECT_DEFAULT]}
            onOptionSelect={(_e, d) =>
              apply((p) =>
                setStepMode(
                  p,
                  step.id,
                  d.optionValue && d.optionValue !== PROJECT_DEFAULT
                    ? (d.optionValue as PermissionMode)
                    : null,
                ),
              )
            }
          >
            <Option value={PROJECT_DEFAULT} text="Project default">
              {projectDefaultLabel(null)}
            </Option>
            {PERMISSION_MODES.map((m) => (
              <Option key={m} value={m} text={PERMISSION_MODE_LABELS[m]}>
                {PERMISSION_MODE_LABELS[m]}
              </Option>
            ))}
          </Dropdown>
        </Field>
      </div>
    </div>
  );
}

interface GateEditorFieldsProps {
  step: GateStep;
  editor: WorkflowBuilderState;
  apply: Apply;
}

/** A gate step's own fields: title, its shell command, and — only once "On failure, send
 *  back" is switched on — where to retry from, how many times, and which exit codes are
 *  worth retrying on. A `retryFrom` that no longer resolves to an earlier agent step (a
 *  reorder or removal left it dangling) shows as "(missing)" rather than silently rewriting
 *  it — `workflowIssues`/`stepIssues` flag the same thing below the card. */
function GateEditorFields({ step, editor, apply }: GateEditorFieldsProps): JSX.Element {
  const styles = useStyles();
  const options = retryFromOptions(editor, step.id);
  const current = step.onFail ? options.find((o) => o.id === step.onFail!.retryFrom) : undefined;

  return (
    <div className={styles.fields}>
      <Field label="Title">
        <Input
          value={step.title}
          onChange={(_e, d) => apply((p) => editStep(p, step.id, { title: d.value }))}
        />
      </Field>
      <Field label="Command">
        <Input
          className={styles.mono}
          value={step.command}
          placeholder="pnpm test"
          onChange={(_e, d) => apply((p) => editStep(p, step.id, { command: d.value }))}
        />
      </Field>
      <Switch
        checked={!!step.onFail}
        label="On failure, send back"
        onChange={(_e, d) =>
          apply((p) =>
            setGateOnFail(
              p,
              step.id,
              d.checked ? { retryFrom: options[0]?.id ?? '', maxAttempts: 1 } : null,
            ),
          )
        }
      />
      {step.onFail && (
        <div className={styles.fieldsRow}>
          <Field label="Retry from">
            <Dropdown
              value={current ? current.title || current.id : '(missing)'}
              selectedOptions={[step.onFail.retryFrom]}
              onOptionSelect={(_e, d) =>
                d.optionValue &&
                apply((p) =>
                  setGateOnFail(p, step.id, { ...step.onFail!, retryFrom: d.optionValue! }),
                )
              }
            >
              {options.map((o) => (
                <Option key={o.id} value={o.id} text={o.title || o.id}>
                  {o.title || o.id}
                </Option>
              ))}
            </Dropdown>
          </Field>
          <Field label="Max attempts">
            <SpinButton
              min={1}
              max={5}
              value={step.onFail.maxAttempts}
              onChange={(_e, d) => {
                const n = d.value ?? Number(d.displayValue);
                if (Number.isFinite(n)) {
                  const maxAttempts = Math.min(5, Math.max(1, Math.round(n as number)));
                  apply((p) => setGateOnFail(p, step.id, { ...step.onFail!, maxAttempts }));
                }
              }}
            />
          </Field>
          <Field label="Retry on exit codes" hint="Comma-separated. Empty means any non-zero exit.">
            <Input
              value={editor.retryOnText[step.id] ?? ''}
              placeholder="1, 2"
              onChange={(_e, d) => apply((p) => setRetryOnText(p, step.id, d.value))}
            />
          </Field>
        </div>
      )}
    </div>
  );
}
