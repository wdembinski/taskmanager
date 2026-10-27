/**
 * The page-side `Date` replacement behind `ui-shots.mjs`'s `clock` row field — kept out of that
 * script for the same reason `shotChecks.mjs` is (its `main()` runs on import), so
 * `clockShim.test.mjs` can evaluate the source in a `vm` context.
 *
 * A screen that compares a fixture timestamp against the page's real `Date.now()` (the review
 * workspace's "Queues as of 12:55" caption, `queuesAsOfNotice`) reads the fixture as hours or
 * months stale against today's clock. The shim starts the page's clock at `clock` and lets it
 * advance with `performance.now()`, so timers, debounces and "just now" labels still move:
 * `new Date()` with no arguments and `Date.now()` return `clock + (performance.now() - t0)`.
 * Every explicit construction (`new Date(0)`, `new Date('2026-01-15')`) and every other static
 * (`Date.UTC`, `Date.parse`) is the real `Date`'s, untouched.
 */

/**
 * The init-script source that replaces `globalThis.Date` with a subclass starting at `clock`
 * (an epoch in ms). Returns `''` for a row without one, so callers can prepend it
 * unconditionally.
 */
export function clockShimSource(clock) {
  if (clock == null) return '';
  if (!Number.isFinite(clock)) throw new Error(`clock must be an epoch in ms, got ${clock}`);
  return `(function(){
    var RealDate = globalThis.Date;
    var perf = globalThis.performance;
    var t0 = perf.now();
    var clock = ${JSON.stringify(clock)};
    function current() { return Math.floor(clock + (perf.now() - t0)); }
    class FrozenDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) super(current());
        else super(...args);
      }
      static now() { return current(); }
    }
    globalThis.Date = FrozenDate;
  })();`;
}
