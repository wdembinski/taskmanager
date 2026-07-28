/**
 * The `wsl.exe` output encoding is the part worth testing: decoding its UTF-16LE
 * listing as UTF-8 does not throw, it silently yields distro names that match
 * nothing, which is exactly the kind of bug that survives to a user's machine.
 */
import { describe, expect, it } from 'vitest';
import { decodeWslListing, parseDistroList } from './wsl';

describe('decodeWslListing', () => {
  it('decodes the UTF-16LE listing `wsl -l -q` actually emits', () => {
    const text = decodeWslListing(Buffer.from('Ubuntu-20.04\r\ndocker-desktop\r\n', 'utf16le'));
    expect(text).toBe('Ubuntu-20.04\r\ndocker-desktop\r\n');
  });

  it('still reads a plain UTF-8 listing', () => {
    expect(decodeWslListing(Buffer.from('Ubuntu\r\n', 'utf8'))).toBe('Ubuntu\r\n');
  });

  it('handles empty output', () => {
    expect(decodeWslListing(Buffer.alloc(0))).toBe('');
  });

  it('keeps non-ASCII UTF-8 intact rather than mistaking it for UTF-16', () => {
    expect(decodeWslListing(Buffer.from('héllo wörld\n', 'utf8'))).toBe('héllo wörld\n');
  });
});

describe('parseDistroList', () => {
  it('drops blank lines and trims the trailing CR', () => {
    expect(parseDistroList('Ubuntu-20.04\r\ndocker-desktop\r\n\r\n')).toEqual([
      'Ubuntu-20.04',
      'docker-desktop',
    ]);
  });

  it('is empty when WSL reports nothing', () => {
    expect(parseDistroList('')).toEqual([]);
    expect(parseDistroList('\r\n\r\n')).toEqual([]);
  });
});
