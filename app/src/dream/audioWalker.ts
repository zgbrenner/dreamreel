//
// The AudioWalker: the Infinite-Jukebox model in CLAP space, a sibling to the visual
// Dreamwalker. It maintains a point in CLAP embedding space, drifts it (Brownian) and
// occasionally leaps, then selects the next sampled-audio asset by cosine similarity through a
// softmax whose temperature is the Surreality control. Each pick is additionally biased toward
// the current on-screen concept via a CLAP-text "claptext" vector (the text bridge), scaled by
// a fixed coupling constant. Original implementation; no external code copied.
//
// Pure module: no DOM, no Tone. Seeded `seed + ':audio'` so the audio sequence is a distinct but
// deterministic function of the shared dream seed.

import type { AudioAsset, AudioKind } from '../manifest/types';
import { makeRng, type Rng } from './prng';
import { cosine, l2norm } from './mood';

export interface AudioWalkerConfig {
  seed: string;
  surreality: number; // 0..1
  coupling?: number; // text-bridge strength; default COUPLING
}

export interface AudioPick {
  asset: AudioAsset;
  dwellMs: number;
}

export interface AudioWalkerPools {
  audio: AudioAsset[];
  audioEmbeddingDim: number;
}

export interface AudioWalker {
  next(claptext: number[] | undefined, tempoMul: number): AudioPick | null;
  setSurreality(v: number): void;
  reseed(seed: string): void;
}

const RECENT_WINDOW = 4;
// Surface rates per kind (multiplicative on the pre-softmax weight; deterministic).
const TYPE_WEIGHTS: Record<AudioKind, number> = { music: 1.0, voice: 0.5, foley: 0.8 };
const COUPLING = 0.6;

export function createAudioWalker(
  pools: AudioWalkerPools,
  config: AudioWalkerConfig,
): AudioWalker {
  return new AudioWalkerImpl(pools, config);
}

class AudioWalkerImpl implements AudioWalker {
  private readonly audio: AudioAsset[];
  private readonly dim: number;
  private readonly coupling: number;
  private surreality: number;
  private seed: string;
  private rng!: Rng;
  private e!: number[];
  private recent: string[] = [];

  constructor(pools: AudioWalkerPools, config: AudioWalkerConfig) {
    this.audio = pools.audio;
    this.dim = pools.audioEmbeddingDim;
    this.coupling = config.coupling ?? COUPLING;
    this.surreality = clamp01(config.surreality);
    this.seed = config.seed;
    this.resetState();
  }

  next(claptext: number[] | undefined, tempoMul: number): AudioPick | null {
    if (this.audio.length === 0) return null;
    this.advancePoint();
    const asset = this.pick(claptext);
    const dwellMs = (asset.dwellBase * 1000) / Math.max(0.1, tempoMul);
    return { asset, dwellMs };
  }

  setSurreality(v: number): void {
    this.surreality = clamp01(v);
  }

  reseed(seed: string): void {
    this.seed = seed;
    this.resetState();
  }

  private resetState(): void {
    // Salt with ':audio' so this walk is independent of the visual CLIP walk.
    this.rng = makeRng(this.seed + ':audio');
    if (this.audio.length > 0) {
      const start = this.audio[this.rng.int(this.audio.length)].embedding;
      this.e = start.slice();
    } else {
      this.e = [];
    }
    this.recent = [];
  }

  private temperature(): number {
    return 0.12 + this.surreality * 1.1;
  }

  private advancePoint(): void {
    const driftScale = 0.12 + this.surreality * 0.6;
    const e = this.e.slice();
    const n = Math.min(this.dim, e.length);
    for (let i = 0; i < n; i++) e[i] += this.rng.gaussian() * driftScale;
    const leapP = this.surreality * 0.28;
    if (this.rng.next() < leapP) {
      this.e = this.audio[this.rng.int(this.audio.length)].embedding.slice();
    } else {
      this.e = l2norm(e);
    }
  }

  private pick(claptext: number[] | undefined): AudioAsset {
    const recent = new Set(this.recent);
    let candidates = this.audio.filter((a) => !recent.has(a.id));
    if (candidates.length === 0) candidates = this.audio;

    const T = this.temperature();
    const useBridge = !!claptext && claptext.length > 0 && this.coupling !== 0;
    // Pre-softmax score: cosine-to-point/T plus the text-bridge term (coupling * cos(asset, concept)).
    const scores = candidates.map((a) => {
      const base = cosine(this.e, a.embedding) / T;
      const bridge = useBridge ? this.coupling * cosine(a.embedding, claptext as number[]) : 0;
      return base + bridge;
    });
    const max = Math.max(...scores);
    let sum = 0;
    const weights = scores.map((s, i) => {
      const w = Math.exp(s - max) * TYPE_WEIGHTS[candidates[i].kind];
      sum += w;
      return w;
    });

    let roll = this.rng.next() * sum;
    let idx = 0;
    for (let i = 0; i < weights.length; i++) {
      roll -= weights[i];
      if (roll <= 0) {
        idx = i;
        break;
      }
    }
    const chosen = candidates[idx];
    this.recent.push(chosen.id);
    if (this.recent.length > RECENT_WINDOW) this.recent.shift();
    return chosen;
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
