// app/src/dream/dreamwalker.ts
//
// The Dreamwalker: the Infinite-Jukebox model applied to mixed media. It maintains a point
// in CLIP embedding space, drifts it (Brownian) and occasionally leaps (non-sequitur), then
// selects the next asset by cosine similarity through a softmax whose temperature — together
// with the leap probability — is the "Surreality" control. This is an original implementation
// of that approach (inspiration: the Infinite Jukebox / Remixatron family); no external code
// was copied.
//
// Pure module: no DOM, no three.js. The seeded PRNG is the only randomness source, so a
// given (seed, surreality) reproduces the same dream script.

import type { Asset, MoodAxis } from '../manifest/types';
import { makeRng, type Rng } from './prng';
import { cosine, l2norm, projectMood } from './mood';

export interface DreamwalkerConfig {
  seed: string;
  surreality: number; // 0..1
}

export interface Beat {
  asset: Asset;
  dwellMs: number;
  ghost?: Asset;
  titleCard: boolean;
}

export type DreamLayer = 'image' | 'ghost' | 'text';

export interface Dreamwalker {
  next(layer: DreamLayer, tempoMul: number): Beat;
  setSurreality(v: number): void;
  setConvergence(on: boolean): void;
  reseed(seed: string): void;
  currentMood(): Record<MoodAxis, number>;
}

const RECENT_WINDOW = 6;
// Bias selection toward scarce moving-image so video reads as a real part of the reel, not a
// rarity. Multiplicative on the pre-softmax weight (deterministic — no extra RNG draw).
const TYPE_WEIGHTS: Record<string, number> = { video: 7.0 };
const CARD_TAGS = new Set(['card', 'intertitle', 'titlecard']);

function isCard(a: Asset): boolean {
  return a.tags.some((t) => CARD_TAGS.has(t));
}

interface LayerState {
  rng: Rng;
  e: number[]; // current embedding point for this layer's walk
  recent: string[];
}

export interface DreamwalkerPools {
  /** Visual pool (image / video / procedural placeholders). */
  visual: Asset[];
  /** Text pool (drifting lines + intertitle cards). */
  texts: Asset[];
  moodAxes: Record<MoodAxis, number[]>;
  embeddingDim: number;
}

/** Optional, additive instrumentation for tests/tuning — never part of the pinned interface. */
export interface DreamwalkerHooks {
  /** Shannon entropy (bits) of the softmax selection distribution at each pick. */
  onSelect?: (layer: DreamLayer, selectionEntropyBits: number, candidateCount: number) => void;
}

export function createDreamwalker(
  pools: DreamwalkerPools,
  config: DreamwalkerConfig,
  hooks?: DreamwalkerHooks,
): Dreamwalker {
  return new DreamwalkerImpl(pools, config, hooks);
}

class DreamwalkerImpl implements Dreamwalker {
  private readonly visual: Asset[];
  private readonly texts: Asset[];
  private readonly drift: Asset[]; // non-card texts, for the text layer
  private readonly cards: Asset[]; // intertitle cards
  private readonly moodAxes: Record<MoodAxis, number[]>;
  private readonly dim: number;
  private surreality: number;
  private seed: string;
  private readonly hooks?: DreamwalkerHooks;

  private image!: LayerState;
  private ghost!: LayerState;
  private text!: LayerState;
  private lastLeaped = false;
  private converging = false;

  constructor(pools: DreamwalkerPools, config: DreamwalkerConfig, hooks?: DreamwalkerHooks) {
    this.hooks = hooks;
    if (pools.visual.length === 0) throw new Error('Dreamwalker: empty visual pool');
    if (pools.texts.length === 0) throw new Error('Dreamwalker: empty text pool');
    this.visual = pools.visual;
    this.texts = pools.texts;
    this.cards = pools.texts.filter(isCard);
    this.drift = pools.texts.filter((t) => !isCard(t));
    this.moodAxes = pools.moodAxes;
    this.dim = pools.embeddingDim;
    this.surreality = clamp01(config.surreality);
    this.seed = config.seed;
    this.resetState();
  }

  // --- public API ---

  next(layer: DreamLayer, tempoMul: number): Beat {
    const t = Math.max(0.1, tempoMul);
    switch (layer) {
      case 'image':
        return this.nextImage(t);
      case 'ghost':
        return this.nextGhost(t);
      case 'text':
        return this.nextText(t);
    }
  }

  setSurreality(v: number): void {
    this.surreality = clamp01(v);
  }

  // Convergence is walker-wide: while on, all three layers (image/ghost/text) tighten together,
  // so a "rhyme" moment coheres across the whole frame, not just the front image.
  setConvergence(on: boolean): void {
    this.converging = on;
  }

  reseed(seed: string): void {
    this.seed = seed;
    this.resetState();
  }

  currentMood(): Record<MoodAxis, number> {
    return projectMood(this.image.e, this.moodAxes);
  }

  // --- internals ---

  private resetState(): void {
    const base = makeRng(this.seed);
    const startEmbedding = (tag: string): number[] => {
      const r = base.fork(tag);
      return [...this.visual[r.int(this.visual.length)].embedding];
    };
    this.image = { rng: base.fork('image'), e: startEmbedding('seed-image'), recent: [] };
    this.ghost = { rng: base.fork('ghost'), e: startEmbedding('seed-ghost'), recent: [] };
    this.text = { rng: base.fork('text'), e: startEmbedding('seed-text'), recent: [] };
    this.lastLeaped = false;
  }

  private temperature(): number {
    const base = 0.12 + this.surreality * 1.1;
    return this.converging ? base * 0.25 : base;
  }

