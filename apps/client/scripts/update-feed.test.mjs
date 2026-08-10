import { describe, expect, it } from 'vitest';
import {
  feedArtifactNames,
  findUnexpandedMacros,
  hasPublisherName,
  isSigningConfigured,
} from './update-feed.mjs';

/** The app-update.yml that shipped in v0.33.0 — the bug this gate exists to catch. */
const BROKEN_APP_UPDATE = `owner: wdembinski
repo: taskmanager
provider: github
updaterCacheDirName: claude-orchestrator-updater
publisherName:
  - \${author}
`;

/** The same file once the publisherName trap is removed. */
const FIXED_APP_UPDATE = `owner: wdembinski
repo: taskmanager
provider: github
updaterCacheDirName: claude-orchestrator-updater
`;

const LATEST_YML = `version: 0.33.0
files:
  - url: claude-orchestrator-0.33.0-setup.exe
    sha512: abc==
    size: 85047636
path: claude-orchestrator-0.33.0-setup.exe
sha512: abc==
releaseDate: '2026-07-30T07:25:24.935Z'
`;

describe('findUnexpandedMacros', () => {
  it('catches the literal ${author} that broke every Windows auto-update', () => {
    expect(findUnexpandedMacros(BROKEN_APP_UPDATE)).toEqual(['${author}']);
  });

  it('reports each distinct macro once', () => {
    const text = 'a: ${name}\nb: ${name}\nc: ${version}\n';
    expect(findUnexpandedMacros(text)).toEqual(['${name}', '${version}']);
  });

  it('passes a clean file', () => {
    expect(findUnexpandedMacros(FIXED_APP_UPDATE)).toEqual([]);
  });

  it('does not mistake a bare $ or an unclosed brace for a macro', () => {
    expect(findUnexpandedMacros('note: costs $5\nother: ${oops\n')).toEqual([]);
  });
});

describe('hasPublisherName', () => {
  it('finds the key that switches on signature verification', () => {
    expect(hasPublisherName(BROKEN_APP_UPDATE)).toBe(true);
  });

  it('is false once the key is gone', () => {
    expect(hasPublisherName(FIXED_APP_UPDATE)).toBe(false);
  });

  it('ignores the word appearing as a value or inside another key', () => {
    expect(hasPublisherName('comment: publisherName was removed\n')).toBe(false);
    expect(hasPublisherName('myPublisherName: x\n')).toBe(false);
  });
});

describe('isSigningConfigured', () => {
  const unsigned = 'win:\n  verifyUpdateCodeSignature: false\n';

  it('is false for the current unsigned setup', () => {
    expect(isSigningConfigured({}, unsigned)).toBe(false);
  });

  it('sees a certificate handed over by environment', () => {
    expect(isSigningConfigured({ CSC_LINK: 'cert.pfx' }, unsigned)).toBe(true);
    expect(isSigningConfigured({ WIN_CSC_LINK: 'cert.pfx' }, unsigned)).toBe(true);
  });

  it('treats an empty variable as absent — a blank CSC_LINK signs nothing', () => {
    expect(isSigningConfigured({ CSC_LINK: '' }, unsigned)).toBe(false);
  });

  it('sees Azure Trusted Signing and signtool declared in the config', () => {
    expect(isSigningConfigured({}, 'win:\n  azureSignOptions:\n    endpoint: x\n')).toBe(true);
    expect(
      isSigningConfigured({}, 'win:\n  signtoolOptions:\n    certificateSubjectName: Me\n'),
    ).toBe(true);
  });
});

describe('feedArtifactNames', () => {
  it('collects the download path and the files entries, deduplicated', () => {
    expect(feedArtifactNames(LATEST_YML)).toEqual(['claude-orchestrator-0.33.0-setup.exe']);
  });

  it('lists every artifact of a multi-file Linux feed', () => {
    const linux = `version: 0.33.0
files:
  - url: claude-orchestrator-0.33.0.AppImage
    size: 1
  - url: claude-orchestrator-0.33.0.deb
    size: 2
path: claude-orchestrator-0.33.0.AppImage
`;
    expect(feedArtifactNames(linux)).toEqual([
      'claude-orchestrator-0.33.0.AppImage',
      'claude-orchestrator-0.33.0.deb',
    ]);
  });

  it('skips absolute URLs — a generic test feed names a host, not a local file', () => {
    expect(feedArtifactNames('provider: generic\nurl: http://localhost:8080\n')).toEqual([]);
  });

  it('strips the quotes electron-builder adds around some values', () => {
    expect(feedArtifactNames("path: 'app-0.1.0.exe'\n")).toEqual(['app-0.1.0.exe']);
  });
});
