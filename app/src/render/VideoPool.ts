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

/** A usable interior shot window (seconds) to play instead of the film's opening. */
export interface Shot {
  start: number;
  end: number;
}

interface Active {
  texture: THREE.Texture;
  video: HTMLVideoElement;
  seq: number;
  /** timeupdate listener that loops playback within a shot window; removed on free. */
  shotHandler?: () => void;
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

  async acquire(url: string, shot?: Shot): Promise<TextureLoadResult> {
    const paused = (this.opts.reducedMotion ?? defaultReducedMotion)();
    const load = this.opts.load ?? loadVideoTexture;
    const res = await load(url, { paused });
    if (!res.ok) return res;

    const video = res.texture.userData.video as HTMLVideoElement;
    const entry: Active = { texture: res.texture, video, seq: this.seq++ };

    const hasShot = !!shot && shot.end > shot.start;
    let startAt = hasShot ? (shot as Shot).start : 0;
    let shotActive = hasShot;
    // A baked shot window can lie beyond the deployed clip (shots[] computed against the full
    // source film while the mirrored clip is a short excerpt). Seeking past the end would clamp to
    // the last frame and freeze the clip forever — once duration is known, fall back to the whole
    // clip instead. Runs on every seek, so it also fires from the loadedmetadata retry when the
    // duration only becomes known after the shot handler was installed.
    const clampToDuration = () => {
      const d = video.duration;
      if (!Number.isFinite(d) || d <= 0) return;
      if (startAt >= d - 0.5) {
        startAt = 0;
        shotActive = false;
        if (entry.shotHandler) {
          video.removeEventListener?.('timeupdate', entry.shotHandler);
          entry.shotHandler = undefined;
        }
        video.loop = true;
      }
    };
    const seekStart = () => {
      clampToDuration();
      try {
        video.currentTime = startAt;
      } catch {
        /* not seekable yet — the loadedmetadata listener below retries */
      }
    };
    seekStart();
    // If the element isn't seekable yet, seek once metadata is in.
    if ((video.readyState ?? 0) < 1) video.addEventListener?.('loadedmetadata', seekStart, { once: true });

    if (shotActive) {
      // Loop WITHIN the shot window rather than the whole film: disable native loop and wrap back
      // to the shot start whenever playback reaches the shot end.
      video.loop = false;
      const end = (shot as Shot).end;
      const onTime = () => {
        if (video.currentTime >= end || video.currentTime < startAt - 0.25) seekStart();
      };
      entry.shotHandler = onTime;
      video.addEventListener?.('timeupdate', onTime);
    }

    if (!paused) void video.play?.()?.catch?.(() => {});

    this.active.push(entry);
    res.texture.addEventListener('dispose', () => this.free(entry));
    this.enforceCap();
    return res;
  }

  /** Pause every active video element (e.g. when the dream is paused) without tearing down. */
  pauseAll(): void {
    for (const a of this.active) {
      try { a.video.pause?.(); } catch { /* ignore */ }
    }
  }

  /** Resume videos that were paused by pauseAll, re-applying the cap. Skips reduced-motion. */
  resumeAll(): void {
    if ((this.opts.reducedMotion ?? defaultReducedMotion)()) return;
    for (const a of this.active) {
      try { void a.video.play?.()?.catch?.(() => {}); } catch { /* ignore */ }
    }
    this.enforceCap();
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
    if (entry.shotHandler) {
      try { entry.video.removeEventListener?.('timeupdate', entry.shotHandler); } catch { /* ignore */ }
      entry.shotHandler = undefined;
    }
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
