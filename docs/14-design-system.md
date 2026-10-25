# 14. The design system

Every screen in the desktop app and the web mirror draws from one token table
([`packages/ui/src/tokens.ts`](../packages/ui/src/tokens.ts)), one glass implementation
([`packages/ui/src/shell/GlassPane.tsx`](../packages/ui/src/shell/GlassPane.tsx)) and one shell.
This page is what to read before adding a screen: which token to reach for, and the values each
one resolves to in light and dark. Colour comes from these tokens, never from a literal —
[`test/theme-tokens.test.ts`](../test/theme-tokens.test.ts) fails on a hex or `rgb()` outside the
theme.

---

## Tokens

Each semantic token is stamped on the provider root as a `--tm-*` CSS custom property
(`tokenCssVars()` in `tokens.ts`), so a `makeStyles` block can read it without importing the
table. The table below is generated from `tokenCssVars('light')` and `tokenCssVars('dark')`;
[`test/design-system-doc.test.ts`](../test/design-system-doc.test.ts) fails when it drifts from
`tokens.ts` and prints the block to paste in. Do not edit it by hand.

<!-- tokens:begin -->

| Variable | Light | Dark |
| --- | --- | --- |
| `--tm-accent-bar` | `#0F6CBD` | `#4FA3E8` |
| `--tm-attention` | `#F2A900` | `#F2A900` |
| `--tm-attention-ink` | `#1b1b1b` | `#1b1b1b` |
| `--tm-attention-tint` | `rgba(242, 169, 0, 0.16)` | `rgba(242, 169, 0, 0.13)` |
| `--tm-brand` | `#0F6CBD` | `#4FA3E8` |
| `--tm-canvas` | `#F7F8FA` | `#202326` |
| `--tm-code-bg` | `#F3F6FA` | `#16202e` |
| `--tm-code-border` | `#D6DEE8` | `#26364a` |
| `--tm-code-inline-bg` | `#EAF0F7` | `#1d2a3a` |
| `--tm-fluo-amber` | `#B7791F` | `#FFC53D` |
| `--tm-fluo-cyan` | `#07748C` | `#22E4FF` |
| `--tm-fluo-cyan-deep` | `#8FD3E0` | `#285258` |
| `--tm-fluo-cyan-dim` | `rgba(7, 116, 140, 0.20)` | `rgba(34, 228, 255, 0.22)` |
| `--tm-fluo-green` | `#1A7F37` | `#2BFF88` |
| `--tm-fluo-red` | `#CF222E` | `#FF4D6A` |
| `--tm-fluo-violet` | `#8250DF` | `#C77DFF` |
| `--tm-label-chip-bg` | `#12836b` | `#12836b` |
| `--tm-label-chip-ink` | `#ffffff` | `#ffffff` |
| `--tm-lane` | `rgba(15, 23, 42, 0.025)` | `rgba(255, 255, 255, 0.025)` |
| `--tm-mono` | `Cascadia Code, JetBrains Mono, Consolas` | `Cascadia Code, JetBrains Mono, Consolas` |
| `--tm-pane-glass` | `rgba(255, 255, 255, 0.86)` | `rgba(26, 28, 32, 0.86)` |
| `--tm-pane-opaque` | `#FFFFFF` | `#1A1C1F` |
| `--tm-pane-rim-rim` | `rgba(17, 24, 39, 0.08)` | `rgba(255, 255, 255, 0.08)` |
| `--tm-pane-rim-sheen-from` | `rgba(255, 255, 255, 0.7)` | `rgba(255, 255, 255, 0.08)` |
| `--tm-pane-rim-sheen-to` | `rgba(255, 255, 255, 0)` | `rgba(255, 255, 255, 0)` |
| `--tm-pane-shadow` | `0 1px 2px rgba(17, 24, 39, 0.05), 0 6px 20px rgba(17, 24, 39, 0.07)` | `0 1px 2px rgba(0, 0, 0, 0.30), 0 6px 20px rgba(0, 0, 0, 0.45)` |
| `--tm-run-dot` | `#0BA5C2` | `#22E4FF` |
| `--tm-run-ink` | `#06606F` | `#22E4FF` |
| `--tm-run-pill` | `#E6FAFE` | `rgba(34, 228, 255, 0.12)` |
| `--tm-sans` | `Segoe UI Variable Text, Segoe UI, Inter, system-ui` | `Segoe UI Variable Text, Segoe UI, Inter, system-ui` |
| `--tm-scrim` | `rgba(17, 19, 23, 0.18)` | `rgba(0, 0, 0, 0.32)` |
| `--tm-selected-tint` | `#EBF3FC` | `#1D2B38` |
| `--tm-status-bar-dot-bad` | `#F85149` | `#F85149` |
| `--tm-status-bar-dot-ok` | `#3FB950` | `#3FB950` |
| `--tm-status-bar-dot-ring` | `rgba(0, 0, 0, 0.45)` | `rgba(0, 0, 0, 0.45)` |
| `--tm-status-bar-dot-run` | `#22E4FF` | `#22E4FF` |
| `--tm-status-bar-ink` | `#1b1b1b` | `#1b1b1b` |
| `--tm-status-bar-quota-critical` | `#F85149` | `#F85149` |
| `--tm-status-bar-quota-ok` | `#FFFFFF` | `#FFFFFF` |
| `--tm-status-bar-quota-track` | `rgba(255, 255, 255, 0.35)` | `rgba(255, 255, 255, 0.35)` |
| `--tm-status-bar-quota-warning` | `#FFC107` | `#FFC107` |
| `--tm-status-gradient` | `linear-gradient(90deg, #0F6CBD, #2A72CA, #5260D3)` | `linear-gradient(90deg, #0F6CBD, #2A72CA, #5260D3)` |
| `--tm-status-gradient-ink` | `#FFFFFF` | `#FFFFFF` |
| `--tm-text` | `#1B1D21` | `#E8EAED` |
| `--tm-text-faint` | `#646B74` | `#8A929B` |
| `--tm-text-muted` | `#454B54` | `#BAC0C7` |
| `--tm-wash-a` | `rgba(212, 228, 245, 0.45)` | `rgba(18, 58, 99, 0.45)` |
| `--tm-wash-b` | `rgba(226, 224, 244, 0.35)` | `rgba(43, 37, 89, 0.4)` |
| `--tm-window-close-active` | `#b3271a` | `#b3271a` |
| `--tm-window-close-hover` | `#c42b1c` | `#c42b1c` |
| `--tm-window-close-ink` | `#ffffff` | `#ffffff` |

