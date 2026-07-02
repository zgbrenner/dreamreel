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
import { cosine, l2norm, projectMood, moodAffinity } from './mood';
import { moodBiasAt, type MoodBiasVector, type MoodIdentity } from './moodBias';
import type { SteeringState } from './steering';

export interface DreamwalkerConfig {
  seed: string;
  surreality: number; // 0..1
  /**
   * The dream's seed-level emotional identity (dream/moodBias). When present, the walk leans its
   * START point and its per-beat picks toward this region, so the dream has a coherent mood (most
   * dreams gentle, a minority nightmare) instead of wandering uniformly. Absent ⇒ unbiased (legacy).
   */
  moodIdentity?: MoodIdentity;
}

// --- behavioral bend tuning (see the seeded-spine-plus-bend model in CLAUDE.md) ---
// The walk keeps a pure seeded SPINE per layer and, on top of it, a decaying BEND offset driven by
// ambient steering. The bend is capped (BEND_MAX) so a steered viewer always gets a recognizable
// variant of the SAME seeded dream, and it RELAXES (BEND_RELAX per beat) back to the spine once the
// signal fades — snapping to exactly zero below BEND_EPS so the walk returns to the spine bit-for-bit.
export const BEND_MAX = 0.34; // cap on ‖bend‖ (spine is unit-length) ⇒ max angular deviation ≈ 19°
const BEND_PUSH = 0.16; // per-beat push from full pointer attention along a seeded basis
const BEND_RELAX = 0.5; // per-beat decay toward the spine when the push eases
const BEND_EPS = 5e-3; // below this ‖bend‖ snaps to exactly 0 ⇒ the walk returns to the pure spine
const IDLE_DWELL_GAIN = 0.6; // idle stretches dwell up to ×1.6 — TIMING only, never reorders the script

// --- seed-level emotional identity (dream/moodBias) tuning ---
// How strongly the dream's emotional identity weights its START asset pick (softmax over mood
// affinity). Set so a dream reliably BEGINS in its region even in low-surreality dreams, where the
// per-beat softmax (gated by temperature) barely moves selection.
const START_MOOD_COUPLING = 5;
// Image beats per arc cycle: the mid-dream turn peaks roughly once every this many image beats, so a
// long dream turns toward (and back from) its arc more than once. Pure function of the beat counter.
const ARC_PERIOD_BEATS = 90;

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
  /**
   * Apply ambient behavioral steering. `null` or `neutralSteering()` means "no input": the bend
   * relaxes to zero and the walk reproduces the pure seeded spine bit-for-bit. The walk consumes
   * only the CONTENT fields (pointer attention ⇒ a bounded, self-relaxing bend; idle ⇒ longer dwell);
   * presentation-only fields (tilt, pointer speed, time-of-day, focus) are ignored here.
   */
  setSteering(s: SteeringState | null): void;
  /**
   * Supply the dream's recurrence echo: a function returning how strongly a candidate's entities
   * echo current memory (>= 0). The walk then leans toward echoing candidates so motifs recur.
   * `null` clears it (no recurrence bias). Deterministic — driven by the seeded observed sequence.
   */
  setRecurrence(echo: ((entities: string[] | undefined) => number) | null): void;
  /** ‖bend‖ for a layer — 0 means the walk is exactly on its seeded spine. Queryable for tests/UI. */
  bendMagnitude(layer: DreamLayer): number;
  /** The pure seeded spine embedding for a layer (a copy) — the baseline the bend deviates from. */
  spineEmbedding(layer: DreamLayer): number[];
}

const RECENT_WINDOW = 6;
// Minimum image beats between title-card interjections — cards are punctuation, not a medium.
const CARD_MIN_GAP_BEATS = 8;
const TEXT_MOOD_COUPLING = 1.2;
// Bias selection toward scarce moving-image so video reads as a real part of the reel, not a
// rarity. Multiplicative on the pre-softmax weight (deterministic — no extra RNG draw).
const TYPE_WEIGHTS: Record<string, number> = { video: 7.0 };
// Gentle aesthetic bias: assets scored above/below the neutral aesthetic lean the softmax toward
// better-composed media without collapsing variety. Added to the pre-softmax exponent (so it
// scales the weight multiplicatively). Deterministic — `aesthetic` is baked per asset. A missing
// score contributes nothing, so legacy manifests are unaffected.
const AESTHETIC_COUPLING = 0.12;
const AESTHETIC_NEUTRAL = 5.5; // LAION scores cluster around here; the pivot for above/below
// Recurrence: lean the walk toward candidates that echo the dream's current entity memory, so
// motifs return. Bounded (the echo is clamped) so recurrence colours the dream without collapsing
// its variety. Added to the pre-softmax exponent; 0 when no memory/entities are present.
export const RECUR_COUPLING = 0.5;
export const RECUR_ECHO_CAP = 3.0; // clamp the echo so a heavily-remembered candidate can't dominate

