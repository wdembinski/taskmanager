import { describe, expect, it } from 'vitest';
import type { TaskAttachment } from './attachments';
import type { TaskActivityEntry } from './model';
import {
  formatSignOff,
  formatVisualSignOffComment,
  latestVisualState,
  parseSignOff,
  parseVisualVerdicts,
  shotPairs,
  visualVerdictFileName,
  visualVerdictFileNames,
} from './visualSignOff';

function attachment(over: Partial<TaskAttachment> & { id: string; name: string }): TaskAttachment {
  return {
    taskId: 'owner-1',
    fileName: over.name,
    mimeType: null,
    size: 0,
    createdAt: 0,
    ...over,
  };
}

describe('parseVisualVerdicts', () => {
  it('parses an ok line and a mismatch line with a dash-separated note', () => {
    const verdicts = parseVisualVerdicts(
      'board-light: ok\nboard-dark: mismatch - header colour drifted from the mockup',
    );
    expect(verdicts).toEqual([
      { screen: 'board-light', status: 'ok', note: '' },
      { screen: 'board-dark', status: 'mismatch', note: 'header colour drifted from the mockup' },
    ]);
  });

  it('reads a mismatch note with no dash the same as one with a dash', () => {
    const verdicts = parseVisualVerdicts('settings: mismatch the save button is misaligned');
    expect(verdicts).toEqual([
      { screen: 'settings', status: 'mismatch', note: 'the save button is misaligned' },
    ]);
  });

  it('is case-insensitive on the verdict word', () => {
    expect(parseVisualVerdicts('issue-peek: OK')).toEqual([
      { screen: 'issue-peek', status: 'ok', note: '' },
    ]);
  });

  it('treats an unrecognised verdict word as a mismatch, keeping the whole remainder', () => {
    expect(parseVisualVerdicts('palette: looks wrong, spacing is off')).toEqual([
      { screen: 'palette', status: 'mismatch', note: 'looks wrong, spacing is off' },
    ]);
  });

  it('skips blank lines and lines with no colon or no screen name', () => {
    const verdicts = parseVisualVerdicts(
      ['', '  ', 'no colon here', ': ok', 'archived-light: ok'].join('\n'),
    );
    expect(verdicts).toEqual([{ screen: 'archived-light', status: 'ok', note: '' }]);
  });

  it('returns nothing for an empty file', () => {
    expect(parseVisualVerdicts('')).toEqual([]);
  });
});

describe('visualVerdictFileName / visualVerdictFileNames', () => {
  it("names a screen's screenshot", () => {
    expect(visualVerdictFileName('board-light')).toBe('board-light.png');
  });

  it('maps a whole verdict list to its screenshot names', () => {
    const verdicts = parseVisualVerdicts('board-light: ok\nboard-dark: mismatch - off');
    expect(visualVerdictFileNames(verdicts)).toEqual(['board-light.png', 'board-dark.png']);
  });
});

describe('formatVisualSignOffComment', () => {
  it('says a human still has to look when there are no verdicts at all', () => {
    expect(formatVisualSignOffComment([], 'Add the archived screen')).toBe(
      'Visual sign-off from "Add the archived screen": screenshots attached, but no ' +
        'verdicts.txt — a human still has to look.',
    );
  });

  it('summarises a clean sheet with no per-screen lines', () => {
    const verdicts = parseVisualVerdicts('board-light: ok\nboard-dark: ok');
    expect(formatVisualSignOffComment(verdicts, 'Add the archived screen')).toBe(
      'Visual sign-off from "Add the archived screen": all 2 screens matched the mockup.',
    );
  });

  it('singularises a one-screen clean sheet', () => {
    const verdicts = parseVisualVerdicts('board-light: ok');
    expect(formatVisualSignOffComment(verdicts, 'Add the board screen')).toContain(
      'all 1 screen matched',
    );
  });

  it('lists every mismatch with its note, and counts the rest as matched', () => {
    const verdicts = parseVisualVerdicts(
      [
        'board-light: ok',
        'board-dark: mismatch - header drifted',
        'settings: mismatch - spacing off',
      ].join('\n'),
    );
    const comment = formatVisualSignOffComment(verdicts, 'Add the settings screen');
    expect(comment).toBe(
      [
        'Visual sign-off from "Add the settings screen": 2 screens of 3 need a look.',
        '',
        '- board-dark: header drifted',
        '- settings: spacing off',
      ].join('\n'),
    );
  });

  it('falls back to a flat note for a mismatch with none given', () => {
    const verdicts = parseVisualVerdicts('board-dark: mismatch');
    const comment = formatVisualSignOffComment(verdicts, 'Add the board screen');
    expect(comment).toContain('- board-dark: flagged, no reason given');
  });
});

