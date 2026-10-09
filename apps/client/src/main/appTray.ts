/**
 * Thin Electron glue around `backgroundMode.ts`'s pure tray menu model (F1.10). Not
 * unit-tested — there is no meaningful way to exercise a real `Tray`/`Menu` without
 * Electron itself; the decision logic it renders is in `backgroundMode.ts`, and IS
 * tested there.
 *
 * Lifecycle is the caller's (`index.ts`, next step): create on the FIRST background
 * close, `destroy()` again if `runInBackground` is turned back off before the next
 * Open, and `destroy()` once more from `before-quit` so the icon never outlives the
 * app. This class just makes each of those a single call.
 */
import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  Tray,
  type MenuItemConstructorOptions,
} from 'electron';
import { PRODUCT_NAME } from '@shared/product';
import { trayMenuModel, type TrayMenuItem } from './backgroundMode';

/** Hook into whatever "pause automations" ends up meaning — the menu only shows it when given one. */
export interface AutomationsController {
  isPaused(): boolean;
  setPaused(paused: boolean): void;
}

function toMenuTemplate(
  items: ReadonlyArray<TrayMenuItem>,
  handlers: { open(): void; pause(): void; quit(): void },
): MenuItemConstructorOptions[] {
  return items.map((item) => {
    if (item.id === 'separator') return { type: 'separator' };
    return {
      label: item.label,
      enabled: item.enabled ?? true,
      type: item.id === 'pause' ? 'checkbox' : 'normal',
      checked: item.checked,
      click:
        item.id === 'open' ? handlers.open : item.id === 'pause' ? handlers.pause : handlers.quit,
    };
  });
}

export class AppTray {
  private tray: Tray | null = null;

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly automations?: AutomationsController,
  ) {}

  /** Whether the tray icon currently exists. */
  get isActive(): boolean {
    return this.tray !== null;
  }

  /** Create the tray icon and its menu, unless one already exists. */
  ensure(): void {
    if (this.tray) return;

    // `new Tray()` needs an image synchronously; the real one (the app's own, so we
    // don't have to ship a second icon asset just for the tray) only resolves async.
    // An empty image is a blank square for that one tick rather than a crash.
    const tray = new Tray(nativeImage.createEmpty());
    tray.setToolTip(PRODUCT_NAME);
    void app.getFileIcon(process.execPath).then((image) => {
      if (this.tray === tray) tray.setImage(image);
    });

    tray.on('double-click', () => this.open());
    tray.setContextMenu(this.buildMenu());

    this.tray = tray;
  }

  /** Destroy the tray icon, if one exists. Safe to call when there is none. */
  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  /** Rebuild the context menu — call after the paused state changes elsewhere. */
  refresh(): void {
    this.tray?.setContextMenu(this.buildMenu());
  }

  private buildMenu(): Menu {
    const model = trayMenuModel({
      canPauseAutomations: this.automations != null,
      automationsPaused: this.automations?.isPaused() ?? false,
    });
    return Menu.buildFromTemplate(
      toMenuTemplate(model, {
        open: () => this.open(),
        pause: () => this.togglePause(),
        quit: () => app.quit(),
      }),
    );
  }

  private open(): void {
    const window = this.getWindow();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    if (!window.isVisible()) window.show();
    window.focus();
  }

  private togglePause(): void {
    const automations = this.automations;
    if (!automations) return;
    automations.setPaused(!automations.isPaused());
    this.refresh();
  }
}
