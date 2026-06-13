// app/src/render/textureLoader.ts
import * as THREE from 'three';

export interface TextureLoadOk {
  ok: true;
  texture: THREE.Texture;
}
export interface TextureLoadFail {
  ok: false;
  reason: 'error' | 'timeout';
}
export type TextureLoadResult = TextureLoadOk | TextureLoadFail;

const MAX_SIDE = 1600; // cap input resolution to protect mobile memory
const DEFAULT_TIMEOUT_MS = 6000;

/**
 * Load an image URL into a THREE.Texture, downscaling so the longest side is <= MAX_SIDE.
 * Uses crossOrigin + no-referrer so third-party PD hosts serve us. Resolves a `fail` result
 * (never rejects) on error or timeout so the caller can substitute a procedural source and
 * never leave a black frame.
 */
export function loadImageTexture(
  url: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<TextureLoadResult> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.decoding = 'async';

    let settled = false;
    const finish = (r: TextureLoadResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      resolve(r);
    };

    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);

    img.onload = () => {
      try {
        const tex = textureFromImage(img);
        finish({ ok: true, texture: tex });
      } catch {
        finish({ ok: false, reason: 'error' });
      }
    };
    img.onerror = () => finish({ ok: false, reason: 'error' });
    img.src = url;
  });
}

function textureFromImage(img: HTMLImageElement): THREE.Texture {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const longest = Math.max(w, h);
  const scale = longest > MAX_SIDE ? MAX_SIDE / longest : 1;

  let tex: THREE.Texture;
  if (scale < 1) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    tex = new THREE.CanvasTexture(canvas);
  } else {
    tex = new THREE.Texture(img);
    tex.needsUpdate = true;
  }
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.userData.ownedByCompositor = true;
  return tex;
}