<!-- tokens:end -->

### Roles, not hexes

A component asks for a **role** — "text", "faint text", "the selected row's fill" — and never
for a value. In TypeScript that is `SEMANTIC[scheme].textFaint`; inside a `makeStyles` block it
is `var(--tm-text-faint)`, which follows the resolved scheme without the component re-rendering.
Prefer the CSS variable: a value read from `SEMANTIC[scheme]` at render time is frozen until the
next render, so it misses an appearance change that a `var()` picks up for free.

[`packages/ui/src/theme.ts`](../packages/ui/src/theme.ts) builds the two Fluent themes from the
same table: `createLightTheme` / `createDarkTheme` over one brand ramp around `#0F6CBD`, then the
neutral background and foreground tokens are overridden from `SEMANTIC[scheme]` (for example
`colorNeutralBackground1` is `paneOpaque`). A Fluent `Button` and a bare `makeStyles` div never
disagree about what "text" means.

Two colour tables that look alike mean different things:

- **`FLUO_BY_SCHEME`** (`SEMANTIC[scheme].fluo`, `--tm-fluo-*`) is for **state indicators**:
  dots, glyphs, spinners. It says what a card is _doing_: cyan moving, green finished well, red
  failed, amber waiting on a human, violet in review.
- **`ACCENT`** (in `theme.ts`) is for **issue type** and similar identity marks — `bugRed`,
  `storyGreen`. It says what a card _is_, and is drawn at glyph size, where Fluent's weights
  already read.

Never borrow one for the other: a bug's red is not a failure.

### Adding a token

1. Add the field to the `SemanticTokens` interface in `tokens.ts`, with a doc comment that names
   the role, not the colour.
2. Give it a value in **both** `SEMANTIC.light` and `SEMANTIC.dark`.
   `packages/ui/src/tokens.test.ts` fails when the two schemes' key sets differ, and
   `contrast.test.ts` holds text/background pairs to their contrast floor.
3. Run `pnpm test`. `test/design-system-doc.test.ts` goes red and prints the whole expected
   table; paste it between the `tokens:begin` / `tokens:end` markers above.
4. Use it as `var(--tm-…)`. Only the files in `ALLOWED` in
   [`test/theme-tokens.test.ts`](../test/theme-tokens.test.ts) — `tokens.ts`, `theme.ts`,
   `GlassPane.tsx`, the colour swatches and the brand marks — may spell a colour literal out;
   anywhere else a hex or `rgb()` fails that test.

---

## Glass

Glass has **one implementation**:
[`packages/ui/src/shell/GlassPane.tsx`](../packages/ui/src/shell/GlassPane.tsx) — the
`GlassPane` component, or `useGlassStyles().pane` merged onto a container that cannot be swapped
for it. [`test/glass-single-implementation.test.ts`](../test/glass-single-implementation.test.ts)
fails if any other file in the repo declares `backdrop-filter`. One implementation is one place
to get "reduce transparency" right; a pane that repeats its own `@supports` block is how a pane
added later quietly stops honouring it.

