/**
 * Loads `workflow:list` and reduces it with `workflowOptions` into the row source the assign
 * dialog and the agent panel's workflow picker share — same shape as `useSkillOptions.ts`.
 *
 * Reloads whenever `open` flips to `true`: a picker is opened fresh each time rather than kept
 * mounted, so a workflow saved or deleted while it was last closed is never shown stale.
 */
import { useEffect, useState } from 'react';
import { workflowOptions, type WorkflowOption } from './workflowPickerState';
import { useTransport } from './transport';

export interface WorkflowOptionsState {
  workflows: WorkflowOption[];
  loading: boolean;
  /** The load failure, or `null` while loading and after a success. */
  error: string | null;
}

export function useWorkflowOptions(open: boolean): WorkflowOptionsState {
  const transport = useTransport();
  const [state, setState] = useState<WorkflowOptionsState>({
    workflows: [],
    loading: true,
    error: null,
  });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    transport
      .invoke('workflow:list')
      .then((docs) => {
        if (cancelled) return;
        setState({ workflows: workflowOptions(docs), loading: false, error: null });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setState({
          workflows: [],
          loading: false,
          error: e instanceof Error ? e.message : String(e),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [transport, open]);

  return state;
}
