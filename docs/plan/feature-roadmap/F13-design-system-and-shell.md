# F13 — Design system and shell

> **Status:** proposed · **Where:** `packages/ui` (theme, shell, rows) · client (window, settings) · web · **Depends on:** F12 (the peek panel is F12's one panel) · **Unlocks:** F14's Archived entry, F15's Reviews entry, F23's mobile shell, F25's list layout and keyboard model — every later screen is drawn in these tokens
> Only the `- [ ]` checkboxes under **Tasks** become cards when this file is imported as a plan; everything else is context.
>
> **Layout rule for this file:** every task's description bullets sit after a **blank line**. The plan
> parser folds any indented line that directly follows a checkbox into that task's *title*
> (`apps/client/src/main/planParser.ts:173-177`); the blank line is what keeps descriptions out of it.

## Why

The app is about to grow from a board with an agent engine into a team tracker with a review
workspace, an AI reviewer and a phone app. Today it has one theme (dark), one rail of ten
icons, and colour decided file by file. Every one of the next fourteen files adds screens, and
each would either invent its own look or copy the nearest one.

F13 settles the look once, before those screens exist: a light-first and calm-dark token set,
near-opaque panes with only a hint of frost, and an engineering shell (activity bar, sidebar,
gradient status bar) that every later screen sits inside. The user has approved the v9 mockups
(and the v10 set drawn in the same look for every other tab); this file is how they become code
without changing what the board already means.

The visual direction, as agreed: minimal and light, Scandinavian with Fluent 2 — **v3's calm
with a hint of v4's glass**, and nothing more. A near-white canvas with two barely visible hazes
(blue top-left, lavender bottom-right; a halved navy / indigo glow in dark). Panes are about 86%
opaque white (dark: 86% graphite) with a light frost and a thin top rim, on a soft shadow; the
sidebar sits directly on the canvas. There are no floating toolbar capsules, no glass rail, no
gradients on cards or borders. One brand blue (`#0F6CBD`); thin Fluent icons; Segoe UI Variable
for text and Cascadia Code for keys. Colour stays for things that move.

## What we have today

- **One theme, dark only.** `packages/ui/src/theme.ts` exports `appDarkTheme` (Fluent's
  `webDarkTheme` with `EDITOR_FOREGROUND` `#CCCCCC` for body text) and nothing light. Both hosts
  mount it through `scaleTheme(appDarkTheme, fontSizePx)` (`apps/client/src/renderer/src/main.tsx:84`,
  `apps/web/src/main.tsx`), and `test/shell-parity.test.ts:612` ("the theme both hosts mount")
  asserts exactly that. There is no theme setting in `AppSettings` and no `prefers-color-scheme`
  read anywhere in `apps/` or `packages/ui`.
- **The document is dark at three levels.** `useGlobalStyles` sets `colorScheme: 'dark'` and
  paints `PAGE_BACKGROUND` `#1f1f1f`; the Electron window is created with
  `backgroundColor: '#1f1f1f'` and `frame: false` (`apps/client/src/main/index.ts:107-125`); the
  web manifest's colours are held to `PAGE_BACKGROUND` by `manifest.test.ts`. Scrollbar thumbs
  are white `rgba(255,255,255,…)`.
- **The palette is tuned against `#1f1f1f`.** `FLUO` (`cyan #22E4FF`, `green #2BFF88`, `amber`,
  `violet`, `red`), `STATUS_INDICATOR_COLOR`, `PIPELINE_COLOR`, `GRAPH_INK`, `CODE_BG`
  `#16202e`, `ATTENTION_TINT`, `ACCENT.statusBlue` `#007ACC` and `ACCENT.unread` (=
  `UNREAD_ORANGE` `#F2A900`, `packages/shared/src/accent.ts:11`). Several of them are
  unreadable on a near-white canvas — `#22E4FF` on white is about 1.5:1.
- **Hard-coded colour literals outside `theme.ts`.** About two dozen quoted hex / `rgba()`
  literals across `ColorSwatches.tsx` (user-picked label colours — legitimate),
  `board/TaskCard.tsx` (6), `apps/client/src/renderer/src/TitleBar.tsx` (4), `UsageQuotaBars.tsx`
  (3), `shell/StatusBar.tsx` (2), and one each in `TaskAgentPanel`, `SyncCurtain`,
  `PersonAvatar`, `JiraMark` (a brand mark — legitimate), `AgentGlyph`, and
  `apps/web/src/board/BoardScreen.tsx`. There is no ESLint in the repo; the only structural
  guards are root vitest files (`test/shell-parity.test.ts`, `test/repo-invariants.test.ts`).
- **The shell** is `packages/ui/src/shell/`:
  - `AppShell.tsx` — slots `titleBar` (desktop only), `nav`, `banners`, `children`, `status`;
    background `colorNeutralBackground2`.
  - `NavRail.tsx` — a 44px icon-only vertical `TabList` on `colorNeutralBackground1`, with
    tooltips, an `unavailable` dimmed state, and an optional Account menu.
  - `StatusBar.tsx` — full-width, `ACCENT.statusBlue` fill with white 12px semibold text,
    `footerAttention` swaps to the orange with `#1b1b1b` ink (the comment records why: white on
    that orange is about 2.2:1). `StatusDot` carries a dark ring so it reads on both fills.
  - `CompactShell.tsx` (`strip` / `children` / `tabBar`) and `BottomTabBar.tsx` (a horizontal
    `TabList`, labels always visible, 44px touch floor) — F3's phone shell.
- **Navigation is two hand-kept lists.** `NAV` in `apps/client/src/renderer/src/App.tsx:130-141`
  (My Tasks, Projects, Tickets, Issues, Automations, Performance, Activity, Attention, Settings,
  Scratch run) and `NAV` in `apps/web/src/App.tsx:133-145` (the same plus Fleet, Scratch run
  marked `unavailable`). Badges (attention count, unread activity) are built per render.
- **No sidebar, no tree, no row component.** Tickets are browsed in `projects/Projects.tsx`
  (Backlog / Timeline / Graph switch) and the board in `board/KanbanColumn.tsx` +
  `board/TaskCard.tsx`. The milestone › epic › ticket shape exists only as data
  (`milestones` table, `Task.epicTaskId`, `Task.milestoneId`; `docs/12-the-ticket-model.md`).
- **The design rules already argued for** — memory *board-colour-budget*: colour only for what
  moves; the ordinary value of a static fact draws nothing; real Fluent icons, never CSS shapes.
  Memory *mock-the-real-components*: copy `TaskCard`, `AgentGlyph` and the theme's exact values
  and icon paths; a mock that changes them reads as a proposal to change them.
- **No DOM test harness** (no jsdom, no testing-library); UI logic is proven as pure functions,
  and visual parity as source structure (`shell-parity.test.ts` header).
- **No `backdrop-filter`, no translucency** anywhere, and no use of Electron's
  `backgroundMaterial` (the app is on Electron `^33.2.0`, `apps/client/package.json:49`).

The approved mockups (latest version in [`mockups/`](mockups/)):

- [v9 issues list — light](mockups/v9-1-issues-list-light.svg) ·
  [v9 issues list — dark](mockups/v9-3-issues-list-dark.svg)
- [v9 issue detail — light](mockups/v9-2-issue-detail-light.svg)
- [v9 mobile — light](mockups/v9-4-mobile-light.svg) · [v9 mobile — dark](mockups/v9-5-mobile-dark.svg)
- [v9 review workspace — light](mockups/v9-6-review-workspace-light.svg) ·
  [v9 review workspace — dark](mockups/v9-6b-review-workspace-dark.svg)
- [v9 kanban board — light](mockups/v9-7-board-light.svg) · [v9 kanban board — dark](mockups/v9-7b-board-dark.svg)

## Design

### Data model & contracts

No database change. Two new **local** settings (machine-specific, so *not* in
`GLOBAL_SETTINGS_KEYS` — memory *settings-mirror-global-vs-local*: replaying them to another
desktop would clobber that machine's choice, exactly as `fontSizePx` would):

- `appearance: 'system' | 'light' | 'dark'` — default `'system'`.
- `transparency: 'system' | 'reduced' | 'full'` — default `'system'`.

And one pure resolver, `resolveAppearance(settings, env)` in `packages/ui/src/appearance.ts`,
where `env` carries `prefersDark`, `prefersReducedTransparency`, `backdropFilterSupported` and,
on the desktop, `nativeMaterial: 'mica' | 'acrylic' | null`. It returns
`{ scheme: 'light' | 'dark', glass: 'native' | 'css' | 'opaque' }`. Everything that paints reads
that result; nothing reads the media queries directly.

### Tokens

`packages/ui/src/tokens.ts` holds **semantic** tokens, one object per scheme with identical
keys (a test asserts the key sets match). Components ask for a role, never a hex. The values
below are taken from the v9 mockups and checked for contrast in F13.2.

| Role | Light | Dark | Notes |
|---|---|---|---|
| `canvas` | `#F7F8FA` | `#202326` | the window behind everything |
| `wash` | two hazes `#D4E4F5` (0.45), `#E2E0F4` (0.35) under a 90px blur | `#123A63` (0.45), `#2B2559` (0.4) | static, never animated; barely visible by design |
| `paneGlass` | `rgba(255,255,255,0.86)` | `rgba(26,28,32,0.86)` | every pane; `backdrop-filter: blur(24px)` — near-opaque, a hint of frost only |
| `paneOpaque` | `#FFFFFF` | `#1A1C1F` | the same pane when glass is off |
| `paneRim` | 1px light rim; top sheen white 0.7 → 0 | 1px faint rim; sheen white 0.08 → 0 | an inset highlight, not a border |
| `paneShadow` | `0 1px 2px rgba(17,24,39,.05)`, `0 6px 20px rgba(17,24,39,.07)` | same offsets, `rgba(0,0,0,.30/.45)` | from the mockups' `feDropShadow`s |
| `text` / `textMuted` / `textFaint` | `#1B1D21` / `#454B54` / `#646B74` | `#E8EAED` / `#BAC0C7` / `#8A929B` | faint is for keys and meta |
| `brand` | `#0F6CBD` | `#4FA3E8` | the one brand blue; dark uses its lighter step |
| `selectedTint` | `#EBF3FC` | `#1D2B38` | the selected row's fill |
| `accentBar` | `#0F6CBD` | `#4FA3E8` | the selected row's short left bar |
| `statusGradient` | `#0F6CBD → #2A72CA → #5260D3` | same | the status bar, left to right |
| `statusGradientInk` | `#FFFFFF` | same | text/glyph colour on `statusGradient` |
| `attention` | orange (see open question 1) | same | the status bar under attention, "today" |
| `run` | `#07748C` on a `#E6FAFE` pill | `FLUO.cyan` `#22E4FF` on `rgba(34,228,255,.12)` | a running agent; light needs the deeper cyan |
| `mono` | Cascadia Code, JetBrains Mono, Consolas | same | keys, branches, versions |
| `sans` | Segoe UI Variable Text, Segoe UI, Inter, system-ui | same | Display cut for titles |

Mapped onto Fluent: `appLightTheme` / `appDarkTheme` are built with Fluent v9's
`createLightTheme` / `createDarkTheme` from a brand ramp around `#0F6CBD`, then the neutral
background and foreground tokens are overridden from the table. Fluent components keep working
unchanged; our own `makeStyles` read `tokens.ts` through CSS custom properties stamped on the
provider root (the same mechanism `--app-font-scale` already uses).

`FLUO`, `STATUS_INDICATOR_COLOR`, `PIPELINE_COLOR`, `GRAPH_INK`, `CODE_*`, `ATTENTION_TINT` and
the scrollbar thumbs each gain a light value. Their *meanings* do not change — cyan is still
"moving", amber still "wants a human". `STATUS_COLOR` / `priorityColor` / `statusNoteColor` stay
where they are, as `theme.ts`'s header already rules.

### Glass

- **CSS glass is the default path.** A pane is `background: paneGlass; backdrop-filter:
  blur(24px) saturate(1.2)`, the rim as an inset box-shadow plus a 1px top highlight, and
  `paneShadow`. Wrapped in `@supports (backdrop-filter: blur(1px))`; without support, or when
  `resolveAppearance` says `glass: 'opaque'`, the pane is `paneOpaque` with the same shadow.
- **Reduce transparency.** The `transparency` setting, the
  `prefers-reduced-transparency: reduce` media query where the engine supports it, and (on
  Windows) the OS "Transparency effects" switch read through Electron's `nativeTheme` (if it
  exposes it — see open question 3) all resolve to `opaque`. `data-glass="opaque"` on the root
  switches every pane at once; no component branches on it.
- **Restraint rules.** Glass means *panes* only (list, detail, peek, board cards, dialogs, the
  mobile tab bar), always at `paneGlass`'s near-opaque level, so it reads as a hint, not an
  effect. Never on rows, chips or text backgrounds; no gradients on cards or borders; no extra
  chrome layers (no toolbar capsules, no glass rail). Code surfaces are fully opaque. Blur
  radius is one token. The wash is static: a
  moving background would compete with the run indicators, which is the one thing the colour
  budget protects.
- **Native material on Windows.** Electron's `BrowserWindow` option `backgroundMaterial`
  (`'mica' | 'acrylic' | 'tabbed' | 'auto' | 'none'`, Windows 11 22H2 and later) can put the OS
  material behind the window instead of our CSS wash. It needs a transparent page background,
  which collides with today's anti-flash `backgroundColor: '#1f1f1f'` and `PAGE_BACKGROUND`; and
  its behaviour with `frame: false` must be proven, not assumed. So it is a **spike first**
  (F13.6), behind the resolver: `glass: 'native'` paints the canvas transparent and keeps the
  panes' own CSS glass on top. Windows 10, Linux (the user also runs the app under WSL)
  and the web all take the CSS path.

### The shell

The frame keeps `AppShell`'s slots and gains one: `sidebar`.

```
┌──┬───────────────┬───────────────────────────────────────────────┐
│A │ Workspace ▾    │                                               │
│c │ Inbox      3   │   list / board / timeline (flat surface)      │   peek (F12,
│t │ My issues      │                                               │   flat surface)
│i │ Reviews        │                                               │
│v │ ── Team ──     │                                               │
│i │ ▸ M2 · Review  │                                               │
│t │   ▸ F6 …       │                                               │
│y │ Archived   3   │                                               │
│  │ This machine   │                                               │
│  │ New issue  C   │                                               │
├──┴───────────────┴───────────────────────────────────────────────┤
│ status bar — blue→indigo gradient, white text; solid orange on attention │
└──────────────────────────────────────────────────────────────────┘
```

- **Activity bar** (far left, `NavRail` restyled): a few icons only — Issues, Board, Reviews,
  Activity, Automations, with Settings and Account at the foot. The other destinations move
  into the sidebar or into Settings (open question 2 has the mapping). The two hosts' `NAV`
  lists become **one** `SHELL_NAV` in `packages/ui/src/shell/shellNav.ts`, each host passing
  only its `unavailable` reasons; `shell-parity.test.ts` asserts both import it.
- **Sidebar** (on the canvas, no pane, no border): a workspace switcher (only "This machine"
  until F19 brings cloud workspaces); Inbox (today's Attention), My issues, Reviews (F15; hidden
  until it ships, rather than a dead link); under the team name, **one row of view icons** —
  Board, Milestones, Timeline, Cycles, Projects, Triage (each a screen in the v10 mockups;
  Cycles / Projects / Triage appear once F24 / F26 ship); the team tree **milestones › epics › tickets** for
  the selected ticket project; a one-line **Archived** (F14); **This machine** (local
  workspaces); and **New issue (C)** pinned at the bottom. Folds are remembered per device,
  like the board's step folds.
- **Status bar**: `statusGradient` with white text at rest; solid `attention` with dark ink
  when anything waits on a human — the existing behaviour, re-skinned. The left/right split
  (`StatusSpacer`) and each host's own contents stay as they are.
- **Rows.** One `IssueRow` for every list in the app: faint mono key, status glyph, title, and
  only when present: a cyan run pill (step n of m), the MR (`!190`), the due date (orange when
  today or overdue), the assignee avatar. Nothing else — type, priority and project are static
  facts and get no mark on a row (memory *board-colour-budget*). Selected = `selectedTint` +
  a 3px `accentBar` on the left, 60% of the row's height.
- **Peek and full screen.** Space on a selected row opens F12's panel as a **peek** (a glass
  pane on the right, the list stays interactive); Enter opens the **full-screen issue** (the
  same `TaskDetailHost` laid out as a page with a breadcrumb `Project › Milestone › Epic`);
  Esc steps back one level. F13 provides the two layouts; F12 provides the panel; F25 adds the
  wider keyboard model.
