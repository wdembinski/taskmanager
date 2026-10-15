/**
 * Push-to-talk dictation (F9.8): a pure state machine over a *structural* recognizer seam,
 * so this file and its tests never depend on the DOM lib shipping `SpeechRecognition` types
 * (it doesn't — `webkitSpeechRecognition` is non-standard) or on a real browser to exercise
 * it. F9.9 wires a real `window.SpeechRecognition`/`webkitSpeechRecognition` through
 * {@link recognizerFor} and {@link bindRecognizer}; until then a `FakeRecognizer` in the test
 * file drives the exact same reducer.
 *
 * Two rules the plan calls out as failure modes, both enforced here rather than left to the
 * UI that will wrap this:
 *
 * - **`insert` never sets `send: true`.** Only `insert-and-send` can. A misheard word
 *   silently submitting a task would be far worse than one sitting unsent in a box.
 * - **An error or an `end` mid-utterance keeps whatever was already finalized.** Only
 *   `interim` (never resent, never confirmed) is dropped; `cancel` is the only action that
 *   discards finalized text too.
 */

/** One recognizer alternative, as `SpeechRecognitionAlternative` shapes it. */
export interface RecognitionAlternativeLike {
  transcript: string;
}

/** One recognizer result — a list of alternatives, the first of which is all this file reads. */
export interface RecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: RecognitionAlternativeLike;
}

/** The event `onresult` fires, as `SpeechRecognitionEvent` shapes it. */
export interface RecognitionResultEventLike {
  resultIndex: number;
  results: ArrayLike<RecognitionResultLike>;
}

/** The event `onerror` fires, as `SpeechRecognitionErrorEvent` shapes it. */
export interface RecognitionErrorEventLike {
  error: string;
  message?: string;
}

/**
 * The structural shape this file needs from a recognizer — exactly the slice of
 * `SpeechRecognition` it calls, so a real browser object and a test fake satisfy it the
 * same way with no DOM lib dependency.
 */
