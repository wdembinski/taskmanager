/**
 * Whether dictation can be offered at all (F9.9), on top of the pure state machine in
 * `dictationModel.ts`. Pure, no React, no DOM lib types — `win` is a plain `object`, exactly
 * as `recognizerFor` already takes it, so a test passes a plain object instead of needing
 * `jsdom`.
 *
 * Two host-level facts gate the mic before `recognizerFor` is ever consulted:
 *
 * - **`host === 'desktop'`** is always unavailable. F9.7's spike found Web Speech fails with
 *   an immediate network error in the packaged Electron renderer; F9.10 revisits this.
 * - **Firefox** is always unavailable even when a `SpeechRecognition` global exists behind a
 *   pref, because Firefox ships the API surface with no speech backend behind it — a real
 *   `start()` call just errors. Checking the UA first means a stray polyfill can never fool
 *   this into offering a mic that will not work.
 */
import { recognizerFor, type Recognizer } from './dictationModel';

export type DictationHost = 'desktop' | 'web';

/** Who processes the audio, as far as dictationTooltip can tell from the UA. */
export type DictationVendor = 'Google' | 'Microsoft' | 'Apple' | null;

export type DictationAvailability =
  { available: true; vendor: DictationVendor; create(): Recognizer } | { available: false };

function navigatorOf(win: object | undefined): { userAgent: string; vendor: string } {
  if (win === undefined) return { userAgent: '', vendor: '' };
  const nav = (win as Record<string, unknown>).navigator as
    { userAgent?: unknown; vendor?: unknown } | undefined;
  return {
    userAgent: typeof nav?.userAgent === 'string' ? nav.userAgent : '',
    vendor: typeof nav?.vendor === 'string' ? nav.vendor : '',
  };
}

function isFirefox(userAgent: string): boolean {
  return /Firefox\//.test(userAgent);
}

/**
 * Who would process the audio, read off `navigator.userAgent`/`navigator.vendor` on `win`.
 * Order matters: Edge's UA still contains `Chrome/`, so `Edg/` is checked first; Safari's UA
 * contains `Safari` but never `Chrome`/`Chromium`, so that exclusion is what tells it apart
 * from every Chromium-based browser (which also carries `Safari` in its UA string). Firefox
 * (and anything else unrecognized) is `null` — `dictationAvailable` never even reaches here
 * for Firefox, but this function stays honest on its own.
 */
export function dictationVendor(win: object | undefined): DictationVendor {
  const { userAgent, vendor } = navigatorOf(win);
  if (/Edg\//.test(userAgent)) return 'Microsoft';
  if (/Chrome|Chromium|CriOS/.test(userAgent)) return 'Google';
  if (/Safari/.test(userAgent)) return 'Apple';
  if (vendor === 'Google Inc.') return 'Google';
  if (vendor === 'Apple Computer, Inc.') return 'Apple';
  return null;
}

/**
 * Gates a recognizer behind the two host-level facts described in the module header, then
 * delegates to `recognizerFor` for the actual constructor check.
 */
export function dictationAvailable(
  host: DictationHost,
  win: object | undefined,
): DictationAvailability {
  if (host === 'desktop') return { available: false };
  const { userAgent } = navigatorOf(win);
  if (isFirefox(userAgent)) return { available: false };
  const support = recognizerFor(win);
  if (!support.supported) return { available: false };
  return { available: true, vendor: dictationVendor(win), create: support.create };
}

/** The mic button's tooltip — names who processes the audio when the UA identifies one. */
export function dictationTooltip(vendor: DictationVendor): string {
  const processor = vendor ?? "your browser's speech service";
  return `Dictate — audio is processed by ${processor}`;
}

/** `m:ss` under ten minutes, `mm:ss` from ten minutes on — the recording overlay's clock. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
