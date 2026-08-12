/**
 * The pipeline's own invariants — the four facts about `.github/workflows/*.yml` that have
 * each already cost this project a release or a red run.
 *
 * A workflow is the one kind of code here that nothing else checks. It is not typechecked,
 * it is not imported by anything, and it does not run until it is on `development` — where
 * the cost of being wrong is a tagged version with no installer on it. Every assertion below
 * is a mistake somebody has already made, in this repo or in the Dockerfile beside it:
 *
 *  1. **A `version:` passed to `pnpm/action-setup`.** The root `package.json` pins pnpm
 *     through `packageManager`; passing both makes the action exit with
 *     `ERR_PNPM_BAD_PM_VERSION` ("Multiple versions of pnpm specified") before a single step
 *     of real work runs. Every job here therefore installs pnpm with no `with:` at all, and
 *     that absence is the sort of thing a helpful edit puts back.
 *  2. **Node older than 22.13.** pnpm 11.18 refuses to run on it. `apps/server/Dockerfile`
 *     carried a stale `node:22.11` layer and produced exactly that failure; a runner pinned
 *     to `node-version: 20` would produce it again, on the release path this time.
 *  3. **Promoting before packaging.** electron-builder cannot upload into a *published*
 *     release — it says `skipped` and exits 0 — so a promote that runs early is a green run
 *     with an empty release (RELEASE.md rule 4). The inverse also has a body count: four
 *     finished drafts once sat unpublished waiting on a Linux build that was never coming,
 *     which is why `promote` must not be gated on the Linux job succeeding (§6).
 *  4. **The gates drifting from RELEASE.md §1.** `ci.yml` and `release.yml` deliberately
 *     duplicate §1's list rather than share a reusable workflow — one guards a merge, one
 *     guards a tag, and coupling them means a change made for one silently changes the
 *     other. Duplication is the right call there and it is also how three lists quietly stop
 *     agreeing. This is the guard that makes "keep them in step by hand" a checkable claim.
 *
 * Lives at the repo root beside `repo-invariants.test.ts` and `shell-parity.test.ts` for the
 * reason those do: the root `vitest.config.ts` sets no `include`, so vitest's default glob
 * collects it, which puts the guard inside `pnpm test` — and `pnpm test` is on every gate
 * anyone actually runs (CONTRIBUTING.md §5, RELEASE.md §1). Notably it is on the gates the
 * pipeline runs *on itself*: a pull request that breaks one of these four facts goes red on
 * the runner before the merge that would have tagged from it.
 *
 * It parses the YAML rather than grepping it — unlike `shell-parity.test.ts`, which reasons
 * about import lines and says so. The claims here are structural (which job `needs` which,
 * which step is inside which job, what a `with:` mapping does and does not contain) and a
 * regex approximating a parse would be the same class of bug as the ones being guarded
 * against. `yaml` is a zero-dependency parser and is a root devDependency for this file.
 *
 * A parse also fails in a direction worth naming: silently. A selector that matches nothing
 * passes every assertion made about it, so each group below first asserts it FOUND what it
 * is about to judge — the parsed step counts are checked against the raw text, so a parser
 * or a selector that stops seeing the steps goes red instead of going quiet.
 *
 * Written red-first: every assertion here was confirmed to fail against a workflow mutated
 * to break it (a `version:` added, a `node-version: 20`, `promote` un-`needs`-ed from
 * `linux`, `--draft=false` moved into the `windows` job, a gate step deleted) before any of
 * it was relied on.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/** The repo root, derived from this file rather than from cwd, so the run directory is free. */
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

interface Step {
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
  run?: string;
}

interface Job {
  needs?: string | string[];
  if?: string;
  steps?: Step[];
}

interface Workflow {
  name?: string;
  jobs?: Record<string, Job>;
}

/** The three workflows, all of them. docs/11-ci-cd-pipeline.md describes them end to end. */
const FILES = ['ci.yml', 'release.yml', 'deploy.yml'] as const;
type WorkflowFile = (typeof FILES)[number];

