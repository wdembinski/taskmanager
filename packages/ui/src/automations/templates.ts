/**
 * Starter automation templates — a human opening a fresh `AutomationEditor` sees a blank
 * form with no sense of what a "good" automation looks like. Each template below is a
 * complete, valid draft (modulo `agentProjectId`, which no template can know) for a
 * common case, so picking one is a starting point rather than a blank page.
 *
 * Pure and no React, same as `automationEditorModel.ts` — the palette UI (a later step)
 * just lists {@link AUTOMATION_TEMPLATES} and calls {@link applyTemplate}.
 */
import {
  newAutomationDraft,
  type AutomationDraft,
  type NewAutomationDraftOptions,
} from './automationEditorModel';

export interface AutomationTemplate {
  id: string;
  name: string;
  description: string;
  draft(opts: NewAutomationDraftOptions): AutomationDraft;
}

const TITLE_TEMPLATE = '{{automation.name}} — {{date}}';

const NIGHTLY_TRIAGE: AutomationTemplate = {
  id: 'nightly-triage',
  name: 'Nightly — triage new tickets',
  description:
    'Every night, review new and untriaged tickets and propose priority, labels and a next step.',
  draft: (opts) => ({
    ...newAutomationDraft(opts),
    name: 'Nightly — triage new tickets',
    scheduleType: 'daily',
    hour: 2,
    minute: 0,
    titleTemplate: TITLE_TEMPLATE,
    briefTemplate:
      'Review the tickets that are new or still untriaged. For each one, propose a priority, ' +
      'suggested labels, and a concrete next step — do not make any code changes.',
    mode: 'plan',
    autoCreatePr: false,
  }),
};

const WEEKDAY_FIX_TESTS: AutomationTemplate = {
  id: 'weekday-fix-tests',
  name: 'Weekday mornings — fix failing tests on main',
  description:
    'Weekday mornings, run the test suite on main, fix any failures, and open a pull request.',
  draft: (opts) => ({
    ...newAutomationDraft(opts),
    name: 'Weekday mornings — fix failing tests on main',
    scheduleType: 'weekdays',
    hour: 6,
    minute: 0,
    titleTemplate: TITLE_TEMPLATE,
    briefTemplate:
      'Run the test suite on the main branch. Fix any failing tests, then open a pull ' +
      'request with the fix.',
    mode: 'acceptEdits',
    autoCreatePr: true,
  }),
};

const WEEKLY_DEPS: AutomationTemplate = {
  id: 'weekly-deps',
  name: 'Weekly — dependency updates',
  description: 'Weekly, update dependencies within semver, run the gates, and open a pull request.',
  draft: (opts) => ({
    ...newAutomationDraft(opts),
    name: 'Weekly — dependency updates',
    scheduleType: 'weekly',
    day: 1,
    hour: 3,
    minute: 0,
    titleTemplate: TITLE_TEMPLATE,
    briefTemplate:
      'Update dependencies within their existing semver ranges. Run the full gate suite ' +
      '(lint, typecheck, tests, build) and fix anything the update breaks, then open a ' +
      'pull request with the changes.',
    mode: 'acceptEdits',
    autoCreatePr: true,
  }),
};

const AGENT_LABEL_TODO: AutomationTemplate = {
  id: 'agent-label-todo',
  name: 'Work any ticket labelled agent in To Do',
  description: 'When a ticket labelled "agent" enters To Do, work it.',
  draft: (opts) => ({
    ...newAutomationDraft(opts),
    name: 'Work any ticket labelled agent in To Do',
    triggerKind: 'tracker',
    source: 'jira',
    event: 'entered-status',
    status: 'To Do',
    anyLabels: 'agent',
    titleTemplate: TITLE_TEMPLATE,
    briefTemplate: 'Work {{ticket.key}}: {{ticket.title}}.',
    mode: 'acceptEdits',
    autoCreatePr: true,
  }),
};

/** Every starter template, in the order the palette (a later step) offers them. */
export const AUTOMATION_TEMPLATES: readonly AutomationTemplate[] = [
  NIGHTLY_TRIAGE,
  WEEKDAY_FIX_TESTS,
  WEEKLY_DEPS,
  AGENT_LABEL_TODO,
];

/** Re-seed from a template, keeping what the human already chose that a template can't
 *  know: time zone, agent project, board project. */
export function applyTemplate(t: AutomationTemplate, current: AutomationDraft): AutomationDraft {
  return t.draft({
    timeZone: current.timeZone,
    agentProjectId: current.agentProjectId,
    boardProjectId: current.boardProjectId,
  });
}
