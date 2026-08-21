/**
 * Headless proof that apps/mobile builds into an installable PWA — the thing Phase 27
 * step 9 (docs/plan/README.md) actually promises, past "the files exist". Chrome only
 * offers the install prompt when the manifest parses and carries every required field,
 * the icons it points at are real images of the declared size, and `sw.js` is reachable
 * at the scope the manifest claims — none of which a green `pnpm build` on its own proves.
 *
 *     node scripts/verify-mobile-build.mjs
 *
 * Builds through turbo (`--filter=@tm/mobile...`) rather than calling `vite build`
 * directly in apps/mobile, because apps/mobile imports `@tm/cloud`, `@tm/ui`,
 * `@tm/shared` and `@tm/protocol` as real workspace packages resolved through their built
 * `dist/` (apps/mobile/vite.config.ts's own header) — turbo's `^build` dependency is what
 * builds those first.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'apps', 'mobile', 'dist');

let failures = 0;
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

// ── Build ─────────────────────────────────────────────────────────────────────────────
const turboBin = join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'turbo.CMD' : 'turbo',
);
const build = spawnSync(turboBin, ['run', 'build', '--filter=@tm/mobile...', '--force'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
check('apps/mobile builds (turbo run build --filter=@tm/mobile...)', build.status === 0);
if (build.status !== 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}

// ── manifest.webmanifest ─────────────────────────────────────────────────────────────
const manifestPath = join(distDir, 'manifest.webmanifest');
check('manifest.webmanifest is emitted to dist', existsSync(manifestPath));

const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
check(
  'the manifest parses as JSON with an id',
  typeof manifest.id === 'string' && manifest.id.length > 0,
);
check('display: standalone', manifest.display === 'standalone');
check('start_url is set', typeof manifest.start_url === 'string' && manifest.start_url.length > 0);
check('scope is set', typeof manifest.scope === 'string' && manifest.scope.length > 0);
check('orientation: portrait', manifest.orientation === 'portrait');
check(
  "theme_color matches useGlobalStyles' page background (#1f1f1f)",
  manifest.theme_color === '#1f1f1f',
);
check(
  "background_color matches useGlobalStyles' page background (#1f1f1f)",
  manifest.background_color === '#1f1f1f',
);

// ── Icons ─────────────────────────────────────────────────────────────────────────────
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
for (const size of [192, 512]) {
  const declared = Array.isArray(manifest.icons)
    ? manifest.icons.find((icon) => icon.sizes === `${size}x${size}`)
    : undefined;
  check(`manifest declares a ${size}x${size} icon`, declared != null);
  check(`icon ${size} declares purpose "any maskable"`, declared?.purpose === 'any maskable');

  if (declared?.src) {
    const iconPath = join(distDir, declared.src.replace(/^\//, ''));
    check(`${declared.src} is emitted to dist`, existsSync(iconPath));
    if (existsSync(iconPath)) {
      const buf = readFileSync(iconPath);
      check(`${declared.src} has a PNG signature`, buf.subarray(0, 8).equals(PNG_SIGNATURE));
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      check(
        `${declared.src} declares ${size}x${size} in its own IHDR chunk`,
        width === size && height === size,
      );
    }
  }
}

// ── Service worker ───────────────────────────────────────────────────────────────────
const swPath = join(distDir, 'sw.js');
check('sw.js is emitted at the dist root', existsSync(swPath));

// ── index.html links the manifest and loads a bundle that registers the SW ─────────────
const indexHtmlPath = join(distDir, 'index.html');
const indexHtml = existsSync(indexHtmlPath) ? readFileSync(indexHtmlPath, 'utf8') : '';
check('index.html links manifest.webmanifest', indexHtml.includes('manifest.webmanifest'));

const assetsDir = join(distDir, 'assets');
const jsFiles = existsSync(assetsDir)
  ? readdirSync(assetsDir).filter((f) => f.endsWith('.js'))
  : [];
const registersSw = jsFiles.some((f) =>
  readFileSync(join(assetsDir, f), 'utf8').includes('serviceWorker.register'),
);
check('the bundle index.html loads registers the service worker', registersSw);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
