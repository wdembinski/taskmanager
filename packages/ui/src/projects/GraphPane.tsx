/**
 * GraphPane — the Graph view of one project's tickets (Phase 24, chaining-tickets plan step 9).
 * A React Flow canvas, mounted alongside `BacklogTable` and `TimelinePane` as the third view in
 * `Projects.tsx`'s switch — never all three at once, the same reasoning `TimelinePane`'s own
 * doc gives for why a project switch remounts rather than reconciles.
 *
 * Scaffold only: no nodes, no edges, no data fetch yet. `ready` exists so this pane already
 * carries the same load-then-render shape every other pane in this switch does — `PaneLoading`
 * while not ready, the real canvas once it is — for a later step to hang a real seed off without
 * reshaping the component.
 */
import { useCallback, useState } from 'react';
import { makeStyles, tokens } from '@fluentui/react-components';
import { Background, Controls, ReactFlow, ReactFlowProvider } from '@xyflow/react';
import { PaneLoading } from '../PaneLoading';
import { useInitialLoad } from '../useInitialLoad';

const useStyles = makeStyles({
  root: {
    flex: 1,
    minHeight: 0,
    height: '100%',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
});

export interface GraphPaneProps {
  projectId: string;
}

export function GraphPane({ projectId: _projectId }: GraphPaneProps): JSX.Element {
  const styles = useStyles();
  const [ready, setReady] = useState(false);

  const seed = useCallback(async () => {
    setReady(true);
  }, []);
  const initial = useInitialLoad(seed);

  if (!ready) {
    return <PaneLoading label="Loading graph…" error={initial.error} onRetry={initial.retry} />;
  }

  return (
    <div className={styles.root}>
      <ReactFlowProvider>
        <ReactFlow nodes={[]} edges={[]} fitView proOptions={{ hideAttribution: true }}>
          <Background />
          <Controls />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
