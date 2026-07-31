/**
 * The agent glyph — and, while the agent is working, the app's "something is happening"
 * signal.
 *
 * It took that job over from a spinner. A running card used to say the same thing three
 * times on one row: a spinner turned, the text read "Running step 2 of 5", and the `2/5`
 * counter sat beside it, while the step rows underneath already showed which step was live.
 * The glyph was going to be on the row anyway, so animating it costs no space at all.
 *
 * **Two glyphs, cross-faded.** At rest it is the OUTLINE (`AgentsRegular`) in white: an
 * agent owns this card, and nothing more. While it works it is the SOLID one, pulsing. That
 * is a weight change as well as a colour change, so the running state reads even at a glance
 * that misses the colour — and it is the one moment the card has earned the extra ink.
 *
 * The two cannot be morphed (they are different paths), so both are rendered, stacked, and
 * their opacity is transitioned. A hard swap between two shapes is a flicker; a 260ms
 * cross-fade is the glyph thickening and thinning again, which is what the state is doing.
 *
 * The pulse is deliberately the SPINNER's two colours — the bright arc and its dark track —
 * so a pulsing glyph and a turning spinner read as one vocabulary rather than two unrelated
 * cyans. Nothing about the layout moves: only colour, weight and a glow, because a card is
 * something you scan past and a moving shape in the corner of the eye is a cost.
 */
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import { AgentsFilled, AgentsRegular } from '@fluentui/react-icons';
import { FLUO } from './theme';

const useStyles = makeStyles({
  /**
   * The stack. `position: relative` and an explicit size, because the solid layer is taken
   * out of flow — without a size of its own the box would collapse to nothing.
   */
  glyph: {
    flexShrink: 0,
    position: 'relative',
    display: 'inline-flex',
    width: '1em',
    height: '1em',
    // White at rest: the glyph's job then is only to say "an agent owns this card".
    color: '#ffffff',
  },
  /** Both layers occupy the whole box, so the two shapes sit exactly on top of each other. */
  layer: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    // The cross-fade. Long enough to read as the glyph gaining weight rather than as a
    // swap, short enough that it is over before you have finished looking at the card.
    transitionProperty: 'opacity',
    transitionDuration: '260ms',
    transitionTimingFunction: 'ease-in-out',
    // A state change you cannot see is better than one that flickers, so the fade is the
    // first thing to go when motion is unwelcome — the weight change survives.
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0ms' },
  },
  hidden: { opacity: 0 },
  /**
   * The solid layer while it runs. `color` and the glow are the animation's; `opacity` is
   * the transition's — two properties, two mechanisms, no contention.
   */
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
    <span className={styles.glyph} style={{ fontSize: size }}>
      <span className={mergeClasses(styles.layer, running && styles.hidden)}>
        <AgentsRegular />
      </span>
      <span
        className={mergeClasses(styles.layer, !running && styles.hidden, running && styles.running)}
      >
        <AgentsFilled />
      </span>
    </span>
  );
}
