/**
 * What the app is called, in one place.
 *
 * It was written out in five: the window title, the title bar, the crash dialog, the error
 * boundary and the HTML `<title>`. Renaming it meant finding all five and getting all five —
 * the same reason `accent.ts` owns the one orange.
 *
 * **Deliberately not the same string as the packaging identity.** `package.json`'s `name`
 * (`claude-orchestrator`) is what Electron derives `app.getPath('userData')` from, so it is
 * where every task, project and setting on disk lives; and `appId` is what NSIS matches an
 * installed app by. Renaming either would point a rebranded build at an empty database, or
 * install it alongside the old one instead of upgrading it. Those stay as they are — this
 * constant is only what a human reads.
 */
export const PRODUCT_NAME = 'VIPPER Task Manager';
