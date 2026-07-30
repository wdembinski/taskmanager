/**
 * The agent glyph — and, while the agent is working, the app's "something is happening"
 * signal.
 *
 * It took that job over from a spinner. A running card used to say the same thing three
 * times on one row: a spinner turned, the text read "Running step 2 of 5", and the `2/5`
 * counter sat beside it, while the step rows underneath already showed which step was live.
 * The glyph was going to be on the row anyway, so animating it costs no space at all.
 *
 * The animation is deliberately the SPINNER's two colours — the bright arc and its dark
 * track — so a pulsing glyph and a turning spinner read as one vocabulary rather than two
 * unrelated cyans. Nothing about the layout moves: only colour and a glow, because a card is
 * something you scan past and a moving shape in the corner of the eye is a cost.
 */
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { AgentsRegular } from '@fluentui/react-icons';
import { FLUO } from './theme';

const useStyles = makeStyles({
  glyph: {
    flexShrink: 0,
    display: 'flex',
    // White at rest: the glyph's job then is only to say "an agent owns this card".
    color: '#ffffff',
  },
  running: {
    // Griffel compiles this object into its own `@keyframes` rule.
    animationName: {
      '0%, 100%': {
        color: FLUO.cyanDeep,
        filter: `drop-shadow(0 0 0 ${tokens.colorTransparentBackground})`,
      },
      '50%': {
        color: FLUO.cyan,
        filter: `drop-shadow(0 0 4px ${FLUO.cyan})`,
      },
    },
    animationDuration: '1.4s',
    animationIterationCount: 'infinite',
    animationTimingFunction: 'ease-in-out',
    // Reduced motion must not cost the INFORMATION, only the movement: hold the bright end
    // with its glow, permanently. A glyph that fell back to white would say nothing at all.
    '@media (prefers-reduced-motion: reduce)': {
      animationName: 'none',
      color: FLUO.cyan,
      filter: `drop-shadow(0 0 3px ${FLUO.cyan})`,
    },
  },
});

export interface AgentGlyphProps {
  /**
   * Whether the agent is working right now. Callers pass the same value that used to turn a
   * spinner (`runPhase(...).spinner`), so the pulse and the spinners that remain elsewhere
   * can never disagree about what "moving" means.
   */
  running?: boolean;
  /** Font size, since the card wants 16px and the detail pane's header wants 18px. */
  size?: string;
}

export function AgentGlyph({ running = false, size = '16px' }: AgentGlyphProps): JSX.Element {
  const styles = useStyles();
  return (
    <span
      className={mergeClasses(styles.glyph, running && styles.running)}
      style={{ fontSize: size }}
    >
      <AgentsRegular />
    </span>
  );
}
