/**
 * MoveToSheet — the compact board's substitute for drag-and-drop (F3.6): a bottom sheet
 * listing every visible column as one full-width, touch-sized button. Touch has no drag
 * gesture to carry a card between columns, so this sheet is the only way a phone moves one.
 *
 * `options` comes from `moveTargets.ts`'s `moveSheetOptions` — the same drop-target rule
 * the wide board's drag-and-drop reads, so a column this sheet offers can never be one a
 * drag would have refused, and the other way round.
 *
 * Monochrome throughout (`board-colour-budget`): a list of destinations is a set of facts,
 * not something in motion, so the only mark beyond plain Fluent tokens is the current
 * column's checkmark.
 */
import {
  Button,
  Caption1,
  DrawerBody,
  DrawerHeader,
  DrawerHeaderTitle,
  OverlayDrawer,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { CheckmarkRegular } from '@fluentui/react-icons';
import type { BoardColumn } from '@tm/shared/model';
import type { MoveSheetOption } from './moveTargets';

const useStyles = makeStyles({
  cardTitle: {
    color: tokens.colorNeutralForeground3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  body: { display: 'flex', flexDirection: 'column', gap: '8px', paddingBottom: '12px' },
  // Touch-sized and full width, so the whole row is the target rather than a label
  // floating in the middle of a sheet sized for a thumb, not a pointer.
  option: { width: '100%', minHeight: '44px', justifyContent: 'flex-start' },
});

export interface MoveToSheetProps {
  /** One row per visible column — `moveTargets.ts`'s `moveSheetOptions`. */
  options: MoveSheetOption[];
  /** The card this sheet is moving, shown under the "Move to…" heading. */
  title: string;
  open: boolean;
  /** A column was picked. The sheet closes itself right after — see the render site. */
  onPick: (column: BoardColumn) => void;
  onClose: () => void;
}

export function MoveToSheet({
  options,
  title,
  open,
  onPick,
  onClose,
}: MoveToSheetProps): JSX.Element {
  const styles = useStyles();
  return (
    <OverlayDrawer open={open} position="bottom" onOpenChange={(_e, d) => !d.open && onClose()}>
      <DrawerHeader>
        <DrawerHeaderTitle>Move to…</DrawerHeaderTitle>
        <Caption1 className={styles.cardTitle}>{title}</Caption1>
      </DrawerHeader>
      <DrawerBody>
        <div className={styles.body}>
          {options.map((option) => (
            <Button
              key={option.column}
              className={styles.option}
              appearance="subtle"
              size="large"
              disabled={!option.enabled}
              icon={option.current ? <CheckmarkRegular /> : undefined}
              iconPosition="after"
              onClick={() => {
                onPick(option.column);
                onClose();
              }}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </DrawerBody>
    </OverlayDrawer>
  );
}
