/**
 * Renderer entry point. Mirrors `apps/client/src/renderer/src/main.tsx`'s own theme choice
 * (dark, softened body text) so the same board reads the same way in a browser tab as it
 * does in the desktop window — see that file's own comment on why `colorNeutralForeground1`
 * is overridden rather than left at Fluent dark's pure white.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { FluentProvider, webDarkTheme, type Theme } from '@fluentui/react-components';
import { App } from './App';
import './index.css';

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
      <App />
    </FluentProvider>
  </React.StrictMode>,
);
