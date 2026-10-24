/**
 * ProjectSwitcher — the Tickets tab's compact ticket-project switch, sitting in the list's
 * "Issues" header right after the title.
 *
 * Replaces `ProjectPicker`, the 320px column of project `Card`s that used to stand left of the
 * list: the sidebar now follows whichever project is open (TM-449), so a whole pane spent on
 * picking one is no longer earned. Same shape as the sidebar header's own switcher
 * (`Sidebar.tsx`'s team header) — a subtle `MenuButton` over one `MenuItemRadio` per project —
 * with the project's ticket prefix shown beside its name.
 */
import {
  Menu,
  MenuButton,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import type { Project } from '@tm/shared/model';

const useStyles = makeStyles({
  label: { display: 'inline-flex', alignItems: 'baseline', gap: '6px' },
  prefix: {
    fontFamily: `var(--tm-mono, ${tokens.fontFamilyMonospace})`,
    color: `var(--tm-text-faint, ${tokens.colorNeutralForeground3})`,
  },
});

export interface ProjectSwitcherProps {
  projects: Project[];
  selectedProjectId: string | null;
  onSelect: (id: string) => void;
}

export function ProjectSwitcher({
  projects,
  selectedProjectId,
  onSelect,
}: ProjectSwitcherProps): JSX.Element {
  const styles = useStyles();
  const selected = projects.find((p) => p.id === selectedProjectId) ?? null;

  return (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <MenuButton appearance="subtle" size="small" aria-label="Switch ticket project">
          <span className={styles.label}>
            {selected?.name ?? 'Choose a project'}
            {selected?.ticketPrefix && (
              <span className={styles.prefix}>{selected.ticketPrefix}</span>
            )}
          </span>
        </MenuButton>
      </MenuTrigger>
      <MenuPopover>
        <MenuList
          checkedValues={{ project: selectedProjectId ? [selectedProjectId] : [] }}
          onCheckedValueChange={(_e, { checkedItems }) => {
            const next = checkedItems.find((id) => id !== selectedProjectId);
            if (next) onSelect(next);
          }}
        >
          {projects.map((project) => (
            <MenuItemRadio key={project.id} name="project" value={project.id}>
              {project.name}
            </MenuItemRadio>
          ))}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}
