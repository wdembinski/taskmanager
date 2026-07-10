/**
 * Settings screen (Phase 6).
 *
 * Global preferences the engine reads at runtime: the defaults applied to newly
 * added projects (model, permission mode, plan write-back) and two scheduler knobs
 * — how many tasks a project runs at once, and how much random jitter to add
 * before resuming after a usage limit resets. Loaded from and saved to the engine
 * over the `settings:*` IPC channels; the scheduler picks up concurrency/jitter on
 * the next task, so no restart is needed.
 */
import { useEffect, useState } from 'react';
import {
  Body1,
  Button,
  Caption1,
  Dropdown,
  Field,
  makeStyles,
  Option,
  Spinner,
  SpinButton,
  Subtitle2,
  Switch,
  tokens,
} from '@fluentui/react-components';
import { PERMISSION_MODE_LABELS } from '@shared/session';
import type { ClaudeModel, PermissionMode } from '@shared/session';
import type { AppSettings } from '@shared/settings';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '520px' },
  grid: { display: 'flex', flexDirection: 'column', gap: '16px' },
  actions: { display: 'flex', alignItems: 'center', gap: '12px', marginTop: '4px' },
  saved: { color: tokens.colorPaletteGreenForeground1 },
  hint: { color: tokens.colorNeutralForeground3 },
});

const MODELS: ClaudeModel[] = ['haiku', 'sonnet', 'opus'];
const MODES: PermissionMode[] = ['acceptEdits', 'plan', 'manual', 'bypassPermissions'];

export function Settings(): JSX.Element {
  const styles = useStyles();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void window.api.invoke('settings:get').then(setSettings);
  }, []);

  // Any edit invalidates the "Saved" confirmation.
  function patch(change: Partial<AppSettings>): void {
    setSettings((prev) => (prev ? { ...prev, ...change } : prev));
    setSaved(false);
  }

  async function save(): Promise<void> {
    if (!settings) return;
    await window.api.invoke('settings:save', settings);
    setSaved(true);
  }

  if (!settings) {
    return <Spinner label="Loading settings…" labelPosition="after" size="tiny" />;
  }

  return (
    <div className={styles.root}>
      <Subtitle2>Settings</Subtitle2>

      <div className={styles.grid}>
        <Field label="Default model for new projects">
          <Dropdown
            value={settings.defaultModel}
            selectedOptions={[settings.defaultModel]}
            onOptionSelect={(_e, d) => patch({ defaultModel: d.optionValue as ClaudeModel })}
          >
            {MODELS.map((m) => (
              <Option key={m} value={m}>
                {m}
              </Option>
            ))}
          </Dropdown>
        </Field>

        <Field label="Default permission mode for new projects">
          <Dropdown
            value={PERMISSION_MODE_LABELS[settings.defaultPermissionMode]}
            selectedOptions={[settings.defaultPermissionMode]}
            onOptionSelect={(_e, d) =>
              patch({ defaultPermissionMode: d.optionValue as PermissionMode })
            }
          >
            {MODES.map((m) => (
              <Option key={m} value={m}>
                {PERMISSION_MODE_LABELS[m]}
              </Option>
            ))}
          </Dropdown>
        </Field>

        <Field
          label="Default concurrency for new projects"
          hint="Seeds each new project's concurrency. Existing projects keep their own value (edit it per project). 1 = strictly one at a time."
        >
          <SpinButton
            min={1}
            max={8}
            value={settings.concurrency}
            onChange={(_e, d) => {
              const n = d.value ?? Number(d.displayValue);
              if (Number.isFinite(n)) patch({ concurrency: Math.max(1, Math.round(n as number)) });
            }}
          />
        </Field>

        <Field
          label="Auto-retry failed tasks"
          hint="How many times a failed task's agent run is retried automatically before it parks in the inbox for you to resolve. 0 = park on the first failure. Merge/integration failures always park."
        >
          <SpinButton
            min={0}
            max={5}
            value={settings.maxAutoRetries}
            onChange={(_e, d) => {
              const n = d.value ?? Number(d.displayValue);
              if (Number.isFinite(n))
                patch({ maxAutoRetries: Math.max(0, Math.round(n as number)) });
            }}
          />
        </Field>

        <Field
          label="Resume jitter (seconds)"
          hint="Random delay added after a usage limit resets, before work resumes."
        >
          <SpinButton
            min={0}
            max={600}
            value={Math.round(settings.limitJitterMs / 1000)}
            onChange={(_e, d) => {
              const n = d.value ?? Number(d.displayValue);
              if (Number.isFinite(n))
                patch({ limitJitterMs: Math.max(0, Math.round(n as number)) * 1000 });
            }}
          />
        </Field>

        <Field label="Plan write-back">
          <Switch
            checked={settings.writeBackPlan}
            label="Tick completed checkboxes back into a new project's plan file"
            onChange={(_e, d) => patch({ writeBackPlan: d.checked })}
          />
        </Field>
      </div>

      <div className={styles.actions}>
        <Button appearance="primary" onClick={save}>
          Save
        </Button>
        {saved && <Caption1 className={styles.saved}>Saved.</Caption1>}
      </div>

      <Body1 className={styles.hint}>
        These are defaults for <strong>new</strong> projects and global scheduler knobs — existing
        projects keep their own model, mode, and write-back settings.
      </Body1>
    </div>
  );
}
