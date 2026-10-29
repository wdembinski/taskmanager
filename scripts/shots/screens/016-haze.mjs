/**
 * The canvas haze (`--tm-page-wash`, `theme.ts`'s `washGradient`) zoomed in: 480×360 crops of
 * the board's top-left and bottom-right corners, where the two v9-7 hazes sit, in both schemes.
 * Each row's rect `clip` crops the mockup the same way, so the pair compares the glow's reach
 * and falloff like for like — no rings or steps, and as strong as the mockup's blurred circles.
 * See `ui-shots.mjs`'s header doc for the row shape and `scripts/lib/shotModules.mjs` for how
 * this file is merged with its siblings.
 */
const VIEWPORT = { width: 1440, height: 900 };
const CROP = { width: 480, height: 360 };

const CORNERS = {
  tl: { x: 0, y: 0 },
  br: { x: VIEWPORT.width - CROP.width, y: VIEWPORT.height - CROP.height },
};

const hazeRow = (corner, scheme) => ({
  name: `haze-${corner}-${scheme}`,
  app: 'client',
  viewport: VIEWPORT,
  scheme,
  setup: null,
  // The card's one-row header (`boardLayout.ts`'s `header`) — proves the board, not a
  // loading pane, is what was shot.
  expect: '[data-board-header]',
  mockup: scheme === 'light' ? 'v9-7-board-light.svg' : 'v9-7b-board-dark.svg',
  clip: { ...CORNERS[corner], ...CROP },
});

export default [
  hazeRow('tl', 'light'),
  hazeRow('br', 'light'),
  hazeRow('tl', 'dark'),
  hazeRow('br', 'dark'),
];
