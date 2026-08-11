/**
 * Renderer entry point — the first UI code that runs inside the app window.
 *
 * It mounts the React tree into <div id="root"> and wraps everything in Fluent
 * UI's <FluentProvider>, which supplies the design tokens (colors, spacing,
 * fonts) that all Fluent components read. We use the dark theme to match a
 * developer tool aesthetic; a light/dark toggle can come later.
 *
 * Note there is NO data-fetching library here (unlike the iam frontend's
 * TanStack Query): this app's "server" is the local engine, reached through
 * `window.api` over IPC, not HTTP.
 */
import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { FluentProvider, Toaster } from '@fluentui/react-components';
import { App } from './App';
import { isFileDrag } from '@ui/AttachmentStrip';
import { RootErrorBoundary } from './RootErrorBoundary';
import { appDarkTheme, BASE_FONT_PX, TOASTER_ID, scaleTheme, useGlobalStyles } from '@ui/theme';
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
 * The provider, sized to the user's font-size setting.
 *
 * Two mechanisms, because one cannot reach everything. `scaleTheme` multiplies Fluent's
 * type ramp, which covers every `Text`, `Button`, `Field` and `Badge` in the app without
 * touching a component. `--app-font-scale` covers the sizes written as literal px in
 * `makeStyles`, which tokens cannot reach — those call `fontPx()`. Both are derived from
 * the same number, so they can never disagree.
 *
 * Read here rather than passed down because it must wrap the whole tree, and re-read on
 * `settings:changed` so the size takes effect as you pick it rather than on next launch.
 */
function ThemedApp(): JSX.Element {
  // The app's global rules — dark colour-scheme, page background, scrollbars, spinner colour.
  // Called here because this component always renders, and `makeStaticStyles` emits its CSS
  // on first use. `index.css` beside this file keeps only the window's drag regions.
  useGlobalStyles();
  const [fontSizePx, setFontSizePx] = useState(BASE_FONT_PX);
  const [toasts, setToasts] = useState(true);

  useEffect(() => {
    const read = (): void => {
      void window.api
        .invoke('settings:get')
        .then((s) => {
          setFontSizePx(s.fontSizePx || BASE_FONT_PX);
          setToasts(s.toastsEnabled);
        })
        .catch(() => undefined);
    };
    read();
    return window.api.on('settings:changed', read);
  }, []);

  return (
    <FluentProvider
      theme={scaleTheme(appDarkTheme, fontSizePx)}
      style={
        {
          height: '100vh',
          '--app-font-scale': fontSizePx / BASE_FONT_PX,
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
