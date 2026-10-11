import { describe, expect, it } from 'vitest';
import {
  aggregateTested,
  branchChangesBody,
  commitType,
  parseCommitMessage,
  prSubject,
  wrapHanging,
  wrapPlainText,
} from './commitMessage';

describe('commitType', () => {
  it('reads the human-picked TaskType first', () => {
    expect(commitType({ title: 'anything', taskType: 'bug' })).toBe('fix');
    expect(commitType({ title: 'anything', taskType: 'feature' })).toBe('feat');
  });

  it('falls back to the title verb when nothing else decides it', () => {
    expect(commitType({ title: 'Refactor the merge gate' })).toBe('refactor');
    expect(commitType({ title: 'Document the merge gate' })).toBe('docs');
    expect(commitType({ title: 'Bump a dependency' })).toBe('chore');
  });

  it('maps build/ci/style branch types onto chore, which CONTRIBUTING.md has no row for', () => {
    expect(commitType({ title: 'Package the client for release' })).toBe('chore');
    expect(commitType({ title: 'Format the codebase' })).toBe('chore');
  });

  it('defaults to feat when nothing matches', () => {
    expect(commitType({ title: 'Something nobody can classify' })).toBe('feat');
  });
});

describe('prSubject', () => {
  it('produces type: summary, lower case, no trailing punctuation', () => {
    expect(prSubject({ title: 'Add the merge switch on cards', taskType: 'feature' })).toBe(
      'feat: add the merge switch on cards',
    );
  });

  it('strips a leading ticket key, since it belongs in the Ticket ID trailer instead', () => {
    expect(
      prSubject({ title: 'TM-15: Implement the catch-up age rule', taskType: 'feature' }),
    ).toBe('feat: implement the catch-up age rule');
  });

  it('never exceeds the 50-character subject budget', () => {
    const subject = prSubject({
      title:
        'Implement a genuinely very long title that could never fit any reasonable commit subject line budget',
      taskType: 'feature',
    });
    expect(subject.length).toBeLessThanOrEqual(50);
  });

  it('cuts on a word boundary rather than mid-word', () => {
    const subject = prSubject({
      title: 'Implement a genuinely very long title that will not fit',
      taskType: 'feature',
    });
    expect(subject.endsWith(' ')).toBe(false);
    expect(/\S$/.test(subject)).toBe(true);
  });
});

describe('wrapHanging', () => {
  it('passes short text through on one line', () => {
    expect(wrapHanging('a short line', 72, 2)).toBe('a short line');
  });

  it('wraps long text and indents continuation lines', () => {
    const text =
      'this sentence is deliberately long enough that it must wrap at least once across lines';
    const wrapped = wrapHanging(text, 40, 2);
    const lines = wrapped.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines.slice(1)) {
      expect(line.startsWith('  ')).toBe(true);
    }
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
  });
});

describe('wrapPlainText', () => {
  it('collapses a soft-wrapped paragraph and rewraps it flat', () => {
    const input = 'This is a paragraph\nwritten with soft\nline breaks in the source.';
    const result = wrapPlainText(input, 72);
    expect(result).toBe('This is a paragraph written with soft line breaks in the source.');
  });

  it('keeps blank-line-separated paragraphs apart', () => {
    const input = 'First paragraph.\n\nSecond paragraph.';
    expect(wrapPlainText(input, 72)).toBe('First paragraph.\n\nSecond paragraph.');
  });

  it('keeps a bullet list as one item per line, normalizing the marker to "-"', () => {
    const input = '* first point\n* second point\n* third point';
    expect(wrapPlainText(input, 72)).toBe('- first point\n- second point\n- third point');
  });

  it('merges an unmarked continuation line into the bullet above it', () => {
    const input =
      '- a paused step never restarted\n- the next card in the queue was never\n  reached';
    const result = wrapPlainText(input, 72);
    expect(result).toBe(
      '- a paused step never restarted\n- the next card in the queue was never reached',
    );
  });

  it('strips bold, inline code and markdown links down to plain text', () => {
    const input = 'Calls **decideFire** in `automationFire.ts`, see [the plan](docs/plan.md).';
    expect(wrapPlainText(input, 72)).toBe(
      'Calls decideFire in automationFire.ts, see the plan (docs/plan.md).',
    );
  });

  it('wraps a long paragraph at the given width with no hanging indent', () => {
    const input =
      'This paragraph is deliberately long enough that it needs to wrap across more than one line of output.';
    const result = wrapPlainText(input, 40);
    const lines = result.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(40);
      expect(line.startsWith(' ')).toBe(false);
    }
  });
});

