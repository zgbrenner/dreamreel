// app/src/render/videoTexture.ts
import * as THREE from 'three';
import type { TextureLoadResult } from './textureLoader';

const DEFAULT_TIMEOUT_MS = 8000;

export interface VideoLoadOptions {
  timeoutMs?: number;
  /** When true (reduced motion), do not autoplay — leave on the first frame. */
  paused?: boolean;
  /** Injectable for tests; defaults to a real <video> element. */
  createVideo?: () => HTMLVideoElement;
  /** Injectable for tests; defaults to new THREE.VideoTexture(el). */
  makeTexture?: (el: HTMLVideoElement) => THREE.Texture;
}

/**
 * Load a video URL into a looping, muted THREE.VideoTexture. Resolves a `fail` result (never
 * rejects) on error or timeout so the caller can substitute a procedural source — mirrors
 * loadImageTexture. The texture carries userData.video so the VideoPool can pause/free the
 * underlying element when the texture is recycled.
 */
export function loadVideoTexture(
  url: string,
  opts: VideoLoadOptions = {},
): Promise<TextureLoadResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const createVideo = opts.createVideo ?? (() => document.createElement('video'));
  const makeTexture = opts.makeTexture ?? ((el) => new THREE.VideoTexture(el));

  return new Promise((resolve) => {
    const video = createVideo();
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    video.setAttribute?.('playsinline', '');

    let settled = false;
    const finish = (r: TextureLoadResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.oncanplay = null;
      video.onerror = null;
      if (!r.ok) {
        // Failure path never reaches the VideoPool's dispose-driven teardown — detach the src
        // here so a failed/timed-out element stops buffering instead of leaking until GC.
        try {
          video.pause?.();
          video.removeAttribute?.('src');
          video.load?.();
        } catch {
          /* ignore */
        }
      }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);

    video.oncanplay = () => {
      try {
        const tex = makeTexture(video);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        tex.userData.ownedByCompositor = true;
        tex.userData.kind = 'video';
        tex.userData.video = video;
        if (!opts.paused) void video.play?.()?.catch?.(() => {});
        finish({ ok: true, texture: tex });
      } catch {
        finish({ ok: false, reason: 'error' });
      }
    };
    video.onerror = () => finish({ ok: false, reason: 'error' });
    video.src = url;
    video.load?.();
  });
}
