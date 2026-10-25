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
