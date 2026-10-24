/**
 * The Off · Focus · All switch for how chain links draw over the board (F13.20) — a link
 * glyph, the three segments as `ToggleButton`s (same segmented-control shape the ×1/×2/×3
 * attempt count already uses in `AssignAgentDialog`). Each segment's tooltip names the `L`
 * shortcut; there is no separate key hint beside them — the v9 strip draws none, and a
 * crushed toolbar clipped it to a stray letter.
 *
 * Shared by both hosts (`MyTasks.tsx`'s toolbar, the web's `BoardToolbar.tsx`), tokens only —
 * the desktop and the browser must agree pixel-for-pixel on what each mode looks like, same
 * bargain `BoardDisplayMenu` makes.
 *
 * Both hosts also wrap this whole group in an `OverflowItem` (`ToolbarOverflow.tsx`'s own
 * toolbar) — which clones its single child and attaches a ref to measure and hide it. A plain
 * function component cannot accept that ref (React silently drops it, and the item never
 * registers with the overflow manager), so this is `forwardRef`'d to the root `<div>`.
 */
import { forwardRef } from 'react';
import { ToggleButton, makeStyles, tokens } from '@fluentui/react-components';
import { LinkMultipleRegular } from '@fluentui/react-icons';
import { LINK_MODES, type LinkMode } from './linkMode';

const LABEL: Record<LinkMode, string> = { off: 'Off', focus: 'Focus', all: 'All' };
const TITLE: Record<LinkMode, string> = {
  off: 'Hide chain links — see needs/unblocks on the card instead',
  focus: 'Light the selected card’s own links, fade the rest',
  all: 'Draw every chain link',
};

const useStyles = makeStyles({
  group: { display: 'flex', alignItems: 'center', gap: '2px' },
  icon: { display: 'flex', color: tokens.colorNeutralForeground3 },
});

export interface LinkModeSwitchProps {
  mode: LinkMode;
  onChange: (mode: LinkMode) => void;
}

export const LinkModeSwitch = forwardRef<HTMLDivElement, LinkModeSwitchProps>(
  function LinkModeSwitch({ mode, onChange }, ref) {
    const styles = useStyles();
    return (
      <div ref={ref} className={styles.group} role="group" aria-label="Chain links">
        <span className={styles.icon} aria-hidden="true">
          <LinkMultipleRegular />
        </span>
        {LINK_MODES.map((m) => (
          <ToggleButton
            key={m}
            size="small"
            appearance="subtle"
            checked={mode === m}
            title={`${TITLE[m]} (L)`}
            onClick={() => onChange(m)}
          >
            {LABEL[m]}
          </ToggleButton>
        ))}
      </div>
    );
  },
);
