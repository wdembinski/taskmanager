/**
 * Browser entry point. Mounts the same provider the desktop renderer does — see
 * `apps/client/src/renderer/src/main.tsx` — so the same board reads the same way in a
 * browser tab as it does in the desktop window.
 *
 * "The same provider" is four things, and none of them is decoration:
 *  - `themeFor(scheme)` (`@tm/ui/theme`), the resolved-scheme Fluent theme. It used to be a
 *    four-token copy in each `main.tsx`; it is one constant now, because two copies of a
 *    palette are a palette that drifts.
 *  - `scaleTheme(...)`, which multiplies Fluent's type ramp. A browser has no font-size
 *    setting to read (that one is the desktop's, over IPC), so this is `BASE_FONT_PX` and
 *    a no-op — stated anyway so the two entry points differ in the value, not the shape.
 *  - `--app-font-scale`, which is what every `fontPx()` in the shared components reads.
 *    Without it the extracted `StatusBar`'s `fontPx(12)` falls back to its own default and
 *    the bar's type stops tracking the theme it sits in.
 *  - the single `<Toaster>` on `TOASTER_ID`, so any shared component that dispatches a
 *    toast has a surface to land in rather than failing silently.
 *
 * One thing is deliberately NOT shared with the desktop renderer: the provider's own
 * sizing. `100dvh` (not `100vh`) so a mobile browser's address bar showing or hiding
 * doesn't resize the app under itself, plus `env(safe-area-inset-*)` padding so a
 * notch or home indicator never sits on top of content — neither applies to a window
 * the OS already sizes for you.
 *
 * There is no `index.css` beside this file any more, and that is the point: the resolved
 * colour-scheme, the page background, the non-scrolling shell and the scrollbars are all in
 * `useGlobalStyles` now, so the tab cannot quietly disagree with the desktop window about
 * them. What was left once they moved was a `font-family` the desktop never set — Fluent's
 * theme owns type here — so the file went with it.
 */
import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { FluentProvider, Toaster } from '@fluentui/react-components';
import { BASE_FONT_PX, TOASTER_ID, scaleTheme, themeFor, useGlobalStyles } from '@tm/ui/theme';
import { tokenCssVars } from '@tm/ui/tokens';
import { useResolvedAppearance } from '@tm/ui/useResolvedAppearance';
import {
  DEFAULT_APPEARANCE_PREFS,
  onAppearancePrefsChange,
  readAppearancePrefs,
  type AppearancePrefs,
} from './appearancePrefs';
import { App } from './App';

function ThemedApp(): JSX.Element {
  const [prefs, setPrefs] = useState<AppearancePrefs>(DEFAULT_APPEARANCE_PREFS);

  useEffect(() => {
    const read = (): void => setPrefs(readAppearancePrefs(window.localStorage));
    read();
    return onAppearancePrefsChange(read);
  }, []);

  const { scheme } = useResolvedAppearance(prefs);
  // The app's global rules — the resolved scheme's colour-scheme, page background,
  // scrollbars, spinner colour. Called here because this component always renders, and
  // `makeStaticStyles` emits its CSS on first use.
  useGlobalStyles();

  return (
    <FluentProvider
      theme={scaleTheme(themeFor(scheme), BASE_FONT_PX)}
      style={
        {
          // `dvh` (not `vh`) so a mobile browser's address bar showing/hiding doesn't
          // resize the provider under the app; the safe-area padding keeps content out
          // from under a notch or home indicator in both orientations.
          height: '100dvh',
          boxSizing: 'border-box',
          padding:
            'env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)',
          // The desktop's is `fontSizePx / BASE_FONT_PX`; with no setting to read, 1.
          '--app-font-scale': 1,
          ...tokenCssVars(scheme),
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
