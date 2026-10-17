/**
 * The one pane surface every container in the shell paints: `paneGlass` under a blurred
 * backdrop, or `paneOpaque` wherever glass can't or shouldn't render. There is exactly one CSS
 * implementation of that switch — this file — and `test/glass-single-implementation.test.ts`
 * enforces it: nothing else in the repo may declare `backdropFilter`. The alternative, letting
 * each pane repeat its own `@supports` block, is how "reduce transparency" quietly stops
 * covering a pane somebody added later; one implementation means one place to get it right.
 *
 * The base rule — no `@supports`, no `data-glass`, no `forced-colors` — is `paneOpaque`, not
 * `paneGlass`. That is deliberate: an engine this file has never heard of, one with no
 * `@supports` support at all, falls through to every declaration it DOES understand, which is
 * the base rule alone. Starting from the opaque value means such an engine renders a plain,
 * readable pane for free; starting from the glass value would leave it a near-transparent fill
 * with no blur behind it, which is unreadable.
 *
 * Restraint rules (F13 plan, "Glass"): glass means *panes* only — the list, detail, peek, board
 * cards, dialogs, the mobile tab bar — always at `paneGlass`'s near-opaque level. Never rows,
 * chips, code surfaces or text backgrounds; no gradients, no extra chrome layers; blur radius is
 * one token, {@link GLASS_BLUR}. `GlassPane` enforces the "one implementation" half structurally
 * — it is the only thing in the repo allowed to paint glass — but it cannot stop a caller from
 * wrapping the wrong kind of element in it; that half stays a code-review rule.
 *
 * Reads no appearance state itself and takes no `mode` prop. `data-glass` is stamped on the
 * document root by `applyDocumentAppearance` (`appearance.ts`); every rule below reacts to CSS
 * alone, so a mounted pane never needs to re-render when transparency changes.
 *
 * `'native'` glass (F13.7, Windows Mica/Acrylic) deliberately keeps this same CSS pane — the
 * native material paints behind the window, not inside this div — so there is no selector for
 * it here; F13.7 owns whatever makes the backdrop transparent enough for it to show through.
 */
import { makeStyles, mergeClasses } from '@fluentui/react-components';
import { forwardRef, type HTMLAttributes } from 'react';

/** The one blur token (F13 plan, "Glass": "Blur radius is one token"). */
export const GLASS_BLUR = 'blur(24px) saturate(1.2)';

/**
 * A single `pane` slot, for existing containers that can't be swapped for `GlassPane` itself
 * (F13.14/F13.17 will `mergeClasses(glass.pane, …)` onto their own root).
 */
export const useGlassStyles = makeStyles({
  pane: {
    // The fallback: same shadow in both modes (rim, top sheen, drop shadow), per the plan.
    backgroundColor: 'var(--tm-pane-opaque)',
    borderRadius: '12px',
    boxShadow:
      'inset 0 1px 0 var(--tm-pane-rim-sheen-from), inset 0 0 0 1px var(--tm-pane-rim-rim), var(--tm-pane-shadow)',

    '@supports (backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))': {
      backgroundColor: 'var(--tm-pane-glass)',
      backdropFilter: GLASS_BLUR,
      WebkitBackdropFilter: GLASS_BLUR,
    },

    // Higher specificity than the `@supports` rule above (an attribute selector on an
    // ancestor beats a bare class), so this wins regardless of which rule Griffel inserts
    // last — the opaque switch must win whenever `data-glass="opaque"` is set.
    ':global(:root[data-glass="opaque"]) &': {
      backgroundColor: 'var(--tm-pane-opaque)',
      backdropFilter: 'none',
      WebkitBackdropFilter: 'none',
    },

    // Forced-colors mode (Windows High Contrast) drops `box-shadow`, so the rim above
    // vanishes; a real border stands in for it instead.
    '@media (forced-colors: active)': {
      backgroundColor: 'var(--tm-pane-opaque)',
      backdropFilter: 'none',
      WebkitBackdropFilter: 'none',
      border: '1px solid CanvasText',
    },
  },
});

/**
 * A thin `div` that paints the shell's one pane surface. No appearance prop — the glass/opaque
 * switch lives entirely in CSS, driven by `data-glass` on the document root.
 */
export const GlassPane = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function GlassPane({ className, ...rest }, ref) {
    const styles = useGlassStyles();
    return <div ref={ref} className={mergeClasses(styles.pane, className)} {...rest} />;
  },
);
