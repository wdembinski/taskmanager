/**
 * Browser entry point. Mounts the same provider the desktop renderer does — see
 * `apps/client/src/renderer/src/main.tsx` — so the same board reads the same way in a
 * browser tab as it does in the desktop window.
 *
 * "The same provider" is four things, and none of them is decoration:
 *  - `appDarkTheme` (`@tm/ui/theme`), Fluent dark with the editor grey for body text. It
 *    used to be a four-token copy in each `main.tsx`; it is one constant now, because two
 *    copies of a palette are a palette that drifts.
 *  - `scaleTheme(...)`, which multiplies Fluent's type ramp. A browser has no font-size
 *    setting to read (that one is the desktop's, over IPC), so this is `BASE_FONT_PX` and
 *    a no-op — stated anyway so the two entry points differ in the value, not the shape.
 *  - `--app-font-scale`, which is what every `fontPx()` in the shared components reads.
 *    Without it the extracted `StatusBar`'s `fontPx(12)` falls back to its own default and
 *    the bar's type stops tracking the theme it sits in.
 *  - the single `<Toaster>` on `TOASTER_ID`, so any shared component that dispatches a
 *    toast has a surface to land in rather than failing silently.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { FluentProvider, Toaster } from '@fluentui/react-components';
import { appDarkTheme, BASE_FONT_PX, TOASTER_ID, scaleTheme, useGlobalStyles } from '@tm/ui/theme';
import { App } from './App';
import './index.css';

function ThemedApp(): JSX.Element {
  // The app's global rules (the spinner's colour). Called here because this component always
  // renders, and `makeStaticStyles` emits its CSS on first use.
  useGlobalStyles();
  return (
    <FluentProvider
      theme={scaleTheme(appDarkTheme, BASE_FONT_PX)}
      style={
        {
          height: '100vh',
          // The desktop's is `fontSizePx / BASE_FONT_PX`; with no setting to read, 1.
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