  /** Drift this layer's point; occasionally leap to a random asset's embedding. */
  private advancePoint(st: LayerState, pool: Asset[]): boolean {
    const driftScale = (0.12 + this.surreality * 0.6) * (this.converging ? 0.3 : 1);
    const e = st.e.slice();
    for (let i = 0; i < this.dim; i++) e[i] += st.rng.gaussian() * driftScale;
    let leaped = false;
    const leapP = this.converging ? 0 : this.surreality * 0.28;
    if (st.rng.next() < leapP) {
      const j = st.rng.int(pool.length);
      st.e = [...pool[j].embedding];
      leaped = true;
    } else {
      st.e = l2norm(e);
    }
    return leaped;
  }

  /** Softmax sample over candidates (excluding the layer's recent ids) by cosine to e. */
  private pick(layer: DreamLayer, st: LayerState, pool: Asset[]): Asset {
    const recent = new Set(st.recent);
    let candidates = pool.filter((a) => !recent.has(a.id));
    if (candidates.length === 0) candidates = pool;

    const T = this.temperature();
    const scores = candidates.map((a) => cosine(st.e, a.embedding) / T);
    const max = Math.max(...scores);
    let sum = 0;
    const weights = scores.map((s, i) => {
      const w = Math.exp(s - max) * (TYPE_WEIGHTS[candidates[i].type] ?? 1);
      sum += w;
      return w;
    });
    if (this.hooks?.onSelect) {
      let h = 0;
      for (const w of weights) {
        const p = w / sum;
        if (p > 0) h -= p * Math.log2(p);
      }
      this.hooks.onSelect(layer, h, candidates.length);
    }
    let roll = st.rng.next() * sum;
    let idx = 0;
    for (let i = 0; i < weights.length; i++) {
      roll -= weights[i];
      if (roll <= 0) {
        idx = i;
        break;
      }
    }
    const chosen = candidates[idx];
    st.recent.push(chosen.id);
    if (st.recent.length > RECENT_WINDOW) st.recent.shift();
    // Rhyme moments: snap the walk onto the chosen embedding so the next pick stays near it,
    // producing a tight thematic cluster. Drift/temperature alone don't converge fast enough.
    if (this.converging) st.e = chosen.embedding.slice();
    return chosen;
  }

  private nextImage(tempoMul: number): Beat {
    this.lastLeaped = this.advancePoint(this.image, this.visual);

    // Title-card interjection: surreality- and leap-dependent.
    const pCard = 0.05 + (this.lastLeaped ? 0.12 : 0) + this.surreality * 0.06;
    if (this.cards.length > 0 && this.image.rng.next() < pCard) {
      const recent = new Set(this.image.recent);
      const pool = this.cards.filter((c) => !recent.has(c.id));
      // Only interject a card if one is available outside the recent window — never repeat.
      if (pool.length > 0) {
        const card = pool[this.image.rng.int(pool.length)];
        this.image.recent.push(card.id);
        if (this.image.recent.length > RECENT_WINDOW) this.image.recent.shift();
        return {
          asset: card,
          dwellMs: (card.dwellBase * 1000) / tempoMul,
          titleCard: true,
        };
      }
    }

    const asset = this.pick('image', this.image, this.visual);
    const mood = projectMood(this.image.e, this.moodAxes);
    const dwellMs = this.dwellFor(asset, mood, tempoMul);

    // Ghost proposal only when the dream feels uncanny/ominous.
    let ghost: Asset | undefined;
    if (Math.max(mood.uncanny, mood.ominous) > 0.62) {
      ghost = this.proposeGhost();
    }

    return { asset, dwellMs, ghost, titleCard: false };
  }

  private nextGhost(tempoMul: number): Beat {
    this.advancePoint(this.ghost, this.visual);
    const asset = this.pick('ghost', this.ghost, this.visual);
    // ghost cadence is a touch quicker than the image it doubles
    const dwellMs = (asset.dwellBase * 700) / tempoMul;
    return { asset, dwellMs, titleCard: false };
  }

  private nextText(tempoMul: number): Beat {
    const pool = this.drift.length > 0 ? this.drift : this.texts;
    this.advancePoint(this.text, pool);
    const asset = this.pick('text', this.text, pool);
    // text drifts faster than imagery
    const dwellMs = (asset.dwellBase * 1000 * 0.6) / tempoMul;
    return { asset, dwellMs, titleCard: false };
  }

  private proposeGhost(): Asset {
    // a near pick around the image point, on the ghost rng so it stays deterministic.
    const recent = new Set(this.image.recent);
    let pool = this.visual.filter((a) => !recent.has(a.id));
    if (pool.length === 0) pool = this.visual;
    let best = pool[0];
    let bestScore = -Infinity;
    let second = pool[0];
    for (const a of pool) {
      const s = cosine(this.image.e, a.embedding);
      if (s > bestScore) {
        bestScore = s;
        second = best;
        best = a;
      }
    }
    // pick the second-nearest so the ghost differs from the front image.
    return second;
  }

  private dwellFor(asset: Asset, mood: Record<MoodAxis, number>, tempoMul: number): number {
    const linger = (mood.tender + mood.nostalgic) / 2;
    const hurry = (mood.uncanny + mood.mechanical) / 2;
    const factor = clamp(1 + 0.5 * linger - 0.5 * hurry, 0.4, 1.8);
    return (asset.dwellBase * 1000 * factor) / tempoMul;
  }
}

function clamp01(v: number): number {
  return clamp(v, 0, 1);
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
