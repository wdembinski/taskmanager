/**
 * Loads the two lists `SkillPicker` draws its rows from — the library (always) and a
 * project's repo skills (only once `projectId` names one) — and reduces them with
 * `skillOptions` into the row source every surface (dialog, panel, step row) shares.
 *
 * Reloads whenever `projectId` changes: the assign dialog and a step's own agent project
 * can point at a different repo mid-session, and a stale project's repo skills must never
 * still be showing once a fresher request has landed — same stale-response guard as
 * `useInitialLoad`.
 */
import { useEffect, useState } from 'react';
import { skillOptions, type SkillOption } from './skillPickerState';
import { useTransport } from './transport';

export interface SkillOptionsState {
  options: SkillOption[];
  loading: boolean;
  /** The load failure, or `null` while loading and after a success. */
  error: string | null;
}

export function useSkillOptions(projectId: string | null): SkillOptionsState {
  const transport = useTransport();
  const [state, setState] = useState<SkillOptionsState>({
    options: [],
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    Promise.all([
      transport.invoke('skill:list'),
      projectId ? transport.invoke('skill:listRepo', projectId) : Promise.resolve([]),
    ])
      .then(([library, repo]) => {
        if (cancelled) return;
        setState({ options: skillOptions(library, repo), loading: false, error: null });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setState({
          options: [],
          loading: false,
          error: e instanceof Error ? e.message : String(e),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [transport, projectId]);

  return state;
}