function source(file: WorkflowFile): string {
  return readFileSync(join(repoRoot, '.github', 'workflows', file), 'utf8');
}

const parsed = new Map<WorkflowFile, Workflow>(
  FILES.map((file) => [file, parse(source(file)) as Workflow]),
);

function workflow(file: WorkflowFile): Workflow {
  return parsed.get(file) as Workflow;
}

function job(file: WorkflowFile, id: string): Job {
  const found = workflow(file).jobs?.[id];
  expect(
    found,
    `${file} has no job called "${id}" — this file's assumptions about it are stale.`,
  ).toBeDefined();
  return found as Job;
}

/** `needs:` is a string when there is one and a list when there are several. */
function needsOf(spec: Job): string[] {
  if (!spec.needs) return [];
  return Array.isArray(spec.needs) ? spec.needs : [spec.needs];
}

/** Every step in every job of a file, each carrying where it came from for the failure message. */
function allSteps(file: WorkflowFile): { job: string; index: number; step: Step }[] {
  return Object.entries(workflow(file).jobs ?? {}).flatMap(([id, spec]) =>
    (spec.steps ?? []).map((step, index) => ({ job: id, index, step })),
  );
}

function everyStep(): { file: WorkflowFile; job: string; index: number; step: Step }[] {
  return FILES.flatMap((file) => allSteps(file).map((entry) => ({ file, ...entry })));
}

/** How a step reads in a failure message: `release.yml windows[3] "Install Node.js"`. */
function where(entry: { file: WorkflowFile; job: string; index: number; step: Step }): string {
  return `${entry.file} ${entry.job}[${entry.index}] "${entry.step.name ?? entry.step.uses ?? '?'}"`;
}

/**
 * Steps using an action, by its name without the `@vN`. The count is cross-checked against
 * the raw text below, so a step this stops finding is a red test rather than a quiet one.
 */
function stepsUsing(action: string) {
  return everyStep().filter((entry) => (entry.step.uses ?? '').split('@')[0] === action);
}

/**
 * The same count taken from the text, independent of the parse. It requires the `uses:` key
 * so that the prose about `pnpm/action-setup` in these files' comments is not counted.
 */
function usesLines(action: string): number {
  const pattern = new RegExp(`^\\s*(?:-\\s+)?uses:\\s*${action.replace('/', '\\/')}@`, 'gm');
  return FILES.reduce((total, file) => total + (source(file).match(pattern) ?? []).length, 0);
}

describe('the toolchain every workflow job installs', () => {
  // The vacuity guard for both assertions below: they judge the steps this finds, so a
  // selector that finds none of them would pass while checking nothing.
  it('finds every pnpm and Node install step the three files contain', () => {
    const pnpmSteps = stepsUsing('pnpm/action-setup');
    const nodeSteps = stepsUsing('actions/setup-node');

    expect(
      pnpmSteps.length,
      'The parsed pnpm/action-setup steps do not match the `uses:` lines in the workflow ' +
        'text. Either the parse or the selector above has stopped seeing steps, and every ' +
        'assertion in this file that judges them is now vacuous.',
    ).toBe(usesLines('pnpm/action-setup'));

    expect(
      nodeSteps.length,
      'The parsed actions/setup-node steps do not match the `uses:` lines in the workflow text.',
    ).toBe(usesLines('actions/setup-node'));

    expect(pnpmSteps.length, 'No job installs pnpm at all.').toBeGreaterThan(0);
    expect(nodeSteps.length, 'No job installs Node at all.').toBeGreaterThan(0);
  });

  it('never passes a version to pnpm/action-setup', () => {
    for (const entry of stepsUsing('pnpm/action-setup')) {
      expect(
        entry.step.with?.version,
        `${where(entry)} passes a version to pnpm/action-setup. The root package.json already ` +
          'pins pnpm through `packageManager`, and the action fails with ERR_PNPM_BAD_PM_VERSION ' +
          '("Multiple versions of pnpm specified") when it is given both. Delete the `with:` and ' +
          'change `packageManager` instead.',
      ).toBeUndefined();
    }
  });

  it('installs Node 22 everywhere, because pnpm 11.18 refuses anything older', () => {
    for (const entry of stepsUsing('actions/setup-node')) {
      const requested = entry.step.with?.['node-version'];

      expect(
        requested === undefined ? undefined : String(requested),
        `${where(entry)} asks for Node ${String(requested)}. pnpm 11.18 refuses to run on ` +
          'anything below 22.13 — apps/server/Dockerfile hit exactly that with a stale ' +
          'node:22.11 layer — so every job in this repo pins `node-version: 22`. Moving one ' +
          'job off it breaks that job and nothing else, which is how it survives review.',
      ).toBe('22');
    }
  });
});