/** Signed pre-softmax aesthetic boost for an asset (0 when it carries no score). Exported for tests. */
export function aestheticBoost(aesthetic: number | undefined): number {
  if (aesthetic === undefined || !Number.isFinite(aesthetic)) return 0;
  return AESTHETIC_COUPLING * (aesthetic - AESTHETIC_NEUTRAL);
}
const CARD_TAGS = new Set(['card', 'intertitle', 'titlecard']);

function isCard(a: Asset): boolean {
  return a.tags.some((t) => CARD_TAGS.has(t));
}

interface LayerState {
  rng: Rng;
  e: number[]; // SPINE: the pure seeded embedding point. Advanced only by the seeded rng — never by
  // steering — so it stays the deterministic baseline the bend measures deviation against.
  eLive: number[]; // the BENT point used for scoring = normalize(e + bend); === e when bend is zero.
  bend: number[]; // accumulated steering offset; decays toward 0 (relax) and is capped (BEND_MAX).
  bendActive: boolean; // false when bend is exactly the zero vector — the fast path that equals the spine.
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
  private lastCardBeat = -Infinity;
  private converging = false;

  // The dream's seed-level emotional identity (null ⇒ unbiased legacy walk), and a deterministic
  // image-beat counter that phases the optional mid-dream arc. The counter advances once per image
  // beat — a pure function of the seeded sequence, independent of steering and wall-clock timing.
  private readonly moodIdentity: MoodIdentity | null;
  private imageBeat = 0;

  // Ambient steering + the seeded basis the pointer-attention bend pushes along. The basis is
  // derived from the seed so a given dream always bends in its own characteristic directions.
  private steering: SteeringState | null = null;
  private recurrenceEcho: ((entities: string[] | undefined) => number) | null = null;
  private basisX!: number[];
  private basisY!: number[];

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
    this.moodIdentity = config.moodIdentity ?? null;
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

  setRecurrence(echo: ((entities: string[] | undefined) => number) | null): void {
    this.recurrenceEcho = echo;
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
    // Mood follows the BENT point so the steered experience feels its own; === spine when unsteered.
    return projectMood(this.image.eLive, this.moodAxes);
  }

  setSteering(s: SteeringState | null): void {
    this.steering = s;
  }

  bendMagnitude(layer: DreamLayer): number {
    return mag(this.layer(layer).bend);
  }

  spineEmbedding(layer: DreamLayer): number[] {
    return this.layer(layer).e.slice();
  }

  // --- internals ---

  private layer(layer: DreamLayer): LayerState {
    return layer === 'image' ? this.image : layer === 'ghost' ? this.ghost : this.text;
  }

  private resetState(): void {
    this.imageBeat = 0;
    const base = makeRng(this.seed);
    const startEmbedding = (tag: string): number[] => {
      const r = base.fork(tag);
      // Bias the dream's starting neighbourhood toward its emotional identity so it BEGINS in
      // region (the per-beat nudge is weak in low-surreality dreams; the start anchors it there).
      const idx = this.moodIdentity
        ? pickByMoodAffinity(this.visual, this.moodIdentity.baseline, r)
        : r.int(this.visual.length);
      return [...this.visual[idx].embedding];
    };
    const fresh = (rngTag: string, embTag: string): LayerState => {
      const e = startEmbedding(embTag);
      return {
        rng: base.fork(rngTag),
        e,
        eLive: e, // identical reference until a non-zero bend forks it off
        bend: new Array(this.dim).fill(0),
        bendActive: false,
        recent: [],
      };
    };
    this.image = fresh('image', 'seed-image');
    this.ghost = fresh('ghost', 'seed-ghost');
    this.text = fresh('text', 'seed-text');
    this.lastLeaped = false;
    this.lastCardBeat = -Infinity;

    // Seeded bend basis: two unit directions in embedding space the pointer-attention bend leans
    // along. A dedicated `:steer` stream keeps it from perturbing the walk/leap draws.
    const sr = base.fork('steer');
    this.basisX = randUnit(sr, this.dim);
    this.basisY = randUnit(sr, this.dim);
  }

