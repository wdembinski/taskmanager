import { describe, expect, it } from 'vitest';
import {
  contentDisposition,
  FALLBACK_MIME_TYPE,
  isInlineMimeType,
  mediaHeaders,
} from './attachmentHeaders';

describe('isInlineMimeType', () => {
  it('is images and only images', () => {
    expect(isInlineMimeType('image/png')).toBe(true);
    expect(isInlineMimeType('IMAGE/PNG')).toBe(true);
    expect(isInlineMimeType('image/svg+xml')).toBe(true);
    expect(isInlineMimeType('application/pdf')).toBe(false);
    expect(isInlineMimeType('text/html')).toBe(false);
    expect(isInlineMimeType(null)).toBe(false);
  });
});

describe('contentDisposition', () => {
  it('carries the name twice, for the browsers that read each form', () => {
    expect(contentDisposition('shot.png', true)).toBe(
      `inline; filename="shot.png"; filename*=UTF-8''shot.png`,
    );
  });

  it('cannot be escaped out of by a filename', () => {
    const header = contentDisposition('a".png', false);
    expect(header).toBe(`attachment; filename="a_.png"; filename*=UTF-8''a%22.png`);
    // One opening and one closing quote — the name never ends the parameter early.
    expect(header.match(/"/g)).toHaveLength(2);
  });

  it('keeps a non-ASCII name readable in the encoded form and safe in the plain one', () => {
    const header = contentDisposition('zrzut-ekranu-łódź.png', true);
    expect(header).toContain('filename="zrzut-ekranu-__d_.png"');
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent('zrzut-ekranu-łódź.png')}`);
  });

  it('is just the kind when there is no name to offer', () => {
    expect(contentDisposition(null, false)).toBe('attachment');
    expect(contentDisposition('   ', true)).toBe('inline');
  });
});

describe('mediaHeaders', () => {
  it('serves an image inline, un-sniffable and cacheable', () => {
    const headers = mediaHeaders('image/png', 'shot.png');
    expect(headers['Content-Type']).toBe('image/png');
    expect(headers['Content-Disposition']).toContain('inline');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Cache-Control']).toContain('private');
    expect(headers['Cache-Control']).toContain('immutable');
    expect(headers['Content-Security-Policy']).toBeUndefined();
  });

  it('hands anything that is not an image over as a download', () => {
    expect(mediaHeaders('text/html', 'page.html')['Content-Disposition']).toContain('attachment');
    expect(mediaHeaders('application/pdf', 'spec.pdf')['Content-Disposition']).toContain(
      'attachment',
    );
  });

  it('sandboxes an SVG, which is an image that can carry script', () => {
    const headers = mediaHeaders('image/svg+xml', 'logo.svg');
    expect(headers['Content-Disposition']).toContain('inline');
    expect(headers['Content-Security-Policy']).toBe('sandbox');
  });

  it('falls back to bytes when nothing said what the file is', () => {
    const headers = mediaHeaders(null, 'mystery');
    expect(headers['Content-Type']).toBe(FALLBACK_MIME_TYPE);
    expect(headers['Content-Disposition']).toContain('attachment');
  });
});
