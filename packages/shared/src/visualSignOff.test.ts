import { describe, expect, it } from 'vitest';
import {
  formatVisualSignOffComment,
  parseVisualVerdicts,
  visualVerdictFileName,
  visualVerdictFileNames,
} from './visualSignOff';

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
