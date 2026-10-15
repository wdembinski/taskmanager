import { describe, expect, it } from 'vitest';
import {
  dictationAvailable,
  dictationTooltip,
  dictationVendor,
  formatElapsed,
} from './dictationAvailability';

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/118.0.0.0 Safari/537.36';
const EDGE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/118.0.0.0 Safari/537.36 Edg/118.0.2088.76';
const SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
  'Version/16.5 Safari/605.1.15';
const FIREFOX_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/118.0';

class StubRecognizer {
  continuous?: boolean;
  interimResults?: boolean;
  onresult = null;
  onerror = null;
  onend = null;
  start(): void {}
  stop(): void {}
  abort(): void {}
}

function win(userAgent: string, ctor?: unknown): object {
  const navigator = { userAgent };
  return ctor === undefined ? { navigator } : { navigator, webkitSpeechRecognition: ctor };
}

describe('dictationVendor', () => {
  it('reads Google off a Chrome UA', () => {
    expect(dictationVendor(win(CHROME_UA))).toBe('Google');
  });

  it('reads Microsoft off an Edge UA, ahead of its embedded Chrome token', () => {
    expect(dictationVendor(win(EDGE_UA))).toBe('Microsoft');
  });

  it('reads Apple off a Safari UA', () => {
    expect(dictationVendor(win(SAFARI_UA))).toBe('Apple');
  });

  it('reads null off a Firefox UA', () => {
    expect(dictationVendor(win(FIREFOX_UA))).toBeNull();
  });
});

describe('dictationAvailable', () => {
  it('is available on web with a Chrome UA and a recognizer ctor, vendor Google', () => {
    const result = dictationAvailable('web', win(CHROME_UA, StubRecognizer));
    expect(result).toEqual({ available: true, vendor: 'Google', create: expect.any(Function) });
  });

  it('is available on web with an Edge UA, vendor Microsoft', () => {
    const result = dictationAvailable('web', win(EDGE_UA, StubRecognizer));
    expect(result.available).toBe(true);
    if (!result.available) throw new Error('unreachable');
    expect(result.vendor).toBe('Microsoft');
  });

  it('is available on web with a Safari UA, vendor Apple', () => {
    const result = dictationAvailable('web', win(SAFARI_UA, StubRecognizer));
    expect(result.available).toBe(true);
    if (!result.available) throw new Error('unreachable');
    expect(result.vendor).toBe('Apple');
  });

  it('is unavailable on web with a Firefox UA and no ctor', () => {
    expect(dictationAvailable('web', win(FIREFOX_UA))).toEqual({ available: false });
  });

  it('is unavailable on web with a Firefox UA even when a ctor exists behind a pref', () => {
    expect(dictationAvailable('web', win(FIREFOX_UA, StubRecognizer))).toEqual({
      available: false,
    });
  });

  it('is unavailable on desktop even with a Chrome-like UA and a ctor', () => {
    expect(dictationAvailable('desktop', win(CHROME_UA, StubRecognizer))).toEqual({
      available: false,
    });
  });

  it('is unavailable on web with no recognizer ctor', () => {
    expect(dictationAvailable('web', win(CHROME_UA))).toEqual({ available: false });
  });

  it('is unavailable when win is undefined', () => {
    expect(dictationAvailable('web', undefined)).toEqual({ available: false });
  });
});

describe('dictationTooltip', () => {
  it('names the vendor when one was identified', () => {
    expect(dictationTooltip('Google')).toBe('Dictate — audio is processed by Google');
    expect(dictationTooltip('Microsoft')).toBe('Dictate — audio is processed by Microsoft');
    expect(dictationTooltip('Apple')).toBe('Dictate — audio is processed by Apple');
  });

  it('falls back to a generic phrase when no vendor was identified', () => {
    expect(dictationTooltip(null)).toBe(
      "Dictate — audio is processed by your browser's speech service",
    );
  });
});

describe('formatElapsed', () => {
  it('formats zero as 0:00', () => {
    expect(formatElapsed(0)).toBe('0:00');
  });

  it('formats 59999ms as 0:59, truncating the fractional second', () => {
    expect(formatElapsed(59_999)).toBe('0:59');
  });

  it('formats 61000ms as 1:01', () => {
    expect(formatElapsed(61_000)).toBe('1:01');
  });

  it('formats 600000ms as 10:00, with two-digit minutes', () => {
    expect(formatElapsed(600_000)).toBe('10:00');
  });
});
