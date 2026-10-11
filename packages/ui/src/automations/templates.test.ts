import { describe, expect, it } from 'vitest';
import { draftErrors, type AutomationDraft } from './automationEditorModel';
import { applyTemplate, AUTOMATION_TEMPLATES } from './templates';

const OPTS = { timeZone: 'Europe/Warsaw', agentProjectId: 'proj-1', boardProjectId: 'board-1' };

describe('AUTOMATION_TEMPLATES', () => {
  it('has a unique id per template', () => {
    const ids = AUTOMATION_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has a non-empty name and description per template', () => {
    for (const t of AUTOMATION_TEMPLATES) {
      expect(t.name.trim()).not.toBe('');
      expect(t.description.trim()).not.toBe('');
    }
  });

  it('never uses manual permission mode', () => {
    for (const t of AUTOMATION_TEMPLATES) {
      expect(t.draft(OPTS).mode).not.toBe('manual');
    }
  });

  it.each(AUTOMATION_TEMPLATES.map((t) => [t.id, t] as const))(
    'is a valid draft once a project is picked: %s',
    (_id, t) => {
      expect(draftErrors(t.draft(OPTS))).toEqual([]);
    },
  );

  it.each(AUTOMATION_TEMPLATES.map((t) => [t.id, t] as const))(
    'is only missing an agent project before one is picked: %s',
    (_id, t) => {
      const errors = draftErrors(t.draft({ timeZone: OPTS.timeZone }));
      expect(errors).toEqual(['An agent project is required.']);
    },
  );
});

describe('applyTemplate', () => {
  it('keeps the current draft’s timeZone/agentProjectId/boardProjectId and takes the rest from the template', () => {
    const current: AutomationDraft = {
      ...AUTOMATION_TEMPLATES[0].draft(OPTS),
      timeZone: 'America/New_York',
      agentProjectId: 'proj-current',
      boardProjectId: 'board-current',
    };

    for (const t of AUTOMATION_TEMPLATES) {
      const applied = applyTemplate(t, current);
      expect(applied.timeZone).toBe('America/New_York');
      expect(applied.agentProjectId).toBe('proj-current');
      expect(applied.boardProjectId).toBe('board-current');

      const fromScratch = t.draft({
        timeZone: 'America/New_York',
        agentProjectId: 'proj-current',
        boardProjectId: 'board-current',
      });
      expect(applied).toEqual(fromScratch);
    }
  });
});
