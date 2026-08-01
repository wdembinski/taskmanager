/**
 * The little panel that hangs off a selected arrow — the only place a link's **gate** can
 * be changed, and one of the two ways to erase it.
 *
 * It is positioned in the board's own content space rather than by a Fluent `Popover`
 * anchored to a trigger, because the thing it belongs to is not a DOM node: an arrow is a
 * `<path>` inside one `<svg>` laid over the whole board, and its middle is a number
 * `chainArrows` already computed. Hanging the panel off that number keeps it on the curve
 * through scrolling and re-layout for free, since it is a sibling of the overlay inside the
 * same scrolling container.
 *
 * Both gates get a line of explanation, not just a name. "Stacked on this branch" sounds
 * like a technique when it is really a trade — sooner, at the cost of a base that may still
 * be rewritten — and a picker that only named the two would be asking you to guess.
 */
import {
  Button,
  Caption1,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { DeleteRegular } from '@fluentui/react-icons';
import {
  LINK_GATES,
  LINK_GATE_HELP,
  LINK_GATE_TITLE,
  type LinkGate,
  type TaskLink,
} from '@shared/taskChain';
import type { Point } from './chainArrows';

/** Kept off the board's edges by this much, so the panel is never half outside the frame. */
const MARGIN = 8;
const WIDTH = 260;

const useStyles = makeStyles({
  root: {
    position: 'absolute',
    width: `${WIDTH}px`,
    // Below the point it hangs from, and centred on it — the arrow stays visible above.
    transform: 'translate(-50%, 10px)',
    zIndex: 2,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: '8px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow16,
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '0 4px 4px',
    color: tokens.colorNeutralForeground3,
  },
  headText: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /** One gate. A button, not a radio: the whole row is the target, including its help line. */
  choice: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '1px',
    textAlign: 'left',
    padding: '6px 8px',
    borderRadius: tokens.borderRadiusSmall,
    border: '1px solid transparent',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  chosen: {
    backgroundColor: tokens.colorNeutralBackground1Selected,
    border: `1px solid ${tokens.colorBrandStroke1}`,
  },
  help: { color: tokens.colorNeutralForeground3 },
  remove: { alignSelf: 'flex-start', marginTop: '2px' },
});

export interface ChainLinkPopoverProps {
  link: TaskLink;
  /** The two cards' titles, for the sentence at the top. */
  fromTitle: string;
  toTitle: string;
  /** The arrow's midpoint, in board content space. */
  at: Point;
  /** The board's width, so the panel can be kept inside it. */
  boardWidth: number;
  onSetGate: (gate: LinkGate) => void;
  onRemove: () => void;
}

export function ChainLinkPopover(props: ChainLinkPopoverProps): JSX.Element {
  const styles = useStyles();
  // The panel is centred on `at.x`, so its own half-width is what has to fit either side.
  const half = WIDTH / 2;
  const left = Math.min(
    Math.max(props.at.x, half + MARGIN),
    Math.max(props.boardWidth - half - MARGIN, half + MARGIN),
  );

  return (
    <div
      className={styles.root}
      style={{ left, top: props.at.y }}
      // A click inside must not reach the board, which reads any click of its own as
      // "nothing is selected any more" and would close the panel on its own buttons.
      onClick={(e) => e.stopPropagation()}
    >
      <div className={styles.head}>
        <Caption1
          className={styles.headText}
          title={`${props.toTitle} runs after ${props.fromTitle}`}
        >
          <Text weight="semibold">{props.toTitle}</Text> runs after {props.fromTitle}
        </Caption1>
      </div>

      {LINK_GATES.map((gate) => (
        <button
          key={gate}
          type="button"
          className={mergeClasses(styles.choice, gate === props.link.gate && styles.chosen)}
          aria-pressed={gate === props.link.gate}
          onClick={() => props.onSetGate(gate)}
        >
          <Text weight="semibold" size={200}>
            {LINK_GATE_TITLE[gate]}
          </Text>
          <Caption1 className={styles.help}>{LINK_GATE_HELP[gate]}</Caption1>
        </button>
      ))}

      {/* Delete and Backspace do this too, with the arrow selected — this is the discoverable
          half of the same action. */}
      <Button
        className={styles.remove}
        size="small"
        appearance="subtle"
        icon={<DeleteRegular />}
        onClick={props.onRemove}
      >
        Remove link
      </Button>
    </div>
  );
}