- **Board.** The kanban board keeps its card anatomy exactly (`TaskCard`, `AgentGlyph`, step
  dots, MR rows, verdict glyphs — memory *mock-the-real-components*); columns stay faint lanes
  on the canvas, and the card re-reads its colours from tokens. The sidebar folds away (its
  header button, or `[`) so the columns get the full width.
- **Chain links on the board** (`ChainOverlay`, `chainArrows.ts`). Today's arrows are curves
  between facing card edges, drawn over the board, so a long link crosses cards. They become
  **routed connectors that never cross a card**:
  - a link leaves its card's side into the **gutter** beside that column, runs vertically in the
    gutter, crosses columns only along a **bus channel** under the column headers, and enters
    the target from its own gutter; columns widen their gap (12 → 30px) while links show;
  - every gutter and the bus hand out **lanes** (7px apart), so two links never share a line;
    corners are 5px rounded; a small port dot marks where a link leaves a card;
  - the three states keep their meaning: cyan solid = releasing now (it moves, so it has colour),
    grey dashed = waits for merge, faint solid = already satisfied;
  - a **Links toggle** in the board header — **Off · Focus · All**, `L` cycles it, remembered per
    device: *All* draws every link; *Focus* draws only the selected card's links and dims the
    cards they don't touch; *Off* draws none, and each card shows quiet `needs TM-71` /
    `unblocks TM-72` chips instead, so a dependency is never invisible;
  - mockups: `mockups/v10-7c-board-links-all-light.svg`, `mockups/v10-7d-board-links-focus-dark.svg`,
    `mockups/v10-7e-board-links-off-light.svg`.

