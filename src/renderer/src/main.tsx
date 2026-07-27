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
import React from 'react';
import ReactDOM from 'react-dom/client';
import { FluentProvider, webDarkTheme, type Theme } from '@fluentui/react-components';
import { App } from './App';
import { RootErrorBoundary } from './RootErrorBoundary';
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

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <FluentProvider theme={appTheme} style={{ height: '100vh' }}>
      {/* A render crash used to blank the window with no explanation. Inside the provider
          so the fallback still gets the theme's tokens. */}
      <RootErrorBoundary>
        <App />
      </RootErrorBoundary>
    </FluentProvider>
  </React.StrictMode>,
);