A pane is `paneGlass` (near-opaque, 0.86 alpha) under `backdrop-filter: blur(24px)
saturate(1.2)` — the one blur token, `GLASS_BLUR` — with the rim as an inset highlight and
`paneShadow` below. Wherever glass cannot or should not render, it is `paneOpaque` with the same
rim and shadow. The base rule _is_ the opaque one, so an engine that understands none of the
conditions below still draws a plain, readable pane.

The pane falls back to opaque when:

- **The engine has no `backdrop-filter`.** The glass declarations sit inside
  `@supports (backdrop-filter: blur(1px))`; without support the opaque base rule stands.
- **Transparency is reduced.** `resolveAppearance` in
  [`packages/ui/src/appearance.ts`](../packages/ui/src/appearance.ts) returns `glass: 'opaque'`
  for the setting `transparency: 'reduced'`, for `'system'` when the OS reports
  `prefers-reduced-transparency: reduce`, and whenever `backdrop-filter` is unsupported.
  `applyDocumentAppearance` stamps `data-glass="opaque"` on the document root and every pane
  switches at once; no component branches on it, and a mounted pane does not re-render.
- **Forced colours are active** (Windows High Contrast): `@media (forced-colors: active)` drops
  the blur, takes the opaque fill and draws a real `CanvasText` border, because forced-colours
  mode drops the `box-shadow` rim.

**Windows Mica / Acrylic.** On the desktop the OS material can paint _behind_ the window while
the panes keep their own CSS glass on top (`glass: 'native'`).
[`apps/client/src/main/windowMaterial.ts`](../apps/client/src/main/windowMaterial.ts) decides it
before any window exists, and refuses it — `'none'`, back to the CSS path — unless all of these
hold: the platform is Windows at build **22621** or later (Electron's `backgroundMaterial` is a
no-op below it); the process is **not in a Remote Desktop session** (`SESSIONNAME` starting
`RDP-`, where the material is dropped); and transparency is not off — `'reduced'` always
refuses, and `'system'` refuses when the OS "Transparency effects" switch is off, because DWM
does not withhold the material on its own. Windows 10, Linux (WSL included) and the web always
take the CSS path.

**Chrome on glass, content flat.** Glass is for _panes_ — the list, the detail, the peek, board
cards, the mobile tab bar — always at `paneGlass`'s near-opaque level. Never on rows, chips,
code surfaces or text backgrounds; no gradients on cards or borders; no extra chrome layers.
Dialogs stay on the flat `colorNeutralBackground1` surface so a modal reads the same with glass
on or off: [`test/dialog-flat-surface.test.ts`](../test/dialog-flat-surface.test.ts) fails if a
file that imports `DialogSurface` also reaches for `GlassPane`. The wash behind the canvas is
static; a moving background would compete with the run indicators.

---

## Colour budget

Colour is spent on **things that move**. The fluo palette marks state that changes on its own —
running (cyan), done (green), failed (red), waiting on a human (amber), in review (violet) — and
the attention orange marks what wants you now. Everything static is monochrome: issue type,
priority, project, a ticket's column glyph (`STATUS_GLYPH` in `IssueRow.tsx` draws every column
in `textMuted`; the glyph's _shape_ carries the state). Idle states — pending, skipped, to do —
stay neutral grey on purpose: "nothing is happening" is information too, and a fluo dot for it
would make every idle row shout.

