/**
 * Android entry point. Mounts the same provider the desktop and browser hosts do — see
 * `apps/web/src/main.tsx`, whose header spells out why each of the four pieces below is
 * shared and not a per-host copy — so the same board reads the same way in the Android app
 * as it does in a desktop window or a browser tab.
 *
 * The one difference from `apps/web/src/main.tsx` is the provider's `height`: `100dvh`
 * rather than `100vh`, so the root shrinks with the browser chrome / PWA gesture strip
 * instead of running a viewport-height under it — `MobileShell`'s own root does the same,
 * stated here too because this is the outermost box the app ever draws into.
 *
 * The other difference is `registerServiceWorker()` below, called once at module scope —
 * `apps/web` has no PWA manifest and registers nothing (Phase 27 Decision 1: mobile is
 * its own app, not a responsive `apps/web`).
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { FluentProvider, Toaster } from '@fluentui/react-components';
import { appDarkTheme, BASE_FONT_PX, TOASTER_ID, scaleTheme, useGlobalStyles } from '@tm/ui/theme';
import { App } from './App';
import { registerServiceWorker } from './registerServiceWorker';

registerServiceWorker();

function ThemedApp(): JSX.Element {
  useGlobalStyles();
  return (
    <FluentProvider
      theme={scaleTheme(appDarkTheme, BASE_FONT_PX)}
      style={
        {
          height: '100dvh',
          // No font-size setting to read on this host either — see apps/web/src/main.tsx.
          '--app-font-scale': 1,
        } as React.CSSProperties
      }
    >
      <App />
      <Toaster toasterId={TOASTER_ID} position="bottom-end" />
    </FluentProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ThemedApp />
  </React.StrictMode>,
);