describe('release.yml promotes the draft last, and does promote it (RELEASE.md rule 4)', () => {
  /** Steps whose `run:` contains a fragment, anywhere in the three workflows. */
  function stepsRunning(fragment: string) {
    return everyStep().filter((entry) => (entry.step.run ?? '').includes(fragment));
  }

  it('creates the release as a draft, before anything packages into it', () => {
    const creates = stepsRunning('gh release create');

    expect(
      creates.map(where),
      "Exactly one step creates the GitHub release, in release.yml's `version` job.",
    ).toHaveLength(1);
    expect(creates[0].file, 'The release is created by release.yml, not by another workflow.').toBe(
      'release.yml',
    );
    expect(creates[0].job).toBe('version');
    expect(
      creates[0].step.run,
      'The release must be created as a DRAFT: `--publish onTagOrDraft` uploads into a draft, ' +
        'and electron-builder cannot write to a published release — it reports "skipped" and ' +
        'exits 0, leaving a green run with an empty release (RELEASE.md rule 4).',
    ).toContain('--draft');
  });

  it('runs promote after both package jobs, and nothing after promote', () => {
    const promote = job('release.yml', 'promote');

    expect(
      needsOf(promote),
      "release.yml's `promote` job must `needs:` both package jobs. Without `windows` it can " +
        'publish before the installer and latest.yml are uploaded, and electron-builder cannot ' +
        'write into a published release (RELEASE.md rule 4).',
    ).toEqual(expect.arrayContaining(['windows', 'linux']));

    // Transitively: both package jobs wait for the tag and the draft to exist.
    for (const id of ['windows', 'linux']) {
      expect(
        needsOf(job('release.yml', id)),
        `release.yml's \`${id}\` job must wait for \`version\`, which is what creates the tag it ` +
          'checks out and the draft it uploads into.',
      ).toContain('version');
    }

    const jobs = workflow('release.yml').jobs ?? {};
    const after = Object.entries(jobs)
      .filter(([, spec]) => needsOf(spec).includes('promote'))
      .map(([id]) => id);
    expect(
      after,
      'Promote is the LAST job. A job that runs after it would be a job that uploads into a ' +
        'release that is already published, which silently uploads nothing.',
    ).toEqual([]);
  });

  it('publishes in the promote job and nowhere else', () => {
    const promotions = stepsRunning('--draft=false');

    expect(
      promotions.map(where),
      'Exactly one step turns the draft into a release, and `promote` is the job it belongs ' +
        'to. A `--draft=false` anywhere else promotes before packaging has finished.',
    ).toHaveLength(1);
    expect(promotions[0].file).toBe('release.yml');
    expect(promotions[0].job).toBe('promote');

    // …and within that job, after the check that the update feed is actually on the release.
    // Publishing without latest.yml beside the installer is a release no installed app can
    // ever see, and it cannot be fixed by uploading the feed afterwards.
    const steps = job('release.yml', 'promote').steps ?? [];
    const feed = steps.findIndex((step) => (step.run ?? '').includes('latest.yml'));
    expect(
      feed,
      'The promote job no longer checks that latest.yml is on the release before publishing it.',
    ).toBeGreaterThanOrEqual(0);
    expect(
      promotions[0].index,
      'The feed check has to run BEFORE the publish, not after it — a published release with ' +
        'no latest.yml beside it is invisible to every installed app.',
    ).toBeGreaterThan(feed);
  });

  it('does not let a failed Linux build hold the release (RELEASE.md §6)', () => {
    const condition = job('release.yml', 'promote').if ?? '';

    expect(
      condition,
      'The promote job needs `always()`: it `needs:` the linux job, so without it a failed ' +
        'Linux build skips the promotion entirely and the release stays a draft.',
    ).toContain('always()');

    expect(
      condition,
      'Promote must still require the WINDOWS build to have succeeded — that is the platform ' +
        'whose artifacts the release is made of.',
    ).toContain("needs.windows.result == 'success'");

    expect(
      condition.includes("needs.linux.result == 'success'"),
      'Promote must NOT require the Linux job to have succeeded. RELEASE.md §6: four green ' +
        'releases once piled up here unpublished, each waiting on a platform build that was ' +
        'never going to happen. Ship what you have and say what is owed — the `Say what is ' +
        'owed` step is how this workflow says it.',
    ).toBe(false);
  });
});