  private temperature(): number {
    // Tight enough that picks actually track embedding similarity at typical surreality —
    // consecutive beats should feel related; only high-surreality dreams approach a flat softmax.
    const base = 0.10 + this.surreality * 0.7;
    return this.converging ? base * 0.25 : base;
  }

  /** Drift this layer's point; occasionally leap to a random asset's embedding. */
  private advancePoint(st: LayerState, pool: Asset[]): boolean {
    const driftScale = (0.10 + this.surreality * 0.4) * (this.converging ? 0.3 : 1);
    const e = st.e.slice();
    for (let i = 0; i < this.dim; i++) e[i] += st.rng.gaussian() * driftScale;
    let leaped = false;
    // Quadratic: non-sequitur hard cuts stay rare for a typical dream (~4.5% at surreality 0.5)
    // and only frenzied seeds leap often — the walk, not random jumps, carries the narrative.
    const leapP = this.converging ? 0 : this.surreality * this.surreality * 0.18;
    if (st.rng.next() < leapP) {
      const j = st.rng.int(pool.length);
      st.e = [...pool[j].embedding];
      leaped = true;
    } else {
      st.e = l2norm(e);
    }
    return leaped;
  }

  /**
   * Relax then re-bend this layer's offset by the current steering, and recompute the bent point.
   * The SPINE (st.e) is never touched here — only the bend and the derived eLive — so the seeded
   * baseline stays pure. With no/neutral steering the bend decays to exactly 0 and eLive === st.e.
   */
  private advanceBend(st: LayerState): void {
    const push = this.steerPush();
    // Fast path: an already-relaxed walk with no push stays exactly on the spine (no per-beat work).
    if (!push && !st.bendActive) {
      st.eLive = st.e;
      return;
    }
    let active = false;
    for (let i = 0; i < this.dim; i++) {
      let b = st.bend[i] * BEND_RELAX; // relax toward the spine
      if (push) b += push[i]; // bend by ambient attention
      st.bend[i] = b;
      if (b !== 0) active = true;
    }
    if (active) {
      // Cap the deviation so a steered dream is always a variant of the same seeded identity.
      const m = mag(st.bend);
      if (m > BEND_MAX) {
        const k = BEND_MAX / m;
        for (let i = 0; i < this.dim; i++) st.bend[i] *= k;
      }
    }
    // Snap a spent bend to exactly zero so the walk returns to the spine bit-for-bit.
    if (!active || mag(st.bend) < BEND_EPS) {
      if (st.bendActive) st.bend.fill(0);
      st.bendActive = false;
      st.eLive = st.e;
      return;
    }
    st.bendActive = true;
    st.eLive = l2norm(addVec(st.e, st.bend));
  }

  /** The per-beat push vector from pointer attention along the seeded basis, or null when neutral. */
  private steerPush(): number[] | null {
    const s = this.steering;
    if (!s) return null;
    const px = s.pointerX;
    const py = s.pointerY;
    if (px === 0 && py === 0) return null;
    const out = new Array<number>(this.dim);
    for (let i = 0; i < this.dim; i++) out[i] = (this.basisX[i] * px + this.basisY[i] * py) * BEND_PUSH;
    return out;
  }

  /**
   * Softmax sample over candidates (excluding the layer's recent ids). Scores come from BOTH the
   * spine point and the bent point, sharing ONE uniform draw: the spine pick drives all persistent
   * state (recent window + convergence snap) so the spine stays steering-independent, while the bent
   * pick is what's actually returned. Sharing the draw means steering never changes the number of
   * RNG draws — the spine advances in lockstep regardless — so the walk can relax back exactly.
   */
  private pick(layer: DreamLayer, st: LayerState, pool: Asset[], moodBias?: Record<MoodAxis, number>): Asset {
    const recent = new Set(st.recent);
    let candidates = pool.filter((a) => !recent.has(a.id));
    if (candidates.length === 0) candidates = pool;

    const T = this.temperature();
    const spine = this.weigh(candidates, st.e, T, moodBias);

    if (this.hooks?.onSelect) {
      let h = 0;
      for (const w of spine.weights) {
        const p = w / spine.sum;
        if (p > 0) h -= p * Math.log2(p);
      }
      this.hooks.onSelect(layer, h, candidates.length);
    }

    const u = st.rng.next(); // single shared draw
    const spineChosen = candidates[selectIndex(spine.weights, spine.sum, u)];

    // Bent pick re-ranks the same candidates by the bent point. When bend is inactive eLive === e,
    // so this is bit-identical to spineChosen (and we skip the work).
    let liveChosen = spineChosen;
    if (st.bendActive) {
      const live = this.weigh(candidates, st.eLive, T, moodBias);
      liveChosen = candidates[selectIndex(live.weights, live.sum, u)];
    }

    // Persistent state advances on the SPINE pick only -> the spine is independent of steering.
    st.recent.push(spineChosen.id);
    if (st.recent.length > RECENT_WINDOW) st.recent.shift();
    // Rhyme moments: snap the spine onto its chosen embedding so the next pick stays near it,
    // producing a tight thematic cluster. Drift/temperature alone don't converge fast enough.
    if (this.converging) st.e = spineChosen.embedding.slice();
    return liveChosen;
  }