describe('parseCommitMessage', () => {
  it('splits a worked-example commit into subject, body and trailers', () => {
    const raw =
      'feat(merge): put the auto-merge switch on cards\n\n' +
      'Three switches, in the three places the question actually gets\n' +
      'asked.\n\n' +
      'Ticket ID: TM-412\n' +
      'Tested: pnpm typecheck, pnpm test (168 green), then pnpm dev and\n' +
      '        toggled the switch at all three levels.';
    const parsed = parseCommitMessage(raw);
    expect(parsed.subject).toBe('feat(merge): put the auto-merge switch on cards');
    expect(parsed.body).toBe(
      'Three switches, in the three places the question actually gets\nasked.',
    );
    expect(parsed.trailers).toEqual({
      'Ticket ID': 'TM-412',
      Tested:
        'pnpm typecheck, pnpm test (168 green), then pnpm dev and toggled the switch at all three levels.',
    });
  });

  it('is total: a bare subject with no body or trailers still parses', () => {
    expect(parseCommitMessage('chore: bump a dependency')).toEqual({
      subject: 'chore: bump a dependency',
      body: '',
      trailers: {},
    });
    expect(parseCommitMessage('')).toEqual({ subject: '', body: '', trailers: {} });
  });

  it('leaves a trailing paragraph as body when not every line fits the trailer shape', () => {
    const raw =
      'fix: a bug\n\nNote: here is one line.\nAnd a second plain line with no colon at all.';
    const parsed = parseCommitMessage(raw);
    expect(parsed.body).toBe(
      'Note: here is one line.\nAnd a second plain line with no colon at all.',
    );
    expect(parsed.trailers).toEqual({});
  });

  it('has no trailers when the body ends in prose with no colon at all', () => {
    const raw = 'fix: a bug\n\nJust an ordinary paragraph of explanation.';
    expect(parseCommitMessage(raw).trailers).toEqual({});
  });
});

describe('branchChangesBody', () => {
  it("uses the single commit's own body verbatim (reflowed) when there is only one", () => {
    const raw =
      'fix(limit): resume steps when the limit resets\n\nThe gate forgot the chain.\n\nTested: pnpm test';
    expect(branchChangesBody([raw])).toBe('The gate forgot the chain.');
  });

  it('falls back to the subject when a single commit has no body', () => {
    expect(branchChangesBody(['chore: bump a dependency'])).toBe('chore: bump a dependency');
  });

  it('lists every commit by subject, bulleted, when there is more than one', () => {
    const commits = [
      'fix(a): first fix\n\nTested: pnpm test',
      'fix(b): second fix\n\nTested: pnpm test',
    ];
    expect(branchChangesBody(commits)).toBe('- fix(a): first fix\n- fix(b): second fix');
  });

  it('is empty on an empty branch, so the caller can fall back to the card description', () => {
    expect(branchChangesBody([])).toBe('');
  });

  it("strips a Generated-with / robot-marker line out of a single commit's body", () => {
    const raw =
      'feat: add the thing\n\n' +
      'The real explanation.\n' +
      '🤖 Generated with Some Tool\n\n' +
      'Tested: pnpm test';
    expect(branchChangesBody([raw])).toBe('The real explanation.');
  });

  it('caps the bullet list and names how many more commits there were', () => {
    const commits = Array.from({ length: 25 }, (_, i) => `fix: change number ${i + 1}`);
    const body = branchChangesBody(commits);
    const lines = body.split('\n');
    expect(lines).toHaveLength(21);
    expect(lines[20]).toBe('- …and 5 more commits.');
  });
});

describe('aggregateTested', () => {
  it('is empty when no commit on the branch carries a Tested trailer', () => {
    expect(aggregateTested(['feat: add the thing', 'fix: a bug'])).toBe('');
  });

  it('collapses identical Tested values from several commits into one', () => {
    const commits = ['fix(a): first\n\nTested: pnpm test', 'fix(b): second\n\nTested: pnpm test'];
    expect(aggregateTested(commits)).toBe('pnpm test');
  });

  it('joins distinct Tested values from several commits', () => {
    const commits = ['fix(a): first\n\nTested: pnpm test', 'fix(b): second\n\nTested: pnpm build'];
    expect(aggregateTested(commits)).toBe('pnpm test; pnpm build');
  });

  it('caps the number of distinct Tested values and names how many more there were', () => {
    const commits = Array.from(
      { length: 10 },
      (_, i) => `fix: change ${i}\n\nTested: ran scenario ${i}`,
    );
    const result = aggregateTested(commits);
    expect(result).toContain('and 2 more commits tested');
    expect(result.split('; ')).toHaveLength(9); // 8 shown + the "and N more" tail
  });
});

