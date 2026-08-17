/**
 * The shape of a browser client's own cloud config — everything `useCloudBoard` and
 * `CloudAuth` need to reach a `@tm/server` and a vipper.iam issuer, without this package
 * ever reading `import.meta.env` itself.
 *
 * That split is deliberate, not incidental: `import.meta.env` is a Vite build-time
 * replacement, and esbuild (what `tsup` runs on) cannot emit `import.meta` in a CJS output
 * — it substitutes `{}`. A config reader living here would build clean and ship a
 * production bundle silently pointing at whatever the `{}` fallback resolves to. Reading
 * the environment stays a per-app job (`apps/web/src/env.ts`, and mobile's own equivalent),
 * each supplying its own client id; this package only names the shape they hand it in.
 */
export interface WebConfig {
  /** The @tm/server root — no trailing slash. */
  cloudApiBase: string;
  /** The vipper.iam OIDC issuer. */
  iamIssuer: string;
  /** This build's own registered PUBLIC vipper.iam client id (PKCE, no secret). */
  iamClientId: string;
}
