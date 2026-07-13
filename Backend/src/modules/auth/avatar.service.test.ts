import { describe, it, expect } from 'vitest';
import { parseAvatarDataUrl, AvatarError } from './avatar.service';

function makeDataUrl(sizeBytes: number, mime = 'image/png'): string {
  // Not a real image — just enough bytes to exercise the size check; parseAvatarDataUrl
  // doesn't validate image content, only the data: URL envelope and decoded size.
  const raw = Buffer.alloc(sizeBytes, 1).toString('base64');
  return `data:${mime};base64,${raw}`;
}

describe('parseAvatarDataUrl', () => {
  it('extracts the mime type and buffer from a well-formed data URL', () => {
    const { buffer, mimeType } = parseAvatarDataUrl(makeDataUrl(100, 'image/jpeg'));
    expect(mimeType).toBe('image/jpeg');
    expect(buffer.length).toBe(100);
  });

  it('rejects a string that is not a data: URL', () => {
    expect(() => parseAvatarDataUrl('https://example.com/avatar.png')).toThrow(AvatarError);
  });

  it('rejects an image over the size cap', () => {
    expect(() => parseAvatarDataUrl(makeDataUrl(3 * 1024 * 1024))).toThrow(AvatarError);
  });

  it('accepts an image right at a reasonable size', () => {
    expect(() => parseAvatarDataUrl(makeDataUrl(500 * 1024))).not.toThrow();
  });
});
