import { describe, it, expect } from 'vitest';
import { preferredImageUrl } from '../../src/render/textureLoader';

describe('preferredImageUrl — Wikimedia thumbnail rewrite', () => {
  it('requests a server-sized thumbnail for Special:FilePath originals', () => {
    const out = preferredImageUrl(
      'https://commons.wikimedia.org/wiki/Special:FilePath/The_Great_Wave_off_Kanagawa.jpg',
    );
    expect(out).toContain('width=1600');
    expect(out).toContain('/Special:FilePath/The_Great_Wave_off_Kanagawa.jpg');
  });

  it('does not override an explicit width already on the URL', () => {
    const url =
      'https://commons.wikimedia.org/wiki/Special:FilePath/X.jpg?width=640';
    expect(preferredImageUrl(url)).toBe(url);
  });

  it('leaves non-Wikimedia URLs untouched (e.g. archive.org video/images)', () => {
    const url = 'https://archive.org/download/foo/foo_512kb.mp4';
    expect(preferredImageUrl(url)).toBe(url);
  });

  it('leaves direct upload.wikimedia.org thumbnail URLs untouched', () => {
    const url =
      'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0a/X.jpg/800px-X.jpg';
    expect(preferredImageUrl(url)).toBe(url);
  });

  it('passes malformed URLs through verbatim instead of throwing', () => {
    expect(preferredImageUrl('not a url')).toBe('not a url');
  });
});
