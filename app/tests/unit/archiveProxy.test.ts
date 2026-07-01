import { describe, expect, it } from 'vitest';
import {
  archiveProxyUrlFor,
  isArchiveUrl,
  rewriteArchiveUrlsForDev,
} from '../../src/manifest/archiveProxy';
import type { Manifest } from '../../src/manifest/types';
import seed from '../../public/manifest.seed.json';

describe('archive.org dev proxy URL rewrite', () => {
  it('recognizes archive.org download hosts only', () => {
    expect(isArchiveUrl('https://archive.org/download/foo/foo.mp4')).toBe(true);
    expect(isArchiveUrl('https://ia600100.us.archive.org/0/items/foo/foo.mp4')).toBe(true);
    expect(isArchiveUrl('https://commons.wikimedia.org/wiki/Special:FilePath/X.jpg')).toBe(false);
    expect(isArchiveUrl('http://archive.org/download/foo/foo.mp4')).toBe(false);
    expect(isArchiveUrl('not a url')).toBe(false);
  });

  it('wraps archive URLs with the configured proxy only in dev', () => {
    const src = 'https://archive.org/download/foo/foo_512kb.mp4';
    const out = archiveProxyUrlFor(src, { dev: true, proxyBase: 'http://127.0.0.1:8787/archive' });
    expect(out).toBe(`http://127.0.0.1:8787/archive?url=${encodeURIComponent(src)}`);
    expect(archiveProxyUrlFor(src, { dev: false })).toBe(src);
  });

  it('supports relative proxy bases', () => {
    const src = 'https://archive.org/download/foo/foo_512kb.mp4';
    expect(archiveProxyUrlFor(src, { dev: true, proxyBase: '/archive-proxy' })).toBe(
      `/archive-proxy?url=${encodeURIComponent(src)}`,
    );
  });

  it('rewrites manifest media src fields without changing attribution links', () => {
    const original = seed as unknown as Manifest;
    const m = rewriteArchiveUrlsForDev(original, { dev: true, proxyBase: 'http://127.0.0.1:8787/' });
    const archiveAsset = m.assets.find((asset) => asset.src?.includes('Popeye_forPresident_512kb.mp4'));
    expect(archiveAsset?.src).toMatch(/^http:\/\/127\.0\.0\.1:8787\/\?url=/);
    expect(archiveAsset?.attributionUrl).toBe(original.assets.find((asset) => asset.id === archiveAsset?.id)?.attributionUrl);
  });
});
