/**
 * AutomationEditor — create or edit one automation (F1.14). Follows the same shape as
 * `AssignAgentDialog`/`projects/NewTicketDialog`: a Fluent `Dialog` that owns its own form
 * state, seeded on open, with the host doing the actual `automation:save` call so this stays
 * transport-agnostic.
 *
 * All the "what does this mean, what would it do" logic lives in `automationEditorModel.ts`
 * (pure, tested there) — this file is rendering and wiring alone.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Body1,
  Button,
  Caption1,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Option,
  Radio,
  RadioGroup,
  Switch,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  HOUR_INTERVALS,
  TRACKER_EVENT_KINDS,
  TRACKER_SOURCES,
  type Automation,
  type HourInterval,
  type TrackerEventKind,
  type TrackerSource,
} from '@tm/shared/automation';
import { TEMPLATE_VARIABLES } from '@tm/shared/automationTemplate';
import { resolveRunModel } from '@tm/shared/model';
import type { Project } from '@tm/shared/model';
import { PERMISSION_MODE_LABELS, type PermissionMode } from '@tm/shared/session';
import { autoCreatePrTooltip, autoMergeTooltip } from '../agentAutoToggles';
import { projectDefaultLabel } from '../modelChoice';
import { ModelField } from '../ModelField';
import { PlanningModelField } from '../PlanningModelField';
import {
  MANUAL_MODE_EXPLANATION,
  SCHEDULE_TYPES,
  automationFromDraft,
  automationModeOptions,
  draftErrors,
  draftFromAutomation,
  newAutomationDraft,
  nextRunsPreview,
  templatePreview,
  type AutomationDraft,
  type ScheduleType,
} from './automationEditorModel';

const useStyles = makeStyles({
  surface: { maxWidth: 'min(760px, calc(100vw - 48px))', width: '100%' },
  body: { maxHeight: 'calc(100vh - 160px)' },
  form: { display: 'flex', flexDirection: 'column', gap: '16px', minWidth: 0 },
  section: { display: 'flex', flexDirection: 'column', gap: '12px' },
  row: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'start' },
  grow: { flex: 1, minWidth: '180px' },
  narrow: { width: '140px', flexShrink: 0 },
  dropdown: { minWidth: 0, width: '100%' },
  hint: { color: tokens.colorNeutralForeground3 },
  preview: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    padding: '8px 10px',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  list: { margin: 0, paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '2px' },
});

const SCHEDULE_TYPE_LABELS: Record<ScheduleType, string> = {
  daily: 'Daily',
  weekdays: 'Weekdays',
  weekly: 'Weekly',
  hours: 'Every N hours',
};

const WEEKDAY_LABELS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

const TRACKER_SOURCE_LABELS: Record<TrackerSource, string> = { jira: 'Jira', github: 'GitHub' };

const TRACKER_EVENT_LABELS: Record<TrackerEventKind, string> = {
  appeared: 'A ticket appears on the board',
  'entered-status': 'A ticket enters a status',
  labeled: 'A ticket is labeled',
};

export interface AutomationEditorProps {
  open: boolean;
  /** `null` means a new automation. */
  automation: Automation | null;
  /** A starter draft (F1.16 templates) — takes the place of the usual new-automation
   *  defaults, but still only on open; see the seeding effect below. */
  initialDraft?: AutomationDraft;
  projects: Project[];
  defaultTimeZone: string;
  onSave: (automation: Automation) => Promise<void>;
  onDismiss: () => void;
}

