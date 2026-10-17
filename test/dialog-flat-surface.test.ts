/**
 * F13.16 step 4: every Fluent `Dialog` stays on the *flat* surface — `colorNeutralBackground1`,
 * which `theme.ts` pins to `SEMANTIC[scheme].paneOpaque` (`tokens.test.ts` asserts that identity
 * directly) — never the glass one `GlassPane.tsx` paints for panes. Unlike the list/detail/peek
 * panes the F13 plan's "Restraint rules" name as glass candidates, a modal surface has to read
 * the same regardless of the user's glass/opaque setting, so it is deliberately left off that
 * toggle rather than switched to it.
 *
 * This file is the enforcement: it walks every non-test source file that imports Fluent's
 * `DialogSurface` and asserts none of them also reaches for `GlassPane`/`useGlassStyles`. Nothing
 * in the repo trips it today — `git grep` found zero colour literals and zero glass imports
 * across these files before this test was written — so this is the regression guard, not a fix.
 *
 * Lives at the repo root, beside `glass-single-implementation.test.ts`, for the same reason that
 * file does: the root `vitest.config.ts`'s default glob puts it on `pnpm test`, every gate
 * anyone actually runs (CONTRIBUTING.md §5, RELEASE.md §1).
 *
 * Proved red first: temporarily adding `import { GlassPane } from '../shell/GlassPane';` to one
 * of the `DIALOG_FILES` below turned the test red, naming that file; removing it turned it green
 * again.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Every non-test source file that imports Fluent's `DialogSurface` — `git grep -l
 *  DialogSurface -- '*.tsx' '*.ts' | grep -v '\.test\.'`, repo-relative. */
const DIALOG_FILES = [
  'packages/ui/src/AddTaskDialog.tsx',
  'packages/ui/src/AssignAgentDialog.tsx',
  'packages/ui/src/ConfirmMergeDialog.tsx',
  'packages/ui/src/SkillsSection.tsx',
  'packages/ui/src/TaskAgentPanel.tsx',
  'packages/ui/src/TaskDetailsCell.tsx',
  'packages/ui/src/WorkflowBuilder.tsx',
  'packages/ui/src/automations/AutomationEditor.tsx',
  'packages/ui/src/automations/AutomationsView.tsx',
  'packages/ui/src/board/ArchivedCardsDialog.tsx',
  'packages/ui/src/palette/CommandPalette.tsx',
  'packages/ui/src/projects/ArchiveMilestoneDialog.tsx',
  'packages/ui/src/projects/GraphLinkPicker.tsx',
  'packages/ui/src/projects/NewTicketDialog.tsx',
];

const REACHES_FOR_GLASS = /\b(?:GlassPane|useGlassStyles)\b/;

describe('every Fluent Dialog stays off the glass pane', () => {
  it.each(DIALOG_FILES)('%s never imports GlassPane/useGlassStyles', (path) => {
    const source = readFileSync(join(repoRoot, ...path.split('/')), 'utf8');
    expect(
      REACHES_FOR_GLASS.test(source),
      `${path} imports GlassPane/useGlassStyles — a Dialog's surface must stay the flat ` +
        '(colorNeutralBackground1/paneOpaque) one regardless of the glass/opaque setting, not ' +
        "toggle with it the way a pane does. If this dialog genuinely needs F13's glass pane, " +
        'update this test and DIALOG_FILES rather than silence it.',
    ).toBe(false);
  });

  it('DIALOG_FILES matches every file importing DialogSurface, so new dialogs are covered too', () => {
    const current = new Set(DIALOG_FILES);
    for (const tree of ['apps/client/src', 'apps/web/src', 'packages/ui/src']) {
      for (const path of filesImportingDialogSurface(tree)) {
        expect(
          current.has(path),
          `${path} imports DialogSurface but is missing from DIALOG_FILES in this test — add it ` +
            'so the glass check above actually covers it.',
        ).toBe(true);
      }
    }
  });
});

function filesImportingDialogSurface(tree: string): string[] {
  const found: string[] = [];
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(join(repoRoot, ...tree.split('/')), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = `${tree}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...filesImportingDialogSurface(path));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      const source = readFileSync(join(repoRoot, ...path.split('/')), 'utf8');
      if (/\bDialogSurface\b/.test(source)) found.push(path);
    }
  }
  return found;
}
