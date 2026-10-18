import { describe, expect, it } from 'vitest';
import type { TaskAttachment } from './attachments';
import { groupAttachmentsForDisplay } from './attachmentDisplay';

function attachment(over: Partial<TaskAttachment> & { id: string; name: string }): TaskAttachment {
  return {
    taskId: 'task-1',
    fileName: over.name,
    mimeType: null,
    size: 0,
    createdAt: 0,
    ...over,
  };
}

describe('groupAttachmentsForDisplay', () => {
  it('pairs a real shot with its mockup and leaves it out of images', () => {
    const real = attachment({ id: '1', name: 'board-light.png', mimeType: 'image/png' });
    const mockup = attachment({ id: '2', name: 'board-light-mockup.png', mimeType: 'image/png' });

    const groups = groupAttachmentsForDisplay([real, mockup]);

    expect(groups.pairs).toEqual([{ name: 'board-light', real, mockup, html: undefined }]);
    expect(groups.images).toEqual([]);
    expect(groups.files).toEqual([]);
  });

  it('still reads a lone .png with no mockup sibling as a pair, mockup left undefined', () => {
    const shot = attachment({ id: '1', name: 'screenshot.png', mimeType: 'image/png' });

    expect(groupAttachmentsForDisplay([shot])).toEqual({
      pairs: [{ name: 'screenshot', real: shot, mockup: undefined, html: undefined }],
      images: [],
      files: [],
    });
  });

  it('puts a non-.png image (shotPairs only ever groups .png) in images, not files', () => {
    const shot = attachment({ id: '1', name: 'screenshot.jpg', mimeType: 'image/jpeg' });

    expect(groupAttachmentsForDisplay([shot])).toEqual({
      pairs: [],
      images: [shot],
      files: [],
    });
  });

  it('puts a non-image in files', () => {
    const log = attachment({ id: '1', name: 'run.log', mimeType: 'text/plain' });

    expect(groupAttachmentsForDisplay([log])).toEqual({
      pairs: [],
      images: [],
      files: [log],
    });
  });

  it('treats a null mimeType as a file, not an image', () => {
    const unknown = attachment({ id: '1', name: 'mystery', mimeType: null });

    expect(groupAttachmentsForDisplay([unknown]).files).toEqual([unknown]);
  });

  it('handles a mix of a pair, a non-.png image and a chip file together', () => {
    const real = attachment({ id: '1', name: 'board-light.png', mimeType: 'image/png' });
    const mockup = attachment({ id: '2', name: 'board-light-mockup.png', mimeType: 'image/png' });
    const lone = attachment({ id: '3', name: 'extra.jpg', mimeType: 'image/jpeg' });
    const log = attachment({ id: '4', name: 'run.log', mimeType: 'text/plain' });

    const groups = groupAttachmentsForDisplay([real, mockup, lone, log]);

    expect(groups.pairs).toHaveLength(1);
    expect(groups.images).toEqual([lone]);
    expect(groups.files).toEqual([log]);
  });
});
