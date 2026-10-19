/**
 * The five plan-check rules' verdict (`@tm/shared/planCheck`), shown in the Inbox next to
 * a `plan-approval` item — whether the project auto-approves plans or not, so a human
 * approving by hand sees the same checks an automatic approval would have used.
 *
 * Monochrome: the board colour budget reserves colour for things that move. A failing
 * row's icon alone may go red; everything else stays neutral foreground.
 */
import { Caption1, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { CheckmarkCircle16Regular, DismissCircle16Regular } from '@fluentui/react-icons';
import type { PlanVerdict } from '@tm/shared/planCheck';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '8px 10px',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  heading: { color: tokens.colorNeutralForeground1, fontWeight: tokens.fontWeightSemibold },
  row: { display: 'flex', alignItems: 'flex-start', gap: '6px' },
  icon: { flexShrink: 0, marginTop: '2px', color: tokens.colorNeutralForeground3 },
  failIcon: { color: tokens.colorPaletteRedForeground1 },
  label: { color: tokens.colorNeutralForeground1 },
  detail: { color: tokens.colorNeutralForeground3 },
});

export interface PlanCheckVerdictProps {
  verdict: PlanVerdict;
}

/** The five plan-check rules' verdict as a compact, monochrome list. */
export function PlanCheckVerdict({ verdict }: PlanCheckVerdictProps): JSX.Element {
  const styles = useStyles();
  const failed = verdict.checks.filter((c) => !c.pass).length;

  return (
    <div
      className={styles.root}
      data-plan-check
      data-plan-check-pass={verdict.pass ? 'true' : 'false'}
    >
      <Caption1 className={styles.heading}>
        {verdict.pass ? 'Plan checks: all passed' : `Plan checks: ${failed} failed`}
      </Caption1>
      {verdict.checks.map((check) => (
        <div key={check.id} className={styles.row}>
          {check.pass ? (
            <CheckmarkCircle16Regular className={styles.icon} />
          ) : (
            <DismissCircle16Regular className={mergeClasses(styles.icon, styles.failIcon)} />
          )}
          <div>
            <Caption1 className={styles.label}>{check.label}</Caption1>
            <br />
            <Caption1 className={styles.detail}>{check.detail}</Caption1>
          </div>
        </div>
      ))}
    </div>
  );
}