Icons are real Fluent icons from `@fluentui/react-icons`, never shapes drawn in CSS. And no
colour is ever a literal outside the allow-list in
[`test/theme-tokens.test.ts`](../test/theme-tokens.test.ts) — see
[Adding a token](#adding-a-token).

---

## Row anatomy

**A board card**
([`packages/ui/src/board/TaskCard.tsx`](../packages/ui/src/board/TaskCard.tsx)) is four stacked
rows, from the v9 board mockups (`mockups/v9-7-board-light.svg`, `v9-7b-board-dark.svg`):

1. **Header** — the faint mono ticket key on the left; on the right an assignee glyph: a
   dashed-ring placeholder when nobody has it, an initials pill for a human, a filled glyph for
   an agent.
2. **Title**, one or two lines.
3. **Status line**, only when something is live: the run row (a cyan dot, "Step n of m", a thin
   progress bar and the elapsed time) while an agent works, or a review verdict worth a line.
4. **Footer** — the epic key with a flag glyph on the left; on the right the MR reference _or_
   the due date (attention orange when today or overdue), never both.

`cardParts` decides which optional pieces a card has; `TaskCard` only draws what it is handed.
The card has no frame — its fill is a step brighter than the lane. Selected is a brighter fill;
"wants you" (unread ticket comments, an agent waiting on an answer) is a 3px orange ring drawn
as a `box-shadow` outside the box — never a border, which would reflow the card's text.

**An issue row**
([`packages/ui/src/issues/IssueRow.tsx`](../packages/ui/src/issues/IssueRow.tsx)) is one line
for every list: the faint mono key, the status glyph, the title, and on the right only the parts
that are present — a cyan run pill, the MR/PR reference, the due date, the assignee avatar.
Type, priority and project get no mark on a row. The **selected row** is `selectedTint` plus a
short `accentBar` on its left edge; there is no bar without the tint. A row that wants attention
is filled with `attentionTint` (as a waiting step is in the steps list), not outlined with a
border.

---

## Shell

```
┌──┬──────────────┬──────────────────────────────────────┬──────────────┐
│A │ Sidebar      │ content: list / board                │ peek (glass) │
│c │ Inbox    3   │                                      │              │
│t │ My issues    │                                      │              │
│i │ ▸ Milestone  │                                      │              │
│v │   ▸ Epic     │                                      │              │
│. │ Archived     │                                      │              │
├──┴──────────────┴──────────────────────────────────────┴──────────────┤
│ status bar — blue→indigo gradient, white ink; solid orange on attention│
└───────────────────────────────────────────────────────────────────────┘
```

- **Activity bar**
  ([`packages/ui/src/shell/NavRail.tsx`](../packages/ui/src/shell/NavRail.tsx)): the icon-only
  strip on the far left, labels as tooltips, its destinations from the one shared `SHELL_NAV`
  (`shellNav.ts`). It sits on the canvas, not on a pane.
- **Sidebar** ([`packages/ui/src/shell/Sidebar.tsx`](../packages/ui/src/shell/Sidebar.tsx)):
  also directly on the canvas, no pane of its own — the fixed rows (Inbox, My issues, Reviews,
  Archived, This machine) around the **milestone › epic › ticket** tree of the selected ticket
  project, built by `sidebarModel.ts`. The tree is a keyboard-driven `role="tree"`.
- **Content**: the screen itself — a list, the board.
- **Status bar**
  ([`packages/ui/src/shell/StatusBar.tsx`](../packages/ui/src/shell/StatusBar.tsx)): the full
  window width, one line high, `statusGradient` with `statusGradientInk` at rest; under
  `attention` it turns solid `--tm-attention` with `--tm-attention-ink`, so a waiting human is
  visible from every screen. The bar is shared; what goes in it is each host's own.

**On phone widths** the web swaps to the compact shell
([`CompactShell.tsx`](../packages/ui/src/shell/CompactShell.tsx)): a one-line status strip on
top, the content, and a glass [`BottomTabBar`](../packages/ui/src/shell/BottomTabBar.tsx) with
always-visible labels at the bottom in place of the activity bar.

**The web mirrors the desktop.** Both hosts render the same `@tm/ui` shell, board and detail
modules; [`test/shell-parity.test.ts`](../test/shell-parity.test.ts) fails if either host grows
a local copy of them.

---

## Peek vs full screen

On the Tickets list, with a row selected:

- **Space** opens the **peek** — the issue's panel as a glass pane on the right, the list still
  interactive beside it. Space again closes it.
- **Enter** opens the **full-screen issue** — the same panel laid out as a page, with a
  `Project › Milestone › Epic` breadcrumb.
- **Escape** steps back one level: full screen → peek → closed → nothing selected.

The transitions live in the pure reducer `issueViewReduce`
([`packages/ui/src/issues/issueView.ts`](../packages/ui/src/issues/issueView.ts), F13.13), so
they are tested without a DOM.

---

## Adding a screen

1. **Tokens only.** Every colour is a `var(--tm-…)` or a Fluent theme token, never a literal —
   see [Colour budget](#colour-budget).
2. **Glass only through `GlassPane`** (or `useGlassStyles().pane`), and only for a pane — see
   [Glass](#glass). Never declare `backdrop-filter` yourself.
3. **Add a screenshot row**: a file `scripts/shots/screens/NNN-<name>.mjs` with one row per
   scheme (`scheme: 'light'` and `scheme: 'dark'`), each naming the `mockup` it should match.
   Rows default to `transparency: 'reduced'`; add a `'full'` row only to prove glass itself.
4. **Run `node scripts/ui-shots.mjs --attach`** and compare the contact sheet with the mockups
   before the card moves to Done. The outbox and verdict format are in
   [13. The UI verification contract](13-ui-verification-contract.md); the routine is
   [CONTRIBUTING.md §6](../CONTRIBUTING.md#6-ui-changes).