describe('the CI gates cannot drift from RELEASE.md §1', () => {
  /**
   * §1's list, read out of RELEASE.md itself rather than restated here — restating it is the
   * drift this test exists to catch.
   */
  function sectionOneCommands(): string[] {
    const md = readFileSync(join(repoRoot, 'RELEASE.md'), 'utf8');
    const section = md.split(/^## /m).find((part) => part.startsWith('1. Green gates'));
    expect(section, 'RELEASE.md has no "## 1. Green gates" section any more.').toBeDefined();

    const fenced = (section as string).match(/```bash\n([\s\S]*?)```/);
    expect(
      fenced,
      'RELEASE.md §1 no longer opens with a ```bash block listing the gates.',
    ).not.toBeNull();

    const commands = (fenced as RegExpMatchArray)[1]
      .split('\n')
      .map((line) => line.replace(/#.*$/, '').trim())
      .filter(Boolean);

    expect(commands.length, 'RELEASE.md §1 lists no commands at all.').toBeGreaterThan(0);
    return commands;
  }

  /**
   * The gate commands a `gates` job runs, in order: its single-line `pnpm …` steps, minus the
   * install. Anything multi-line is a script, not a gate.
   */
  function gateCommands(file: WorkflowFile): string[] {
    return (job(file, 'gates').steps ?? [])
      .map((step) => (step.run ?? '').trim())
      .filter(
        (run) => run.startsWith('pnpm ') && !run.includes('\n') && !run.startsWith('pnpm install'),
      );
  }

  it("runs RELEASE.md §1's list, in §1's order, on every pull request", () => {
    // §1 is the three gates; the note under it adds `pnpm format:check` ahead of them, which
    // is a CI-only addition and stated as such in the doc.
    expect(
      gateCommands('ci.yml'),
      "ci.yml's `gates` job and RELEASE.md §1 disagree about what a green tree means. §1 is " +
        'the specification — change it first if the list is genuinely changing, and change ' +
        "release.yml's `gates` job in the same commit.",
    ).toEqual(['pnpm format:check', ...sectionOneCommands()]);
  });

  it('runs the identical list before a tag as before a merge', () => {
    // The two are duplicated on purpose (one guards a merge, one guards a tag, and a reusable
    // workflow would make a change to either silently change both). Duplicated is also how
    // they stop agreeing, so: same list, asserted, and RELEASE.md §1 is the arbiter above.
    expect(
      gateCommands('release.yml'),
      "release.yml's `gates` job no longer runs the same list as ci.yml's. A commit can now " +
        'pass CI and be tagged by a weaker set of checks, or fail the release after passing ' +
        "the merge — see release.yml's comment on why they are duplicated rather than shared.",
    ).toEqual(gateCommands('ci.yml'));
  });
});