### UI — desktop

- `main.tsx` picks the theme through `resolveAppearance`, listening to
  `matchMedia('(prefers-color-scheme: dark)')` and the setting.
- The window's `backgroundColor` follows the resolved scheme at creation (read from settings in
  main before `createWindow`) so restore still never flashes, and `TitleBar.tsx`'s window
  controls move onto tokens.
- Settings → Appearance: Theme (System / Light / Dark), Transparency (System / Reduced / Full),
  beside the existing font size.

### UI — web

- The same theme, shell, sidebar and rows from `@tm/ui` (memory *web-mirrors-the-desktop*).
  The manifest's `background_color` / `theme_color` follow the light canvas, and
  `manifest.test.ts` holds them to the token.
- Compact mode (`CompactShell`) keeps flat cards, gets a glass `BottomTabBar` with a 2px
  `statusGradient` hairline on its top edge, and the strip on tokens. F23 builds on it.

### Failure modes & edge cases

- **No `backdrop-filter`** (older engines, some Linux GPU paths): `@supports` falls back to the
  opaque pane. Nothing about layout depends on transparency.
- **Glass on a slow GPU.** Blur is expensive over large animated areas. Only panes blur, the
  wash is static, and nothing inside a scrolling list carries a filter. Reduced transparency is
  one setting away.
- **Native material unavailable** (Windows 10, a remote desktop session, a GPU fallback):
  Electron silently ignores it; the resolver must not assume it took effect. The spike records
  how to detect it; if it cannot be detected, the canvas stays opaque and only CSS glass is used.
- **Contrast in both themes.** Every text/background pair is checked by F13.2, including white
  on both ends of the gradient, ink on the orange, the run pill, faint keys, and text on a glass
  pane over the *brightest* part of the wash (the opaque fallback is the floor, glass is checked
  against its worst-case composite).
- **A colour that means something** (cyan run, orange attention, green/red pipeline) must keep
  its meaning in light mode at a different value; the step dots and pipeline dots therefore get
  light values from the same table, never Fluent palette defaults.
- **`prefers-reduced-motion`** already stills the status bar's busy ring; the new peek slide-in
  and sidebar folds honour it too.
- **High contrast / forced colours** (Windows): glass, wash and gradient are dropped under
  `forced-colors: active`; panes take system colours and the selected bar becomes a system
  highlight.

## Out of scope (v1)

- User-defined themes or accent colours beyond the one brand blue.
- macOS `vibrancy` (no macOS build is shipped today).
- Animating the wash or the gradient.
- New screens. F13 re-skins and restructures the frame; the screens that fill it (Reviews,
  Inbox, Insights, cloud workspaces) belong to their own files.
- A DOM or screenshot test harness. Parity stays structural; visual review is a human check
  against the mockups.

## Open questions

1. **Which orange?** The mockups use `#F28C28`; the app's `UNREAD_ORANGE` is `#F2A900`
   (`packages/shared/src/accent.ts:11`), shared with the main process. *Recommended default:*
   keep `#F2A900` for the attention fill and "today" (one orange app-wide, already tested for ink
   contrast), and update the mockups; change it only if the user prefers the mockups' hue, in
   which case `UNREAD_ORANGE` changes once and everything follows.
