/**
 * Whether an execution target can actually run work (Phase: WSL execution target).
 *
 * The target may be a machine the app has never touched — a distro without `claude`,
 * one that was never logged in, or one with Windows interop switched off (which is
 * how the tool-approval relay reaches the app). Each of those fails at task time with
 * an error that reads like a bug in the orchestrator, so they are checked up front
 * and reported here, each with the specific thing to do about it.
 */
import { useCallback, useEffect, useState } from 'react';
import { Body1, Caption1, makeStyles, Spinner, Tag, tokens } from '@fluentui/react-components';
import { CheckmarkCircleFilled, DismissCircleFilled } from '@fluentui/react-icons';
import { execTargetLabel, type ExecTarget, type TargetReadiness } from '@shared/execTarget';

const useStyles = makeStyles({
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '12px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  header: { display: 'flex', alignItems: 'center', gap: '8px' },
  check: { display: 'flex', alignItems: 'flex-start', gap: '8px' },
  ok: { color: tokens.colorPaletteGreenForeground1, flexShrink: 0 },
  bad: { color: tokens.colorPaletteRedForeground1, flexShrink: 0 },
  detail: { color: tokens.colorNeutralForeground3 },
  fix: { color: tokens.colorPaletteRedForeground1 },
  body: { display: 'flex', flexDirection: 'column' },
});

export function ReadinessPanel({ target }: { target: ExecTarget }): JSX.Element | null {
  const styles = useStyles();
  const [readiness, setReadiness] = useState<TargetReadiness | null>(null);
  const [loading, setLoading] = useState(true);

  const probe = useCallback(async () => {
    setLoading(true);
    try {
      setReadiness(await window.api.invoke('exec:readiness', target));
    } finally {
      setLoading(false);
    }
    // Re-probe whenever the selected target changes, keyed by value rather than
    // identity so a re-render with an equal target doesn't refetch.
  }, [target.kind, target.kind === 'wsl' ? target.distro : '']);

  useEffect(() => {
    void probe();
  }, [probe]);

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <Body1>
          <strong>{execTargetLabel(target)}</strong>
        </Body1>
        {loading ? (
          <Spinner size="tiny" />
        ) : (
          <Tag appearance="outline" size="extra-small">
            {readiness?.ok ? 'ready' : 'not ready'}
          </Tag>
        )}
      </div>

      {readiness?.checks.map((check) => (
        <div key={check.id} className={styles.check}>
          {check.ok ? (
            <CheckmarkCircleFilled className={styles.ok} />
          ) : (
            <DismissCircleFilled className={styles.bad} />
          )}
          <div className={styles.body}>
            <Caption1>{check.label}</Caption1>
            {check.detail && <Caption1 className={styles.detail}>{check.detail}</Caption1>}
            {!check.ok && check.fix && <Caption1 className={styles.fix}>{check.fix}</Caption1>}
          </div>
        </div>
      ))}
    </div>
  );
}
