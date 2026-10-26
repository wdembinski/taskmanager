/**
 * ProjectSwitcher — the Tickets tab's compact ticket-project switch, sitting in the list's
 * "Issues" header right after the title.
 *
 * Replaces `ProjectPicker`, the 320px column of project `Card`s that used to stand left of the
 * list: the sidebar now follows whichever project is open (TM-449), so a whole pane spent on
 * picking one is no longer earned. Same shape as the sidebar header's own switcher
 * (`Sidebar.tsx`'s team header) — a subtle `MenuButton` over one `MenuItemRadio` per project —
 * with the project's ticket prefix shown beside its name.
 *
 * Drawn as a quiet chip (v9-1/v9-3), the same outlined pill as the board header's `Links:`
 * switch (`LinkModeSwitch`): it leads the list's one header row, ahead of the "Issues" title,
 * and must not read as a second title beside it.
 */
import {
  Menu,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { ChevronDownRegular } from '@fluentui/react-icons';
import type { Project } from '@tm/shared/model';

const useStyles = makeStyles({
  // `LinkModeSwitch`'s pill, one step smaller: this chip sits beside a 20px title.
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
    gap: '6px',
    height: '24px',
    padding: '0 8px 0 10px',
    borderRadius: '12px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: tokens.fontSizeBase200,
    color: `var(--tm-text-muted, ${tokens.colorNeutralForeground2})`,
    whiteSpace: 'nowrap',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
  },
  chevron: { display: 'flex', fontSize: '12px', color: tokens.colorNeutralForeground3 },
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
        <button type="button" className={styles.chip} aria-label="Switch ticket project">
          <span className={styles.label}>
            {selected?.name ?? 'Choose a project'}
            {selected?.ticketPrefix && (
              <span className={styles.prefix}>{selected.ticketPrefix}</span>
            )}
          </span>
          <span className={styles.chevron} aria-hidden="true">
            <ChevronDownRegular />
          </span>
        </button>
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
