/**
 * How chain links draw over the board — Off · Focus · All (F13.20) — as the v9-7 header's one
 * pill (`Chains: on` in the mockup): a link glyph and `Links: <mode>`, opening a radio `Menu`
 * of the three modes. It used to be three `ToggleButton` segments in the row; the header now
 * spends one quiet pill on it, and everything else goes behind `BoardMoreMenu`'s "…".
 *
 * `L` still cycles the mode (each host registers it), and the pill's tooltip says so — there
 * is no key hint drawn beside it.
 *
 * Shared by both hosts (`MyTasks.tsx`'s header, the web's `BoardToolbar.tsx`), tokens only —
 * the desktop and the browser must agree pixel-for-pixel on what each mode looks like, same
 * bargain `BoardDisplayMenu` makes.
 *
 * `open`/`inline` exist for the render test: this package has no DOM testing library to click
 * the pill, so the test renders the menu already open and in place (a portal renders nothing
 * on the server) and calls {@link linkModeMenuChange} directly.
 */
import {
  Menu,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
  makeStyles,
  tokens,
  type MenuProps,
} from '@fluentui/react-components';
import { ChevronDownRegular, LinkMultipleRegular } from '@fluentui/react-icons';
import { LINK_MODES, type LinkMode } from './linkMode';

export const LINK_MODE_LABEL: Record<LinkMode, string> = { off: 'Off', focus: 'Focus', all: 'All' };
const TITLE: Record<LinkMode, string> = {
  off: 'Hide chain links — see needs/unblocks on the card instead',
  focus: 'Light the selected card’s own links, fade the rest',
  all: 'Draw every chain link',
};

const useStyles = makeStyles({
  pill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    height: '26px',
    padding: '0 10px',
    borderRadius: '13px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    background: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    whiteSpace: 'nowrap',
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
  },
  icon: { display: 'flex', fontSize: '15px', color: tokens.colorNeutralForeground3 },
  chevron: { display: 'flex', fontSize: '12px', color: tokens.colorNeutralForeground3 },
});

/**
 * The radio menu's change handler: the one mode picked, or nothing for anything that is not a
 * mode. Exported so the test can prove a pick reaches `onChange` without a DOM to click in.
 */
export function linkModeMenuChange(
  onChange: (mode: LinkMode) => void,
): NonNullable<MenuProps['onCheckedValueChange']> {
  return (_e, d) => {
    const next = d.checkedItems[0];
    if ((LINK_MODES as readonly string[]).includes(next)) onChange(next as LinkMode);
  };
}

export interface LinkModeSwitchProps {
  mode: LinkMode;
  onChange: (mode: LinkMode) => void;
  /** Test only: render the menu open. */
  open?: boolean;
  /** Test only: render the popover in place rather than in a portal. */
  inline?: boolean;
}

export function LinkModeSwitch({ mode, onChange, open, inline }: LinkModeSwitchProps): JSX.Element {
  const styles = useStyles();
  return (
    <Menu
      open={open}
      inline={inline}
      checkedValues={{ links: [mode] }}
      onCheckedValueChange={linkModeMenuChange(onChange)}
    >
      <MenuTrigger disableButtonEnhancement>
        <button
          type="button"
          className={styles.pill}
          title={`Chain links: ${TITLE[mode]} (L)`}
          aria-label={`Chain links: ${LINK_MODE_LABEL[mode]}`}
          data-link-mode={mode}
        >
          <span className={styles.icon} aria-hidden="true">
            <LinkMultipleRegular />
          </span>
          Links: {LINK_MODE_LABEL[mode]}
          <span className={styles.chevron} aria-hidden="true">
            <ChevronDownRegular />
          </span>
        </button>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          {LINK_MODES.map((m) => (
            <MenuItemRadio key={m} name="links" value={m} title={TITLE[m]}>
              {LINK_MODE_LABEL[m]}
            </MenuItemRadio>
          ))}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}
