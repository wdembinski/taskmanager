/**
 * The full-screen issue's **Built** and **Tested** sections (`TaskDetail`'s `layout="full"`,
 * after `v9-2-issue-detail-light.svg`): what the agent produced and what CI said about it,
 * read straight off data the card already carries — the branch (`task.agentBranch`) and its
 * merge requests. No new reads.
 *
 * Both render NOTHING when there is nothing to say, never a placeholder: a card that has not
 * run has no branch and no MR, and a section headed "Built" over an empty line would read as
 * a failure. The mockup's "2 commits ahead" and test counts have no data source today
 * (no per-card ahead count, no stored test summary), so `commitsAhead` is shown only when a
 * caller supplies it and Tested shows the head pipeline's stages instead of counts.
 */
import { Caption1, Text, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { mrRef, type MergeRequest, type PipelineStatus } from '@tm/shared/mergeRequest';
import type { Task } from '@tm/shared/model';

const useStyles = makeStyles({
  section: { display: 'flex', flexDirection: 'column', gap: '4px' },
  line: { color: `var(--tm-text-muted, ${tokens.colorNeutralForeground2})` },
  branch: { fontFamily: `var(--tm-mono, ${tokens.fontFamilyMonospace})` },
  stages: { display: 'flex', flexWrap: 'wrap', columnGap: '12px', rowGap: '2px' },
  failed: { color: tokens.colorPaletteRedForeground1 },
});

/** A pipeline status in the words a human reads it in — "passed", not "success". */
export const PIPELINE_WORD: Record<PipelineStatus, string> = {
  unknown: 'unknown',
  none: 'none',
  created: 'pending',
  pending: 'pending',
  running: 'running',
  success: 'passed',
  failed: 'failed',
  canceled: 'canceled',
  skipped: 'skipped',
  manual: 'manual',
};

/** Whether an MR's head pipeline has anything to report. */
function hasPipeline(mr: MergeRequest): boolean {
  return mr.pipelineStatus !== 'none' && mr.pipelineStatus !== 'unknown';
}

/** The MRs Built lists — open and merged; a closed or locked one built nothing that stands. */
export function builtMergeRequests(mergeRequests: readonly MergeRequest[]): MergeRequest[] {
  return mergeRequests.filter((mr) => mr.state === 'opened' || mr.state === 'merged');
}

/** One MR's Built line: `!191 open · pipeline passed`. */
export function builtLine(mr: MergeRequest): string {
  const state = mr.state === 'opened' ? (mr.draft ? 'draft' : 'open') : mr.state;
  const parts = [`${mrRef(mr)} ${state}`];
  if (hasPipeline(mr)) parts.push(`pipeline ${PIPELINE_WORD[mr.pipelineStatus]}`);
  return parts.join(' · ');
}

/** The MR whose pipeline Tested reports: the most recently updated one that has one. */
export function testedMergeRequest(mergeRequests: readonly MergeRequest[]): MergeRequest | null {
  return mergeRequests
    .filter(hasPipeline)
    .reduce<MergeRequest | null>((a, b) => (a === null || b.updatedAt > a.updatedAt ? b : a), null);
}

export interface IssueBuiltProps {
  task: Pick<Task, 'agentBranch'>;
  mergeRequests: readonly MergeRequest[];
  /** Commits on the branch past its base, when something can say — nothing does today. */
  commitsAhead?: { count: number; base: string };
}

export function IssueBuilt({
  task,
  mergeRequests,
  commitsAhead,
}: IssueBuiltProps): JSX.Element | null {
  const styles = useStyles();
  const mrs = builtMergeRequests(mergeRequests);
  const branch = task.agentBranch ?? null;
  if (!branch && mrs.length === 0) return null;
  return (
    <section className={styles.section} aria-label="Built" data-issue-built>
      <Text weight="semibold">Built</Text>
      {branch && <Caption1 className={mergeClasses(styles.line, styles.branch)}>{branch}</Caption1>}
      {commitsAhead && (
        <Caption1 className={styles.line}>
          {commitsAhead.count} commit{commitsAhead.count === 1 ? '' : 's'} ahead of{' '}
          {commitsAhead.base}
        </Caption1>
      )}
      {mrs.map((mr) => (
        <Caption1 key={mr.id} className={styles.line}>
          {builtLine(mr)}
        </Caption1>
      ))}
    </section>
  );
}

export interface IssueTestedProps {
  mergeRequests: readonly MergeRequest[];
}

export function IssueTested({ mergeRequests }: IssueTestedProps): JSX.Element | null {
  const styles = useStyles();
  const mr = testedMergeRequest(mergeRequests);
  if (!mr) return null;
  return (
    <section className={styles.section} aria-label="Tested" data-issue-tested>
      <Text weight="semibold">Tested</Text>
      <Caption1
        className={mergeClasses(styles.line, mr.pipelineStatus === 'failed' && styles.failed)}
      >
        {mrRef(mr)} pipeline {PIPELINE_WORD[mr.pipelineStatus]}
      </Caption1>
      {/* Stages only when the jobs could be read — an empty list is "unknown", never "none". */}
      {mr.pipelineStages.length > 0 && (
        <div className={styles.stages}>
          {mr.pipelineStages.map((stage) => (
            <Caption1
              key={stage.name}
              className={mergeClasses(styles.line, stage.status === 'failed' && styles.failed)}
            >
              {stage.name} {PIPELINE_WORD[stage.status]}
            </Caption1>
          ))}
        </div>
      )}
    </section>
  );
}
