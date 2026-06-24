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

import type { AudioAsset, AudioKind, MoodAxis } from '../manifest/types';
import { makeRng, type Rng } from './prng';
import { cosine, l2norm, moodAffinity } from './mood';

export interface AudioWalkerConfig {
  seed: string;
  surreality: number; // 0..1
  coupling?: number; // text-bridge strength; default COUPLING
  moodCoupling?: number; // mood-vector bias strength; default MOOD_COUPLING
  energyCoupling?: number; // energy×arousal selection-bias strength; default ENERGY_COUPLING
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
  next(claptext: number[] | undefined, tempoMul: number, mood?: Record<MoodAxis, number>): AudioPick | null;
  setSurreality(v: number): void;
  reseed(seed: string): void;
}

const RECENT_WINDOW = 4;
// Surface rates per kind (multiplicative on the pre-softmax weight; deterministic).
const TYPE_WEIGHTS: Record<AudioKind, number> = { music: 1.0, voice: 0.5, foley: 0.8 };
const COUPLING = 0.6;
const MOOD_COUPLING = 0.8;
const ENERGY_COUPLING = 1.6;
const BEATS_PER_BAR = 4;

// Axes that read as high vs. low physiological arousal. Arousal is the (high - low) mean of the
// signed deviations from neutral (0.5), so a tender/melancholy dream is calm and a joy/fear/manic
// one is excited — used to pull louder clips into excited moments and gentler ones into calm.
const HIGH_AROUSAL: MoodAxis[] = ['joy', 'fear', 'absurdity', 'uncanny', 'strange'];
const LOW_AROUSAL: MoodAxis[] = ['tender', 'melancholy', 'loss', 'nostalgic'];

/** Signed arousal of a mood blend, roughly -0.5..0.5 (0 at neutral). Pure + exported for tests. */
export function audioArousal(mood: Record<MoodAxis, number>): number {
  const mean = (axes: MoodAxis[]) =>
    axes.reduce((s, a) => s + ((mood[a] ?? 0.5) - 0.5), 0) / axes.length;
  return mean(HIGH_AROUSAL) - mean(LOW_AROUSAL);
}

/**
 * Snap a dwell to a whole number of musical bars at the clip's tempo, so sampled clips swap on a
 * bar boundary instead of an arbitrary instant. `bpm` undefined/non-finite → returns `baseMs`
 * unchanged (legacy manifests behave exactly as before). Always ≥ one bar. Pure + exported.
 */
export function musicalDwellMs(baseMs: number, bpm?: number): number {
  if (bpm === undefined || !Number.isFinite(bpm) || bpm <= 0) return baseMs;
  const barMs = (BEATS_PER_BAR * 60_000) / bpm;
  const bars = Math.max(1, Math.round(baseMs / barMs));
  return bars * barMs;
}

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
  private readonly moodCoupling: number;
  private readonly energyCoupling: number;
  private surreality: number;
  private seed: string;
  private rng!: Rng;
  private e!: number[];
  private recent: string[] = [];

  constructor(pools: AudioWalkerPools, config: AudioWalkerConfig) {
    this.audio = pools.audio;
    this.dim = pools.audioEmbeddingDim;
    this.coupling = config.coupling ?? COUPLING;
    this.moodCoupling = config.moodCoupling ?? MOOD_COUPLING;
    this.energyCoupling = config.energyCoupling ?? ENERGY_COUPLING;
    this.surreality = clamp01(config.surreality);
    this.seed = config.seed;
    this.resetState();
  }

  next(claptext: number[] | undefined, tempoMul: number, mood?: Record<MoodAxis, number>): AudioPick | null {
    if (this.audio.length === 0) return null;
    this.advancePoint();
    const asset = this.pick(claptext, mood);
    const baseMs = (asset.dwellBase * 1000) / Math.max(0.1, tempoMul);
    // Bar-quantize so clip swaps land on a musical boundary (no-op when bpm is absent).
    const dwellMs = musicalDwellMs(baseMs, asset.bpm);
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

  private pick(claptext: number[] | undefined, mood?: Record<MoodAxis, number>): AudioAsset {
    const recent = new Set(this.recent);
    let candidates = this.audio.filter((a) => !recent.has(a.id));
    if (candidates.length === 0) candidates = this.audio;

    const T = this.temperature();
    const useBridge = !!claptext && claptext.length > 0 && this.coupling !== 0;
    const useMood = !!mood && this.moodCoupling !== 0;
    // Energy bias: lean toward louder clips when the mood is excited, gentler ones when it's calm.
    // Vanishes when no mood is supplied, when coupling is 0, or for clips lacking baked energy.
    const useEnergy = !!mood && this.energyCoupling !== 0;
    const arousal = useEnergy ? audioArousal(mood as Record<MoodAxis, number>) : 0;
    // Pre-softmax score: cosine-to-point/T plus text-bridge, mood-alignment, and energy×arousal terms.
    const scores = candidates.map((a) => {
      const base = cosine(this.e, a.embedding) / T;
      const bridge = useBridge ? this.coupling * cosine(a.embedding, claptext as number[]) : 0;
      const moodTerm = useMood ? this.moodCoupling * moodAffinity(a.mood, mood as Record<MoodAxis, number>) : 0;
      const energyTerm =
        useEnergy && a.energy !== undefined ? this.energyCoupling * arousal * (a.energy - 0.5) : 0;
      return base + bridge + moodTerm + energyTerm;
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
