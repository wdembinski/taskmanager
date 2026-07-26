/**
 * Add-task dialog (Phase 8, Deliverable C1).
 *
 * Create an ad-hoc task directly in a project — no plan file required. This makes
 * plan-less projects usable and lets you add work on the fly; the task is tagged
 * `source: 'adhoc'`, so plan re-syncs never remove it. An optional phase groups it
 * under a milestone (reuse an existing one or type a new one).
 *
 * On a board that passes `parents` (My Tasks, Phase 11), the dialog can also add a
 * **step** under an existing card: pick the card and write the step's brief, and it
 * joins that card's chain — the hand-written equivalent of an approved plan.
 */
import { useEffect, useMemo, useState } from 'react';
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
  Textarea,
} from '@fluentui/react-components';
import type { Task, TaskType } from '@shared/model';

/** The task types offered in the picker, with their display labels. */
const TASK_TYPES: Array<{ value: TaskType; label: string }> = [
  { value: 'feature', label: 'Feature' },
  { value: 'bug', label: 'Bug' },
];

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '440px' },
});

/** Sentinel for "no parent" in the parent dropdown (an Option needs a value). */
const NO_PARENT = '';

export interface AddTaskDialogProps {
  open: boolean;
  projectId: string | null;
  /** Existing phase names in the project, offered as a hint. */
  phases: string[];
  /**
   * Cards the new task may be added under as a step. Omit (or pass an empty list) to
   * hide the picker entirely — only the My Tasks board has chains.
   */
  parents?: Task[];
  /** Preselected parent, when the dialog is opened from a card's Steps section. */
  defaultParentId?: string | null;
  onClose: () => void;
  onCreated: () => void;
}

export function AddTaskDialog({
  open,
  projectId,
  phases,
  parents = [],
  defaultParentId = null,
  onClose,
  onCreated,
}: AddTaskDialogProps): JSX.Element {
  const styles = useStyles();
  const [title, setTitle] = useState('');
  const [phase, setPhase] = useState('');
  const [type, setType] = useState<TaskType>('feature');
  const [description, setDescription] = useState('');
  const [parentId, setParentId] = useState<string>(NO_PARENT);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTitle('');
      setPhase('');
      setType('feature');
      setDescription('');
      setParentId(defaultParentId ?? NO_PARENT);
      setError(null);
    }
  }, [open, defaultParentId]);

  const parent = useMemo(() => parents.find((p) => p.id === parentId) ?? null, [parents, parentId]);
  const isStep = parent !== null;

  async function save(): Promise<void> {
    if (!projectId || !title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      // A step is created through its parent (it inherits the delegation and joins
      // the chain); everything else is an ordinary ad-hoc card.
      if (parent) {
        await window.api.invoke('task:addSubtask', parent.id, {
          title: title.trim(),
          description: description.trim() || null,
        });
      } else {
        await window.api.invoke('task:create', projectId, {
          title: title.trim(),
          phase: phase.trim() || undefined,
          type,
        });
      }
      onCreated();
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
          <DialogTitle>{isStep ? 'Add step' : 'Add task'}</DialogTitle>
          <DialogContent>
            <div className={styles.body}>
              {error && (
                <MessageBar intent="error">
                  <MessageBarBody>{error}</MessageBarBody>
                </MessageBar>
              )}
              <Field label={isStep ? 'Step' : 'Task'} required>
                <Input
                  value={title}
                  onChange={(_e, d) => setTitle(d.value)}
                  placeholder="What should Claude do?"
                />
              </Field>
              {parents.length > 0 && (
                <Field
                  label="Step of (optional)"
                  hint={
                    isStep
                      ? 'Runs in its turn on the card’s branch, in its own session.'
                      : 'Pick a card to make this one of its steps.'
                  }
                >
                  <Dropdown
                    value={parent?.title ?? 'Standalone task'}
                    selectedOptions={[parentId]}
                    onOptionSelect={(_e, d) => setParentId(d.optionValue ?? NO_PARENT)}
                  >
                    <Option value={NO_PARENT}>Standalone task</Option>
                    {parents.map((p) => (
                      <Option key={p.id} value={p.id}>
                        {p.title}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>
              )}
              {/* A brief belongs to a step: it is what that step's session is given.
                  A standalone card has no such field — its context is the ticket. */}
              {isStep && (
                <Field
                  label="Brief for this step"
                  hint="The only context the step’s session gets — say what “done” means."
                >
                  <Textarea
                    value={description}
                    resize="vertical"
                    onChange={(_e, d) => setDescription(d.value)}
                    placeholder="What this step must deliver…"
                  />
                </Field>
              )}
              {!isStep && (
                <>
                  <Field label="Type">
                    <Dropdown
                      value={TASK_TYPES.find((t) => t.value === type)?.label ?? ''}
                      selectedOptions={[type]}
                      onOptionSelect={(_e, d) => setType(d.optionValue as TaskType)}
                    >
                      {TASK_TYPES.map((t) => (
                        <Option key={t.value} value={t.value}>
                          {t.label}
                        </Option>
                      ))}
                    </Dropdown>
                  </Field>
                  <Field
                    label="Phase / milestone (optional)"
                    hint={
                      phases.length ? `Existing: ${phases.join(' · ')}` : 'e.g. "Phase 1 — Setup"'
                    }
                  >
                    <Input
                      value={phase}
                      onChange={(_e, d) => setPhase(d.value)}
                      placeholder="(ungrouped)"
                    />
                  </Field>
                </>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              appearance="primary"
              onClick={() => void save()}
              disabled={saving || !title.trim()}
            >
              {isStep ? 'Add step' : 'Add task'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
