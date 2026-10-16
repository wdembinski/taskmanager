/**
 * The web app manifest, the icons it points at, `index.html`'s own links and
 * `staticwebapp.config.json`'s MIME mapping are four files that have to agree with each
 * other and with `SEMANTIC` (`@tm/ui/tokens`) for the installed app to look like one
 * product rather than a static bundle with a mismatched splash colour. None of the four can
 * import from another — a `.webmanifest` is static JSON and `index.html` is static markup —
 * so this is the only place a drift between them would be caught, the same role
 * `test/repo-invariants.test.ts` plays for the version.
 *
 * The manifest itself stays pinned to `SEMANTIC.light.canvas`: a `.webmanifest` has no
 * media-query mechanism, so there is no "follow the user's scheme" option for it — F13.4
 * picks light as its one fixed value. `index.html`'s `<meta name="theme-color">` is
 * different: a `<meta>` CAN carry a `media` attribute, so it gets both — one for each
 * scheme — and this file holds both of those to `SEMANTIC`'s canvas too.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEMANTIC } from '@tm/ui/tokens';

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

interface Manifest {
  name: string;
  short_name: string;
  start_url: string;
  display: string;
  background_color: string;
  theme_color: string;
  icons: ManifestIcon[];
}

function readManifest(): Manifest {
  return JSON.parse(
    readFileSync(join(webRoot, 'public', 'manifest.webmanifest'), 'utf8'),
  ) as Manifest;
}

/** Reads width/height straight out of a PNG's IHDR chunk — always the first 24 bytes. */
function pngDimensions(path: string): { width: number; height: number } {
  const buf = readFileSync(path);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('manifest.webmanifest', () => {
  it('is installable: named, standalone, and rooted at the app itself', () => {
    const manifest = readManifest();
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
  });

  it('paints an installed window in SEMANTIC.light.canvas, not a colour of its own', () => {
    const manifest = readManifest();
    expect(manifest.background_color).toBe(SEMANTIC.light.canvas);
    expect(manifest.theme_color).toBe(SEMANTIC.light.canvas);
  });

  it('lists the 192 and 512 icons installability requires, each a real PNG of that size', () => {
    const manifest = readManifest();
    const sizesListed = manifest.icons.map((icon) => icon.sizes);
    expect(sizesListed).toContain('192x192');
    expect(sizesListed).toContain('512x512');

    for (const icon of manifest.icons) {
      expect(icon.type).toBe('image/png');
      const [declaredWidth, declaredHeight] = icon.sizes.split('x').map(Number);
      const filePath = join(webRoot, 'public', icon.src.replace(/^\//, ''));
      const { width, height } = pngDimensions(filePath);
      expect(width, `${icon.src} should be ${icon.sizes} wide`).toBe(declaredWidth);
      expect(height, `${icon.src} should be ${icon.sizes} tall`).toBe(declaredHeight);
    }
  });
});

describe('index.html', () => {
  function html(): string {
    return readFileSync(join(webRoot, 'index.html'), 'utf8');
  }

  it('links the manifest and a favicon', () => {
    const markup = html();
    expect(markup).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(markup).toContain('rel="icon"');
  });

  it('carries a theme-color meta for each scheme, matching SEMANTIC', () => {
    // A static document can't read the resolved appearance setting, but a <meta> CAN carry
    // a media query, so it gets one per OS scheme rather than being pinned to one like the
    // manifest above.
    const markup = html();
    expect(markup).toMatch(
      new RegExp(
        `<meta name="theme-color" content="${SEMANTIC.light.canvas}" media="\\(prefers-color-scheme: light\\)" */?>`,
      ),
    );
    expect(markup).toMatch(
      new RegExp(
        `<meta name="theme-color" content="${SEMANTIC.dark.canvas}" media="\\(prefers-color-scheme: dark\\)" */?>`,
      ),
    );
  });
});

describe('staticwebapp.config.json', () => {
  it('serves .webmanifest with its own MIME type, not a generic octet-stream', () => {
    const config = JSON.parse(readFileSync(join(webRoot, 'staticwebapp.config.json'), 'utf8')) as {
      mimeTypes?: Record<string, string>;
    };
    expect(config.mimeTypes?.['.webmanifest']).toBe('application/manifest+json');
  });
});
