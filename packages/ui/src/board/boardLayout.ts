/**
 * The board's frame: the rules that make a Kanban screen THIS board rather than a grid of
 * the same cards. The insets, the single scroll container, the exact detail-pane basis and
 * the surface that separates the two halves of the screen.
 *
 * Extracted from `MyTasks.tsx` so the browser client draws the same board and not a
 * lookalike — the same reason the shell moved in the step before this one. The cards were
 * already shared (`KanbanColumn`, `TaskCard`); what was not shared was everything AROUND
 * them, which is most of what makes two screens look like one application.
 *
 * The desktop's commit-graph pane stays behind in `MyTasks`: it is a third pane in this row
 * that only the desktop has (it costs a `git log` on the machine the project lives on), and
 * a rule here for a pane one host can never render would be a rule nobody can read.
 */
import { makeStyles, tokens } from '@fluentui/react-components';

export const useBoardLayoutStyles = makeStyles({
  // No gap: the detail pane's own surface runs to the board's edge, and the change of
  // shade is the seam.
  root: { display: 'flex', minHeight: 0, flex: 1 },
  board: {
    // `auto` rather than a 60% basis: with the graph pane open there are THREE panes in this
    // row, and a board that insists on 60% of the window plus the detail pane's 40% plus the
    // graph's own width adds up to more than there is — so something would be squeezed by
    // whichever flex rule happened to lose. The board simply takes what the other two leave.
    flex: '1 1 auto',
    // The screen owns its insets now that the shell adds none, and only the board side
    // needs them — the detail pane runs to the window's edges on purpose.
    padding: '12px 16px 12px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    minHeight: 0,
    minWidth: 0,
  },
  toolbar: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
  grow: { flex: 1 },
  // The whole board scrolls as one — not each column on its own — so the columns stay
  // aligned with each other while you scroll. A grid (rather than a flex row) is what
  // makes that work: the single auto row sizes to the *tallest* column, every column
  // stretches to it (so a short column is still a full-height drop target), and this
  // container is the only thing that scrolls.
  columns: {
    display: 'grid',
    gridAutoFlow: 'column',
    gridAutoColumns: 'minmax(0, 1fr)',
    gap: '12px',
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    // The containing block for the chain overlay (`ChainOverlay`), which is one `<svg>`
    // laid over the whole board. It had none, and this is exactly why one overlay is
    // possible at all: this is the ONLY scrolling element, so an absolutely-positioned
    // child of it shares the cards' coordinate space and scrolls with them. It changes
    // nothing about the columns themselves — an absolutely-positioned child of a grid
    // container is out of flow and never becomes a track of its own.
    position: 'relative',
    // Breathing room above the first card. Its 3px project stripe and its 3px attention
    // ring both live ON the card's top edge, and with the sticky header sitting directly
    // on top of the list they had nothing to breathe into.
    paddingTop: '4px',
  },
  right: {
    // Exactly 40%, whatever the card holds. `1 1 40%` let the pane grow past its basis:
    // a flex item's automatic minimum is its CONTENT's min-width, so a card with wide
    // content (a long MR title, a full stage row, the three pickers side by side) widened
    // the pane and squeezed the board — and the pane visibly changed size card to card.
    // `minWidth: 0` drops that automatic minimum and `flex-shrink: 0` holds the basis.
    flex: '0 0 40%',
    minWidth: 0,
    // Anything that still doesn't fit scrolls inside its own row (the chat, the code
    // blocks, the details cell) rather than spilling over the board.
    overflow: 'hidden',
    display: 'flex',
    minHeight: 0,
    // No inset: the detail pane's top band is full-bleed (it is a section of the pane,
    // not a card in it), so each of the pane's other rows carries its own padding.
    // One surface for the whole pane, a step LIGHTER than the board — that contrast is
    // what separates the two halves of the screen, so no dividing line is needed.
    backgroundColor: tokens.colorNeutralBackground1,
  },
});
