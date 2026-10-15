import { describe, expect, it } from 'vitest';
import {
  INITIAL_DICTATION,
  bindRecognizer,
  dictationReduce,
  recognizerFor,
  type DictationAction,
  type DictationState,
  type Recognizer,
  type RecognitionErrorEventLike,
  type RecognitionResultEventLike,
  type RecognitionResultLike,
} from './dictationModel';

/**
 * Drives the exact seam a real `webkitSpeechRecognition` would: `emitPartial`/`emitFinal`
 * build `resultIndex`/`results` the way Chrome does — a finalized slot is never resent, a
 * growing interim slot is resent in full on every call — so `foldResults` is exercised the
 * same way through this fake as it will be through the real thing in F9.9.
 */
class FakeRecognizer implements Recognizer {
  continuous?: boolean;
  interimResults?: boolean;
  lang?: string;
  onresult: ((event: RecognitionResultEventLike) => void) | null = null;
  onerror: ((event: RecognitionErrorEventLike) => void) | null = null;
  onend: (() => void) | null = null;

  private results: RecognitionResultLike[] = [];
  private pendingIndex = 0;

  start(): void {
    this.results = [];
    this.pendingIndex = 0;
  }

  stop(): void {}

  abort(): void {}

  private result(transcript: string, isFinal: boolean): RecognitionResultLike {
    return { isFinal, length: 1, 0: { transcript } };
  }

  private dispatchFrom(resultIndex: number): void {
    this.onresult?.({ resultIndex, results: this.results.slice() });
  }

  /** Resends the still-growing interim slot with new text. */
  emitPartial(text: string): void {
    this.results[this.pendingIndex] = this.result(text, false);
    this.dispatchFrom(this.pendingIndex);
  }

  /** Finalizes the current slot, then advances — a finalized slot is never resent. */
  emitFinal(text: string): void {
    this.results[this.pendingIndex] = this.result(text, true);
    this.dispatchFrom(this.pendingIndex);
    this.pendingIndex += 1;
  }

  emitError(code: string): void {
    this.onerror?.({ error: code });
  }

  emitEnd(): void {
    this.onend?.();
  }
}

/** Binds a fresh `FakeRecognizer` to a local `dictationReduce` dispatch loop. */
function harness() {
  let state: DictationState = INITIAL_DICTATION;
  const fake = new FakeRecognizer();
  const dispatch = (action: DictationAction): void => {
    state = dictationReduce(state, action);
  };
  bindRecognizer(fake, dispatch);
  return {
    fake,
    dispatch,
    get state(): DictationState {
      return state;
    },
  };
}

