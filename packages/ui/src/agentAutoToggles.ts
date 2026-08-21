/**
 * Tooltip wording for the three auto-toggles in TaskAgentPanel (merge, PR, release).
 *
 * Pulled out because an icon-only control has no `Field` hint paragraph beside it to carry
 * this wording — the tooltip is the only place left for it to live, and it needs to lead
 * with the state the icon is in ("on"/"off") since the icon itself no longer says so the
 * way the switch's label used to.
 */
import { RELEASE_DOC } from '@tm/shared/release';

function stateWord(on: boolean): string {
  return on ? 'on' : 'off';
}

export function autoMergeTooltip({
  on,
  baseBranch,
  projectName,
  inherited,
}: {
  on: boolean;
  baseBranch: string | undefined;
  projectName: string | undefined;
  inherited: boolean;
}): string {
  const prefix = `Merge when finished — ${stateWord(on)}.`;
  if (on) {
    return `${prefix} The branch is merged into ${baseBranch || 'the base branch'} as soon as this card's work finishes — no Merge button, no review pause.`;
  }
  const exception = inherited
    ? ` ${projectName ?? 'This repo'} merges automatically by default — this card is the exception.`
    : '';
  return `${prefix} The branch is left for you to merge with the button above.${exception}`.trim();
}

export function autoCreatePrTooltip({
  on,
  prNoun,
  projectName,
  projectDefaultOn,
}: {
  on: boolean;
  prNoun: string;
  projectName: string | undefined;
  projectDefaultOn: boolean;
}): string {
  const prefix = `Open a ${prNoun} when finished — ${stateWord(on)}.`;
  if (on) {
    return `${prefix} The branch is pushed and a ${prNoun} is opened when the last step finishes, instead of being merged locally.`;
  }
  const exception = projectDefaultOn
    ? ` ${projectName ?? 'This repo'} opens one by default — this card is the exception.`
    : '';
  return `${prefix} The branch is merged or left for you, and nothing is pushed.${exception}`.trim();
}

export function autoReleaseTooltip({
  on,
  projectName,
  hasReleaseDoc,
}: {
  on: boolean;
  projectName: string | undefined;
  hasReleaseDoc: boolean | null;
}): string {
  const prefix = `Release after merge — ${stateWord(on)}.`;
  if (hasReleaseDoc === false) {
    return `${prefix} ${projectName ?? 'This repo'} has no ${RELEASE_DOC} yet, so nothing would run. Add one describing how it is released — the next merge follows it.`;
  }
  if (on) {
    return `${prefix} When this card's branch merges, an agent follows ${RELEASE_DOC} in the repo and releases it.`;
  }
  return `${prefix} The branch is merged and left there.`;
}
