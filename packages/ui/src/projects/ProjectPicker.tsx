/**
 * ProjectPicker — the ticket-project list, read-only.
 *
 * The list half of `ProjectAdmin` (same `Card` rows: colour dot, name, prefix badge, selection
 * border) with the add/edit/remove half cut away — this is the Tickets tab's picker, not its
 * management pane. Managing a project (adding one, renaming it, choosing what it owns) now lives
 * on the Projects tab, in `ProjectAdmin` itself.
 */
import {
  Badge,
  Body1,
  Card,
  CardHeader,
  makeStyles,
  Text,
  tokens,
} from '@fluentui/react-components';
import type { Project } from '@tm/shared/model';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: '12px' },
  list: { display: 'flex', flexDirection: 'column', gap: '8px' },
  card: { padding: '4px', cursor: 'pointer' },
  cardSelected: { border: `1px solid ${tokens.colorBrandStroke1}` },
  headerText: { display: 'flex', flexDirection: 'column', gap: '2px' },
  nameRow: { display: 'flex', alignItems: 'center', gap: '6px' },
  colorDot: { width: '10px', height: '10px', borderRadius: '3px', flexShrink: 0 },
  prefix: {
    fontFamily: 'ui-monospace, Consolas, monospace',
    color: tokens.colorNeutralForeground3,
  },
  hint: { color: tokens.colorNeutralForeground3 },
});

export interface ProjectPickerProps {
  projects: Project[];
  selectedProjectId: string | null;
  onSelect: (id: string) => void;
}

export function ProjectPicker({
  projects,
  selectedProjectId,
  onSelect,
}: ProjectPickerProps): JSX.Element {
  const styles = useStyles();

  return (
    <div className={styles.root}>
      {projects.length === 0 ? (
        <Body1 className={styles.hint}>
          No ticket projects yet — add one on the Projects tab and choose &quot;its own ticket
          board&quot;.
        </Body1>
      ) : (
        <div className={styles.list}>
          {projects.map((project) => (
            <Card
              key={project.id}
              className={
                project.id === selectedProjectId
                  ? `${styles.card} ${styles.cardSelected}`
                  : styles.card
              }
              onClick={() => onSelect(project.id)}
              selected={project.id === selectedProjectId}
            >
              <CardHeader
                header={
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
                      {project.ticketPrefix && (
                        <Badge appearance="tint" color="informative" className={styles.prefix}>
                          {project.ticketPrefix}
                        </Badge>
                      )}
                    </div>
                  </div>
                }
              />
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
