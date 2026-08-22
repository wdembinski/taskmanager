/**
 * contextMenu — the app's only right-click menu, and the reason it exists at all: `role:
 * 'paste'` runs `webContents.paste()`, which dispatches a REAL paste into the focused
 * element, so the renderer's `onPaste` handler (`usePasteAttachments`, `AddTaskDialog`)
 * fires exactly as it would for Ctrl+V. One code path serves both gestures — this menu
 * does not know attachments exist.
 *
 * Roles, not hand-rolled click handlers, so the OS draws the accelerators and Electron
 * owns cut/copy/paste/select-all's behaviour — the same reason `webContents.paste()` is
 * left to do the work above rather than reading the clipboard ourselves.
 *
 * `buildContextMenuTemplate` is the decision (given where the click landed, what should
 * the menu contain), kept Electron-menu-free enough to unit-test; a menu with four dead
 * items is worse than no menu, so it returns `null` — not an empty template — when there
 * is neither an editable field nor a selection to act on.
 */
import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';

/** The slice of Electron.ContextMenuParams this decision actually depends on. */
export interface ContextMenuDecisionParams {
  isEditable: boolean;
  editFlags: {
    canCut: boolean;
    canCopy: boolean;
    canPaste: boolean;
    canSelectAll: boolean;
  };
}

/**
 * `null` means "show nothing" — a caller must not fall back to popping up an empty menu.
 */
export function buildContextMenuTemplate(
  params: ContextMenuDecisionParams,
): MenuItemConstructorOptions[] | null {
  const { isEditable, editFlags } = params;

  if (isEditable) {
    return [
      { role: 'cut', enabled: editFlags.canCut },
      { role: 'copy', enabled: editFlags.canCopy },
      { role: 'paste', enabled: editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: editFlags.canSelectAll },
    ];
  }

  if (editFlags.canCopy) {
    return [
      { role: 'copy' },
      { type: 'separator' },
      { role: 'selectAll', enabled: editFlags.canSelectAll },
    ];
  }

  return null;
}

/** Wires the decision above into a real popup on `window`'s webContents. */
export function registerContextMenu(window: BrowserWindow): void {
  window.webContents.on('context-menu', (_event, params) => {
    const template = buildContextMenuTemplate(params);
    if (!template) return;
    Menu.buildFromTemplate(template).popup({ window });
  });
}
