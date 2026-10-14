/**
 * Prompt templates settings section (F7.10) — list, edit, reorder, toggle surfaces and reset
 * the global `AppSettings.promptTemplates`, backed by `promptTemplatesEditor.ts`'s pure
 * saved/draft pair so nothing reaches `onSave` until Save is actually clicked.
 *
 * Takes `templates` and `onSave` as props rather than owning its own load/save round trip —
 * the host screen (desktop `Settings.tsx`, and eventually its web mirror) decides how the
 * rest of `AppSettings` is read and merged, the same way every other tab there does.
 */
import { useEffect, useState } from 'react';
import {
  Body1,
  Button,
  Caption1,
  Checkbox,
  Input,
  makeStyles,
  Textarea,
  tokens,
} from '@fluentui/react-components';
import { ArrowDownRegular, ArrowUpRegular, DismissRegular } from '@fluentui/react-icons';
import {
  PROMPT_TEMPLATE_SURFACES,
  type PromptTemplate,
  type PromptTemplateSurface,
} from '@tm/shared/promptTemplates';
import {
  addTemplate,
  canSave,
  discard,
  editTemplate,
  isDirty,
  moveTemplate,
  openEditor,
  removeTemplate,
  resetToDefaults,
  toggleSurface,
  validateTemplates,
  type PromptTemplatesEditor,
} from './promptTemplatesEditor';

/** Labels in `PROMPT_TEMPLATE_SURFACES` order. */
const SURFACE_LABEL: Record<PromptTemplateSurface, string> = {
  'add-task': 'Add task',
  assign: 'Assign',
  chat: 'Chat',
};

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '16px' },
  hint: { color: tokens.colorNeutralForeground3 },
  list: { display: 'flex', flexDirection: 'column', gap: '12px' },
  row: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '12px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  rowTop: { display: 'flex', alignItems: 'flex-start', gap: '8px' },
  rowName: { flex: 1, minWidth: 0 },
  rowActions: { display: 'flex', gap: '4px' },
  surfaces: { display: 'flex', gap: '16px', flexWrap: 'wrap' },
  error: { color: tokens.colorPaletteRedForeground1 },
  actions: { display: 'flex', alignItems: 'center', gap: '12px' },
  saved: { color: tokens.colorPaletteGreenForeground1 },
});

export interface PromptTemplatesSectionProps {
  templates: PromptTemplate[];
  onSave: (next: PromptTemplate[]) => Promise<void>;
}

export function PromptTemplatesSection({
  templates,
  onSave,
}: PromptTemplatesSectionProps): JSX.Element {
  const styles = useStyles();
  const [state, setState] = useState<PromptTemplatesEditor>(() => openEditor(templates));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Re-seed only when the STORED list itself changes (a Save round trip, or settings
  // arriving from elsewhere) — never on every render, or a draft edit mid-keystroke would
  // be stomped by the very value that triggered the re-render.
  useEffect(() => {
    setState(openEditor(templates));
    setSaved(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-seed only on `templates` itself
  }, [templates]);

  // Any edit invalidates the "Saved" confirmation, same rule the other tabs follow.
  function apply(next: PromptTemplatesEditor): void {
    setState(next);
    setSaved(false);
  }

  const errors = validateTemplates(state.draft);

  async function save(): Promise<void> {
    setSaving(true);
    try {
      await onSave(state.draft);
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.root}>
      <Body1 className={styles.hint}>
        Reusable starting text for the Add-task description, the assign-dialog instructions and the
        chat composer. Use <code>{'{{title}}'}</code>, <code>{'{{key}}'}</code> and{' '}
        <code>{'{{project}}'}</code> in the body — they are filled in when a template is inserted.
      </Body1>

      <div className={styles.list}>
        {state.draft.map((template, i) => {
          const templateErrors = errors[template.id] ?? [];
          return (
            <div key={template.id} className={styles.row}>
              <div className={styles.rowTop}>
                <Input
                  className={styles.rowName}
                  value={template.name}
                  placeholder="Template name"
                  onChange={(_e, d) => apply(editTemplate(state, template.id, { name: d.value }))}
                />
                <div className={styles.rowActions}>
                  <Button
                    size="small"
                    appearance="subtle"
                    icon={<ArrowUpRegular />}
                    title="Move up"
                    disabled={i === 0}
                    onClick={() => apply(moveTemplate(state, template.id, -1))}
                  />
                  <Button
                    size="small"
                    appearance="subtle"
                    icon={<ArrowDownRegular />}
                    title="Move down"
                    disabled={i === state.draft.length - 1}
                    onClick={() => apply(moveTemplate(state, template.id, 1))}
                  />
                  <Button
                    size="small"
                    appearance="subtle"
                    icon={<DismissRegular />}
                    title="Delete this template"
                    onClick={() => apply(removeTemplate(state, template.id))}
                  />
                </div>
              </div>

              <Textarea
                value={template.body}
                resize="vertical"
                placeholder="Template body"
                onChange={(_e, d) => apply(editTemplate(state, template.id, { body: d.value }))}
              />

              <div className={styles.surfaces}>
                {PROMPT_TEMPLATE_SURFACES.map((surface) => (
                  <Checkbox
                    key={surface}
                    label={SURFACE_LABEL[surface]}
                    checked={template.surfaces.includes(surface)}
                    onChange={() => apply(toggleSurface(state, template.id, surface))}
                  />
                ))}
              </div>

              {templateErrors.length > 0 && (
                <Caption1 className={styles.error}>{templateErrors.join(' ')}</Caption1>
              )}
            </div>
          );
        })}
      </div>

      <div className={styles.actions}>
        <Button onClick={() => apply(addTemplate(state, crypto.randomUUID()))}>Add template</Button>
        <Button onClick={() => apply(resetToDefaults(state))}>Reset to defaults</Button>
      </div>

      <div className={styles.actions}>
        <Button
          appearance="primary"
          disabled={!canSave(state) || saving}
          onClick={() => void save()}
        >
          Save
        </Button>
        <Button
          appearance="secondary"
          disabled={!isDirty(state)}
          onClick={() => apply(discard(state))}
        >
          Discard
        </Button>
        {saved && <Caption1 className={styles.saved}>Saved.</Caption1>}
      </div>
    </div>
  );
}
