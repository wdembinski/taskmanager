/**
 * Add / Edit project dialog (Phase 8, Deliverable A).
 *
 * One form, two modes. **Add** collects a folder (Browse), an optional custom
 * **plan file** (Browse — so you can point at an existing `ROADMAP.md` instead of
 * `plan.md`), a display name, model, permission mode, and write-back, then calls
 * `project:add`. **Edit** pre-fills from an existing project (the folder is fixed)
 * and calls `project:update`, re-syncing the plan afterward in case the plan file
 * changed. Model/mode changes take effect on the project's next run.
 */
import { useEffect, useState } from 'react';
import {
  Button,
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
  MessageBar,
  MessageBarBody,
  Option,
  Switch,
} from '@fluentui/react-components';
import { PERMISSION_MODE_LABELS } from '@shared/session';
import type { ClaudeModel, PermissionMode } from '@shared/session';
import type { Project } from '@shared/model';

const useStyles = makeStyles({
  form: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '420px' },
  row: { display: 'flex', gap: '8px', alignItems: 'flex-end' },
  grow: { flex: 1 },
  mono: { fontFamily: 'ui-monospace, Consolas, monospace' },
});

const MODELS: ClaudeModel[] = ['haiku', 'sonnet', 'opus'];
const MODES: PermissionMode[] = ['acceptEdits', 'plan', 'manual', 'bypassPermissions'];

export interface ProjectDialogProps {
  open: boolean;
  mode: 'add' | 'edit';
  /** The project being edited (required in edit mode). */
  project?: Project;
  onClose: () => void;
  /** Called after a successful add/update so the caller can refresh its list. */
  onSaved: () => void;
}

export function ProjectDialog({
  open,
  mode,
  project,
  onClose,
  onSaved,
}: ProjectDialogProps): JSX.Element {
  const styles = useStyles();
  const [path, setPath] = useState('');
  const [planPath, setPlanPath] = useState('');
  const [name, setName] = useState('');
  const [model, setModel] = useState<ClaudeModel>('sonnet');
  const [permMode, setPermMode] = useState<PermissionMode>('acceptEdits');
  const [writeBack, setWriteBack] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the form whenever the dialog opens (from the project in edit mode, or
  // from the global defaults in add mode).
  useEffect(() => {
    if (!open) return;
    setError(null);
    if (mode === 'edit' && project) {
      setPath(project.path);
      setPlanPath(project.planPath);
      setName(project.name);
      setModel(project.defaultModel);
      setPermMode(project.defaultPermissionMode);
      setWriteBack(project.writeBackPlan);
    } else {
      setPath('');
      setPlanPath('');
      setName('');
      void window.api.invoke('settings:get').then((s) => {
        setModel(s.defaultModel);
        setPermMode(s.defaultPermissionMode);
        setWriteBack(s.writeBackPlan);
      });
    }
  }, [open, mode, project]);

  async function browseFolder(): Promise<void> {
    const picked = await window.api.invoke('project:pickDirectory');
    if (picked) setPath(picked);
  }

  async function browsePlan(): Promise<void> {
    const picked = await window.api.invoke('project:pickFile');
    if (picked) setPlanPath(picked);
  }

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      if (mode === 'add') {
        if (!path) {
          setError('Choose a project folder first.');
          return;
        }
        await window.api.invoke('project:add', {
          path,
          name: name.trim() || undefined,
          planPath: planPath.trim() || undefined,
          defaultModel: model,
          defaultPermissionMode: permMode,
          writeBackPlan: writeBack,
        });
      } else if (project) {
        await window.api.invoke('project:update', project.id, {
          name: name.trim() || undefined,
          planPath: planPath.trim() || undefined,
          defaultModel: model,
          defaultPermissionMode: permMode,
          writeBackPlan: writeBack,
        });
        // The plan file may have changed — reconcile tasks from the new source.
        await window.api.invoke('project:syncPlan', project.id);
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(_e, d) => !d.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{mode === 'add' ? 'Add project' : 'Edit project'}</DialogTitle>
          <DialogContent>
            <div className={styles.form}>
              {error && (
                <MessageBar intent="error">
                  <MessageBarBody>{error}</MessageBarBody>
                </MessageBar>
              )}

              <Field label="Project folder" required>
                <div className={styles.row}>
                  <Input
                    className={`${styles.grow} ${styles.mono}`}
                    value={path}
                    readOnly
                    placeholder="Choose a folder…"
                  />
                  {mode === 'add' && <Button onClick={() => void browseFolder()}>Browse…</Button>}
                </div>
              </Field>

              <Field label="Plan file" hint="Defaults to plan.md in the folder. Point at any markdown file.">
                <div className={styles.row}>
                  <Input
                    className={`${styles.grow} ${styles.mono}`}
                    value={planPath}
                    onChange={(_e, d) => setPlanPath(d.value)}
                    placeholder="…/plan.md"
                  />
                  <Button onClick={() => void browsePlan()}>Browse…</Button>
                </div>
              </Field>

              <Field label="Display name" hint="Defaults to the folder name.">
                <Input value={name} onChange={(_e, d) => setName(d.value)} placeholder="(folder name)" />
              </Field>

              <div className={styles.row}>
                <Field label="Model" className={styles.grow}>
                  <Dropdown
                    value={model}
                    selectedOptions={[model]}
                    onOptionSelect={(_e, d) => setModel(d.optionValue as ClaudeModel)}
                  >
                    {MODELS.map((m) => (
                      <Option key={m} value={m}>
                        {m}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
                <Field label="Permission mode" className={styles.grow}>
                  <Dropdown
                    value={PERMISSION_MODE_LABELS[permMode]}
                    selectedOptions={[permMode]}
                    onOptionSelect={(_e, d) => setPermMode(d.optionValue as PermissionMode)}
                  >
                    {MODES.map((m) => (
                      <Option key={m} value={m}>
                        {PERMISSION_MODE_LABELS[m]}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              </div>

              <Switch
                checked={writeBack}
                label="Tick completed checkboxes back into the plan file"
                onChange={(_e, d) => setWriteBack(d.checked)}
              />
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button appearance="primary" onClick={() => void save()} disabled={saving}>
              {mode === 'add' ? 'Add project' : 'Save'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
