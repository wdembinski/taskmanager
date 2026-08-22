/** How an `AssignmentStatus` reads at a glance — shared by `Fleet` and `AssignAgentSection`
 *  so a status means the same color everywhere it appears. */
import { Badge } from '@fluentui/react-components';
import type { AssignmentStatus } from '@tm/shared/agent';

const COLOR: Record<AssignmentStatus, 'subtle' | 'informative' | 'brand' | 'success' | 'danger'> = {
  queued: 'subtle',
  claimed: 'informative',
  running: 'brand',
  done: 'success',
  failed: 'danger',
};

export function AssignmentStatusBadge({ status }: { status: AssignmentStatus }): JSX.Element {
  return (
    <Badge appearance="tint" color={COLOR[status]}>
      {status}
    </Badge>
  );
}
