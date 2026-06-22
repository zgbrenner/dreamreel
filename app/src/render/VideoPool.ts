// app/src/render/VideoPool.ts
import type * as THREE from 'three';
import { loadVideoTexture, type VideoLoadOptions } from './videoTexture';
import type { TextureLoadResult } from './textureLoader';

export interface VideoPoolOptions {
  /** Max videos decoding at once; older ones are paused (frozen still) beyond this. */
  cap: number;
  /** Defaults to a prefers-reduced-motion media query. */
  reducedMotion?: () => boolean;
  /** Injectable for tests; defaults to loadVideoTexture. */
  load?: (url: string, opts?: VideoLoadOptions) => Promise<TextureLoadResult>;
}

interface Active {
  texture: THREE.Texture;
  video: HTMLVideoElement;
  seq: number;
}

/**
 * Bounds concurrent video decoders in the N-layer compositor. A video plays when acquired;
 * once more than `cap` are playing, the oldest is paused (its texture freezes on its last
 * frame — cheap, and never black). Full teardown of the <video> element follows the texture's
 * lifecycle: when the LayerStack/compositor disposes the texture, we pause + detach the element.
 */
export class VideoPool {
  private readonly active: Active[] = [];
  private seq = 0;

  constructor(private readonly opts: VideoPoolOptions) {}

  async acquire(url: string): Promise<TextureLoadResult> {
    const paused = (this.opts.reducedMotion ?? defaultReducedMotion)();
    const load = this.opts.load ?? loadVideoTexture;
    const res = await load(url, { paused });
    if (!res.ok) return res;

    const video = res.texture.userData.video as HTMLVideoElement;
    try {
      video.currentTime = 0; // deterministic start-point on every show
    } catch {
      /* not seekable yet — harmless */
    }
    if (!paused) void video.play?.()?.catch?.(() => {});

    const entry: Active = { texture: res.texture, video, seq: this.seq++ };
    this.active.push(entry);
    res.texture.addEventListener('dispose', () => this.free(entry));
    this.enforceCap();
    return res;
  }

  dispose(): void {
    for (const a of [...this.active]) this.free(a);
  }

  private enforceCap(): void {
    const cap = Math.max(1, this.opts.cap);
    const playing = this.active.filter((a) => !a.video.paused).sort((a, b) => a.seq - b.seq);
    const overflow = playing.length - cap;
    for (let i = 0; i < overflow; i++) {
      try {
        playing[i].video.pause?.();
      } catch {
        /* ignore */
      }
    }
  }

  private free(entry: Active): void {
    const i = this.active.indexOf(entry);
    if (i !== -1) this.active.splice(i, 1);
    try {
      entry.video.pause?.();
    } catch {
      /* ignore */
    }
    entry.video.removeAttribute?.('src');
    try {
      entry.video.load?.();
    } catch {
      /* ignore */
    }
  }
}

function defaultReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}