// F1.10's own two real commits (c5a8c40, 21e6896) — chosen as the worked example because it
// is exactly the shape this file was built for: more than one commit, each with its own
// Ticket ID, a distinct Tested trailer, and (since both predate CLAUDE.md's "no AI
// attribution" rule being enforced retroactively) a Co-Authored-By trailer that must never
// reach a rendered pull request body.
describe('the F1.10 two-commit worked example', () => {
  const first =
    'feat(tray): add background-mode decision logic\n\n' +
    'Pure decision tables for F1.10: what closing the window should\n' +
    'do, and the tray menu it can now show while kept open.\n\n' +
    'backgroundMode.ts stays self-contained rather than importing\n' +
    'AppSettings, since the runInBackground field does not exist\n' +
    'there yet - that lands in the next step, which also wires both\n' +
    "modules into the window's close handling.\n\n" +
    'appTray.ts is the thin, untested Electron glue (Tray + Menu)\n' +
    "that renders backgroundMode's tray menu model.\n\n" +
    'Ticket ID: F1.10\n' +
    'Tested: pnpm format, pnpm typecheck, pnpm test (1847 passed, 11\n' +
    '        skipped) all green; backgroundMode.test.ts covers\n' +
    '        closeAction, shouldQuitOnClose, trayLikelyAvailable and\n' +
    '        trayMenuModel directly. appTray.ts is untested Electron\n' +
    '        glue by design, so only typechecked.\n' +
    'Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>';

  const second =
    'feat(app): keep running in the tray on close\n\n' +
    "Adds the runInBackground setting (local - a machine's own\n" +
    'process-lifetime choice, never synced to the cloud mirror) and\n' +
    'wires it into window close handling.\n\n' +
    "Closing the last window now consults backgroundMode's decision\n" +
    "table: off keeps today's behaviour (darwin stays open, elsewhere\n" +
    'quits); on hides to a lazily-created tray icon, or minimizes where\n' +
    'no tray is available (WSLg, or a real Tray() failure). The tray\n' +
    'menu offers Open, Pause automations and Quit.\n\n' +
    "index.ts registers the close interceptor first so ipc.ts's own\n" +
    'close listeners (window-state flush, sign-in watch) can skip via\n' +
    'event.defaultPrevented. A Windows/Linux session-end sets a\n' +
    'shuttingDown flag so the OS is never blocked by a hidden window.\n' +
    'window-all-closed and second-instance both go through the same\n' +
    'decision table / tray-aware restore.\n\n' +
    'Desktop Settings gets a "Keep running in the background" switch\n' +
    "next to Toasts; the web app doesn't, since it's a local key.\n\n" +
    'Ticket ID: F1.10\n' +
    'Tested: pnpm format:check, pnpm typecheck, pnpm test (3814 passed,\n' +
    '        11 skipped), pnpm build --force all green. Verified\n' +
    '        backgroundMode.test.ts and the global/local classification\n' +
    '        test in settings.test.ts each go red under a deliberate\n' +
    '        one-line regression, then restored. Confirmed\n' +
    '        out/main/chunks/icon-*.png is bundled and index.js\n' +
    '        references it via join(__dirname, "./chunks/icon-...png").\n' +
    'Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>';

  it('parses each real commit into its own subject, body and trailers', () => {
    const a = parseCommitMessage(first);
    expect(a.subject).toBe('feat(tray): add background-mode decision logic');
    expect(a.body).toContain('Pure decision tables for F1.10');
    expect(a.trailers['Ticket ID']).toBe('F1.10');
    expect(a.trailers['Co-Authored-By']).toBe('Claude Sonnet 5 <noreply@anthropic.com>');

    const b = parseCommitMessage(second);
    expect(b.subject).toBe('feat(app): keep running in the tray on close');
    expect(b.body).toContain('Adds the runInBackground setting');
    expect(b.trailers['Ticket ID']).toBe('F1.10');
    expect(b.trailers['Co-Authored-By']).toBe('Claude Sonnet 5 <noreply@anthropic.com>');
  });

  it('lists both subjects bulleted, strips Co-Authored-By, and keeps every line within 72 columns', () => {
    const body = branchChangesBody([first, second]);
    expect(body).toBe(
      '- feat(tray): add background-mode decision logic\n' +
        '- feat(app): keep running in the tray on close',
    );
    expect(body).not.toContain('Co-Authored-By');
    for (const line of body.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(72);
    }
  });

  it("aggregates both commits' distinct Tested values rather than falling back to a commit count", () => {
    const tested = aggregateTested([first, second]);
    expect(tested).toContain('pnpm format, pnpm typecheck, pnpm test (1847 passed, 11 skipped)');
    expect(tested).toContain(
      'pnpm format:check, pnpm typecheck, pnpm test (3814 passed, 11 skipped)',
    );
    expect(tested).not.toContain("see this branch's");
    expect(tested).not.toContain('more commit');
  });
});
