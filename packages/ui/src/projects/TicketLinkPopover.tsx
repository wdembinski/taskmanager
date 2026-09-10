/**
 * `ChainLinkPopover`'s own shape, for a `blocks` dependency arrow instead of a chain edge. A
 * `TicketLink` gates nothing (`ticketLinks.ts`'s own doc comment) — there is no scheduler
 * decision riding on it — so this panel has no gate picker, only the sentence and a way to
 * erase the row.
 *
 * Positioned in the timeline's own content space for the same reason `ChainLinkPopover` is:
 * the thing it belongs to is a `<path>`, not a DOM node with a natural anchor.
 */
import { Button, Caption1, Text, makeStyles, tokens } from '@fluentui/react-components';
import { DeleteRegular } from '@fluentui/react-icons';
import type { TicketLink } from '@tm/shared/model';
import type { Point } from '../board/chainArrows';

/** Kept off the chart's edges by this much, so the panel is never half outside the frame. */
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
  remove: { alignSelf: 'flex-start', marginTop: '2px' },
});

export interface TicketLinkPopoverProps {
  link: TicketLink;
  /** The two tickets' titles, for the sentence at the top. */
  fromTitle: string;
  toTitle: string;
  /** The arrow's midpoint, in the timeline's content space. */
  at: Point;
  /** The chart's width, so the panel can be kept inside it. */
  boardWidth: number;
  onRemove: () => void;
}

export function TicketLinkPopover(props: TicketLinkPopoverProps): JSX.Element {
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
      // A click inside must not reach the chart, which reads any click of its own as "nothing
      // is selected any more" and would close the panel on its own button.
      onClick={(e) => e.stopPropagation()}
    >
      <div className={styles.head}>
        <Caption1
          className={styles.headText}
          title={`${props.toTitle} is blocked by ${props.fromTitle}`}
        >
          <Text weight="semibold">{props.toTitle}</Text> is blocked by {props.fromTitle}
        </Caption1>
      </div>

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
