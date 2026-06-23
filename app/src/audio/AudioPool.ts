// Bounds concurrent sampled-audio sources, mirroring render/VideoPool. A source plays when
// acquired; once more than `cap` are playing, the oldest is paused (frozen, not torn down).
// pauseAll/resumeAll follow dream pause + tab visibility.

export interface PooledAudio {
  url: string;
  pause(): void;
  play(): void;
  readonly paused: boolean;
  dispose(): void;
}

export interface AudioPoolOptions {
  cap: number;
  /** Injectable for tests; defaults to the streaming/buffered loader in mixer.ts. */
  load?: (url: string) => Promise<PooledAudio>;
}

interface Active {
  src: PooledAudio;
  seq: number;
}

export class AudioPool {
  private readonly active: Active[] = [];
  private seq = 0;

  constructor(private readonly opts: AudioPoolOptions) {}

  async acquire(url: string): Promise<PooledAudio> {
    if (!this.opts.load) throw new Error('AudioPool: no loader configured');
    const src = await this.opts.load(url);
    const entry: Active = { src, seq: this.seq++ };
    this.active.push(entry);
    this.enforceCap();
    return src;
  }

  pauseAll(): void {
    for (const a of this.active) {
      try { a.src.pause(); } catch { /* ignore */ }
    }
  }

  resumeAll(): void {
    for (const a of this.active) {
      try { a.src.play(); } catch { /* ignore */ }
    }
    this.enforceCap();
  }

  dispose(): void {
    for (const a of [...this.active]) {
      try { a.src.dispose(); } catch { /* ignore */ }
    }
    this.active.length = 0;
  }

  private enforceCap(): void {
    const cap = Math.max(1, this.opts.cap);
    const playing = this.active.filter((a) => !a.src.paused).sort((a, b) => a.seq - b.seq);
    const overflow = playing.length - cap;
    for (let i = 0; i < overflow; i++) {
      try { playing[i].src.pause(); } catch { /* ignore */ }
    }
  }
}
