/**
 * Unit tests for the pure question detector. Permissions are covered by
 * permissionPolicy.test.ts (and exercised through the broker, not here).
 */
import { describe, expect, it } from 'vitest';
import {
  AGREE_SENTINEL,
  detectAttention,
  detectProposal,
  detectQuestion,
  detectResponse,
  fileMatchesGlob,
  NEEDS_INPUT_SENTINEL,
  OBJECT_SENTINEL,
  parseFileOwnership,
  PROPOSE_SENTINEL,
  siblingsAffectedByProposal,
  tallyConsensus,
} from './attention';
import type { SessionEvent } from '@shared/session';

describe('detectQuestion — the @@NEEDS_INPUT@@ contract', () => {
  it('extracts a free-text question that follows the sentinel', () => {
    expect(detectQuestion(`${NEEDS_INPUT_SENTINEL} Which database should I use?`)).toEqual({
      kind: 'question',
      prompt: 'Which database should I use?',
      options: [],
    });
  });

  it('parses following "- " bullets as multiple-choice options', () => {
    const text = `Some preamble.\n${NEEDS_INPUT_SENTINEL} Which storage backend?\n- SQLite (embedded)\n- Postgres (needs a server)`;
    expect(detectQuestion(text)).toEqual({
      kind: 'question',
      prompt: 'Which storage backend?',
      options: ['SQLite (embedded)', 'Postgres (needs a server)'],
    });
  });

  it('does NOT fire on prose that merely contains a question mark', () => {
    expect(detectQuestion('I wondered whether to cache this? I did, and moved on.')).toBeNull();
    expect(detectQuestion('Done — everything passes.')).toBeNull();
  });

  it('falls back to a generic prompt when the marker has no text', () => {
    expect(detectQuestion(NEEDS_INPUT_SENTINEL)).toEqual({
      kind: 'question',
      prompt: 'Claude needs input to continue.',
      options: [],
    });
  });
});

describe('detectAttention', () => {
  it('detects a sentinel question in an assistant event', () => {
    const event: SessionEvent = { kind: 'assistant', text: `${NEEDS_INPUT_SENTINEL} pick one?` };
    expect(detectAttention(event)).toEqual({ kind: 'question', prompt: 'pick one?', options: [] });
  });

  it('ignores other event kinds and non-sentinel assistant text', () => {
    expect(detectAttention({ kind: 'assistant', text: 'working on it' })).toBeNull();
    expect(detectAttention({ kind: 'tool-use', name: 'Bash', toolId: 't', input: {} })).toBeNull();
    expect(detectAttention({ kind: 'exited', code: 0 })).toBeNull();
  });
});

describe('detectProposal — the @@PROPOSE@@ contract', () => {
  it('extracts the proposal text on the sentinel line', () => {
    expect(detectProposal(`${PROPOSE_SENTINEL} Switch the API to return camelCase.`)).toEqual({
      kind: 'proposal',
      text: 'Switch the API to return camelCase.',
      files: [],
    });
  });

  it('parses following bullets as the affected files/areas', () => {
    const text = `Some reasoning.\n${PROPOSE_SENTINEL} Rename the User type.\n- src/shared/model.ts\n- src/api/**`;
    expect(detectProposal(text)).toEqual({
      kind: 'proposal',
      text: 'Rename the User type.',
      files: ['src/shared/model.ts', 'src/api/**'],
    });
  });

  it('does not fire without the sentinel', () => {
    expect(detectProposal('I propose we refactor this later.')).toBeNull();
  });

  it('falls back to a generic text when the marker line is empty', () => {
    expect(detectProposal(`${PROPOSE_SENTINEL}\n- a.ts`)).toEqual({
      kind: 'proposal',
      text: 'A teammate proposes a change.',
      files: ['a.ts'],
    });
  });
});

describe('detectResponse — AGREE / OBJECT', () => {
  it('detects agreement', () => {
    expect(detectResponse(`Sure. ${AGREE_SENTINEL}`)).toEqual({ position: 'agree', reason: '' });
  });

  it('detects an objection with its reason', () => {
    expect(detectResponse(`${OBJECT_SENTINEL} that breaks my in-progress migration`)).toEqual({
      position: 'object',
      reason: 'that breaks my in-progress migration',
    });
  });

  it('treats a mixed reply as an objection (fail safe)', () => {
    expect(detectResponse(`${AGREE_SENTINEL} but ${OBJECT_SENTINEL} on second thought`)).toEqual({
      position: 'object',
      reason: 'on second thought',
    });
  });

  it('returns null when neither marker is present', () => {
    expect(detectResponse('still working on my part')).toBeNull();
  });
});

describe('parseFileOwnership', () => {
  it('reads owner→globs rows under a "File ownership" heading, in both bullet shapes', () => {
    const md = [
      '# Contract',
      'Some intro prose mentioning file.ts that must be ignored.',
      '## File ownership',
      '- src/api/** — Build the API',
      '- Build the UI: src/ui/**, src/ui/App.tsx',
      '## Other',
      '- src/ignored.ts — not ownership',
    ].join('\n');
    const entries = parseFileOwnership(md);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ owner: 'Build the API', globs: ['src/api/**'] });
    expect(entries[1].owner).toBe('Build the UI');
    expect(entries[1].globs).toEqual(['src/ui/**', 'src/ui/App.tsx']);
  });

  it('returns nothing when there is no ownership section', () => {
    expect(parseFileOwnership('# Contract\nJust prose, no ownership map.')).toEqual([]);
  });
});

describe('fileMatchesGlob', () => {
  it('matches ** across directories and * within a segment', () => {
    expect(fileMatchesGlob('src/api/routes/users.ts', 'src/api/**')).toBe(true);
    expect(fileMatchesGlob('src/api/users.ts', 'src/api/*.ts')).toBe(true);
    expect(fileMatchesGlob('src/ui/App.tsx', 'src/api/**')).toBe(false);
  });

  it('matches a proposal path that is broader than the contract glob', () => {
    expect(fileMatchesGlob('src/api', 'src/api/**')).toBe(true); // substring fallback
  });
});

describe('siblingsAffectedByProposal', () => {
  const ownership = parseFileOwnership(
    ['## File ownership', '- src/api/** — Build API', '- src/ui/** — Build UI'].join('\n'),
  );

  it('narrows to the owner whose files the proposal touches', () => {
    expect(
      siblingsAffectedByProposal(['src/api/routes.ts'], ownership, ['Build API', 'Build UI']),
    ).toEqual(['Build API']);
  });

  it('falls back to all siblings when the proposal names no files', () => {
    expect(siblingsAffectedByProposal([], ownership, ['Build API', 'Build UI'])).toEqual([
      'Build API',
      'Build UI',
    ]);
  });

  it('falls back to all siblings when nothing in the contract matches', () => {
    expect(
      siblingsAffectedByProposal(['docs/readme.md'], ownership, ['Build API', 'Build UI']),
    ).toEqual(['Build API', 'Build UI']);
  });

  it('falls back to all siblings when there is no parseable ownership', () => {
    expect(siblingsAffectedByProposal(['src/api/x.ts'], [], ['Build API', 'Build UI'])).toEqual([
      'Build API',
      'Build UI',
    ]);
  });
});

describe('tallyConsensus', () => {
  it('is agree only when everyone agrees', () => {
    expect(tallyConsensus(['agree', 'agree'])).toBe('agree');
    expect(tallyConsensus(['agree', 'object'])).toBe('contested');
    expect(tallyConsensus(['object'])).toBe('contested');
  });

  it('treats an empty set as vacuously agreed', () => {
    expect(tallyConsensus([])).toBe('agree');
  });
});