2. **Where do today's ten destinations go?** *Recommended default:* activity bar = Issues (the
   Tickets screen, reborn as the list), Board (My Tasks), Reviews (F15), Activity (with
   Performance as its second tab), Automations; foot = Settings, Account. Attention becomes the
   sidebar's Inbox. Projects (repo admin) moves into Settings → Projects. The external Issues
   browser (F5) becomes a sidebar entry under "This machine", Scratch run a palette command, and
   the web's Fleet a sidebar entry. Confirm before F13.8.

   **Confirmed 2026-10-17.** The recommended default stands, with one addition F13.8 needed
   that this question did not spell out: the sidebar those moves land in does not exist yet
   (F13.11 builds it), so `SHELL_NAV` (`packages/ui/src/shell/shellNav.ts`) carries a third,
   temporary `interim` group between the permanent `bar` group (Issues/`tickets`, Board/
   `mytasks`, Activity, Automations — Reviews joins once F15 ships) and the `foot` group
   (Settings) — Attention, Projects, the external Issues browser (`issues`), Fleet and Scratch
   run, every one of them reachable from the rail exactly as it is today, just grouped apart
   with a hairline divider, until F13.11 has somewhere else to put them. Performance is the one
   exception: this question folds it into Activity as a second tab, but that is a screen-level
   merge with no card of its own yet (not F13.11's sidebar, which has no second-tab concept),
   so it keeps a permanent `bar` slot next to Activity rather than riding along with
   `interim`'s sidebar-bound entries — revisit when that merge gets a card. **F13.11 deletes
   the `interim` group** as each of its entries moves into the sidebar it renders (Scratch run
   becomes a palette command instead, with no rail tile at all).
3. **Can the OS "Transparency effects" switch be read?** Electron exposes
   `nativeTheme.prefersReducedTransparency` on macOS; on Windows it is not documented.
   *Recommended default:* read it where Electron offers it, otherwise rely on the app setting and
   the CSS media query; the spike (F13.6) records what Windows reports.

   **Findings (F13.6, 2026-10-16):** Probed on Electron 33.4.11 / Chromium 130.0.6723.191 / Node
   20.18.3, Windows build 10.0.26200, an interactive console session (not RDP). With `frame:
   false` and `backgroundColor: '#00000000'`, both `backgroundMaterial: 'mica'` and `'acrylic'`
   painted a visibly distinct flat backdrop over the probe's green test background (sampled
   32,32,32 for mica, 84,84,84 for acrylic — mica reads darker and flatter, acrylic lighter and
   more blurred), and `transparent: true` produced the identical mica result as an alternative to
   a transparent `backgroundColor`. Across five sampled offsets after a minimize/restore cycle
   (0, 50, 100, 200, 400 ms), mica, acrylic and the `transparent: true` variant never once showed
   a white or sentinel flash — the material held from the first captured frame. A control window
   (`backgroundMaterial: 'none'`, opaque magenta `backgroundColor`) showed **white** at every one
   of those same offsets instead of reverting to magenta — proof the harness can detect a flash
   when one exists, so the clean mica/acrylic results are not a methodology blind spot. Separately,
   a `backgroundMaterial: 'mica'` window given a non-transparent `backgroundColor` never showed
   the material at all (steady state read pure magenta): **`backgroundColor` must be transparent
   (or `transparent: true`) for the material to paint.** Calling `win.setBackgroundMaterial()`
   *after* the window was already created and shown with `backgroundMaterial: 'none'` did **not**
   apply mica or acrylic (samples stayed black) — `backgroundMaterial` must be a `BrowserWindow`
   constructor option decided before the window is created, and there is no getter to read it back
   (`getBackgroundMaterial` does not exist on this Electron). `nativeTheme.prefersReducedTransparency`
   read `true` in every config and matched the machine's registry state exactly
   (`HKCU\...\Personalize\EnableTransparency = 0x0`, i.e. the OS "Transparency effects" switch was
   off) — the signal is real and trustworthy on Windows despite being undocumented, which answers
   this question. Critically, **DWM did not withhold Mica or Acrylic because that switch was
   off** — both still rendered with `prefersReducedTransparency: true` — so the app, not the OS,
   must refuse native material when the user has reduced transparency. Windows 10 and a Remote
   Desktop session were not reachable from this machine to probe directly; Electron documents
   `backgroundMaterial` as a no-op below build 22621 and as dropped over RDP, so the detection
   rule below treats both defensively rather than from direct observation. (Screen capture in
   this disconnected-automation session twice read the wrong content before `win.setAlwaysOnTop(true,
   'screen-saver')` plus `moveTop()` on every probe window fixed z-ordering; this run's samples
   are self-consistent per config — the sentinel reads as sentinel, mica and acrylic read as
   distinct flat grays — which is the evidence the fix held.)

   **Decision:** Ship `native`. All three conditions hold: (a) mica showed with `frame: false`;
   (b) restore never flashed once the background was transparent; (c) the detection rule needs
   only signals available before the window is created. F13.7's
   `windowMaterialFor(platform, osBuild, settings)` needs two extra inputs beyond that signature —
   `remoteSession: boolean` (`/^RDP-/i.test(process.env.SESSIONNAME ?? '')`) and
   `reducedTransparency: boolean` (`nativeTheme.prefersReducedTransparency`, readable with no
   window yet created) — because this spike showed the OS will not refuse the material on the
   app's behalf. Rule: return `'none'` unless `platform === 'win32'` **and** `osBuild >= 22621`
   **and** `!remoteSession` **and** `!reducedTransparency`; only then does the user's own
   transparency/material setting choose `'mica' | 'acrylic' | 'none'`. F13.7 must also pass
   `backgroundColor: '#00000000'` (or `transparent: true`) alongside `backgroundMaterial` in the
   `BrowserWindow` constructor, never via `setBackgroundMaterial()` after creation, which this
   spike showed does not apply the material.
4. **Light first for existing users?** Every user has only ever seen dark. *Recommended
   default:* `appearance: 'system'` for new installs; an existing install keeps `'dark'` (the
   migration writes it when the setting is absent and a settings row already exists), so nobody
   wakes up to a white window they did not choose.
5. **Fonts.** Segoe UI Variable and Cascadia Code ship with Windows 11 but not with Linux or
   every browser. *Recommended default:* do not bundle fonts; the stacks fall back to Segoe UI /
   Inter / system-ui and JetBrains Mono / Consolas. Bundle only if the fallback visibly breaks
   the row layout.

## Tasks

### F13 · Phase 1 — Tokens and appearance

- [x] F13.1 Define the semantic light and dark token sets and the two Fluent themes

  - New `packages/ui/src/tokens.ts` with the table above (`canvas`, `wash`, `paneGlass`,
    `paneOpaque`, `paneRim`, `paneShadow`, text steps, `brand`, `selectedTint`, `accentBar`,
    `statusGradient`, `attention`, `run`, `mono`, `sans`), and light values for `FLUO`,
    `STATUS_INDICATOR_COLOR`, `PIPELINE_COLOR`, `GRAPH_INK`, `CODE_*`, `ATTENTION_TINT`.
    `theme.ts` exports `appLightTheme` and a rebuilt `appDarkTheme` (Fluent `createLightTheme` /
    `createDarkTheme` from a `#0F6CBD` ramp, neutrals overridden), and stamps the tokens as CSS
    custom properties beside `--app-font-scale`.
  - Acceptance: `tokens.test.ts` — both schemes have identical key sets; every
    `STATUS_INDICATOR_COLOR` / `PIPELINE_COLOR` key resolves in both; `appDarkTheme` still sets
    the editor-grey body text. `pnpm typecheck`, `pnpm test`, `pnpm build` green.

- [x] F13.2 Add a pure contrast checker and assert every token pair in both themes @needs: F13.1 Define the semantic light and dark token sets and the two Fluent themes

  - `packages/ui/src/contrast.ts`: WCAG relative luminance, `contrastRatio(fg, bg)`, and alpha
    compositing for glass (`composite(rgba, over)`). `contrast.test.ts` lists every pair the
    shell draws: body / muted / faint text on canvas, opaque pane and worst-case glass; white on
    each `statusGradient` stop; ink on `attention`; `run` text on its pill; `brand` text;
    `selectedTint` against the pane; the step and pipeline dots against the card (3:1 for
    non-text).
  - Acceptance: AA (4.5:1 text, 3:1 large text and glyphs) holds for every pair in both
    themes; the test fails when one value is mutated (proven by mutation once, per memory
    *a-cached-gate-is-not-a-gate*, and gates run with `--force`).

