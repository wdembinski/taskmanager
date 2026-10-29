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
 * The commit-graph pane's own rule is here too (`graph`), now that both clients can draw one:
 * `git:graph` is relayed, so a browser gets the same picture out of the desktop's repository.
 * It is the third pane in this row, and how wide it is — and that the board is what gives way
 * to it — is a rule about the ROW, which is what this file holds.
 */
import { makeStyles, tokens } from '@fluentui/react-components';

/** A column's width — fixed, the mockup's 259.6px lane (v9-7, v10-7e) rounded. Columns
 *  never stretch to fill a wide window: the spare width stays empty canvas, and a window too
 *  narrow for every column scrolls sideways. Shared with `PaneLoading`'s skeleton track so
 *  the loading state draws the same width the real board will. */
export const BOARD_COLUMN_WIDTH = '260px';

export const useBoardLayoutStyles = makeStyles({
  /**
   * The tinted canvas the cards stand on (v9-7/v9-7b): a 10px inset all round — the shell
   * gives this tab no padding of its own — and the same 10px between the board, the detail
   * pane and the commit graph. The Tickets screen's own `root` (`Projects.tsx`), so the two
   * screens stand on the same canvas.
   */
  root: {
    display: 'flex',
    gap: '10px',
    minHeight: 0,
    flex: 1,
    height: '100%',
    boxSizing: 'border-box',
    padding: '10px',
  },
  /** The compact (phone) board stands flat on the screen: no canvas to inset a card from. */
  rootCompact: { padding: 0, gap: 0 },
  /**
   * The board's own card — rendered as `<GlassPane className={layout.board}>` in both hosts,
   * so the surface, the 12px radius and the shadow are `GlassPane`'s and this rule is only the
   * card's BODY: the header row, then the columns grid running to the bottom padding.
   */
  board: {
    // `auto` rather than a 60% basis: with the graph pane open there are THREE panes in this
    // row, and a board that insists on 60% of the window plus the detail pane's 40% plus the
    // graph's own width adds up to more than there is — so something would be squeezed by
    // whichever flex rule happened to lose. The board simply takes what the other two leave.
    flex: '1 1 auto',
    padding: '12px 16px 16px',
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    minHeight: 0,
    minWidth: 0,
    // The containing block for `chainLegend` below — an overlay anchored to the BOARD, not
    // to the scrolling columns grid, so it can never become a grid track of its own again.
    position: 'relative',
  },
  /**
   * The card's one-row header (v9-7): the title picker, the Board/List tabs, a spacer, the
   * `Links:` pill, "…" (`BoardMoreMenu`) and the "+". `data-board-header` in both hosts.
   *
   * One row, never two: every other control lives behind "…" permanently, so the row holds
   * five things at any width. When even those do not fit (a phone, or the detail pane open on
   * a narrow window) the title is the one that gives — it ellipsizes; nothing else shrinks.
   */
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'nowrap',
    overflow: 'hidden',
    minWidth: 0,
    minHeight: '32px',
    flexShrink: 0,
    '& > *': { flexShrink: 0, whiteSpace: 'nowrap' },
    '& > [data-board-title]': { flexShrink: 1, minWidth: 0 },
  },
  grow: { flex: 1 },
  /**
   * The title picker (`BoardTitlePicker`): which board the card shows, set as the card's
   * title — Title3, 20px semibold, the mockup's "M4 · Reach" — with a chevron that says it
   * opens. A bare button rather than a `Dropdown`: a title with a field's border round it
   * reads as a form, not a heading. A long board name ellipsizes at `maxWidth`, or sooner
   * when the row itself runs out of width (`header`).
   */
  title: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    minWidth: 0,
    maxWidth: '260px',
    padding: '0 4px',
    margin: '0 2px 0 -4px',
    border: 'none',
    borderRadius: tokens.borderRadiusMedium,
    background: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: tokens.fontSizeBase500,
    lineHeight: tokens.lineHeightBase500,
    fontWeight: tokens.fontWeightSemibold,
    color: `var(--tm-text, ${tokens.colorNeutralForeground1})`,
    ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover },
  },
  // The picker's own slot in the row (`data-board-title`).
  titleSlot: { display: 'flex' },
  titleText: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  titleChevron: {
    display: 'flex',
    flexShrink: 0,
    fontSize: '14px',
    color: `var(--tm-text-faint, ${tokens.colorNeutralForeground3})`,
  },
  /** The Board / List pill tabs (`BoardViewTabs`). */
  tabs: { display: 'flex', alignItems: 'center', gap: '2px', flexShrink: 0 },
  tab: {
    height: '26px',
    padding: '0 10px',
    borderRadius: '13px',
    border: 'none',
    background: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: tokens.fontSizeBase300,
    color: `var(--tm-text-faint, ${tokens.colorNeutralForeground3})`,
    whiteSpace: 'nowrap',
    ':hover': { color: tokens.colorNeutralForeground1 },
    ':disabled': { cursor: 'default', color: tokens.colorNeutralForegroundDisabled },
  },
  // The mockup's selected pill: a filled neutral pill, no brand colour — the selection is a
  // fact about the view, and this board spends colour only on things that move.
  tabSelected: {
    backgroundColor: tokens.colorNeutralBackground3,
    color: `var(--tm-text, ${tokens.colorNeutralForeground1})`,
    fontWeight: tokens.fontWeightSemibold,
    cursor: 'default',
  },
  /**
   * The chain legend (`ChainLegend`), anchored to the board itself rather than drawn inside
   * `columns` — see `ChainOverlay.tsx`'s own `legend` style comment for the bug this replaces
   * (a `gridColumn: '1 / -1'` that, against an implicit grid, became a sixth ~260px column
   * instead of spanning the row). `position: absolute` against `board`'s own `position:
   * relative`, so it floats over the columns without ever being one of their flex/grid
   * children, and `pointerEvents: 'none'` here too so it never steals a drag over the
   * corner it sits in — `ChainLegend`'s own pill already clears pointer events for itself.
   */
  chainLegend: {
    position: 'absolute',
    insetBlockEnd: '10px',
    insetInlineEnd: '16px',
    zIndex: 1,
    pointerEvents: 'none',
  },
  // The whole board scrolls as one — not each column on its own — so the columns stay
  // aligned with each other while you scroll. A grid (rather than a flex row) is what
  // makes that work: the single auto row sizes to the *tallest* column, every column
  // stretches to it (so a short column is still a full-height drop target), and this
  // container is the only thing that scrolls.
  columns: {
    display: 'grid',
    gridAutoFlow: 'column',
    // A fixed track, packed to the start (v9-7, v10-7e): `minmax(260px, 1fr)` stretched each
    // column to ~550px on a 2500px window, and a track that shrinks crushes a card's header
    // until its title wraps one word per line. The grid scrolls sideways instead.
    gridAutoColumns: BOARD_COLUMN_WIDTH,
    justifyContent: 'start',
    gap: '12px',
    flex: 1,
    minHeight: 0,
    // Both axes: once the floor above is reached, more columns than fit make the grid
    // wider than the pane, and `auto` is what lets it scroll sideways for that instead of
    // only ever vertically.
    overflow: 'auto',
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
    // A size container, so each column can ask for `100cqh` — the grid's own visible
    // height — as its floor (`& > [data-board-column]` below). The grid is sized by the card
    // (`flex: 1`), never by its content, so the containment costs nothing.
    containerType: 'size',
    // Every column pane runs to the card's bottom padding, however few cards it holds. This
    // is what used to stop at ~735px of a 900px window: the shelf strip was the grid's
    // SIBLING, so the grid — and every pane stretched to its one row — ended where the strip
    // began. The strip is now a second row INSIDE this grid (`shelf`), below the panes'
    // one-screen floor, and this stays the board's only scroll container.
    '& > [data-board-column]': { gridRow: 1, minHeight: '100cqh', boxSizing: 'border-box' },
    // Row 1's floor is its tallest column's CONTENT, not just the `100cqh` above: a set
    // `minHeight` replaces a grid item's automatic (content-based) minimum, so an `auto` row
    // would otherwise hold a twelve-card column to one screen and spill the rest out of it.
    gridTemplateRows: 'minmax(min-content, auto)',
  },
  /**
   * The same grid, while a chain's links are actually drawn over it (`mode !== 'off'` and
   * `links.length > 0`) — a wider gutter so `chainRoute`'s lanes have somewhere to run that
   * is not a card's own padding. One shared rule rather than a host re-declaring the gap,
   * for the same reason `columns` itself is shared (`shell-parity.test.ts`).
   */
  columnsLinked: { gap: '30px' },
  /**
   * The parked shelf (Phase 25's `settings.features.shelf`): a full-width band below the
   * columns rather than a column of its own, because a shelved card has deliberately left
   * every column — giving it one more would put it right back in the thing it left.
   * `flex: '0 0 auto'` so it takes only what its own content needs and never competes with
   * `columns` for the board's one scrollbar.
   *
   * On the wide board it is the columns grid's SECOND row (`ShelfStrip`'s `span` sets the
   * columns it crosses), below the panes' one-screen floor — scrolled to, in the board's one
   * scroll container, rather than standing in the panes' way. As the grid's sibling it used
   * to shorten every pane by its own height (the ~735px stop), and floated over them it
   * covered the same strip of every lane.
   */
  shelf: {
    flex: '0 0 auto',
    gridRow: 2,
    display: 'flex',
    flexDirection: 'column',
    borderRadius: tokens.borderRadiusMedium,
    border: '1px solid transparent',
    backgroundColor: tokens.colorNeutralBackground2,
  },
  // The whole strip is one drop target, header included — a shelf collapsed to its header
  // still has to accept a card, or folding it would also turn off the gesture that fills it.
  shelfOver: {
    border: `1px dashed ${tokens.colorBrandStroke1}`,
  },
  shelfHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 10px',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: tokens.colorNeutralForeground2,
    textAlign: 'left',
    width: '100%',
    ':hover': { color: tokens.colorNeutralForeground1 },
  },
  shelfHeaderLabel: { letterSpacing: '0.04em' },
  shelfCount: { color: tokens.colorNeutralForeground3 },
  // A drop target the same way a `KanbanColumn` is one, laid out as a horizontal row
  // rather than a column's vertical list — the shelf's whole reason to exist is to get a
  // card OUT of the columns' layout, and stacking it back into a column shape here would
  // undo that.
  shelfList: {
    display: 'flex',
    flexDirection: 'row',
    gap: '12px',
    padding: '4px 10px 10px',
    overflowX: 'auto',
    minHeight: '48px',
  },
  shelfEmpty: { color: tokens.colorNeutralForeground4, padding: '8px 4px' },
  // Each card keeps a column's usual width instead of shrinking to its content — a strip
  // of cards squeezed to their title's width would read as chips, not as the same cards
  // that just sat in a column.
  shelfCard: { flex: '0 0 280px', minWidth: 0 },
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
    // No fill of its own either: it is rendered as a `GlassPane`, a card of its own beside
    // the board's, and the canvas between the two is the seam.
  },
  /**
   * The commit graph's pane (`GitGraphPane`), last in the row. A fixed px basis rather than
   * the detail pane's percentage: what it holds is a fixed-width thing — a lane gutter, a
   * subject, an author and a date — so a share of the window would leave it either clipping
   * every subject or padded with empty space, depending only on how wide the monitor is.
   * `0 0` so it neither grows nor shrinks, and the board (`flex: 1 1 auto`) absorbs the
   * difference.
   */
  graph: {
    flex: '0 0 340px',
    minWidth: 0,
    display: 'flex',
    minHeight: 0,
    overflow: 'hidden',
    // Rendered as a `GlassPane` — its own card, so the canvas gap is the edge and the
    // surface is `GlassPane`'s.
  },
});