export interface Recognizer {
  continuous?: boolean;
  interimResults?: boolean;
  lang?: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: RecognitionResultEventLike) => void) | null;
  onerror: ((event: RecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}

/** Whether a recognizer is available on `win`, and a factory for one when it is. */
export type RecognizerSupport = { supported: true; create(): Recognizer } | { supported: false };

/**
 * Reads `SpeechRecognition ?? webkitSpeechRecognition` off `win` (the standard name
 * preferred over the vendor-prefixed one) and reports whether it is usable. `win` is typed
 * as a bare `object` rather than `Window` so a test can pass a plain object instead of
 * needing `jsdom`.
 */
export function recognizerFor(win: object | undefined): RecognizerSupport {
  if (win === undefined) return { supported: false };
  const globals = win as Record<string, unknown>;
  const ctor = globals.SpeechRecognition ?? globals.webkitSpeechRecognition;
  if (typeof ctor !== 'function') return { supported: false };
  const RecognizerCtor = ctor as new () => Recognizer;
  return {
    supported: true,
    create(): Recognizer {
      const recognizer = new RecognizerCtor();
      recognizer.continuous = true;
      recognizer.interimResults = true;
      return recognizer;
    },
  };
}

/** Where dictation is being offered — the two hosts need different recognizer policies. */
export type DictationHost = 'desktop' | 'web';

/** An OS whose built-in dictation `osDictationHint` can point at. Linux has none, so it is
 *  never a member of this type — it only ever resolves to `{ kind: 'none' }`. */
export type OsDictationPlatform = 'windows' | 'mac';

/** What dictation path, if any, a host should offer. */
export type DictationPath =
  | { kind: 'web-speech'; create(): Recognizer }
  | { kind: 'os-dictation'; platform: OsDictationPlatform }
  | { kind: 'none' };

/**
 * The host-aware dictation policy F9.9's mic button is gated on. On **desktop** this never
 * returns `web-speech`, even when `webkitSpeechRecognition` exists on `win` — the F9.7 spike
 * found Electron's packaged renderer reaches `onerror: "network"` immediately, since Electron
 * ships no Google speech-service API key the way Chrome does. Desktop instead reads the OS off
 * `win.navigator.userAgent`: Windows and macOS both have a built-in dictation shortcut, so they
 * resolve to `os-dictation`; anything else (Linux, which is how the project's own WSL run shows
 * up here) has none, so it resolves to `none`. On **web**, this is exactly `recognizerFor(win)`
 * — Web Speech works there (F9's open question 3) — narrowed to `web-speech`/`none`.
 */
export function dictationAvailable(host: DictationHost, win: object | undefined): DictationPath {
  if (host === 'desktop') {
    if (win === undefined) return { kind: 'none' };
    const userAgent = (win as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? '';
    if (userAgent.includes('Windows')) return { kind: 'os-dictation', platform: 'windows' };
    if (userAgent.includes('Mac OS X') || userAgent.includes('Macintosh')) {
      return { kind: 'os-dictation', platform: 'mac' };
    }
    return { kind: 'none' };
  }

  const support = recognizerFor(win);
  return support.supported ? { kind: 'web-speech', create: support.create } : { kind: 'none' };
}

/** The shortcut and tooltip text for an `os-dictation` path's hint. Both tooltips note that
 *  the OS, not this app, handles the audio — there is nothing for this app's mic tooltip
 *  vendor-attribution convention (F9's open question 3) to say here. */
export function osDictationHint(platform: OsDictationPlatform): {
  shortcut: string;
  tooltip: string;
} {
  if (platform === 'windows') {
    return {
      shortcut: 'Win+H',
      tooltip:
        'Dictate with Windows voice typing — press Win+H. Audio is handled by the OS, not this app.',
    };
  }
  return {
    shortcut: 'Fn Fn',
    tooltip:
      'Dictate with macOS Dictation — press Fn twice. Audio is handled by the OS, not this app.',
  };
}

/** Appends `next` onto `base` with a single space, trimming `next` first — the seam between
 *  an already-finalized transcript and whatever is joined onto it. */
function joinSeam(base: string, next: string): string {
  const trimmed = next.trim();
  if (!trimmed) return base;
  return base ? `${base} ${trimmed}` : trimmed;
}

/**
 * Folds a `resultIndex`-onward slice of a recognition event into `final`/`interim`. Each
 * final result in the walked range appends onto `final` (space-joined, seam-trimmed); every
 * non-final result in the range is joined together and REPLACES `interim` outright — Chrome
 * resends the whole growing interim result on every event, so the previous `interim`
 * argument is never itself part of the output, only the shape this function returns.
 */
export function foldResults(
  final: string,
  _interim: string,
  event: RecognitionResultEventLike,
): { final: string; interim: string } {
  let nextFinal = final;
  const interimParts: string[] = [];

  for (let i = event.resultIndex; i < event.results.length; i++) {
    const result = event.results[i];
    const transcript = result[0]?.transcript ?? '';
    if (result.isFinal) {
      nextFinal = joinSeam(nextFinal, transcript);
    } else {
      interimParts.push(transcript);
    }
  }

  return { final: nextFinal, interim: interimParts.join(' ').trim() };
}

/** The transcript so far, final and interim joined with the same seam rule as `foldResults`. */
export function transcriptOf({ final, interim }: { final: string; interim: string }): string {
  return joinSeam(final, interim);
}

export interface DictationState {
  phase: 'idle' | 'recording';
  /** True while the recognizer itself is between `start` and its next `error`/`end`. */
  listening: boolean;
  final: string;
  interim: string;
  /** The last recognizer error code, or null. Never cleared by `error` itself overwriting
   *  a prior one — only `start`/`cancel`/a commit reset it. */
  error: string | null;
  /** Set for the rest of the session by `not-allowed`/`service-not-allowed` — the mic
   *  permission was refused, and retrying `start` without the human re-granting it would
   *  just fail the same way again. */
  blocked: boolean;
  /** What the host should do with the transcript, set by `insert`/`insert-and-send` and
   *  consumed (then cleared) by whoever dispatched it. */
  commit: { text: string; send: boolean } | null;
}

export const INITIAL_DICTATION: DictationState = {
  phase: 'idle',
  listening: false,
  final: '',
  interim: '',
  error: null,
  blocked: false,
  commit: null,
};

const PERMISSION_ERRORS = new Set(['not-allowed', 'service-not-allowed']);

export type DictationAction =
  | { type: 'start' }
  | { type: 'result'; event: RecognitionResultEventLike }
  | { type: 'error'; event: RecognitionErrorEventLike }
  | { type: 'end' }
  | { type: 'cancel' }
  | { type: 'insert' }
  | { type: 'insert-and-send' };

/**
 * The whole dictation lifecycle, `idle → recording → idle`. See the module header for the
 * two rules every call site relies on (`insert` never sends; a mid-utterance failure keeps
 * finalized text).
 */
export function dictationReduce(state: DictationState, action: DictationAction): DictationState {
  switch (action.type) {
    case 'start': {
      if (state.blocked) return state;
      return {
        ...state,
        phase: 'recording',
        listening: true,
        final: '',
        interim: '',
        error: null,
        commit: null,
      };
    }

    case 'result': {
      if (state.phase === 'idle') return state;
      const folded = foldResults(state.final, state.interim, action.event);
      return { ...state, final: folded.final, interim: folded.interim };
    }

    case 'error': {
      const code = action.event.error;
      return {
        ...state,
        interim: '',
        listening: false,
        error: code,
        blocked: state.blocked || PERMISSION_ERRORS.has(code),
      };
    }

    case 'end':
      return { ...state, listening: false, interim: '' };

    case 'cancel':
      return { ...INITIAL_DICTATION, blocked: state.blocked };

    case 'insert':
    case 'insert-and-send': {
      const text = transcriptOf(state);
      const commit = text ? { text, send: action.type === 'insert-and-send' } : null;
      return { ...INITIAL_DICTATION, blocked: state.blocked, commit };
    }
  }
}

/**
 * Wires a recognizer's three callbacks to the matching actions and returns an unbind
 * function — the seam F9.9's hook mounts a real recognizer through, and the test file's
 * `FakeRecognizer` mounts through identically.
 */
export function bindRecognizer(
  recognizer: Recognizer,
  dispatch: (action: DictationAction) => void,
): () => void {
  recognizer.onresult = (event) => dispatch({ type: 'result', event });
  recognizer.onerror = (event) => dispatch({ type: 'error', event });
  recognizer.onend = () => dispatch({ type: 'end' });
  return () => {
    recognizer.onresult = null;
    recognizer.onerror = null;
    recognizer.onend = null;
  };
}
