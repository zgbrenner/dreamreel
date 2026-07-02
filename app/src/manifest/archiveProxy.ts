import type { Manifest } from './types';

const DEFAULT_ARCHIVE_PROXY_URL = 'http://127.0.0.1:8787/';
const RELATIVE_BASE = 'http://dreamreel.local';

interface ArchiveProxyOptions {
  dev?: boolean;
  proxyBase?: string;
}

export function isArchiveUrl(src: string): boolean {
  try {
    const u = new URL(src);
    return u.protocol === 'https:' && (u.hostname === 'archive.org' || u.hostname.endsWith('.archive.org'));
  } catch {
    return false;
  }
}

export function archiveProxyUrlFor(src: string, opts: ArchiveProxyOptions = {}): string {
  // import.meta.env only exists under Vite; scripts/validate-manifest.ts runs this under plain
  // tsx, where dereferencing .DEV would throw. Outside Vite, treat as non-dev (no rewrite).
  const env = import.meta.env as ImportMetaEnv | undefined;
  const dev = opts.dev ?? env?.DEV ?? false;
  if (!dev || !isArchiveUrl(src)) return src;

  const proxyBase = opts.proxyBase ?? env?.VITE_ARCHIVE_PROXY_URL ?? DEFAULT_ARCHIVE_PROXY_URL;
  const absolute = /^[a-z][a-z\d+.-]*:/i.test(proxyBase);
  const u = new URL(proxyBase, RELATIVE_BASE);
  u.searchParams.set('url', src);
  return absolute ? u.toString() : `${u.pathname}${u.search}${u.hash}`;
}

export function rewriteArchiveUrlsForDev(manifest: Manifest, opts: ArchiveProxyOptions = {}): Manifest {
  const rewrite = (src: string): string => archiveProxyUrlFor(src, opts);
  return {
    ...manifest,
    assets: manifest.assets.map((asset) => asset.src ? { ...asset, src: rewrite(asset.src) } : asset),
    texts: manifest.texts.map((text) => text.src ? { ...text, src: rewrite(text.src) } : text),
    audio: manifest.audio.map((audio) => ({ ...audio, src: rewrite(audio.src) })),
    entitySprites: manifest.entitySprites?.map((sprite) => ({ ...sprite, src: rewrite(sprite.src) })),
  };
}
