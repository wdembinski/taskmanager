/**
 * The desktop's agent projects, read-only.
 *
 * The half of `apps/client/src/renderer/src/projects/Projects.tsx` a browser CAN honestly draw.
 * Creating one starts at a native folder picker on the machine the engine runs on, and
 * editing one is that same form — so neither is here, and `SettingsScreen`'s Desktop-only tab
 * says so. Looking at what is configured needs none of that, and is what somebody filing a
 * card under a repo actually wants to check.
 *
 * PRESENTATIONAL, AND THAT IS THE WHOLE OF "READ ONLY"
 * ----------------------------------------------------
 * No transport call, no direct engine bridge, no state, no dialog, no buttons: this file
 * takes a list and returns markup. That is a structural statement rather than a stylistic one
 * — the write channels (`project:add|update|remove`) are classified `'relay'` and would
 * work from a browser, so nothing in `RELAY_POLICY` and nothing in `pnpm typecheck` stops a
 * control being added here. What holds the line is that there is nothing here to add one to,
 * and `test/shell-parity.test.ts` keeps it that way by reading this file for both spellings
 * of "can send something" — which is also why neither appears above.
 *
 * WHY IT SHOWS MORE THAN THE DESKTOP'S LIST CARD DOES
 * ---------------------------------------------------
 * On the desktop, a card shows name, path, models and mode, and everything else — base
 * branch, execution target, the two automation switches, the epics — is one Edit click away
 * in the drawer. There is no drawer here and there is not going to be one, so a fact that is
 * only in the drawer would be a fact this host simply cannot see. The wording is the desktop's
 * own (`PERMISSION_MODE_LABELS`, `modelCaption`, `execTargetLabel`) rather than a second set
 * of words for the same settings.
 */
import { Badge, Body1, Caption1, Card, Text, makeStyles, tokens } from '@fluentui/react-components';
import { execTargetLabel } from '@tm/shared/execTarget';
import { PERMISSION_MODE_LABELS } from '@tm/shared/session';
import type { Project } from '@tm/shared/model';
import { modelCaption } from '@tm/ui/modelChoice';

const useStyles = makeStyles({
  list: { display: 'flex', flexDirection: 'column', gap: '12px' },
  card: { padding: '12px' },
  headerText: { display: 'flex', flexDirection: 'column', gap: '2px' },
  nameRow: { display: 'flex', alignItems: 'center', gap: '6px' },
  /** The project's board colour, so the list reads the way the board does. */
  colorDot: { width: '10px', height: '10px', borderRadius: '3px', flexShrink: 0 },
  path: { color: tokens.colorNeutralForeground3, fontFamily: 'ui-monospace, Consolas, monospace' },
  facts: { display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '8px' },
  factRow: { display: 'flex', gap: '6px' },
  factLabel: { color: tokens.colorNeutralForeground3, minWidth: '132px' },
  epics: { display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '8px' },
  hint: { color: tokens.colorNeutralForeground3 },
});

/** What a project's base branch means when it has not named one — see `Project.baseBranch`. */
function baseBranchCaption(project: Project): string {
  return project.baseBranch || 'whatever the checkout has';
}

/**
 * The three-state merge switch, in words. `null` is the interesting one and the default: it
 * means the repo never ruled, so the app-wide setting decides and moving that moves this too.
 */
function autoMergeCaption(project: Project): string {
  if (project.autoIntegrate === null) return 'follows the app-wide setting';
  return project.autoIntegrate
    ? 'merges finished branches automatically'
    : 'you merge from the card';
}

export interface ProjectsSectionProps {
  /** Already resolved and ordered by the caller — see `selectAgentProjects`. */
  projects: Project[];
}

export function ProjectsSection({ projects }: ProjectsSectionProps): JSX.Element {
  const styles = useStyles();

  return (
    <div className={styles.list}>
      {projects.map((project) => (
        <Card key={project.id} className={styles.card}>
          <div className={styles.headerText}>
            <div className={styles.nameRow}>
              {project.color && (
                <span
                  className={styles.colorDot}
                  style={{ backgroundColor: project.color }}
                  title={`Board colour ${project.color}`}
                />
              )}
              <Text weight="semibold">{project.name}</Text>
            </div>
            <Caption1 className={styles.path}>{project.path}</Caption1>
          </div>

          <div className={styles.facts}>
            <Fact label="Model">{modelCaption(project)}</Fact>
            <Fact label="Permission mode">
              {PERMISSION_MODE_LABELS[project.defaultPermissionMode]}
            </Fact>
            <Fact label="Base branch">{baseBranchCaption(project)}</Fact>
            <Fact label="Runs on">{execTargetLabel(project.target)}</Fact>
            <Fact label="Merge after work">{autoMergeCaption(project)}</Fact>
            <Fact label="Release after merge">{project.autoRelease ? 'on' : 'off'}</Fact>
          </div>

          {project.jiraEpicKeys.length > 0 && (
            <div className={styles.epics}>
              {project.jiraEpicKeys.map((key) => (
                <Badge key={key} appearance="tint" color="informative">
                  {key}
                </Badge>
              ))}
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

/** One label/value line. A `<dl>` would be more correct and read worse at this size. */
function Fact({ label, children }: { label: string; children: string }): JSX.Element {
  const styles = useStyles();
  return (
    <div className={styles.factRow}>
      <Caption1 className={styles.factLabel}>{label}</Caption1>
      <Caption1>{children}</Caption1>
    </div>
  );
}

/** Nothing configured, or nothing known yet — two different sentences. See `SettingsScreen`. */
export function ProjectsEmpty({ synced }: { synced: boolean }): JSX.Element {
  const styles = useStyles();
  return (
    <Body1 className={styles.hint}>
      {synced
        ? 'No agent projects yet. Add one from the desktop app and it appears here.'
        : 'Nothing has synced yet — this list fills in on the first sync from your desktop app.'}
    </Body1>
  );
}
