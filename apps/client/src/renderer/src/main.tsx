/**
 * Renderer entry point — the first UI code that runs inside the app window.
 *
 * It mounts the React tree into <div id="root"> and wraps everything in Fluent
 * UI's <FluentProvider>, which supplies the design tokens (colors, spacing,
 * fonts) that all Fluent components read. The theme follows the user's resolved
 * `appearance` setting (light/dark/system) via `useResolvedAppearance`, which also
 * stamps `data-scheme`/`data-glass` onto `document.documentElement` so the document
 * styles (`useGlobalStyles`) never disagree with the `FluentProvider` mounted beside
 * them.
 *
 * Note there is NO data-fetching library here (unlike the iam frontend's
 * TanStack Query): this app's "server" is the local engine, reached through
 * `window.api` over IPC, not HTTP.
 */
import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { FluentProvider, Toaster } from '@fluentui/react-components';
import type { NativeMaterial } from '@shared/canvas';
import type { AppSettings } from '@shared/settings';
import { App } from './App';
import { isFileDrag } from '@ui/AttachmentStrip';
import { RootErrorBoundary } from './RootErrorBoundary';
import { BASE_FONT_PX, TOASTER_ID, scaleTheme, themeFor, useGlobalStyles } from '@ui/theme';
import { tokenCssVars } from '@ui/tokens';
import { useResolvedAppearance } from '@ui/useResolvedAppearance';
import { TransportProvider } from '@ui/transport';
import './index.css';

/**
 * **A file dropped anywhere else must not navigate the window.**
 *
 * A drop the page does not cancel is handled by Chromium itself, and its default for a
 * file is to *open* it — the window leaves the app for a `file://` view of a PNG. In a
 * frameless window (`index.ts:68`) there is no back button and no address bar to come
 * back with, so it is unrecoverable without restarting the app. Both events have to be
 * cancelled: `dragover` is what makes the page a drop target at all, and `drop` is what
 * would otherwise navigate.
 *
 * Gated on `Files` for the same reason the strip's own zone is: the board drags cards and
 * draws chain links with this mechanism, and cancelling every `dragover` at the window
 * would make the whole page accept those drops and take the "no" cursor away from the
 * targets that legitimately refuse them.
 *
 * At module scope rather than in a `useEffect`: it is a property of the window, not of
 * anything mounted in it, and there is no moment during the app's life when it should be
 * off. Non-passive by necessity — a passive listener may not call `preventDefault`.
 */
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, (event: DragEvent) => {
    if (isFileDrag(event.dataTransfer?.types)) event.preventDefault();
  });
}

/**
 * The provider, sized to the user's font-size setting and themed to their resolved
 * appearance.
 *
 * Two mechanisms size it, because one cannot reach everything. `scaleTheme` multiplies
 * Fluent's type ramp, which covers every `Text`, `Button`, `Field` and `Badge` in the app
 * without touching a component. `--app-font-scale` covers the sizes written as literal px
 * in `makeStyles`, which tokens cannot reach — those call `fontPx()`. Both are derived from
 * the same number, so they can never disagree.
 *
 * The first render already uses the saved values: `fontSizePx`, `appearance`,
 * `transparency` and `nativeMaterial` start from `window.api.boot`, which the preload read
 * synchronously from main (`window:boot`) before this script ran. `useResolvedAppearance`
 * resolves in its own `useState` initializer, so the very first frame paints the right
 * scheme and glass — no guess that a later async answer corrects. Under native glass that
 * frame keeps the canvas wash over Mica/Acrylic, exactly as every later one does, so there is
 * no haze that appears and then vanishes. Without a hand-off (`boot` is `null`: main could
 * not answer) the old defaults stand in — `'dark'`/`'system'`, matching the window's own
 * `backgroundColor` for an existing install — until the first `settings:get` lands.
 *
 * `nativeMaterial` follows `window.api.onNativeMaterialChanged`: main re-applies the window's
 * material when the OS transparency or contrast changes, or when the Transparency setting now
 * grants or refuses it, and `data-glass` moves between `native` and `css` with it.
 * Everything else is re-read on `settings:changed`, so a change takes effect as you pick it
 * rather than on next launch; `useResolvedAppearance` re-resolves on top of that and keeps
 * `document.documentElement` in step with it.
 */
function ThemedApp(): JSX.Element {
  const boot = window.api.boot ?? null;
  const [fontSizePx, setFontSizePx] = useState(boot?.fontSizePx || BASE_FONT_PX);
  const [toasts, setToasts] = useState(true);
  const [appearance, setAppearance] = useState<AppSettings['appearance']>(
    boot?.appearance ?? 'dark',
  );
  const [transparency, setTransparency] = useState<AppSettings['transparency']>(
    boot?.transparency ?? 'system',
  );
  const [nativeMaterial, setNativeMaterial] = useState<NativeMaterial | null>(
    boot?.nativeMaterial ?? null,
  );

  useEffect(() => window.api.onNativeMaterialChanged(setNativeMaterial), []);

  useEffect(() => {
    const read = (): void => {
      void window.api
        .invoke('settings:get')
        .then((s) => {
          setFontSizePx(s.fontSizePx || BASE_FONT_PX);
          setToasts(s.toastsEnabled);
          setAppearance(s.appearance);
          setTransparency(s.transparency);
        })
        .catch(() => undefined);
    };
    read();
    return window.api.on('settings:changed', read);
  }, []);

  const { scheme } = useResolvedAppearance({ appearance, transparency }, nativeMaterial);
  // The app's global rules — the resolved scheme's colour-scheme, page background,
  // scrollbars, spinner colour. Called here because this component always renders, and
  // `makeStaticStyles` emits its CSS on first use. `index.css` beside this file keeps only
  // the window's drag regions.
  useGlobalStyles();

  return (
    <FluentProvider
      theme={scaleTheme(themeFor(scheme), fontSizePx)}
      style={
        {
          height: '100vh',
          '--app-font-scale': fontSizePx / BASE_FONT_PX,
          ...tokenCssVars(scheme),
        } as React.CSSProperties
      }
    >
      {/* A render crash used to blank the window with no explanation. Inside the provider
          so the fallback still gets the theme's tokens. */}
      <RootErrorBoundary>
        {/* @tm/ui's board/chat/TaskDetail reach the engine through this rather than
            `window.api` directly, so the same components also work in apps/web behind
            an HTTP client. `window.api` already has the invoke/on/pathForFile shape
            `Transport` wants — see packages/ui/src/transport.tsx. */}
        <TransportProvider transport={window.api}>
          <App />
        </TransportProvider>
      </RootErrorBoundary>
      {/* One surface for the whole app, so any screen can dispatch into it. Absent
          entirely when toasts are off — everything they say is also on screen. */}
      {toasts && <Toaster toasterId={TOASTER_ID} position="bottom-end" />}
    </FluentProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ThemedApp />
  </React.StrictMode>,
);