  private weigh(
    candidates: Asset[],
    e: number[],
    T: number,
    moodBias?: Record<MoodAxis, number>,
  ): { weights: number[]; sum: number } {
    const scores = candidates.map((a) => cosine(e, a.embedding) / T);
    const max = Math.max(...scores);
    let sum = 0;
    const weights = scores.map((s, i) => {
      const moodBoost =
        moodBias !== undefined ? TEXT_MOOD_COUPLING * moodAffinity(candidates[i].mood, moodBias) : 0;
      const aesBoost = aestheticBoost(candidates[i].aesthetic);
      const recurBoost = this.recurrenceEcho
        ? RECUR_COUPLING * Math.min(this.recurrenceEcho(candidates[i].entities), RECUR_ECHO_CAP)
        : 0;
      const w =
        Math.exp(s - max + moodBoost + aesBoost + recurBoost) * (TYPE_WEIGHTS[candidates[i].type] ?? 1);
      sum += w;
      return w;
    });
    return { weights, sum };
  }

  /** The image layer's current mood bias: the identity's baseline, arc-modulated by the deterministic
   *  image-beat phase. Undefined when the dream has no identity (legacy unbiased walk). */
  private imageMoodBias(): MoodBiasVector | undefined {
    if (!this.moodIdentity) return undefined;
    const phase = (this.imageBeat / ARC_PERIOD_BEATS) % 1;
    return moodBiasAt(this.moodIdentity, phase);
  }

  private nextImage(tempoMul: number): Beat {
    this.imageBeat++; // advance the arc phase once per image beat (covers the card path too)
    this.lastLeaped = this.advancePoint(this.image, this.visual);
    this.advanceBend(this.image);

    const liveMood = projectMood(this.image.eLive, this.moodAxes);

    // Title-card interjection: rare mood-tinted punctuation, never a substitute for the picture.
    // Gated so a card can't fire right after a non-sequitur leap (an intertitle on top of a hard
    // cut reads as noise) and never twice within CARD_MIN_GAP_BEATS. The rng draw is unconditional
    // (when cards exist) so gating never changes the stream's draw cadence.
    const pCard =
      0.008 + this.surreality * 0.02 + liveMood.absurdity * 0.012 + liveMood.strange * 0.008;
    if (this.cards.length > 0) {
      const roll = this.image.rng.next();
      const gateOpen =
        !this.lastLeaped && this.imageBeat - this.lastCardBeat >= CARD_MIN_GAP_BEATS;
      if (gateOpen && roll < pCard) {
        const recent = new Set(this.image.recent);
        const pool = this.cards.filter((c) => !recent.has(c.id));
        // Only interject a card if one is available outside the recent window — never repeat.
        if (pool.length > 0) {
          const card = this.pickCardByMood(pool, liveMood);
          this.lastCardBeat = this.imageBeat;
          this.image.recent.push(card.id);
          if (this.image.recent.length > RECENT_WINDOW) this.image.recent.shift();
          return {
            asset: card,
            dwellMs: (this.idleDwellMul() * card.dwellBase * 1000) / tempoMul,
            titleCard: true,
          };
        }
      }
    }

    const asset = this.pick('image', this.image, this.visual, this.imageMoodBias());
    const mood = liveMood;
    const dwellMs = this.dwellFor(asset, mood, tempoMul);

    // Ghost proposal when the dream feels uncanny, ominous, fearful, or strange.
    let ghost: Asset | undefined;
    if (Math.max(mood.uncanny, mood.ominous, mood.fear, mood.strange) > 0.62) {
      ghost = this.proposeGhost();
    }

    return { asset, dwellMs, ghost, titleCard: false };
  }

