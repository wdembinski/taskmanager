/**
 * The review workspace's `?` key list (F15.14). Its own file because a Fluent dialog stays on
 * the flat surface and must never share a module with the glass pane — `ReviewWorkspaceView`
 * paints its columns as glass, and `test/dialog-flat-surface.test.ts` enforces the split.
 */
import type { JSX } from 'react';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
} from '@fluentui/react-components';
import { KeyboardShortcutsList } from '../palette/KeyboardShortcutsList';
import { REVIEW_KEYS } from './reviewKeys';

export function ReviewKeysDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={(_e, data) => !data.open && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogContent>
            <KeyboardShortcutsList items={REVIEW_KEYS} />
          </DialogContent>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
