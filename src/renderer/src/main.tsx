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
import { FluentProvider, Toaster, webDarkTheme, type Theme } from '@fluentui/react-components';
import { App } from './App';
import { RootErrorBoundary } from './RootErrorBoundary';
import { BASE_FONT_PX, TOASTER_ID, scaleTheme } from './theme';
import './index.css';

/**
 * The dark theme with **softer body text**.
 *
 * Fluent's dark theme sets `colorNeutralForeground1` to pure white, which is what a
 * code editor deliberately avoids: at this text density white-on-near-black glares and
 * every word reads as emphasis. The editor grey (#CCCCCC) is the reference the user
 * asked for — headings and semibold text still read as brighter because they gain
 * weight, not luminance. Everything else stays stock Fluent, so contrast ratios for
 * brand/danger/success surfaces are untouched.
 */
const EDITOR_FOREGROUND = '#CCCCCC';
const appTheme: Theme = {
  ...webDarkTheme,
  colorNeutralForeground1: EDITOR_FOREGROUND,
  colorNeutralForeground1Hover: EDITOR_FOREGROUND,
  colorNeutralForeground1Pressed: EDITOR_FOREGROUND,
  colorNeutralForeground1Selected: EDITOR_FOREGROUND,
};

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
      theme={scaleTheme(appTheme, fontSizePx)}
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
        <App />
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