describe('shotPairs', () => {
  it('groups a real shot with its mockup and side-by-side page by name', () => {
    const attachments = [
      attachment({ id: '1', name: 'board-light.png' }),
      attachment({ id: '2', name: 'board-light-mockup.png' }),
      attachment({ id: '3', name: 'board-light.html' }),
      attachment({ id: '4', name: 'shots.json' }),
      attachment({ id: '5', name: 'index.html' }),
    ];
    const { pairs, indexHtml } = shotPairs(attachments);
    expect(pairs).toEqual([
      {
        name: 'board-light',
        real: attachments[0],
        mockup: attachments[1],
        html: attachments[2],
      },
    ]);
    expect(indexHtml).toBe(attachments[4]);
  });

  it('leaves mockup and html undefined for a screen the script ran with neither', () => {
    const attachments = [attachment({ id: '1', name: 'board-sidebar-folded.png' })];
    expect(shotPairs(attachments).pairs).toEqual([
      { name: 'board-sidebar-folded', real: attachments[0], mockup: undefined, html: undefined },
    ]);
  });

  it('is empty for a card with no screenshots at all', () => {
    expect(shotPairs([attachment({ id: '1', name: 'notes.txt' })]).pairs).toEqual([]);
  });
});

describe('formatSignOff / parseSignOff', () => {
  it('round-trips an approval with no screens', () => {
    const body = formatSignOff('approved');
    expect(body).toBe('Visual sign-off: approved');
    expect(parseSignOff(body)).toEqual({ status: 'approved', screens: [], by: 'human' });
  });

  it('round-trips a needs-changes naming its screens', () => {
    const body = formatSignOff('needs-changes', ['board-light', 'settings']);
    expect(body).toBe('Visual sign-off: needs changes — board-light, settings');
    expect(parseSignOff(body)).toEqual({
      status: 'needs-changes',
      screens: ['board-light', 'settings'],
      by: 'human',
    });
  });

  it('round-trips the AI reviewer’s approval, and keeps the human form byte-identical', () => {
    const ai = formatSignOff('approved', [], 'ai');
    expect(ai).toBe('Visual sign-off: approved (AI reviewer)');
    expect(parseSignOff(ai)).toEqual({ status: 'approved', screens: [], by: 'ai' });
    expect(formatSignOff('approved', [], 'human')).toBe('Visual sign-off: approved');
  });

  it('rejects an approval with any other suffix', () => {
    expect(parseSignOff('Visual sign-off: approved (by someone)')).toBeNull();
  });

  it('never matches the agent’s own "Visual sign-off from" comment', () => {
    expect(
      parseSignOff('Visual sign-off from "Add the board screen": all 1 screen matched the mockup.'),
    ).toBeNull();
  });

  it('returns null for text that is not a sign-off comment at all', () => {
    expect(parseSignOff('Looks good to me.')).toBeNull();
  });
});

describe('latestVisualState', () => {
  function comment(id: number, body: string, createdAt: number): TaskActivityEntry {
    return { kind: 'comment', id, body, createdAt };
  }

  it('is pending with every row unknown when activity has no sign-off at all', () => {
    const state = latestVisualState([comment(1, 'unrelated note', 0)], ['board-light']);
    expect(state.human).toBe('pending');
    expect(state.rows.get('board-light')).toEqual({ status: 'unknown', note: '' });
  });

  it('reads the agent’s per-screen verdict off its latest sign-off comment', () => {
    const body = [
      'Visual sign-off from "Add the settings screen": 1 screen of 2 need a look.',
      '',
      '- settings: spacing off',
    ].join('\n');
    const state = latestVisualState([comment(1, body, 0)], ['board-light', 'settings']);
    expect(state.rows.get('board-light')).toEqual({ status: 'ok', note: '' });
    expect(state.rows.get('settings')).toEqual({ status: 'mismatch', note: 'spacing off' });
  });

  it('leaves every row unknown when the agent ingested with no verdicts.txt', () => {
    const body =
      'Visual sign-off from "Add the board screen": screenshots attached, but no verdicts.txt — a human still has to look.';
    const state = latestVisualState([comment(1, body, 0)], ['board-light']);
    expect(state.rows.get('board-light')).toEqual({ status: 'unknown', note: '' });
  });

  it('reads the human’s latest approval or needs-changes call', () => {
    const approved = latestVisualState([comment(1, formatSignOff('approved'), 0)], []);
    expect(approved.human).toBe('approved');

    const needsChanges = latestVisualState(
      [comment(1, formatSignOff('needs-changes', ['board-light']), 0)],
      [],
    );
    expect(needsChanges.human).toBe('needs-changes');
    expect(needsChanges.needsChangesScreens).toEqual(['board-light']);
  });

  it('prefers the newest sign-off over an older one', () => {
    const state = latestVisualState(
      [
        comment(1, formatSignOff('needs-changes', ['board-light']), 0),
        comment(2, formatSignOff('approved'), 1000),
      ],
      [],
    );
    expect(state.human).toBe('approved');
  });

  it('says who signed off — nobody while pending, then the human or the AI reviewer', () => {
    expect(latestVisualState([], []).signedOffBy).toBeNull();
    expect(latestVisualState([comment(1, formatSignOff('approved'), 0)], []).signedOffBy).toBe(
      'human',
    );
    const ai = latestVisualState([comment(1, formatSignOff('approved', [], 'ai'), 0)], []);
    expect(ai.human).toBe('approved');
    expect(ai.signedOffBy).toBe('ai');
  });

  it('lets a human needs-changes after an AI approval win', () => {
    const state = latestVisualState(
      [
        comment(1, formatSignOff('approved', [], 'ai'), 0),
        comment(2, formatSignOff('needs-changes', ['board-light']), 1000),
      ],
      [],
    );
    expect(state.human).toBe('needs-changes');
    expect(state.signedOffBy).toBe('human');
  });
});