describe('dictationReduce', () => {
  it('replaces interim on each partial while leaving final untouched', () => {
    const h = harness();
    h.dispatch({ type: 'start' });

    h.fake.emitPartial('hel');
    expect(h.state.interim).toBe('hel');
    expect(h.state.final).toBe('');

    h.fake.emitPartial('hello');
    expect(h.state.interim).toBe('hello');
    expect(h.state.final).toBe('');
  });

  it('keeps a finalized result across later partials', () => {
    const h = harness();
    h.dispatch({ type: 'start' });

    h.fake.emitFinal('hello world');
    expect(h.state.final).toBe('hello world');
    expect(h.state.interim).toBe('');

    h.fake.emitPartial('next');
    expect(h.state.final).toBe('hello world');
    expect(h.state.interim).toBe('next');
  });

  it('folds a single event carrying a final result then an interim one', () => {
    const h = harness();
    h.dispatch({ type: 'start' });

    h.fake.onresult?.({
      resultIndex: 0,
      results: [
        { isFinal: true, length: 1, 0: { transcript: 'hello' } },
        { isFinal: false, length: 1, 0: { transcript: 'wor' } },
      ],
    });

    expect(h.state.final).toBe('hello');
    expect(h.state.interim).toBe('wor');
  });

  it('keeps finalized text and drops interim on a mid-utterance error', () => {
    const h = harness();
    h.dispatch({ type: 'start' });
    h.fake.emitFinal('hello');
    h.fake.emitPartial('wor');

    h.fake.emitError('network');

    expect(h.state.final).toBe('hello');
    expect(h.state.interim).toBe('');
    expect(h.state.listening).toBe(false);
    expect(h.state.error).toBe('network');
    expect(h.state.blocked).toBe(false);
  });

  it('blocks the session on not-allowed and makes a later start a no-op', () => {
    const h = harness();
    h.dispatch({ type: 'start' });

    h.fake.emitError('not-allowed');
    expect(h.state.blocked).toBe(true);

    const blocked = h.state;
    h.dispatch({ type: 'start' });
    expect(h.state).toBe(blocked);
  });

  it('blocks the session on service-not-allowed too', () => {
    const h = harness();
    h.dispatch({ type: 'start' });

    h.fake.emitError('service-not-allowed');

    expect(h.state.blocked).toBe(true);
  });

  it('discards everything on cancel', () => {
    const h = harness();
    h.dispatch({ type: 'start' });
    h.fake.emitFinal('hello');
    h.fake.emitPartial('world');

    h.dispatch({ type: 'cancel' });

    expect(h.state.phase).toBe('idle');
    expect(h.state.final).toBe('');
    expect(h.state.interim).toBe('');
    expect(h.state.commit).toBeNull();
  });

  it('commits the transcript with send:false on insert', () => {
    const h = harness();
    h.dispatch({ type: 'start' });
    h.fake.emitFinal('hello');
    h.fake.emitPartial('world');

    h.dispatch({ type: 'insert' });

    expect(h.state.phase).toBe('idle');
    expect(h.state.commit).toEqual({ text: 'hello world', send: false });
  });

  it('commits the transcript with send:true on insert-and-send', () => {
    const h = harness();
    h.dispatch({ type: 'start' });
    h.fake.emitFinal('hello world');

    h.dispatch({ type: 'insert-and-send' });

    expect(h.state.commit).toEqual({ text: 'hello world', send: true });
  });

  it('never sets send:true from a plain insert, however it is reached', () => {
    const h = harness();
    h.dispatch({ type: 'start' });
    h.fake.emitFinal('ship it');

    h.dispatch({ type: 'insert' });

    expect(h.state.commit?.send).toBe(false);
  });

  it('yields no commit when insert is pressed with an empty transcript', () => {
    const h = harness();
    h.dispatch({ type: 'start' });

    h.dispatch({ type: 'insert' });

    expect(h.state.phase).toBe('idle');
    expect(h.state.commit).toBeNull();
  });

  it('ignores a result while idle', () => {
    const h = harness();
    expect(h.state.phase).toBe('idle');
    const before = h.state;

    h.fake.emitPartial('should be ignored');

    expect(h.state).toBe(before);
  });

  it('drops interim but keeps final and stays in recording on end', () => {
    const h = harness();
    h.dispatch({ type: 'start' });
    h.fake.emitFinal('hello');
    h.fake.emitPartial('world');

    h.fake.emitEnd();

    expect(h.state.listening).toBe(false);
    expect(h.state.interim).toBe('');
    expect(h.state.final).toBe('hello');
    expect(h.state.phase).toBe('recording');
  });
});

describe('recognizerFor', () => {
  it('reports unsupported for an object with neither constructor', () => {
    expect(recognizerFor({})).toEqual({ supported: false });
  });

  it('reports unsupported for undefined', () => {
    expect(recognizerFor(undefined)).toEqual({ supported: false });
  });

  it('supports a webkit-prefixed recognizer and configures it on create', () => {
    const support = recognizerFor({ webkitSpeechRecognition: FakeRecognizer });
    expect(support.supported).toBe(true);
    if (!support.supported) throw new Error('unreachable');

    const recognizer = support.create();
    expect(recognizer).toBeInstanceOf(FakeRecognizer);
    expect(recognizer.continuous).toBe(true);
    expect(recognizer.interimResults).toBe(true);
  });

  it('prefers the standard constructor over the webkit-prefixed one', () => {
    class StandardRecognizer extends FakeRecognizer {}
    class PrefixedRecognizer extends FakeRecognizer {}

    const support = recognizerFor({
      SpeechRecognition: StandardRecognizer,
      webkitSpeechRecognition: PrefixedRecognizer,
    });
    expect(support.supported).toBe(true);
    if (!support.supported) throw new Error('unreachable');

    const recognizer = support.create();
    expect(recognizer).toBeInstanceOf(StandardRecognizer);
    expect(recognizer).not.toBeInstanceOf(PrefixedRecognizer);
  });
});