- [x] F13.3 Add the appearance and transparency settings with a pure resolver

  - `AppSettings.appearance` and `AppSettings.transparency`, both LOCAL (listed in
    `settings.test.ts`'s local keys, not `GLOBAL_SETTINGS_KEYS`); the existing-install default
    from open question 4. `packages/ui/src/appearance.ts`: `resolveAppearance(settings, env)` →
    `{ scheme, glass }`.
  - Acceptance: resolver tests — system follows `prefersDark`; reduced transparency (setting or
    media query) always gives `opaque`; no `backdrop-filter` gives `opaque`; `native` only when
    the desktop reports a material; a settings test that the new keys never reach the cloud
    replay. Gates green.

- [x] F13.4 Mount the resolved theme in both hosts and make the document follow it @needs: F13.1 Define the semantic light and dark token sets and the two Fluent themes, F13.3 Add the appearance and transparency settings with a pure resolver

  - Both `main.tsx` files mount `scaleTheme(themeFor(scheme), fontSizePx)`; `useGlobalStyles`
    sets `colorScheme`, the page background, the static wash and the scrollbar thumbs per
    scheme; `data-glass` on the root. The Electron window's `backgroundColor` is chosen from the
    saved appearance before `createWindow`. The web manifest moves to the light canvas.
    Settings → Appearance offers both settings.
  - Acceptance: `shell-parity.test.ts`'s theme block updated to assert both hosts mount through
    the resolver, and red when one host mounts a fixed theme; `manifest.test.ts` follows the
    token; gates green; a headless check (memory *verify-electron-app*, never launch the user's
    app) that the bundle boots in both schemes.

### F13 · Phase 2 — Glass

- [x] F13.5 Build the glass pane primitive with the opaque fallback @needs: F13.4 Mount the resolved theme in both hosts and make the document follow it

  - `packages/ui/src/shell/GlassPane.tsx` (and a `useGlassStyles` for existing containers):
    `paneGlass` + `backdrop-filter` inside `@supports`, the rim and top sheen, `paneShadow`;
    `[data-glass="opaque"]` and `forced-colors: active` switch to `paneOpaque`. No component
    branches on the mode itself.
  - Acceptance: a source-structure test that `backdrop-filter` appears only in `GlassPane` /
    `useGlassStyles` (glass stays one implementation); contrast pairs from F13.2 include the
    pane in both modes. Gates green.

- [x] F13.6 Spike Electron's native background material on Windows with a frameless window

  - Throwaway probe, never merged: a packaged build with `backgroundMaterial: 'mica'` and
    `'acrylic'`, `frame: false`, a transparent page background; record whether the material
    shows, whether the anti-flash on restore survives, what `nativeTheme` reports for the OS
    transparency switch, and how to tell that the material did not apply (Windows 10, remote
    desktop). Do NOT launch the app on the user's machine — hand the probe build to the human or
    use a throwaway profile, as F9.7 did.
  - Acceptance: a findings note appended to this file's open questions, and a decision:
    ship `native` (with its detection rule) or keep CSS glass only on Windows. No product code
    merged.

- [x] F13.7 Use the native material on Windows when the spike says it is safe @needs: F13.5 Build the glass pane primitive with the opaque fallback, F13.6 Spike Electron's native background material on Windows with a frameless window

  - In `apps/client/src/main/index.ts`, set `backgroundMaterial` from the saved settings and the
    spike's detection rule; report `nativeMaterial` to the renderer through the existing
    settings/bootstrap path; the resolver paints the canvas transparent only when `native`. If
    the spike said no, this card records that and closes with no code.
  - Acceptance: a pure `windowMaterialFor(platform, osBuild, settings)` with tests (Windows 11
    22H2+ only, reduced transparency gives `none`, Linux/WSL gives `none`); gates green; the
    human confirms the look on their machine.
  - **Decisions taken, carried over from the spike's findings:** only `'mica'` ships, not a
    user choice between the two materials — the spike sampled both but found no reason to
    expose `'acrylic'` as an option the settings UI would need to explain, so
    `windowMaterialFor` returns `'mica'` unconditionally wherever it would otherwise grant a
    material; `'acrylic'` stays a valid `NativeMaterial`/`WindowMaterial` value (the resolver
    and `readAppearanceEnv`/`useResolvedAppearance` already treat it exactly like `'mica'`) in
    case that changes later, but nothing in this app currently produces it. Second,
    `transparency: 'full'` overrides the OS "Transparency effects" switch for the *native*
    material exactly as it already does for CSS glass (`resolveAppearance`) — the spike proved
    DWM does not withhold Mica on the OS switch's say alone, so without this override `'full'`
    would mean nothing different from `'system'` on Windows, the same reasoning that already
    justified the override for `backdropFilterSupported`.

### F13 · Phase 3 — Shell

- [x] F13.8 Replace the two NAV lists with one shared shell navigation and the slim activity bar @needs: F13.4 Mount the resolved theme in both hosts and make the document follow it

  - `packages/ui/src/shell/shellNav.ts` exports `SHELL_NAV` per open question 2; both
    `App.tsx` files pass only their `unavailable` reasons and badges. `NavRail` is restyled onto
    tokens (thin Regular icons, `brand` selected indicator) and keeps tooltips, the
    `aria-disabled` refusal and the Account menu.
  - Acceptance: `shell-parity.test.ts` — both hosts import `SHELL_NAV`, neither declares its
    own list; the existing "both NAVs carry an automations / activity / issues tab" assertions
    move onto `SHELL_NAV`. Gates green.

- [x] F13.9 Restyle the status bar as the gradient bar with the orange attention fill @needs: F13.2 Add a pure contrast checker and assert every token pair in both themes

  - `StatusBar.tsx` reads `statusGradient` and `attention` from tokens; white text on the
    gradient, dark ink on orange; `StatusDot` keeps its ring; the busy ring keeps
    `currentColor`. Each host's contents are untouched.
  - Acceptance: F13.2's pairs cover white on every gradient stop and ink on orange; no hex
    literal left in `StatusBar.tsx`; gates green.

- [x] F13.10 Write the pure sidebar model with the milestone, epic and ticket tree

  - `packages/ui/src/shell/sidebarModel.ts` exports `NO_MILESTONE_GROUP = 'No milestone'`,
    a sibling of `backlogView.ts`'s `NO_EPIC_GROUP` (`packages/ui/src/projects/backlogView.ts:13`)
    rather than a restated string, and `buildSidebar(input: SidebarInput): SidebarSection[]`.
  - `SidebarInput`: `workspaces: readonly { id: string; name: string }[]` (only "This machine"
    until F19), `activeWorkspaceId?: string | null` (default: first), `projects: readonly
    Pick<Project, 'id' | 'name'>[]` (`Project` at `packages/shared/src/model.ts:201`) for the
    "This machine" entries, `teamName?: string` (the selected ticket project's name),
    `milestones: readonly Milestone[]` (`model.ts:1320`) and `tickets: readonly Task[]`
    (`model.ts:692`, epics included — `isEpic`, `packages/shared/src/tickets.ts:49`, tests
    `issueType === 'epic'`) of the selected ticket project, `attentionCount: number`,
    `archivedCount: number`, `folds: readonly string[]` (folded tree-node ids),
    `reviewsEnabled?: boolean` (F15; default `false` → no Reviews row), and
    `isMilestoneArchived?: (m: Milestone) => boolean` (F14's predicate; default hides nothing).
  - `SidebarSection` is a discriminated union on `kind`, always returned in this order:
    `workspace` (the list plus the active id) → `views` (Inbox with `count: attentionCount`,
    My issues, and Reviews only when `reviewsEnabled`) → `team` (`name`, `tree:
    SidebarTreeNode[]`) → `archived` (`count: archivedCount`) → `machine` (one item per
    project) → `newIssue` (`shortcut: 'C'`).
  - `SidebarTreeNode`: `{ id, kind: 'milestone' | 'epic' | 'ticket', label, ticketKey?,
    taskId?, milestoneId?, closed?, count, folded, children }`. Ids are stable and unique:
    `milestone:<id>` / `milestone:none`, `epic:<milestoneId|none>:<epicId|none>` (an epic can
    appear under two milestones, so its id is qualified by the milestone it is grouped
    under), `ticket:<taskId>`. `folded = folds.has(id)`; children are returned regardless of
    `folded` — the renderer (F13.11) decides what a fold hides, so a folded node's `count`
    stays correct without the model needing to know anything about rendering. `count` is the
    number of non-epic tickets under the node: a milestone node counts all tickets placed in
    it (every leaf under every one of its epic groups, plus its own "No epic" bucket); an
    epic node counts its direct children.
  - Placement rule: a ticket's own `milestoneId` (`Task.milestoneId`, `model.ts:1206`) decides
    its milestone; its `epicTaskId` (`model.ts:1204`) decides the epic group inside that
    milestone — independently of what milestone the epic ticket itself is planned for. So a
    ticket in M2 whose epic is planned for M1 shows under M2 › that epic, and the epic also
    heads its own (possibly empty) group under M1, the same "a header never vanishes" rule
    `groupTickets` already keeps (`backlogView.ts:76-123`). A `milestoneId` naming a milestone
    not in `milestones` lands in the `No milestone` bucket, the same rule `groupTickets` uses
    for a missing epic. An `epicTaskId` naming a ticket that is not an epic in `tickets`, or
    not in `tickets` at all, lands in that milestone's `No epic` bucket instead of being
    dropped.
  - Milestone order: open (`closed: false`) milestones first, by `dueAt` ascending with
    undated (`dueAt: null`) ones last — the same convention `sortBacklog`'s `'due'` key uses
    (`backlogView.ts:60-73`) — then by `createdAt` ascending, then by `name`; then the `No
    milestone` bucket, only when it has at least one ticket; then closed milestones last, in
    that same internal order. A milestone that is archived (`isMilestoneArchived` true) is
    dropped from the tree together with every ticket placed into it — `No milestone` and `No
    epic` buckets are themselves never archived.
  - Inside a milestone: epic groups are ordered by the epic ticket's key ordinal (reusing
    `sortBacklog(…, 'key')`'s ordinal, not a string compare — `backlogView.ts:46-49`), with
    the milestone's `No epic` bucket last and only when non-empty; tickets inside each group
    (and inside `No epic`) are ordered the same way, by key ordinal. `sortBacklog` and
    `isEpic` are imported from `@tm/ui`'s `backlogView.ts` and `@tm/shared/tickets`
    respectively rather than reimplemented, and `NO_EPIC_GROUP` is imported rather than
    restated, matching the sibling-constant note above.
  - Acceptance: `sidebarModel.test.ts` — section order and shape (including Reviews absent by
    default and present only with `reviewsEnabled: true`); milestone ordering (open-by-due,
    undated-last, closed-last) and the id scheme, including an epic id qualified by two
    different milestones for the same epic; the two named buckets (`No milestone`, `No epic`)
    appearing only when non-empty; a ticket whose `milestoneId` is unknown and one whose
    `epicTaskId` is unknown or non-epic; an epic ticket itself never appearing as a ticket
    leaf; counts staying correct on a folded node; an archived milestone (and its tickets)
    dropped from the tree. Gates green.

- [ ] F13.11 Render the sidebar in both hosts with tree keyboard navigation @needs: F13.8 Replace the two NAV lists with one shared shell navigation and the slim activity bar, F13.10 Write the pure sidebar model with the milestone, epic and ticket tree

  - `packages/ui/src/shell/Sidebar.tsx` on the canvas (no pane); `AppShell` gains a `sidebar`
    slot; Fluent `Tree` (or `role="tree"`) with arrow keys, Home/End and type-ahead; folds saved
    per device; "New issue (C)" opens `NewTicketDialog`; the workspace switcher shows only
    "This machine" until F19.
  - **Deletes `SHELL_NAV`'s `interim` group** (`packages/ui/src/shell/shellNav.ts`, F13.8):
    Attention, Projects, the external Issues browser (`issues`) and Fleet move into the
    sidebar this card renders; Scratch run becomes a palette command instead, with no rail
    tile left at all.
  - Acceptance: `shell-parity.test.ts` asserts both hosts pass the shared `Sidebar`; the
    tree's key handling is a pure reducer with tests (expand, collapse, move into children,
    skip folded). Gates green.

- [x] F13.12 Build the shared issue row with the selected state

  - `packages/ui/src/issues/IssueRow.tsx` and a pure `issueRowParts(task, ctx)` deciding which
    optional parts show: run pill (from the live-run index, "Step n of m"), MR (`!iid`), due
    (orange when today or overdue), avatar. Selected = `selectedTint` + left `accentBar`. Key in
    `mono` / `textFaint`; status glyph from the existing status icons.
  - Acceptance: `issueRowParts.test.ts` — an idle ticket with nothing else shows key, glyph and
    title only; a running ticket shows the pill; an overdue date is flagged, a future one is not;
    priority and type never produce a part. Gates green.

  - **Facts checked** (ahead of design, so it isn't re-derived next): `runPhase`
    (`packages/shared/src/board.ts:460`), `columnForTask` / `BoardColumn` (`board.ts:228`),
    `mrRef` / `MergeRequestState` (`@tm/shared/mergeRequest:215,24`), `assigneeDisplayParts` /
    `AssigneeDisplay` / `delegatedAgentName` (`packages/ui/src/projects/assigneeParts.ts`,
    `AssigneeDisplay.tsx`, `@tm/shared/tickets:67`), `Task.ticketKey` / `externalKey` / `dueAt`,
    the `SEMANTIC` shape and `tokenCssVars`'s `--tm-*` names, all five Fluent icons (installed
    `@fluentui/react-icons@2.0.331`), and the no-barrel `tsup` build all match the card's own
    description exactly.
  - One claim needs correcting: `tokenCssVars` is **already** stamped on both hosts' provider
    roots (`apps/client/src/renderer/src/main.tsx:91`, `apps/web/src/main.tsx:58`), beside
    `--app-font-scale` — not "nothing stamps them yet". Both hosts hard-code
    `tokenCssVars('dark')` today (F13.4 is what makes it follow the resolved scheme instead),
    so every `--tm-*` var always carries its dark value regardless of which Fluent theme a
    component sits under. The card's `var(--tm-x, <fluent-fallback>)` pattern still stands —
    the fallback just never actually engages before F13.4, since the var is always set — but a
    row built on it will read dark-scheme colours inside a light Fluent theme until F13.4
    ships. Pre-existing condition of every surface already reading a `--tm-*` var, not
    something this card introduces or needs to work around.
  - The attached v9 mockups (`issues-list-light/dark.svg`) draw the row precisely enough to
    read exact values from the markup. Several aren't in the card's own description and
    Design should decide on, not re-derive:
    - Row: 34px tall, 7px corner radius; selected fill `#EBF3FC`/`#1D2B38` (= `selectedTint`)
      with a 3px, 18px-tall (centred, ~53% of row height) bar — matches `accentBar` exactly.
    - Selected title is also recoloured and bolded (`#0F548C`/`#9CCBF2`, weight 600), not just
      the background tint and bar — "selected = tint + bar" alone is incomplete.
    - The key and the empty-assignee ring (see below) share a colour with no entry in the
      current token table: `#AEB4BC` light / `#5A6169` dark, visibly fainter than `textFaint`
      (`#646B74`/`#8A929B`). Either `textFaint` is close enough and the mockup is only
      approximate, or this role wants its own token.
    - Status glyph: a 5.5px outline circle, `#454B54`/`#BAC0C7` stroke when the ticket carries
      more state, the same faint tone as the key for a plain Todo ring with no wedge. In
      Progress adds a small (~90°) filled wedge, In Review a larger (~270°,
      `large-arc-flag=1`) one — reads as `CircleRegular` → a hinted fill → a half fill,
      consistent with the card's icon list. Neither mockup shows a Done or Blocked row, so
      `CheckmarkCircleFilled` / `PresenceBlockedRegular` have no visual reference yet.
    - MR ref: plain mono text, no pill, faint (`#7C838D`/`#8A929B`), right-aligned — unlike the
      run indicator, which is a pill.
    - Run pill: dark-mode bg and ink match `run.pill` / `run.ink` from `tokens.ts` exactly
      (`rgba(34,228,255,.12)` / `#22E4FF`). Light-mode bg also matches `run.pill` (`#E6FAFE`),
      but the mockup's light-mode dot/text (`#0BA5C2`/`#06606F`) is a near miss on `run.ink`
      (`#07748C`) — treat `tokens.ts` as authoritative (it is the one F13.2 already checked for
      contrast) rather than colour-picking the SVG.
    - Due date: plain faint text normally, bold `#F28C28` for "Today" — the mockups' orange
      from open question 1, not the shipped `UNREAD_ORANGE` (`#F2A900`). No row shows a
      past-due date, only "Today", so only that one state has a visual reference.
    - Avatar has three states, not two. Besides the agent glyph (filled `selectedTint`-ish
      circle, brand-coloured `AgentsRegular`-shaped glyph) and human initials (filled
      `canvas`-ish circle, two letters), several Todo rows with neither draw a dashed outline
      ring (`stroke-dasharray 2 2`, the same faint tone as the key) rather than nothing.
      `assigneeDisplayParts` returns `null` for that case today and `AssigneeDisplay` renders
      nothing ("neither is not this component's problem", by its own doc comment). Reusing it
      as-is means `IssueRow` renders nothing where the mockup shows a ring; drawing the ring
      is new behaviour the card didn't ask for — Design's call.

  - **Design decisions, taken against the facts above — step 3 writes these, it does not
    re-derive them:**
    - **No new token, and no new row behaviour.** The faint key/empty-ring tone and the
      selected title's recolour both get folded onto tokens that already exist rather than
      minted fresh: the key and status glyph read `--tm-text-faint` /
      `SEMANTIC[scheme].textFaint`, and the selected title reads `--tm-brand` /
      `.brand` (`#0F6CBD`/`#4FA3E8`), not the mockup's own near-miss hexes
      (`#AEB4BC`/`#5A6169`, `#0F548C`/`#9CCBF2`) — the same call the facts step already made
      for `run.ink` against the mockup's light-mode dot. And the dashed "neither" ring stays
      undrawn: `avatar` is exactly `assigneeDisplayParts(ctx.assignee, ctx.agentName) ??
      undefined`, so a Todo row with no assignee and no agent renders no avatar part at all,
      matching `AssigneeDisplay`'s own "neither is not this component's problem" stance
      instead of growing it a third, row-only state. If the ring is wanted later it is
      `AssigneeDisplay`'s own change to make (every caller gains it at once), not a fork kept
      alive only inside `IssueRow`.
    - **The status glyph is one icon per column, one colour throughout — not five
      hand-traced wedges.** `STATUS_GLYPH: Record<BoardColumn, JSX.Element>` maps
      `columnForTask(task)`'s five values directly (`board.ts:228`): `todo` →
      `CircleRegular`, `in-progress` → `CircleHalfFillRegular`, `in-review` →
      `CircleHintRegular`, `blocked` → `PresenceBlockedRegular`, `done` →
      `CheckmarkCircleFilled`, every one in `textMuted` regardless of column. The mockup
      draws the ring in two different strokes (faint for a bare Todo ring, a darker
      `textMuted` once any wedge appears) and traces the wedges as raw arc paths — reasonable
      for a static SVG, but readable with Fluent's own half-fill and hinted-fill icon
      variants instead, which already encode "some progress" / "more progress" without this
      component drawing geometry. One tone (not two) also matches the colour-budget rule the
      facts step leaned on for `run.ink`: the glyph's SHAPE carries the state; its colour
      stays out of the budget colour spends on things that move. Neither mockup shows a Done
      or Blocked row, so those two icons are chosen to match the card's own icon list, not a
      visual reference — same as the facts step already flagged.
    - **`run`'s label is computed, never read off `runPhase`'s own `label` string.**
      `runPhase(task, ctx.subtasks ?? [], ctx.liveRunTaskIds, ctx.mergingTaskIds)`
      (`board.ts:460`) stays the one source of truth for "is anything moving", but its
      `label` is prose for a different reader ("Running step 2 of 5", "Paused — usage limit
      (step 3 of 5)") — not the row's "Step 2 of 4". So: no `run` part unless `.spinner` is
      true; then branch on `.phase`. `'merging'` → `'Merging'`. Otherwise, when `subtasks`
      is non-empty, pull `n`/`m` out of `.label` with `/step (\d+) of (\d+)/i` and render
      `` `Step ${n} of ${m}` `` — reusing the index `runPhase` already found for its
      `running`/`starting` branches instead of re-walking `subtasks` with a second copy of
      its predicates (its `TERMINAL` set is private to `board.ts`, so duplicating the walk
      would mean either exporting it or drifting from it over time). When the regex finds
      nothing (no subtasks, or a phase whose label carries none), fall back to `'Starting'`
      for `phase === 'starting'` and `'Running'` for everything else `.spinner` leaves — which
      for `runPhase` is only `running`/`starting`/`merging`, so that fallback never actually
      fires for `merging` or for a bare `running: true` task.status in practice, but costs
      nothing to keep as the exhaustive default.
    - **`mr` trusts `ctx.mergeRequests` as already scoped to this task.** `issueRowParts`
      does not re-run the key/branch matching `matchTaskId` does in either forge's
      reconciler — that is the container's job (F13.13/F13.15), the same division
      `issueRowParts`'s other optional parts already keep from their containers. Given that
      list, it picks `mergeRequests.find(m => m.state === 'opened') ?? mergeRequests.find(m
      => m.state === 'merged')`; `closed`/`locked` rows are never chosen (and produce no part
      if that's all there is). `ref: mrRef(mr)` (`mergeRequest.ts:215`), `url: mr.webUrl`.
    - **`due`'s "flagged" test compares local calendar days, computed from the injected
      `now`, never `Date.now()`.** Both `ctx.now` and `task.dueAt` (`model.ts:1235`, epoch
      ms) are floored to local midnight (`new Date(x).setHours(0,0,0,0)`); flagged when the
      due day's floor is `<=` today's floor, except when `columnForTask(task) === 'done'` —
      finished work is never overdue, however old its `dueAt`. Label is `'Today'` exactly
      when the two floors are equal, otherwise `new Date(dueAt).toLocaleDateString(undefined,
      { month: 'short', day: 'numeric' })` — including on a flagged, *past* day (e.g. an
      overdue ticket reads "Oct 10", styled `attention`, not "Today"); neither mockup shows
      that state, so this is read off the card's own rule, not a visual reference.
    - **Right-cluster order is run → mr → due → avatar**, matching the mockup's own pixel
      order once the two mutually-exclusive middle slots (no row shows `mr` and `due`
      together) are read as one slot: the run pill sits leftmost of the cluster
      (`x="828"`, mockup `TM-71`), the avatar is always rightmost (`cx="991"`, every row),
      and `mr`/`due` share the slot between them, right-aligned against the avatar. The two
      ARE allowed to coexist in real data (an in-review ticket can also carry a due date);
      `mr` sits closer to the title than `due` because the mockup's one row that shows
      `mr` (`TM-176`) has no `due` to compare against, so the title-to-avatar reading order
      (what's blocking it, then when it's due, then who owns it) is the tie-break.
    - **`IssueRowContext` carries no story about WHICH task's subtasks/MRs these are** —
      `subtasks`, `mergeRequests`, `liveRunTaskIds` and `mergingTaskIds` are exactly the
      slices `runPhase` and the `mr` rule above need, already filtered to this row's task by
      the container. `issueRowParts` itself touches no store, no IPC channel and no other
      task's data — it stays as pure as `runPhase` itself.
    - **`IssueRow`'s own state is one `useMemo` and three DOM handlers**, nothing else:
      `parts = useMemo(() => issueRowParts(task, ctx), [task, ctx])`; `onClick` →
      `onSelect?.(task.id)`; `onDoubleClick` and an Enter `onKeyDown` both → `onOpen?.(task.id)`
      (space, roving focus, and virtualised list wiring are F13.13/F13.15's job — the row
      takes `id` as a prop rather than computing one so the container can own that scheme).
      Selected styling is two rules, not a single combined one: the fill
      (`background: var(--tm-selected-tint)`) and title recolour/weight apply whenever
      `selected`; the bar is the row's `::before` (`width: 3px`, `height: 60%`, `top: 20%`,
      `border-radius`, `background: var(--tm-accent-bar)`) shown only alongside that same
      fill — there is no "bar without tint" or "tint without bar" state, so the two are one
      Griffel rule keyed on `selected`, not two independently-toggled styles. Hover is a
      second, non-exclusive rule (a neutral subtle background) that still applies when
      `selected` — the mockup shows no hover-while-selected state, so this stays the
      simplest composition (both backgrounds painted, selected's tint winning by being the
      more opaque of the two) rather than a special-cased third style.

- [ ] F13.13 Open the F12 panel as a peek on Space and as a full-screen issue on Enter @needs: F13.11 Render the sidebar in both hosts with tree keyboard navigation, F13.12 Build the shared issue row with the selected state

  - A `peek` layout (flat surface on the right, list still focusable) and a `full` layout (the
    same `TaskDetailHost` as a page with a breadcrumb) over F12's panel; Space / Enter / Esc
    through a pure `issueViewReduce`. Needs F12's `TaskDetailHost` shipped.
  - Acceptance: reducer tests (Space toggles peek, Enter from peek goes full, Esc steps back
    one level, a deleted ticket closes with a message); gates green.

### F13 · Phase 4 — Migrate the screens

- [ ] F13.14 Move the board onto tokens and glass without changing its anatomy @needs: F13.5 Build the glass pane primitive with the opaque fallback

  - `KanbanColumn` columns stay faint lanes on the canvas; `TaskCard`, `AgentGlyph`,
    `TaskChain`, `ChainOverlay` and the MR rows read colours from tokens (the six literals in
    `TaskCard.tsx` go). Dot sizes, glyphs, sections and verdicts stay exactly as they are
    (memory *mock-the-real-components*); compare with the v9 kanban mockup.
  - Acceptance: no colour literal left in `packages/ui/src/board/`; the cyan run state and the
    amber/red/green dots pass F13.2 in light; gates green; the human reviews the board in both
    themes against the mockup (there is no screenshot path for the Electron window).

- [ ] F13.15 Move Projects, the Tickets list and the detail panel onto the new rows and panes @needs: F13.12 Build the shared issue row with the selected state, F13.14 Move the board onto tokens and glass without changing its anatomy

  - `BacklogTable` renders `IssueRow`s grouped by status as in the v9 list mockup;
    `TimelinePane` and `GraphPane` take token colours (Gantt bars and milestone markers
    monochrome, the live branch cyan as `GRAPH_INK` already rules); `TaskDetail` sections sit
    on a flat surface.
  - Acceptance: `backlogView.test.ts` / `ganttLayout.test.ts` unchanged and green; no colour
    literal left in `packages/ui/src/projects/`; gates green.

- [ ] F13.16 Move every remaining screen, dialog and the title bar onto tokens @needs: F13.15 Move Projects, the Tickets list and the detail panel onto the new rows and panes

  - Settings, Activity, Performance, Automations, Issues, the review pane, `UsageQuotaBars`,
    `SyncCurtain`, `TaskAgentPanel`, `PersonAvatar`, the code surfaces (`CODE_*` per scheme),
    every Fluent `Dialog` (flat surface) and `TitleBar.tsx`'s window controls.
  - Acceptance: the only colour literals left are in `theme.ts` / `tokens.ts`, user-chosen
    colours (`ColorSwatches`, label colours) and brand marks (`JiraMark`, `GitHubMark`,
    `LinearMark`); gates green.

- [ ] F13.17 Bring the compact shell onto glass with the gradient hairline @needs: F13.5 Build the glass pane primitive with the opaque fallback, F13.9 Restyle the status bar as the gradient bar with the orange attention fill

  - `BottomTabBar` becomes a glass bar with a 2px `statusGradient` hairline on top (replacing
    its `colorNeutralStroke2` border); compact cards and action bars use `GlassPane`; the strip
    turns orange under attention like the desktop bar. Touch floors unchanged.
  - Acceptance: `compactColumns.test.ts` and `compactRoute.test.ts` stay green; contrast pairs
    for the tab bar labels in both themes; web build green; the human checks the phone layout
    against the v9 mobile mockups.

- [ ] F13.20 Route board chain links through the column gutters with an Off, Focus and All toggle @needs: F13.14 Move the board onto tokens and glass without changing its anatomy

  - Replace the facing-edge curves in `packages/ui/src/board/chainArrows.ts` with a pure
    `routeChainLinks(cards, links, layout)` → orthogonal polylines: card side → own gutter →
    (bus channel under the headers when the columns are not adjacent) → target's gutter →
    target side; per-gutter and per-bus lane allocation (7px apart, keyed by the column
    boundary, so two links in the same gap never overlap); 5px rounded corners. `ChainOverlay`
    draws them; the column gap grows from 12 to 30px only while links show.
  - A `Links: Off · Focus · All` segmented control in the board header, `L` cycles it, stored
    per device like the step folds. *Focus* draws only the selected card's links and dims the
    rest; *Off* swaps the lines for `needs …` / `unblocks …` chips on the cards (from
    `@shared/taskChain`, no new data).
  - Acceptance: `chainRoute.test.ts` proves no routed segment intersects any card rectangle
    across adjacent, distant, same-column and forward links, and that two links through one
    gutter get distinct lanes; the existing releasing / waiting / satisfied styling and the
    focus-mode filter (`focusCards`) keep their tests; gates green; the human checks the board
    against `mockups/v10-7c…7e`.

### F13 · Phase 5 — Guard and document

- [ ] F13.18 Add a token-only test that refuses colour literals outside the theme @needs: F13.16 Move every remaining screen, dialog and the title bar onto tokens

  - `test/theme-tokens.test.ts` (root, so `pnpm test` runs it, like `shell-parity.test.ts`):
    scans `packages/ui/src`, `apps/client/src/renderer/src` and `apps/web/src` for hex, `rgb()`,
    `rgba()`, `hsl()` literals and `backdrop-filter`, comments and strings stripped as
    `shell-parity.test.ts`'s `objectLiteralAfter` does; allow-list = `theme.ts`, `tokens.ts`,
    `GlassPane.tsx`, `ColorSwatches.tsx` and the brand marks, each with a one-line reason.
  - Acceptance: written red-first — a literal added to `TaskCard.tsx` fails it, a comment
    containing `#fff` does not; green on the migrated tree; gates green with `--force`.

- [ ] F13.19 Document the design system and verify it headlessly @needs: F13.13 Open the F12 panel as a peek on Space and as a full-screen issue on Enter, F13.17 Bring the compact shell onto glass with the gradient hairline, F13.18 Add a token-only test that refuses colour literals outside the theme

  - `docs/13-design-system.md`: the token table, the glass rules and fallbacks, the colour
    budget, row anatomy, peek vs full screen, and how to add a screen. `docs/05-glossary.md`
    gains peek, activity bar, sidebar, glass pane. A headless boot of the packaged bundle in
    both schemes and with reduced transparency (memory *verify-electron-app*); the web build
    served and checked at desktop and phone widths by the human.
  - Acceptance: the doc's token table is generated from or tested against `tokens.ts` so it
    cannot drift; `pnpm typecheck`, `pnpm test`, `pnpm build` green.