  private nextGhost(tempoMul: number): Beat {
    this.advancePoint(this.ghost, this.visual);
    this.advanceBend(this.ghost);
    // Ghost leans to the identity's resting baseline (not the arc) so it stays in the dream's mood
    // region without coupling to the image layer's beat counter — keeping per-layer determinism.
    const asset = this.pick('ghost', this.ghost, this.visual, this.moodIdentity?.baseline);
    // ghost cadence is a touch quicker than the image it doubles
    const dwellMs = (this.idleDwellMul() * asset.dwellBase * 700) / tempoMul;
    return { asset, dwellMs, titleCard: false };
  }

  private nextText(tempoMul: number): Beat {
    const pool = this.drift.length > 0 ? this.drift : this.texts;
    this.advancePoint(this.text, pool);
    this.advanceBend(this.text);
    const liveMood = projectMood(this.text.eLive, this.moodAxes);
    const asset = this.pick('text', this.text, pool, liveMood);
    // text drifts faster than imagery
    const dwellMs = (this.idleDwellMul() * asset.dwellBase * 1000 * 0.6) / tempoMul;
    return { asset, dwellMs, titleCard: false };
  }

  /**
   * Idle stretches how long every beat lingers (up to ×1+IDLE_DWELL_GAIN). This is the one CONTENT
   * effect a purely passive viewer feels — and it touches only TIMING, never which assets/text/events
   * occur or their order, so the seeded script is preserved. Returns 1 when not idle.
   */
  private idleDwellMul(): number {
    const idle = this.steering?.idle ?? 0;
    return 1 + clamp(idle, 0, 1) * IDLE_DWELL_GAIN;
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
    const linger = (mood.tender + mood.nostalgic + mood.love + mood.joy * 0.5) / 3.5;
    const hurry = (mood.uncanny + mood.mechanical + mood.fear + mood.absurdity) / 4;
    const factor = clamp(1 + 0.5 * linger - 0.5 * hurry, 0.4, 1.8);
    return (this.idleDwellMul() * asset.dwellBase * 1000 * factor) / tempoMul;
  }

  /** Mood-weighted card pick among intertitle candidates (deterministic via image rng). */
  private pickCardByMood(pool: Asset[], mood: Record<MoodAxis, number>): Asset {
    const scores = pool.map((c) => Math.exp(TEXT_MOOD_COUPLING * moodAffinity(c.mood, mood)));
    const sum = scores.reduce((s, x) => s + x, 0);
    let roll = this.image.rng.next() * sum;
    for (let i = 0; i < pool.length; i++) {
      roll -= scores[i];
      if (roll <= 0) return pool[i];
    }
    return pool[pool.length - 1];
  }
}

/**
 * Softmax-roulette index into `pool`, weighting each asset by how well its mood aligns with `bias`
 * (mood.moodAffinity). One `rng` draw, deterministic. Used to anchor a dream's START asset in its
 * emotional region so the dream begins in-identity regardless of surreality.
 */
function pickByMoodAffinity(pool: Asset[], bias: Record<MoodAxis, number>, rng: Rng): number {
  let sum = 0;
  const weights = pool.map((a) => {
    const w = Math.exp(START_MOOD_COUPLING * moodAffinity(a.mood, bias));
    sum += w;
    return w;
  });
  let roll = rng.next() * sum;
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return i;
  }
  return pool.length - 1;
}

function clamp01(v: number): number {
  return clamp(v, 0, 1);
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Weighted-roulette index from softmax weights, given a shared uniform u in [0,1). Matches the
 * walk's original inline selection exactly — including its fall-through to index 0 — so unsteered
 * picks stay bit-for-bit identical to the pre-bend code.
 */
function selectIndex(weights: number[], sum: number, u: number): number {
  let roll = u * sum;
  let idx = 0;
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i];
    if (roll <= 0) {
      idx = i;
      break;
    }
  }
  return idx;
}

function mag(v: number[]): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

function addVec(a: number[], b: number[]): number[] {
  const out = new Array<number>(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + b[i];
  return out;
}

/** A deterministic unit vector of length `dim` drawn from `rng` (zero-vector guarded). */
function randUnit(rng: Rng, dim: number): number[] {
  const v = new Array<number>(dim);
  for (let i = 0; i < dim; i++) v[i] = rng.gaussian();
  return l2norm(v);
}
