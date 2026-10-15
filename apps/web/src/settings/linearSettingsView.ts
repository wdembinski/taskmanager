/**
 * Pure view logic for the read-only Linear pane — the rows it shows, with no DOM. Same reason
 * as `tokensView.ts`: this workspace has no jsdom/`@testing-library`, so anything worth
 * asserting about the pane has to live in a function like this one.
 *
 * The pane itself has no inputs: Linear's connection test and its team/state pickers need the
 * desktop's own API key, which never leaves that machine (see `SettingsScreen.tsx`'s Linear
 * pane and `HOST_ONLY_SECTIONS`). This is everything there is to show about it instead.
 */
import { LINEAR_STATE_TYPE_ORDER } from '@tm/ui/linearSettingsForm';
import type { LinearSettings } from '@tm/shared/settings';

/** `type`, spelled for display — `'unstarted'` -> `'Unstarted'`. */
function stateTypeLabel(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/** One row of the pane: a label and the plain-text value next to it. */
export interface LinearSettingsRow {
  label: string;
  value: string;
}

/** The rows the read-only Linear pane shows, in display order. */
export function describeLinearSettings(linear: LinearSettings): LinearSettingsRow[] {
  const rows: LinearSettingsRow[] = [
    { label: 'Sync', value: linear.enabled ? 'On' : 'Off' },
    {
      label: 'Teams',
      value: linear.teamKeys.length > 0 ? linear.teamKeys.join(', ') : 'None — nothing is mirrored',
    },
    { label: 'Assignee', value: linear.assignee === 'me' ? 'Me' : 'Anyone' },
    {
      label: 'Included state types',
      value: LINEAR_STATE_TYPE_ORDER.filter((type) => linear.includeStateTypes.includes(type))
        .map(stateTypeLabel)
        .join(', '),
    },
    {
      label: 'Advanced filter',
      value: linear.advancedFilter?.trim() ? linear.advancedFilter : 'None',
    },
    { label: 'Keep finished cards for', value: `${linear.doneRetentionDays} days` },
    {
      label: 'Column overrides',
      value: String(Object.keys(linear.stateColumnOverrides).length),
    },
  ];

  for (const teamKey of Object.keys(linear.columnTargetStates).sort()) {
    const targets = linear.columnTargetStates[teamKey] ?? {};
    const entries = Object.entries(targets)
      .map(([column, state]) => `${column}: ${state}`)
      .join(', ');
    rows.push({ label: `${teamKey} column targets`, value: entries || 'None' });
  }

  return rows;
}