export function AutomationEditor({
  open,
  automation,
  initialDraft,
  projects,
  defaultTimeZone,
  onSave,
  onDismiss,
}: AutomationEditorProps): JSX.Element {
  const styles = useStyles();
  const [draft, setDraft] = useState<AutomationDraft>(
    () => initialDraft ?? draftOf(automation, defaultTimeZone),
  );
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Seed once per opening, the same discipline `AssignAgentDialog` follows — keyed on the
  // automation's id (not the object), so a background `automations:changed` refresh while
  // the dialog is open cannot wipe what the human is halfway through typing.
  const latest = useRef({ automation, initialDraft, defaultTimeZone });
  latest.current = { automation, initialDraft, defaultTimeZone };
  useEffect(() => {
    if (!open) return;
    const { automation: a, initialDraft: seed, defaultTimeZone: tz } = latest.current;
    setDraft(seed ?? draftOf(a, tz));
    setBusy(false);
    setSubmitError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, automation?.id]);

  function patch(fields: Partial<AutomationDraft>): void {
    setDraft((d) => ({ ...d, ...fields }));
  }

  async function save(): Promise<void> {
    setBusy(true);
    setSubmitError(null);
    try {
      await onSave(automationFromDraft(draft, automation));
      onDismiss();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const now = Date.now();
  const errors = draftErrors(draft);
  const runs = nextRunsPreview(draft, now);
  const preview = templatePreview(draft, now);
  const agentProject = projects.find((p) => p.id === draft.agentProjectId) ?? null;
  const boardProject = projects.find((p) => p.id === draft.boardProjectId) ?? null;
  const executionModel = agentProject
    ? resolveRunModel(
        { agentModel: draft.model || null, agentPlanningModel: null },
        agentProject,
        false,
      )
    : draft.model || 'sonnet';
  const inheritedCreatePr = Boolean(agentProject?.autoCreatePr);
  const inheritedIntegrate = Boolean(agentProject?.autoIntegrate);
  const effectiveCreatePr = draft.autoCreatePr ?? inheritedCreatePr;
  const effectiveIntegrate = draft.autoIntegrate ?? inheritedIntegrate;

  function patchNumber(field: 'hour' | 'minute', text: string): void {
    const n = text === '' ? 0 : Number(text);
    if (!Number.isNaN(n)) patch({ [field]: n } as Partial<AutomationDraft>);
  }

  return (
    <Dialog open={open} onOpenChange={(_e, d) => !d.open && onDismiss()}>
      <DialogSurface className={styles.surface}>
        <DialogBody className={styles.body}>
          <DialogTitle>{automation ? 'Edit automation' : 'New automation'}</DialogTitle>
          <DialogContent>
            <div className={styles.form}>
              {submitError && (
                <MessageBar intent="error">
                  <MessageBarBody>{submitError}</MessageBarBody>
                </MessageBar>
              )}

              <Field label="Name" required>
                <Input
                  value={draft.name}
                  onChange={(_e, d) => patch({ name: d.value })}
                  placeholder="e.g. Nightly triage"
                />
              </Field>

              <Field label="Enabled">
                <Switch
                  checked={draft.enabled}
                  onChange={(_e, d) => patch({ enabled: d.checked })}
                  label={draft.enabled ? 'Runs on its own' : 'Paused — never fires'}
                />
              </Field>

              <Field label="Trigger">
                <RadioGroup
                  layout="horizontal"
                  value={draft.triggerKind}
                  onChange={(_e, d) =>
                    patch({ triggerKind: d.value as AutomationDraft['triggerKind'] })
                  }
                >
                  <Radio value="schedule" label="Schedule — fires on a clock" />
                  <Radio value="tracker" label="Tracker — fires on a ticket event" />
                </RadioGroup>
              </Field>

              {draft.triggerKind === 'schedule' ? (
                <div className={styles.section}>
                  <div className={styles.row}>
                    <Field label="Shape" className={styles.narrow}>
                      <Dropdown
                        className={styles.dropdown}
                        value={SCHEDULE_TYPE_LABELS[draft.scheduleType]}
                        selectedOptions={[draft.scheduleType]}
                        onOptionSelect={(_e, d) =>
                          d.optionValue && patch({ scheduleType: d.optionValue as ScheduleType })
                        }
                      >
                        {SCHEDULE_TYPES.map((t) => (
                          <Option key={t} value={t} text={SCHEDULE_TYPE_LABELS[t]}>
                            {SCHEDULE_TYPE_LABELS[t]}
                          </Option>
                        ))}
                      </Dropdown>
                    </Field>

                    {draft.scheduleType !== 'hours' && (
                      <>
                        <Field label="Hour" className={styles.narrow}>
                          <Input
                            type="number"
                            value={String(draft.hour)}
                            onChange={(_e, d) => patchNumber('hour', d.value)}
                          />
                        </Field>
                        <Field label="Minute" className={styles.narrow}>
                          <Input
                            type="number"
                            value={String(draft.minute)}
                            onChange={(_e, d) => patchNumber('minute', d.value)}
                          />
                        </Field>
                      </>
                    )}

                    {draft.scheduleType === 'weekly' && (
                      <Field label="Day" className={styles.narrow}>
                        <Dropdown
                          className={styles.dropdown}
                          value={WEEKDAY_LABELS[draft.day - 1]}
                          selectedOptions={[String(draft.day)]}
                          onOptionSelect={(_e, d) =>
                            d.optionValue &&
                            patch({ day: Number(d.optionValue) as AutomationDraft['day'] })
                          }
                        >
                          {WEEKDAY_LABELS.map((label, i) => (
                            <Option key={label} value={String(i + 1)} text={label}>
                              {label}
                            </Option>
                          ))}
                        </Dropdown>
                      </Field>
                    )}

                    {draft.scheduleType === 'hours' && (
                      <Field label="Every" className={styles.narrow}>
                        <Dropdown
                          className={styles.dropdown}
                          value={draft.every === 1 ? 'every hour' : `every ${draft.every} hours`}
                          selectedOptions={[String(draft.every)]}
                          onOptionSelect={(_e, d) =>
                            d.optionValue && patch({ every: Number(d.optionValue) as HourInterval })
                          }
                        >
                          {HOUR_INTERVALS.map((h) => (
                            <Option key={h} value={String(h)} text={`every ${h} hours`}>
                              {h === 1 ? 'every hour' : `every ${h} hours`}
                            </Option>
                          ))}
                        </Dropdown>
                      </Field>
                    )}
                  </div>
                  <Caption1 className={styles.hint}>Time zone: {draft.timeZone}</Caption1>
                </div>
              ) : (
                <div className={styles.section}>
                  <div className={styles.row}>
                    <Field label="Source" className={styles.narrow}>
                      <Dropdown
                        className={styles.dropdown}
                        value={TRACKER_SOURCE_LABELS[draft.source]}
                        selectedOptions={[draft.source]}
                        onOptionSelect={(_e, d) =>
                          d.optionValue && patch({ source: d.optionValue as TrackerSource })
                        }
                      >
                        {TRACKER_SOURCES.map((s) => (
                          <Option key={s} value={s} text={TRACKER_SOURCE_LABELS[s]}>
                            {TRACKER_SOURCE_LABELS[s]}
                          </Option>
                        ))}
                      </Dropdown>
                    </Field>
                    <Field label="Event" className={styles.grow}>
                      <Dropdown
                        className={styles.dropdown}
                        value={TRACKER_EVENT_LABELS[draft.event]}
                        selectedOptions={[draft.event]}
                        onOptionSelect={(_e, d) =>
                          d.optionValue && patch({ event: d.optionValue as TrackerEventKind })
                        }
                      >
                        {TRACKER_EVENT_KINDS.map((e) => (
                          <Option key={e} value={e} text={TRACKER_EVENT_LABELS[e]}>
                            {TRACKER_EVENT_LABELS[e]}
                          </Option>
                        ))}
                      </Dropdown>
                    </Field>
                  </div>

                  {draft.event === 'entered-status' && (
                    <Field
                      label="Status"
                      required
                      hint="Matches the ticket's status, case-insensitively."
                    >
                      <Input
                        value={draft.status}
                        onChange={(_e, d) => patch({ status: d.value })}
                        placeholder='e.g. "To Do"'
                      />
                    </Field>
                  )}
                  {draft.event === 'labeled' && (
                    <Field label="Label" required>
                      <Input
                        value={draft.label}
                        onChange={(_e, d) => patch({ label: d.value })}
                        placeholder="e.g. agent"
                      />
                    </Field>
                  )}

                  <div className={styles.row}>
                    <Field
                      label="Any of these labels (optional)"
                      className={styles.grow}
                      hint="Comma-separated."
                    >
                      <Input
                        value={draft.anyLabels}
                        onChange={(_e, d) => patch({ anyLabels: d.value })}
                      />
                    </Field>
                    <Field
                      label="All of these labels (optional)"
                      className={styles.grow}
                      hint="Comma-separated."
                    >
                      <Input
                        value={draft.allLabels}
                        onChange={(_e, d) => patch({ allLabels: d.value })}
                      />
                    </Field>
                    <Field
                      label="Excluding these labels (optional)"
                      className={styles.grow}
                      hint="Comma-separated."
                    >
                      <Input
                        value={draft.excludeLabels}
                        onChange={(_e, d) => patch({ excludeLabels: d.value })}
                      />
                    </Field>
                  </div>
                </div>
              )}

              <div className={styles.section}>
                {draft.triggerKind === 'schedule' && (
                  <Field label="Board project" hint="Where the new card is created.">
                    <Dropdown
                      className={styles.dropdown}
                      value={boardProject?.name ?? ''}
                      selectedOptions={draft.boardProjectId ? [draft.boardProjectId] : []}
                      onOptionSelect={(_e, d) => patch({ boardProjectId: d.optionValue ?? '' })}
                    >
                      {projects.map((p) => (
                        <Option key={p.id} value={p.id} text={p.name}>
                          {p.name}
                        </Option>
                      ))}
                    </Dropdown>
                  </Field>
                )}

                <Field
                  label="Agent project"
                  required
                  hint={agentProject ? agentProject.path : 'The repository the agent works in.'}
                >
                  <Dropdown
                    className={styles.dropdown}
                    value={agentProject?.name ?? ''}
                    selectedOptions={draft.agentProjectId ? [draft.agentProjectId] : []}
                    onOptionSelect={(_e, d) => patch({ agentProjectId: d.optionValue ?? '' })}
                  >
                    {projects.map((p) => (
                      <Option key={p.id} value={p.id} text={p.name}>
                        {p.name}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>

                <div className={styles.row}>
                  <PlanningModelField
                    label="Planning model"
                    className={styles.grow}
                    value={draft.planningModel}
                    executionModel={executionModel}
                    onChange={(m) => patch({ planningModel: m })}
                  />
                  <ModelField
                    label="Steps execution model"
                    className={styles.grow}
                    dropdownClassName={styles.dropdown}
                    value={draft.model}
                    onChange={(v) => patch({ model: v })}
                    sentinel={{ value: '', label: projectDefaultLabel(agentProject) }}
                  />
                </div>

                <Field
                  label="Permission mode"
                  hint={draft.mode === 'manual' ? MANUAL_MODE_EXPLANATION : undefined}
                >
                  <Dropdown
                    className={styles.dropdown}
                    value={PERMISSION_MODE_LABELS[draft.mode]}
                    selectedOptions={[draft.mode]}
                    onOptionSelect={(_e, d) =>
                      d.optionValue && patch({ mode: d.optionValue as PermissionMode })
                    }
                  >
                    {automationModeOptions().map((o) => (
                      <Option key={o.value} value={o.value} disabled={o.disabled} text={o.label}>
                        {o.label}
                      </Option>
                    ))}
                  </Dropdown>
                </Field>

                <div className={styles.row}>
                  <Field
                    label="Open a pull request"
                    className={styles.grow}
                    hint={autoCreatePrTooltip({
                      on: effectiveCreatePr,
                      prNoun: 'pull request',
                      projectName: agentProject?.name,
                      projectDefaultOn: inheritedCreatePr,
                    })}
                  >
                    <Switch
                      checked={effectiveCreatePr}
                      onChange={(_e, d) =>
                        patch({
                          autoCreatePr: d.checked === inheritedCreatePr ? null : d.checked,
                        })
                      }
                    />
                  </Field>
                  <Field
                    label="Merge automatically"
                    className={styles.grow}
                    hint={autoMergeTooltip({
                      on: effectiveIntegrate,
                      baseBranch: agentProject?.baseBranch,
                      projectName: agentProject?.name,
                      inherited: inheritedIntegrate,
                    })}
                  >
                    <Switch
                      checked={effectiveIntegrate}
                      onChange={(_e, d) =>
                        patch({
                          autoIntegrate: d.checked === inheritedIntegrate ? null : d.checked,
                        })
                      }
                    />
                  </Field>
                </div>
              </div>

              <div className={styles.section}>
                {draft.triggerKind === 'schedule' && (
                  <Field label="Title template">
                    <Input
                      value={draft.titleTemplate}
                      onChange={(_e, d) => patch({ titleTemplate: d.value })}
                    />
                  </Field>
                )}
                <Field label="Brief template">
                  <Textarea
                    value={draft.briefTemplate}
                    resize="vertical"
                    onChange={(_e, d) => patch({ briefTemplate: d.value })}
                  />
                </Field>
                <Caption1 className={styles.hint}>
                  Variables: {TEMPLATE_VARIABLES.map((v) => `{{${v.name}}}`).join('  ·  ')}
                </Caption1>
                <div className={styles.preview}>
                  <Body1>Preview</Body1>
                  {draft.triggerKind === 'schedule' && <span>{preview.title}</span>}
                  <span>{preview.brief}</span>
                </div>
              </div>

              {draft.triggerKind === 'schedule' && (
                <Field label="Next 5 runs">
                  {runs.length === 0 ? (
                    <Caption1 className={styles.hint}>
                      No upcoming runs — fix the schedule above.
                    </Caption1>
                  ) : (
                    <ul className={styles.list}>
                      {runs.map((r) => (
                        <li key={r.at}>{r.label}</li>
                      ))}
                    </ul>
                  )}
                </Field>
              )}

              {errors.length > 0 && (
                <MessageBar intent="error">
                  <MessageBarBody>
                    <ul className={styles.list}>
                      {errors.map((e) => (
                        <li key={e}>{e}</li>
                      ))}
                    </ul>
                  </MessageBarBody>
                </MessageBar>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onDismiss} disabled={busy}>
              Cancel
            </Button>
            <Button
              appearance="primary"
              onClick={() => void save()}
              disabled={busy || errors.length > 0}
            >
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

/** The seed for a fresh open: the automation's own draft, or a brand-new one. */
function draftOf(automation: Automation | null, timeZone: string): AutomationDraft {
  return automation ? draftFromAutomation(automation) : newAutomationDraft({ timeZone });
}
