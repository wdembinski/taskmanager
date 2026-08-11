/**
 * A minimal "Add task…" dialog — the web board's own, not `@tm/ui`'s `AddTaskDialog`-shaped
 * equivalent on the desktop (`apps/client/src/renderer/src/AddTaskDialog.tsx`), which offers
 * plan/adhoc/agent-project/parent-step options this app has no data for. This one asks only
 * what `CommandEnvelope`'s `create-task` kind can carry: which project, a title, and an
 * optional phase — see `@tm/protocol/wire`.
 *
 * The FIELDS differ from the desktop's and are meant to: the wire carries less. The TRIGGER
 * does not — a small primary "Add task…", no icon, exactly as `MyTasks.tsx` renders it. It
 * sits in a row of small controls, so a default-size button set this toolbar's height and made
 * the two boards' toolbars visibly different; the icon made the same action read as a
 * different control at a glance.
 */
import { useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Dropdown,
  Field,
  Input,
  Option,
  Spinner,
} from '@fluentui/react-components';
import type { Project } from '@tm/shared/model';

export interface AddTaskDialogProps {
  projects: Project[];
  onCreate: (projectId: string, input: { title: string; phase?: string }) => Promise<void>;
  disabled?: boolean;
  disabledReason?: string;
}

export function AddTaskDialog({
  projects,
  onCreate,
  disabled,
  disabledReason,
}: AddTaskDialogProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState<string>(projects[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [phase, setPhase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reset = (): void => {
    setTitle('');
    setPhase('');
    setError(null);
  };

  const submit = async (): Promise<void> => {
    if (!projectId || !title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onCreate(projectId, { title: title.trim(), phase: phase.trim() || undefined });
      reset();
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(_, data) => {
        setOpen(data.open);
        if (!data.open) reset();
      }}
    >
      <DialogTrigger disableButtonEnhancement>
        <Button
          size="small"
          appearance="primary"
          disabled={disabled}
          title={disabled ? disabledReason : undefined}
        >
          Add task…
        </Button>
      </DialogTrigger>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Add task</DialogTitle>
          <DialogContent>
            <Field label="Project" required>
              <Dropdown
                value={projects.find((p) => p.id === projectId)?.name ?? ''}
                onOptionSelect={(_, data) => setProjectId(data.optionValue ?? '')}
              >
                {projects.map((p) => (
                  <Option key={p.id} value={p.id}>
                    {p.name}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Field label="Title" required>
              <Input value={title} onChange={(_, data) => setTitle(data.value)} autoFocus />
            </Field>
            <Field label="Phase" hint="Optional">
              <Input value={phase} onChange={(_, data) => setPhase(data.value)} />
            </Field>
            {error && <Field validationState="error" validationMessage={error} />}
          </DialogContent>
          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary">Cancel</Button>
            </DialogTrigger>
            <Button
              appearance="primary"
              disabled={!projectId || !title.trim() || saving}
              icon={saving ? <Spinner size="tiny" /> : undefined}
              onClick={() => void submit()}
            >
              Create
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
